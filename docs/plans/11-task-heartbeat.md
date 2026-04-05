# Plan 11 — Task Mode, Heartbeat & Run History

> Status: Planning Done  
> Depends on: Plan 8 (Memory), Plan 9 (Persona), Plan 10 (Channels)  
> Layer: App layer

---

## 1. Overview & Goals

Plan 11 menambah tiga hal yang saling terkait:

1. **Task Mode** — agent bisa spawn conversation bertipe `task` via `run_task` tool. Berjalan autonomous tanpa nunggu user input. Bisa di-detach (background) atau attach (tunggu dengan timeout).
2. **Heartbeat** — scheduled autonomous run per agent. Agent "bangun" secara berkala, evaluate, bisa spawn task. Conversation bertipe `heartbeat`.
3. **Run History** — halaman tabel pagination (server-side) yang menampilkan semua conversations lintas type. View-only dengan conversation viewer component yang reusable.

**Prinsip utama:**
- Semua run (chat, task, heartbeat) adalah `conversation` — satu table, dibedakan oleh `type`
- `caller_id` menjaga scope — inherit dari parent, null untuk system-initiated
- `parent_conversation_id` untuk tracking spawn chain
- `run_task` tool bisa dipanggil dari conversation manapun (chat, task, heartbeat)
- Tidak ada limit spawn — agent bebas cabang sesuai kebutuhan
- Heartbeat per agent, bukan per project

---

## 2. Conversation Schema Extension

### Extend table `conversations`

```sql
-- Kolom yang perlu ditambah ke conversations table yang sudah ada
ALTER TABLE conversations
  ADD COLUMN type               text NOT NULL DEFAULT 'chat'
                                  CHECK (type IN ('chat', 'task', 'heartbeat')),
                                  -- type adalah text bukan enum agar extensible
  ADD COLUMN metadata           jsonb NOT NULL DEFAULT '{}',
  ADD COLUMN caller_id          uuid REFERENCES users(id),  -- null = system/agent
  ADD COLUMN parent_conversation_id uuid REFERENCES conversations(id),
  ADD COLUMN status             text NOT NULL DEFAULT 'idle'
                                  CHECK (status IN ('idle', 'running', 'completed', 'failed', 'cancelled')),
  ADD COLUMN started_at         timestamptz,
  ADD COLUMN finished_at        timestamptz,
  ADD COLUMN error_message      text;

-- Index untuk Run History queries
CREATE INDEX idx_conversations_project_type 
  ON conversations(project_id, type, created_at DESC);

CREATE INDEX idx_conversations_parent 
  ON conversations(parent_conversation_id);

CREATE INDEX idx_conversations_caller 
  ON conversations(caller_id);

CREATE INDEX idx_conversations_status 
  ON conversations(status, created_at DESC);
```

### Conversation types

```typescript
// type adalah string, bukan enum — extensible untuk plan berikutnya
type ConversationType = 'chat' | 'task' | 'heartbeat' | string

// metadata per type (simpan di jsonb)
interface ChatMetadata {
  // kosong untuk sekarang
}

interface TaskMetadata {
  goal: string                    // prompt/goal yang diberikan ke task
  spawned_by_tool_call_id?: string // tool_call_id dari run_task yang spawn ini
  timeout_ms?: number
}

interface HeartbeatMetadata {
  scheduled_at: string            // ISO timestamp kapan harusnya jalan
  trigger: 'cron' | 'manual'
}
```

### Caller ID rules

```
User chat dengan agent              → caller_id = user.id
run_task dipanggil dari conversation → caller_id = inherit dari parent conversation
Heartbeat (cron trigger)            → caller_id = null
Connector group binding             → caller_id = null
Connector private (mapped user)     → caller_id = mapped_user_id
```

---

## 3. `run_task` Built-in Tool

Tool ini selalu aktif di semua conversation (chat, task, heartbeat). Di-register di `RuntimeManager.wakeUp()` sebagai built-in tool.

```typescript
// apps/studio/server/src/task/tools.ts

run_task: tool({
  description: `Spawn a new autonomous task conversation. The task runs independently with its own context.
Use detach=true to run in background (returns immediately with task_id).
Use detach=false to wait for completion (max timeout applies, returns result or task_id if timeout).
Tasks can spawn their own sub-tasks. Caller scope is inherited from current conversation.`,
  parameters: z.object({
    goal: z.string().describe("The prompt/goal for the task agent to accomplish"),
    agent_id: z.string().optional().describe("Agent to run the task. Defaults to current agent."),
    detach: z.boolean().default(true).describe("true=background (returns task_id immediately), false=wait with timeout"),
    timeout_ms: z.number().default(30000).describe("Max wait time in ms when detach=false. Default 30s, max 60s."),
    metadata: z.record(z.unknown()).optional().describe("Additional metadata to attach to the task conversation"),
  }),
  execute: async (input, { toolCallId }) => {
    // Clamp timeout
    const timeoutMs = Math.min(input.timeout_ms ?? 30000, 60000)

    // Resolve agent
    const agentId = input.agent_id ?? currentAgentId

    // Inherit caller dari parent conversation
    const callerId = currentConversation.caller_id

    // Create task conversation
    const taskConv = await createConversation({
      project_id: currentConversation.project_id,
      agent_id: agentId,
      type: 'task',
      caller_id: callerId,                           // inherit
      parent_conversation_id: currentConversation.id,
      status: 'idle',
      metadata: {
        goal: input.goal,
        spawned_by_tool_call_id: toolCallId,
        timeout_ms: timeoutMs,
        ...input.metadata,
      } satisfies TaskMetadata,
    })

    // Start task runner async
    const taskPromise = runTaskConversation(taskConv.id, agentId, input.goal, callerId)

    if (input.detach) {
      // Fire and forget
      taskPromise.catch((err) => console.error(`Task ${taskConv.id} failed:`, err))
      return {
        status: 'spawned',
        task_id: taskConv.id,
        message: `Task spawned in background. Use task_id to check progress.`,
      }
    }

    // Attach mode — tunggu dengan timeout
    try {
      const result = await Promise.race([
        taskPromise,
        sleep(timeoutMs).then(() => ({ timed_out: true })),
      ])

      if ('timed_out' in result) {
        return {
          status: 'running',
          task_id: taskConv.id,
          message: `Task is still running after ${timeoutMs / 1000}s. Check progress via task_id.`,
        }
      }

      return {
        status: result.status,
        task_id: taskConv.id,
        output: result.output,
      }
    } catch (err: any) {
      return {
        status: 'failed',
        task_id: taskConv.id,
        error: err.message,
      }
    }
  }
})
```

### Task Runner

```typescript
// apps/studio/server/src/task/runner.ts

async function runTaskConversation(
  conversationId: string,
  agentId: string,
  goal: string,
  callerId: string | null,
): Promise<{ status: string; output?: string }> {

  await updateConversation(conversationId, {
    status: 'running',
    started_at: new Date(),
  })

  try {
    const runtime = RuntimeManager.getRuntime(agentId)

    const stream = await runtime.run({
      conversation_id: conversationId,
      caller: buildCaller(callerId),
      mode: 'task',
      input: goal,
    })

    const result = await collectStream(stream)

    await updateConversation(conversationId, {
      status: 'completed',
      finished_at: new Date(),
      metadata: { ...existingMetadata, output: result.text },
    })

    return { status: 'completed', output: result.text }

  } catch (err: any) {
    await updateConversation(conversationId, {
      status: 'failed',
      finished_at: new Date(),
      error_message: err.message,
    })
    throw err
  }
}
```

### Task mode system prompt injection

```
[Base Prompt]
[Persona]
[Memory]

[Mode: Task]
You are running in autonomous task mode.
Your goal: {goal}

Work independently to accomplish this goal. You have access to all your tools.
When you have completed the goal, call task_complete() with your output.
If you cannot complete the goal, call task_fail() with the reason.
You may spawn sub-tasks using run_task() if needed.
```

### Additional task tools (built-in, hanya aktif di mode task)

```typescript
task_complete: tool({
  description: "Mark this task as completed with output",
  parameters: z.object({
    output: z.string().describe("Final output or result of the task"),
  }),
  execute: async ({ output }) => {
    await updateConversation(conversationId, {
      status: 'completed',
      finished_at: new Date(),
      metadata: { ...metadata, output },
    })
    // Signal runner bahwa task selesai
    taskCompletionEmitter.emit('complete', { output })
    return { success: true }
  }
})

task_fail: tool({
  description: "Mark this task as failed with reason",
  parameters: z.object({
    reason: z.string(),
  }),
  execute: async ({ reason }) => {
    await updateConversation(conversationId, {
      status: 'failed',
      finished_at: new Date(),
      error_message: reason,
    })
    taskCompletionEmitter.emit('fail', { reason })
    return { success: true }
  }
})

task_report_progress: tool({
  description: "Report progress update (visible in run history)",
  parameters: z.object({
    message: z.string(),
    percent: z.number().min(0).max(100).optional(),
  }),
  execute: async ({ message, percent }) => {
    // Append ke metadata.progress_log
    await appendTaskProgress(conversationId, { message, percent, at: new Date() })
    return { success: true }
  }
})
```

---

## 4. Heartbeat System

### Heartbeat config per agent

Tambah field di `agents` table:

```sql
ALTER TABLE agents
  ADD COLUMN heartbeat_enabled    boolean NOT NULL DEFAULT false,
  ADD COLUMN heartbeat_cron       text,           -- cron expression, e.g. '0 * * * *' (setiap jam)
  ADD COLUMN heartbeat_prompt     text,           -- custom prompt, null = pakai default
  ADD COLUMN heartbeat_last_run_at timestamptz,
  ADD COLUMN heartbeat_next_run_at timestamptz;
```

### Default heartbeat system prompt

```
You are running in heartbeat mode — a scheduled autonomous check-in.

Your responsibilities in this heartbeat:
- Review any pending items or goals you're aware of
- Check if there are tasks you should initiate based on your memory and project context
- Send notifications or updates if needed via available channels
- Spawn tasks for any work that needs to be done

Be proactive but focused. Only take action if there's meaningful work to do.
If nothing requires attention, you may complete this heartbeat without action.

Current time: {datetime}
Schedule: {cron_expression}
```

Ini adalah base prompt. Admin bisa override via `heartbeat_prompt` di agent settings.

### Heartbeat Scheduler

```typescript
// apps/studio/server/src/heartbeat/scheduler.ts

export class HeartbeatScheduler {
  private jobs: Map<string, CronJob> = new Map()

  // Dipanggil saat RuntimeManager.wakeUp()
  async scheduleAgent(agentId: string, projectId: string) {
    const agent = await getAgent(agentId)
    if (!agent.heartbeat_enabled || !agent.heartbeat_cron) return

    const job = new CronJob(agent.heartbeat_cron, async () => {
      await this.triggerHeartbeat(agentId, projectId, agent)
    })

    job.start()
    this.jobs.set(agentId, job)
  }

  async triggerHeartbeat(agentId: string, projectId: string, agent: Agent) {
    // Create heartbeat conversation
    const conv = await createConversation({
      project_id: projectId,
      agent_id: agentId,
      type: 'heartbeat',
      caller_id: null,              // system-initiated
      status: 'idle',
      metadata: {
        scheduled_at: new Date().toISOString(),
        trigger: 'cron',
      } satisfies HeartbeatMetadata,
    })

    // Build prompt
    const prompt = buildHeartbeatPrompt(agent)

    // Run async, non-blocking
    runTaskConversation(conv.id, agentId, prompt, null)
      .catch((err) => console.error(`Heartbeat ${conv.id} failed:`, err))

    // Update next run
    await updateAgent(agentId, {
      heartbeat_last_run_at: new Date(),
      heartbeat_next_run_at: getNextCronDate(agent.heartbeat_cron),
    })
  }

  async rescheduleAgent(agentId: string, projectId: string) {
    this.jobs.get(agentId)?.stop()
    this.jobs.delete(agentId)
    await this.scheduleAgent(agentId, projectId)
  }

  stopAgent(agentId: string) {
    this.jobs.get(agentId)?.stop()
    this.jobs.delete(agentId)
  }
}

export const heartbeatScheduler = new HeartbeatScheduler()
```

### Heartbeat integration di RuntimeManager

```typescript
// Di RuntimeManager.wakeUp()
await heartbeatScheduler.scheduleAgent(agent.id, projectId)

// Di RuntimeManager.syncAgent() — kalau heartbeat config berubah
await heartbeatScheduler.rescheduleAgent(agent.id, projectId)

// Di RuntimeManager.shutdown()
heartbeatScheduler.stopAgent(agent.id)
```

---

## 5. Run History Page

### Server-side pagination query

```typescript
// apps/studio/db/src/queries/conversations.ts

interface ListConversationsParams {
  project_id: string
  type?: string                   // filter by type
  agent_id?: string               // filter by agent
  status?: string                 // filter by status
  caller_id?: string | null       // filter by caller
  search?: string                 // search di metadata.goal atau messages
  page: number                    // 1-indexed
  per_page: number                // default 20, max 100
  sort: 'created_at' | 'started_at' | 'finished_at'
  order: 'asc' | 'desc'
}

interface ListConversationsResult {
  data: ConversationRow[]
  total: number
  page: number
  per_page: number
  total_pages: number
}

// ConversationRow untuk tabel
interface ConversationRow {
  id: string
  type: string
  status: string
  agent_id: string
  agent_name: string
  caller_id: string | null
  caller_name: string | null       // join ke users
  parent_conversation_id: string | null
  metadata: Record<string, unknown>
  message_count: number            // count dari messages
  started_at: string | null
  finished_at: string | null
  duration_ms: number | null       // finished_at - started_at
  created_at: string
}
```

### Run History API route

```
GET /api/projects/:pid/runs?type=&agent_id=&status=&page=&per_page=&sort=&order=
→ ListConversationsResult

GET /api/projects/:pid/runs/:conv_id
→ ConversationRow + messages (readonly)
```

---

## 6. Reusable Components

### `<DataTable>` — server-side pagination table

```typescript
// apps/studio/web/components/ui/data-table.tsx

interface DataTableProps<T> {
  // Data
  data: T[]
  columns: ColumnDef<T>[]

  // Server-side pagination
  pagination: {
    page: number
    perPage: number
    total: number
    totalPages: number
    onPageChange: (page: number) => void
    onPerPageChange: (perPage: number) => void
  }

  // Optional
  isLoading?: boolean
  onRowClick?: (row: T) => void
  emptyState?: React.ReactNode

  // Slot untuk action bar di atas tabel (filter, search, buttons)
  toolbar?: React.ReactNode
}

// Usage contoh:
<DataTable
  data={runs}
  columns={runColumns}
  pagination={pagination}
  toolbar={
    <div className="flex gap-2">
      <Select value={typeFilter} onValueChange={setTypeFilter}>...</Select>
      <Select value={statusFilter} onValueChange={setStatusFilter}>...</Select>
    </div>
  }
  onRowClick={(row) => router.push(`/runs/${row.id}`)}
/>
```

Implementasi pakai **TanStack Table** (`@tanstack/react-table`) yang sudah familiar. Server-side berarti `manualPagination: true`, data di-fetch ulang saat page berubah via TanStack Query.

### `<ConversationViewer>` — reusable conversation display

```typescript
// apps/studio/web/components/conversation/conversation-viewer.tsx

interface ConversationViewerProps {
  conversationId: string
  mode: 'edit' | 'readonly'       // edit = bisa kirim chat, readonly = view only
  showContextBar?: boolean         // tampilkan context/memory bar (default true)
  showHeader?: boolean             // tampilkan header dengan info conversation
  realtime?: boolean               // subscribe SSE untuk update realtime (default true kalau status=running)
}

// Di chat page — mode edit (existing behavior)
<ConversationViewer
  conversationId={conv.id}
  mode="edit"
  showContextBar={true}
/>

// Di run history detail — mode readonly
<ConversationViewer
  conversationId={run.id}
  mode="readonly"
  showContextBar={true}
  realtime={run.status === 'running'}
/>
```

Komponen ini refactor dari chat page yang ada. Logic yang dipindah ke component:
- Message list rendering
- SSE subscription untuk realtime
- Context bar
- Memory preview sheet (dari Plan 10 carry-over)

---

## 7. UI

### Agent Settings — Tab "Heartbeat" (baru, di bawah Prompt)

```
┌─ Agent Settings ───────────────────────────────────┐
│  Info │ LLM │ Prompt │ Heartbeat │ Persona │ ...   │
│                                                     │
│  Heartbeat                                          │
│  ┌───────────────────────────────────────────────┐ │
│  │ Enable Heartbeat          [toggle OFF → ON]   │ │
│  │                                               │ │
│  │ Schedule (cron)                               │ │
│  │ [0 * * * *          ] Every hour             │ │
│  │                                               │ │
│  │ Next run: in 23 minutes                       │ │
│  │ Last run: 37 minutes ago  [View Run →]        │ │
│  └───────────────────────────────────────────────┘ │
│                                                     │
│  Heartbeat Prompt                                   │
│  ┌───────────────────────────────────────────────┐ │
│  │ [Use default ↓] [Custom]                      │ │
│  │                                               │ │
│  │ You are running in heartbeat mode...          │ │
│  │ [textarea — editable kalau Custom]            │ │
│  └───────────────────────────────────────────────┘ │
│                                                     │
│  [Save]                [Trigger Now] (manual run)   │
└─────────────────────────────────────────────────────┘
```

### Run History Page

```
/studio/companies/[company]/projects/[project]/runs

┌─ Run History ──────────────────────────────────────────────────────┐
│                                                                     │
│  [Type ▼] [Agent ▼] [Status ▼]              [Search...]            │
│                                                                     │
│  Type        Agent    Caller    Status      Duration   Started      │
│  ──────────────────────────────────────────────────────────────    │
│  💬 chat     Aria     John      completed   2m 14s     5 min ago   │
│  ⚡ task     Aria     John      running     —          2 min ago   │
│    └ ⚡ task Aria     (inherit) running     —          1 min ago   │  ← child task (indent)
│  🔄 heartbeat Max     —         completed   45s        1 hr ago    │
│  ⚡ task     Max      —         failed      12s        1 hr ago    │
│                                                                     │
│                          < 1 2 3 ... 24 >  [20 per page ▼]        │
└─────────────────────────────────────────────────────────────────────┘
```

Child tasks di-indent di bawah parent-nya (kalau parent ada di halaman yang sama). Kalau tidak ada di halaman yang sama, ada link "spawned by [conv_id]" di detail.

### Run Detail Page (readonly)

```
/studio/companies/[company]/projects/[project]/runs/[conv_id]

┌─ Run Detail ──────────────────────────────── [← Back to Runs] ────┐
│  ⚡ Task · Aria · completed · 2m 14s                               │
│  Goal: "Analyze latest DeFi protocol metrics and summarize"        │
│  Caller: John · Spawned by: [conv_abc →]                          │
│  Started: 14:32:01 · Finished: 14:34:15                           │
│  ──────────────────────────────────────────────────────────────── │
│                                                                     │
│  [ConversationViewer mode="readonly" realtime={false}]             │
│  (sama persis dengan chat UI tapi tidak ada input bar)             │
│                                                                     │
│  Sub-tasks (2)                                                      │
│  ┌─────────────────────────────────────────────────────────────┐  │
│  │ ⚡ task · completed · 45s  "Fetch protocol TVL data"  [→]  │  │
│  │ ⚡ task · completed · 1m3s "Generate summary report"  [→]  │  │
│  └─────────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────────┘
```

---

## 8. Routes

### Server routes baru

```
# Task management
POST   /api/conversations/:id/cancel          → cancel running task/heartbeat
GET    /api/conversations/:id/progress        → get task progress log

# Run history (project-scoped)
GET    /api/projects/:pid/runs                → list all conversations (paginated)
GET    /api/projects/:pid/runs/stats          → summary stats (total per type/status)

# Heartbeat management
POST   /api/agents/:aid/heartbeat/trigger     → manual trigger heartbeat
GET    /api/agents/:aid/heartbeat/status      → next run, last run, enabled
PATCH  /api/agents/:aid/heartbeat             → update heartbeat config
```

### Web routes baru

```
/studio/.../projects/[project]/runs           → Run History page
/studio/.../projects/[project]/runs/[conv_id] → Run Detail page (readonly)
/studio/.../agents/[agent]/heartbeat          → Heartbeat settings tab
```

---

## 9. Implementation Checklist

### @jiku/types

- [ ] Extend `Conversation` type: `type`, `metadata`, `caller_id`, `parent_conversation_id`, `status`, `started_at`, `finished_at`, `error_message`
- [ ] `ConversationType` type alias (`'chat' | 'task' | 'heartbeat' | string`)
- [ ] `TaskMetadata`, `HeartbeatMetadata`, `ChatMetadata` interfaces
- [ ] `ConversationRow` type untuk list queries
- [ ] `ListConversationsParams` + `ListConversationsResult` types
- [ ] Extend `Agent` type: `heartbeat_enabled`, `heartbeat_cron`, `heartbeat_prompt`, `heartbeat_last_run_at`, `heartbeat_next_run_at`

### @jiku-studio/db

- [ ] Migration: extend `conversations` table (type, metadata, caller_id, parent_conversation_id, status, started_at, finished_at, error_message)
- [ ] Migration: extend `agents` table (heartbeat fields)
- [ ] Migration: indexes (project_type, parent, caller, status)
- [ ] `listConversations(params)` — server-side paginated query dengan join agents + users
- [ ] `updateConversation(id, data)` — partial update
- [ ] `appendTaskProgress(convId, entry)` — append ke metadata.progress_log
- [ ] `getConversationWithStats(id)` — include message_count, duration_ms, sub-task count
- [ ] `updateAgentHeartbeat(agentId, config)` query

### apps/studio/server

- [ ] `runTaskConversation(convId, agentId, goal, callerId)` — task runner
- [ ] `buildCaller(callerId)` — build CallerContext dari user_id atau null
- [ ] `buildTaskModePrompt(goal)` — task mode system prompt injection
- [ ] `buildHeartbeatPrompt(agent)` — heartbeat prompt dengan fallback ke default
- [ ] `run_task` built-in tool — register di `RuntimeManager.wakeUp()`
- [ ] `task_complete`, `task_fail`, `task_report_progress` tools — aktif di mode task
- [ ] `HeartbeatScheduler` class
- [ ] Integrate `heartbeatScheduler` ke `RuntimeManager` (wakeUp, syncAgent, shutdown)
- [ ] Routes: `/api/projects/:pid/runs` (list + stats)
- [ ] Routes: `/api/conversations/:id/cancel` + `/progress`
- [ ] Routes: `/api/agents/:aid/heartbeat` (CRUD + manual trigger)
- [ ] SSE untuk task progress (reuse `StreamRegistry` yang sudah ada)

### apps/studio/web

- [ ] `<DataTable>` component (TanStack Table, server-side pagination, toolbar slot)
- [ ] `useServerPagination()` hook — encapsulate page state + TanStack Query fetch
- [ ] Refactor chat page → ekstrak `<ConversationViewer mode="edit|readonly">` component
- [ ] `<ConversationViewer>` props: conversationId, mode, showContextBar, realtime
- [ ] Run History page (`/runs`) — DataTable + filters (type, agent, status) + search
- [ ] Run Detail page (`/runs/[id]`) — header info + ConversationViewer readonly + sub-tasks list
- [ ] Heartbeat tab di agent settings layout
- [ ] `HeartbeatConfig` component — toggle, cron input + human-readable preview, prompt textarea
- [ ] Project sidebar: tambah "Runs" item (antara Chats dan Channels)
- [ ] Status badges component: `chat` (blue), `task` (amber), `heartbeat` (purple), `running` (green pulse), `failed` (red)
- [ ] `<CronInput>` component — input cron expression + preview "next run in X"

---

## 10. Defer ke Plan Berikutnya

- **`task_request_clarification`** — task minta input user saat stuck (butuh notif system)
- **Task queue** — limit concurrent tasks per project (untuk resource management)
- **Heartbeat awareness antar agent** — agent A tahu heartbeat agent B sedang jalan
- **Task cancellation cascade** — cancel parent otomatis cancel semua child tasks
- **Run History filter by caller** — butuh proper user management dulu
- **Cron expression builder UI** (visual) — defer, text input cukup untuk sekarang

---

*Plan 11 — Task Mode, Heartbeat & Run History*  
*Depends on: Plan 8 (Memory), Plan 9 (Persona), Plan 10 (Channels)*  
*Generated: 2026-04-05*