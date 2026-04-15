# Plan 25 — Action Request Center

> **Goal:** Satu **Action Request Center** unified yang jadi gateway untuk:
>
> 1. **Outbound approval** — binding channel bisa di-config "kirim pesan harus lewat approval", outbound agent di-hold di center, admin approve → fallback ke adapter native untuk eksekusi.
> 2. **Agent-initiated request** — agent bisa panggil tool `action_request.create(...)` untuk minta input / pilihan / konfirmasi dari human operator. Response ke agent (sync wait atau async callback).
> 3. **Task checkpoint** — agent di task long-running minta approval sebelum lanjut aksi berisiko. Decision resume task dengan state approval.
>
> **Why unified:** tiga use case di atas secara esensial **sama**: human-in-the-loop gate yang memproduksi decision yang mengalirkan eksekusi lanjutan. Membangun tiga sistem terpisah = waste. Satu center dengan tipe-polymorphic = maintainable, reusable, konsisten untuk operator.
>
> **Non-goals:**
> - Bukan full-fledged workflow engine (temporal/airflow-like). Ini decision queue ringan.
> - Bukan ticketing system (Jira-like). Scope: single decision per request, bukan multi-step.
> - Bukan notification system untuk event-without-decision (itu beda — mungkin future nice-to-have).

---

## 1. Konsep Inti

### Action Request (AR)

Entitas pusat. Setiap AR punya:
- **Type** — menentukan bentuk UI input + bentuk response ke source.
- **Source** — siapa yang create (outbound interceptor, agent tool, task checkpoint).
- **Destination** — kemana decision di-route saat closed (connector_send adapter call, task resume, agent notify, dll).
- **State** — `pending` → salah satu dari `approved` / `rejected` / `answered` / `dropped` / `expired` / `failed`.
- **History** — semua AR tersimpan permanen, termasuk yang `dropped`.

### AR Type

Plugable, polymorphic. MVP ship 4 type:

| Type | UI | Response shape |
|---|---|---|
| `boolean` | Dua tombol (label custom: "Approve/Reject", "Yes/No", "Allow/Deny", default "Approve/Reject") | `{ value: true\|false, label: string }` |
| `choice` | Tombol-tombol (n options, label custom per option) | `{ value: string, label: string }` |
| `input` | Textarea (multi-line) atau input (single-line) free-form, optional placeholder/validation | `{ value: string }` |
| `form` | Multi-field form (array of { name, label, type, required, options? }) | `{ values: Record<string, unknown> }` |

**Setiap AR punya tombol `Drop` terpisah** (bukan tipe response) — ini meta-action yang **tidak mengirim response ke source**, cuma remove AR dari active view + mark history.

### Drop vs Reject

Penting distinction:

- **Reject** (variant dari response `boolean`/`choice`) → decision dikirim ke source. Agent/outbound tahu "ditolak" dan act accordingly (mis. agent skip tindakan, outbound tidak dikirim).
- **Drop** → AR di-cancel tanpa notifikasi source. Source (agent/outbound) akan kena timeout natural atau explicit ignored:
  - Kalau source adalah **outbound_message** → tidak jadi dikirim, tidak ada feedback ke agent yang originate. Persis seperti admin "diem-diem batalkan".
  - Kalau source adalah **agent_tool** yang agent `await`-ing → agent dapat error `{ error: 'dropped', hint: 'Request was dismissed by operator without a decision. Either skip this step or retry with clearer context.' }`.
  - Kalau source adalah **task_checkpoint** → task di-mark `cancelled` dengan reason `dropped_by_operator`.

---

## 2. Data Model

### `action_requests` Table

```sql
CREATE TABLE action_requests (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id            uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  agent_id              uuid REFERENCES agents(id) ON DELETE SET NULL,
  conversation_id       uuid REFERENCES conversations(id) ON DELETE SET NULL,
  task_id               uuid REFERENCES tasks(id) ON DELETE SET NULL,

  -- What + Why
  type                  text NOT NULL CHECK (type IN ('boolean','choice','input','form')),
  title                 text NOT NULL,
  description           text,
  context               jsonb NOT NULL DEFAULT '{}',  -- free-form, shown to operator for decision support
  spec                  jsonb NOT NULL,               -- UI spec: labels, options, validation, etc.

  -- Who + Where decision flows
  source_type           text NOT NULL CHECK (source_type IN ('outbound_message','agent_tool','task_checkpoint','manual')),
  source_ref            jsonb NOT NULL,               -- { kind, id, meta } pointing back to source entity
  destination_type      text CHECK (destination_type IN ('outbound_approval','task','task_resume')),  -- NULL = no side-effect (sync-wait / info-only)
  destination_ref       jsonb,                         -- payload destination needs to resume; NULL when destination_type is NULL

  -- Lifecycle
  status                text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected','answered','dropped','expired','failed')),
  response              jsonb,                         -- filled on approved/rejected/answered
  response_by           uuid REFERENCES users(id) ON DELETE SET NULL,
  response_at           timestamptz,
  expires_at            timestamptz,                   -- NULL = never
  execution_error       text,                          -- if destination execution failed after decision

  created_at            timestamptz NOT NULL DEFAULT NOW(),
  created_by            uuid REFERENCES users(id),     -- null for agent-initiated
  updated_at            timestamptz NOT NULL DEFAULT NOW()
);

CREATE INDEX action_requests_project_status ON action_requests(project_id, status, created_at DESC);
CREATE INDEX action_requests_agent ON action_requests(agent_id, created_at DESC);
CREATE INDEX action_requests_task ON action_requests(task_id) WHERE task_id IS NOT NULL;
CREATE INDEX action_requests_pending_expires ON action_requests(expires_at) WHERE status = 'pending' AND expires_at IS NOT NULL;
```

### `action_request_events` Table (audit-like, append-only)

```sql
CREATE TABLE action_request_events (
  id                    bigserial PRIMARY KEY,
  action_request_id     uuid NOT NULL REFERENCES action_requests(id) ON DELETE CASCADE,
  event_type            text NOT NULL,     -- 'created','viewed','responded','dropped','expired','executed','execution_failed'
  actor_id              uuid REFERENCES users(id),
  actor_type            text,              -- 'user','agent','system'
  metadata              jsonb NOT NULL DEFAULT '{}',
  created_at            timestamptz NOT NULL DEFAULT NOW()
);

CREATE INDEX action_request_events_ar ON action_request_events(action_request_id, created_at);
```

### `spec` Format per Type

```ts
// boolean
{
  approve_label: string           // default 'Approve'
  reject_label: string             // default 'Reject'
  approve_style?: 'primary'|'destructive'|'neutral'
  reject_style?: 'primary'|'destructive'|'neutral'
}

// choice
{
  options: Array<{
    value: string                   // returned to source
    label: string                   // shown on button
    style?: 'primary'|'destructive'|'neutral'
    description?: string            // subtitle
  }>
  multi?: boolean                   // allow multi-select (future)
}

// input
{
  input_kind: 'text'|'textarea'|'password'|'number'|'url'|'email'
  placeholder?: string
  default_value?: string
  min_length?: number
  max_length?: number
  pattern?: string                  // regex
  validation_hint?: string
}

// form
{
  fields: Array<{
    name: string
    label: string
    type: 'text'|'textarea'|'number'|'boolean'|'select'
    required: boolean
    options?: Array<{ value: string; label: string }>  // for select
    default_value?: unknown
    placeholder?: string
  }>
  submit_label?: string              // default 'Submit'
}
```

---

## 3. Source + Destination Model

### `source_ref` Shapes

Identifikasi ASAL AR dibuat — untuk tracing + UI context display.

```ts
// outbound_message
source_ref = {
  kind: 'outbound_message',
  connector_id: string,
  binding_id?: string,
  target: ConnectorTarget,
  content_preview: string,    // truncated text
}

// agent_tool
source_ref = {
  kind: 'agent_tool',
  conversation_id: string,
  message_id: string,         // pesan agent yang panggil tool
  tool_call_id: string,
  agent_id: string,
}

// task_checkpoint
source_ref = {
  kind: 'task_checkpoint',
  task_id: string,
  checkpoint_step?: string,   // optional descriptor
}

// manual (dibuat oleh user/admin via UI — future use case)
source_ref = {
  kind: 'manual',
  created_by: string,
  reason?: string,
}
```

### `destination_type` + `destination_ref` Shapes

Kemana decision di-eksekusi. **Hanya tiga destination type** yang engine eksekusi secara aktif, plus destination optional (null) untuk AR yang sifatnya read-only / sync-wait.

| destination_type | Support types | Triggered on |
|---|---|---|
| `outbound_approval` | **`boolean` only** | `approved` → forward payload ke connector adapter untuk kirim; `rejected` → cancel |
| `task` | All types (`boolean`/`choice`/`input`/`form`) | Any final non-dropped state → spawn task baru dengan prompt utama + response di-inject sebagai context |
| `task_resume` | All types | Any final non-dropped state → resume existing task, inject response ke task conversation |
| *(null / no destination)* | All types | Engine tidak eksekusi side-effect. Response tersimpan di AR, `action_request.wait` subscriber read state lewat pub/sub. Pattern untuk sync-wait dalam conversation aktif atau info-only request. |

```ts
// outbound_approval — hanya boolean, approve → adapter sends
destination_type = 'outbound_approval'
destination_ref = {
  connector_id: string,
  target: ConnectorTarget,
  content: ConnectorContent,  // payload penuh yang ready dikirim kalau approved
}
// Runtime validator: engine REJECT create AR dengan destination=outbound_approval
// dan type != 'boolean'. Error informatif: "outbound_approval only supports boolean".

// task — spawn NEW task with response as prompt context
destination_type = 'task'
destination_ref = {
  agent_id: string,                // agent yang jadi executor task baru
  prompt_template: string,         // prompt utama task, bisa pakai {{response}} / {{response.value}}
  context?: Record<string, unknown>, // additional context merged ke task context
  parent_task_id?: string,          // optional: link sebagai child task
}

// task_resume — resume existing task with decision injected
destination_type = 'task_resume'
destination_ref = {
  task_id: string,
  resume_token: string,            // opaque token task menunggu
}

// (destination null) — no side effect, pure AR
// destination_type = null, destination_ref = null
// Used by agent_tool sync-wait pattern, manual info requests, etc.
```

### Decision → Destination Execution

Saat AR masuk state final non-dropped (`approved`/`rejected`/`answered`), engine eksekusi destination:

```ts
async function executeDestination(ar: ActionRequest): Promise<void> {
  // Always publish to pub/sub so action_request.wait subscribers wake up,
  // regardless of destination_type.
  await publishActionRequestDecision(ar)

  if (ar.destination_type === null) {
    // Pure sync-wait / info-only. No side effect. Decision stored in AR row only.
    return
  }

  if (ar.destination_type === 'outbound_approval') {
    // Type-constraint already validated at create: ar.type === 'boolean'.
    if (ar.response?.value === true) {
      const adapter = await getConnectorAdapter(ar.destination_ref.connector_id)
      await adapter.sendMessage(ar.destination_ref.target, ar.destination_ref.content)
    }
    // value === false → cancel, nothing sent.
    return
  }

  if (ar.destination_type === 'task') {
    const prompt = renderTemplate(ar.destination_ref.prompt_template, { response: ar.response })
    await spawnTask({
      agent_id: ar.destination_ref.agent_id,
      prompt,
      context: { ...(ar.destination_ref.context ?? {}), action_request: ar },
      parent_task_id: ar.destination_ref.parent_task_id,
    })
    return
  }

  if (ar.destination_type === 'task_resume') {
    await resumeTask(ar.destination_ref.task_id, ar.destination_ref.resume_token, {
      decision: ar.status,
      response: ar.response,
    })
    return
  }
}
```

Execution errors → AR marked `failed`, `execution_error` populated. Retry logic per destination type:
- `outbound_approval` → reuse adapter's retry (Telegram `withTelegramRetry`). Flood-wait → queue, eventually retry.
- `task` → best-effort spawn. Kalau gagal, AR `failed` + error; operator bisa retry manual.
- `task_resume` → best-effort, kalau gagal task tetap suspended + AR `failed`.
- *(null destination)* → no execution. Tidak pernah `failed`.

---

## 4. Agent Tools Baru

### `action_request.create`

Agent panggil untuk create AR. Tidak block.

```ts
{
  name: 'action_request.create',
  description: 'Request human input or approval. Creates a pending Action Request visible in the Action Center. Does NOT wait for response — pair with action_request.wait(id) to block until decision, or register a task_checkpoint destination to resume a task.',
  input: {
    type: { enum: ['boolean','choice','input','form'] },
    title: { type: 'string', max: 200 },
    description: { type: 'string', required: false },
    context: { type: 'object', required: false, description: 'Free-form context shown to the operator to help them decide (e.g. the message being sent, the file being deleted, the tool call args).' },
    spec: { type: 'object', description: 'Type-specific UI spec. See docs for shape per type.' },
    expires_in_seconds: { type: 'number', required: false, description: 'Auto-expire if not answered. Default: no expiry.' },
    destination: {
      type: 'object',
      required: false,
      description: 'Where the decision flows. Omit for agent_callback default (pair with action_request.wait).',
    },
  },
  output: { action_request_id: string, status: 'pending' }
}
```

### `action_request.wait`

Agent panggil untuk block sampai AR closed. Long-poll (timeout configurable).

```ts
{
  name: 'action_request.wait',
  description: 'Block until an Action Request is answered/dropped/expired. Long-poll — default timeout 10 minutes. Use this after action_request.create to implement synchronous human-in-the-loop.',
  input: {
    action_request_id: { type: 'string' },
    timeout_seconds: { type: 'number', required: false, default: 600 },
  },
  output: {
    status: 'approved'|'rejected'|'answered'|'dropped'|'expired',
    response: object|null,
    responded_by: string|null,
    responded_at: string|null,
  }
}
```

Implementasi: `action_request.wait` subscribe ke pub/sub channel `ar:{id}`, block sampai message datang atau timeout. Pub dipublish oleh engine saat AR state transition.

### `action_request.list` (read-only, untuk agent awareness)

```ts
{
  name: 'action_request.list',
  description: 'List Action Requests relevant to the current agent or conversation. Read-only — useful for self-monitoring or avoiding duplicate requests.',
  input: {
    status: { type: 'string', required: false },
    limit: { type: 'number', default: 20 },
  },
  output: { items: Array<ActionRequestSummary> }
}
```

---

## 5. Outbound Interceptor (Binding Integration)

### Binding Config Baru

```ts
interface BindingRule {
  // ... existing ...
  outbound_approval: {
    mode: 'none' | 'always' | 'tagged'
    // 'none' = langsung kirim (existing behavior)
    // 'always' = SEMUA outbound lewat AR
    // 'tagged' = cuma yang agent tandai .tag_approval saat panggil connector_send
    default_expires_in_seconds?: number  // default 3600 (1 jam)
    auto_approve_roles?: string[]        // future: role membership auto-approve
  }
}
```

### Interceptor Flow

Saat agent panggil `connector_send(target, content)` dan binding attached punya `outbound_approval.mode !== 'none'`:

```
1. connector_send tool invoked
2. Resolve binding → read outbound_approval config
3. If mode requires approval:
   a. Create AR: type='boolean', source='outbound_message',
      destination='outbound_approval' with full payload,
      spec: {approve_label: 'Send', reject_label: 'Cancel'}
   b. Return to agent: { success: true, queued: true, action_request_id: '...',
      hint: 'Message queued for operator approval. Use action_request.wait(id) to block for decision, or continue with other work.' }
4. If mode = 'none' OR content.skip_approval=true (agent explicit bypass for system msgs):
   → fallback to existing direct send
```

Agent **tidak** disuruh panggil `action_request.create` manually — interceptor otomatis wrap. Agent cuma baca response `queued: true` dan decide mau block (pakai `action_request.wait`) atau lanjut.

### UI Decision Flow (Outbound)

Operator di Action Center lihat card:

```
┌──────────────────────────────────────────────────────┐
│ 📬 Outbound Message Approval                         │
│ Channel: Jiku Agent Grup (Telegram)                  │
│ Agent: Aria · 2 minutes ago                          │
├──────────────────────────────────────────────────────┤
│ Preview:                                             │
│ > Halo builders! Weekly digest kita minggu ini:      │
│ > 1. Topic A terbahas dengan 47 reply...             │
│ > (shows first 500 chars, click to expand full)      │
│                                                      │
│ Context:                                             │
│ • binding: DevCommunity auto-digest                  │
│ • cron: every Monday 09:00                           │
│                                                      │
│ [ ✅ Send ]  [ ❌ Cancel ]    [ ⋯ Drop ]            │
└──────────────────────────────────────────────────────┘
```

Klik **Send** → AR `approved` → engine fallback ke adapter → pesan terkirim, AR event `executed` + `message_id` di metadata.
Klik **Cancel** → AR `rejected` → tidak dikirim. Agent yang `wait()` dapat `{status: rejected}`, tahu harus skip.
Klik **Drop** (di menu `⋯`) → AR `dropped` → tidak dikirim, tidak ada notifikasi ke agent, disappear dari active view tapi masuk history.

---

## 6. Task Checkpoint Integration

### `task_runner` Baru: `requestApproval`

Dalam task runner, agent bisa panggil tool `action_request.create` dengan `destination: { type: 'task_resume', task_id, resume_token }`. Task runner:

1. Agent call → AR created, task state → `waiting_for_action_request`.
2. Task loop **pause** — event-loop non-blocking, runtime disposed sementara.
3. Saat AR state berubah → engine publish `task.resume(task_id, { action_request_id, decision, response })`.
4. Task runner resurrect — context di-restore (scratch, memory, tool state), inject pesan sintetis ke conversation:
   ```
   [System: operator responded to action_request_abc123]
   Decision: approved
   Response: { value: true, label: 'Delete' }
   ```
5. Agent run continue dari titik itu.

Kalau AR `dropped` atau `expired` tanpa decision:
- `dropped` → task marked `cancelled`, reason `operator_dismissed`.
- `expired` → task marked `failed`, reason `checkpoint_timeout`.

Config per task: opsional `max_checkpoints` + `checkpoint_timeout_default`. Task yang stuck berulang akan di-surface ke monitoring.

---

## 7. Agent Usage Patterns

### Pattern 1 — Synchronous Input Request (agent butuh jawaban before continuing)

```
# In agent prompt / tool call
- action_request.create({
    type: 'input',
    title: 'User question needs clarification',
    description: 'User asked to delete "old reports" — which folder exactly?',
    context: { user_message: '...', scanned_folders: ['/reports/2024','/reports/2025'] },
    spec: { input_kind: 'textarea', placeholder: 'Folder path or "cancel"' },
    expires_in_seconds: 1800,
  })
  → { action_request_id: 'ar_xyz', status: 'pending' }

- action_request.wait({ action_request_id: 'ar_xyz', timeout_seconds: 1800 })
  → { status: 'answered', response: { value: '/reports/2024' } }

# Agent now knows what to do.
```

### Pattern 2 — Dangerous Action Guard (boolean approve)

```
- action_request.create({
    type: 'boolean',
    title: 'Confirm deletion',
    description: 'About to delete 147 files in /reports/archive/',
    context: { file_count: 147, total_size_bytes: 89234567, sample_paths: [...] },
    spec: { approve_label: 'Delete 147 files', approve_style: 'destructive', reject_label: 'Cancel' },
    expires_in_seconds: 600,
  })

- action_request.wait(...)
  → { status: 'rejected', response: { value: false, label: 'Cancel' } }

# Agent skip deletion, respond to user "action cancelled by operator"
```

### Pattern 3 — Multi-option Decision

```
- action_request.create({
    type: 'choice',
    title: 'How should I respond to this complaint?',
    context: { complaint_text: '...', customer_tier: 'premium' },
    spec: {
      options: [
        { value: 'refund_full', label: 'Full refund', style: 'primary' },
        { value: 'refund_partial', label: 'Partial refund (50%)' },
        { value: 'replace', label: 'Send replacement' },
        { value: 'escalate', label: 'Escalate to manager', style: 'destructive' },
      ],
    },
  })
```

### Pattern 4 — Background Task Self-Check

```
# Task runs every hour checking inventory
# Agent finds anomaly: stock count dropped 80% in 1 hour
- action_request.create({
    type: 'boolean',
    title: '⚠️ Anomaly detected — auto-reorder?',
    description: 'Stock for SKU-XYZ dropped from 500 to 98 in last hour. Normal variance is ±5%.',
    context: { sku: 'XYZ', current: 98, previous: 500, threshold: 25 },
    spec: { approve_label: 'Auto-reorder', reject_label: 'Hold, investigate' },
    destination: { type: 'task_resume', task_id: '<current_task_id>', resume_token: '<token>' },
  })
# Task suspends here. Later, operator clicks Approve → task resumes with decision.
```

---

## 8. UI Design

### Route `/actions` — Action Request Center

Tabs + filter + realtime list.

```
┌────────────────────────────────────────────────────────────┐
│ Action Center                          [ 3 pending ] [🔔]  │
├────────────────────────────────────────────────────────────┤
│ [ Active (3) ]  [ Recent (127) ]  [ Dropped (8) ]  [All]  │
│                                                            │
│ Filter: [ All types ▾ ] [ All agents ▾ ] [ Search...    ]  │
├────────────────────────────────────────────────────────────┤
│                                                            │
│  ┌─ Card 1 (pending) ────────────────────────────────┐    │
│  │ 📬 Outbound Message · Aria → DevCommunity         │    │
│  │ 2 min ago · expires in 58 min                     │    │
│  │ Preview: "Halo builders..."                       │    │
│  │ [ Send ] [ Cancel ] [ ⋯ ]                         │    │
│  └───────────────────────────────────────────────────┘    │
│                                                            │
│  ┌─ Card 2 (pending) ────────────────────────────────┐    │
│  │ ⚠️ Confirm deletion · Bruno                       │    │
│  │ 5 min ago · 147 files                             │    │
│  │ Click to expand details                           │    │
│  │ [ Delete 147 files ] [ Cancel ] [ ⋯ ]             │    │
│  └───────────────────────────────────────────────────┘    │
│                                                            │
│  ┌─ Card 3 (pending, input type) ────────────────────┐    │
│  │ ❓ Which folder? · Aria                           │    │
│  │ 8 min ago                                         │    │
│  │ [ _____________________________________________ ] │    │
│  │ [ Submit ] [ ⋯ ]                                  │    │
│  └───────────────────────────────────────────────────┘    │
│                                                            │
└────────────────────────────────────────────────────────────┘
```

**`⋯` menu:**
- View details (drawer dengan full context)
- Drop (confirm dialog "This removes the request without notifying the agent")
- View source conversation (deep-link ke chat)

### Badge di Layout

Sidebar / header punya counter badge untuk pending AR. Realtime via SSE.

### Detail Drawer

Expandable untuk lihat full context, history events, dan preview payload lengkap (untuk outbound: full text + entities + media).

### History Tab

Tombol "Dropped" dan "All" untuk audit. Filter by: agent, type, status, date range. Export CSV opsional.

---

## 9. Realtime Updates

- **SSE stream** `/api/projects/:pid/action-requests/stream` → push event `created`, `updated`, `executed`, `expired`.
- **Redis pub/sub** (reuse existing infra) channel `project:{pid}:action_requests` untuk cross-worker sync.
- **Agent `action_request.wait` tool** subscribe channel `ar:{id}` dengan long-poll fallback kalau pub/sub tidak sampai.

Expiry worker: background cron setiap 30 detik scan `pending` dengan `expires_at < NOW()`, transition ke `expired`, publish event.

---

## 10. API Surface

### Server Routes

```
GET    /api/projects/:pid/action-requests                              # list, filter by status/agent/type/date
GET    /api/projects/:pid/action-requests/:id                          # detail
POST   /api/projects/:pid/action-requests                              # create manually (admin)
POST   /api/projects/:pid/action-requests/:id/respond                  # submit decision { response }
POST   /api/projects/:pid/action-requests/:id/drop                     # drop
GET    /api/projects/:pid/action-requests/stream                       # SSE realtime
```

Permission:
- `action_requests:read` — list + detail
- `action_requests:respond` — respond/drop (manager+)
- Agent tool calls lewat internal bypass (pakai agent identity).

### Audit Events

- `action_request.created { ar_id, source_type, type }`
- `action_request.viewed { ar_id, user_id }` (opsional, untuk tracking)
- `action_request.responded { ar_id, response, user_id }`
- `action_request.dropped { ar_id, user_id }`
- `action_request.expired { ar_id }`
- `action_request.executed { ar_id, destination_type, success }`
- `action_request.execution_failed { ar_id, error }`

---

## 11. Implementation Phases

### Phase 1 — Core Data + API
1. Migration `000N_action_requests.sql` (dua tabel + indexes).
2. Types di `@jiku/types`: `ActionRequest`, `ActionRequestSpec`, `ActionRequestType`, `DestinationType`.
3. Service `apps/studio/server/src/action-requests/service.ts`: CRUD, state transitions, execution dispatcher.
4. Routes list/detail/respond/drop/create.
5. Expiry worker cron.
6. Pub/sub wiring (reuse existing Redis).
7. SSE stream endpoint.
8. Audit events.

### Phase 2 — UI
9. Page `/projects/:pid/actions` dengan 3 tab (Active, Recent, Dropped) + filter.
10. Card components per-type (BooleanCard, ChoiceCard, InputCard, FormCard).
11. Detail drawer.
12. Badge di sidebar + SSE hookup.
13. Drop confirm dialog.

### Phase 3 — Agent Tools
14. Tool `action_request.create` (core runner register).
15. Tool `action_request.wait` (long-poll dengan pub/sub subscribe — works for any destination including null).
16. Tool `action_request.list`.
17. Pub/sub publisher: engine publish ke channel `ar:{id}` pada setiap state transition, regardless of destination_type.

### Phase 4 — Outbound Interceptor
18. Binding config `outbound_approval` (mode setting) schema di DB + UI (Settings → Channels → binding edit).
19. Interceptor di `connector_send` tool: kalau mode !== 'none', wrap jadi AR create dengan `destination_type='outbound_approval'` + return `{queued:true, action_request_id}`.
20. `content.skip_approval` explicit bypass (untuk agent emergency system msg — audit heavily).
21. Execution: destination `outbound_approval` → call adapter send on `response.value===true`, update AR. Type-constraint validator enforce `boolean` only saat create.

### Phase 5 — Task Checkpoint
22. Task runner: state `waiting_for_action_request` + persistence.
23. Resume token flow: create → task save state + token → AR closed → resume.
24. Task UI: tampilkan pending checkpoint in task detail page, link ke AR.

### Phase 6 — Polish
25. Expiry notifications: AR `pending` > 50% TTL → soft notify operator via push/email (opt-in).
26. Bulk operations UI: select multiple pending AR → "Approve all" / "Drop all" (with confirm).
27. Agent auto-timeout handling: `action_request.wait` kalau timeout, return structured status `{status:'wait_timeout', ar_still_pending:true}` — agent decide retry wait atau move on.
28. Documentation: `docs/feats/action-request.md` dengan flow diagram + examples.

---

## 12. Acceptance Criteria

- [ ] Migration applied, 2 tabel hadir dengan indexes.
- [ ] Agent bisa panggil `action_request.create({ type: 'boolean' | 'choice' | 'input' | 'form' })` — AR muncul di UI real-time.
- [ ] Agent `action_request.wait` block sampai AR responded/dropped/expired, return proper status.
- [ ] UI Action Center tampilkan 3 tabs, realtime push via SSE, badge counter di sidebar benar.
- [ ] Boolean AR: custom approve_label + reject_label (default Approve/Reject) rendered correctly.
- [ ] Choice AR: n options tombol, pilih satu → response dikirim.
- [ ] Input AR: free-form text kirim value ke source.
- [ ] Form AR: multi-field → values object.
- [ ] Drop button: AR disappear dari active view, source agent dapat error `dropped`, history tab tetap tampilkan.
- [ ] Binding `outbound_approval.mode='always'` → `connector_send` dari agent di-hold sebagai AR dengan `destination_type='outbound_approval'`, muncul di Center; Send button → pesan benar terkirim via adapter; Cancel → tidak dikirim + audit trail.
- [ ] Type-constraint validator: create AR dengan `destination_type='outbound_approval'` dan `type != 'boolean'` → reject dengan error informatif.
- [ ] Destination `task` spawn task baru dengan prompt template + response injected; task muncul di task list terkait AR.
- [ ] Destination `task_resume` resume existing task dengan state restored + decision injected.
- [ ] AR dengan destination null: decision tersimpan, `action_request.wait` subscriber wake up benar, tidak ada side-effect eksekusi.
- [ ] Task checkpoint pattern: task suspend, resume setelah approve, state restored.
- [ ] Expiry worker mark AR `expired` 60s past `expires_at`, publish event.
- [ ] Audit events complete.
- [ ] Permission gating: non-manager cannot respond/drop.

---

## 13. Risks & Mitigations

| Risk | Mitigation |
|---|---|
| Agent bikin terlalu banyak AR (spam operator) | Rate limit per-agent: max 10 AR pending concurrent. Lebih dari itu, tool return error "too many pending requests". Hint: drop or resolve older ones first. |
| Operator overwhelmed → pending pile up | UI sort by urgency (expiring soon first). Bulk-drop button. Digest notification. |
| AR `approved` tapi destination execution gagal (connector down) | State transition ke `failed` + `execution_error`. UI tampilkan "failed" card dengan retry button. Audit critical event. |
| Task state restore setelah resume tidak lengkap | Task runner wajib persist full context (memory snapshot, tool call state, conversation tail) sebelum suspend. Test resume dari cold server restart. |
| Race: AR responded dan expired bersamaan | Transaction lock per AR + state machine strict (pending → final = atomic). Expire check fail kalau status sudah bukan pending. |
| Agent loop: create → wait → drop → create ulang infinitely | Wait loop inherently break karena drop returns error; agent yang retry infinitely akan kena LLM usage cap. Observable via audit. |
| `agent_callback` destination + agent conversation sudah tutup | Publish tetap jalan; nobody subscribed → message dropped. Agent tool timeout natural handle. |
| SSE connection lost → operator miss update | Client fallback: pull refresh setiap 30 detik. Reconnect SSE exponential backoff. |

---

## 14. Out of Scope (Future)

- Escalation chain (timeout → auto-escalate to manager).
- Team-based routing (AR wajib di-handle role X).
- Conditional auto-approve (rule-based skip pending state untuk trusted patterns).
- SLA tracking + reporting dashboard.
- Email/Slack notification integration (pakai channel existing? plugin?).
- Multi-approver consensus (2 of 3 approve).
- Undo after execute (untuk `connector_send` yang sudah terkirim: ada `edit_message` / `delete_message` tool existing, tapi "undo AR decision" sebagai UX construct = future).

---

## 15. Open Questions

1. **Default `expires_in_seconds` untuk outbound approval** — kebanyakan admin mungkin perlu 24 jam (bisnis sehari), sebagian kasus kritis 1 jam. Saran: configurable per binding, default 3600s.

2. **AR untuk outbound di-create oleh siapa `created_by`?** — agent tidak punya `user_id`. Set `created_by = null`, field `source_ref.agent_id` = identitas agent.

3. **Bagaimana kalau operator approve tapi adapter rate-limited (flood_wait)?** — AR stay `approved` tapi execution queued di adapter rate limiter. Pesan terkirim eventually. AR event `execution_delayed` + timestamp final execute.

4. **`action_request.create` tanpa `destination` dan tanpa `wait` = fire-and-forget info request?** — Secara teknis bisa. Tapi ini blur garis dengan "notification system". Cegah? Izinkan? Saran: izinkan, tapi audit khusus + rate limit ekstra.

6. **Destination `task` — agent_id yang jalankan task baru haruskah same-as-creator atau bebas?** — Saran default: agent_id same as creator (AR yang di-create by agent X → destination task default executor agent X). Bebas override via destination_ref.agent_id kalau operator/admin AR. Cegah escalation (agent X create AR yang spawn task oleh agent Y dengan privilege lebih tinggi) dengan policy check: creator agent harus punya permission execute-as-target-agent.

5. **UI badge count inclusive atau scoped?** — Per-project scope, cuma tampilkan yang user punya permission `action_requests:respond`. Non-manager tidak lihat badge.

---

## 16. References

- Scenario yang drive feature ini: `docs/scenarios/1-manage-a-channel-with-agent.md` §9b Nice-to-Have → now promoted ke High priority.
- Plan 22 binding system (trigger rules) — binding config diperluas dengan `outbound_approval`.
- Plan 27 connector custom params — AR destination `connector_send` reuse `ConnectorContent` yang di-build berdasarkan param schema.
- Existing task runner: `apps/studio/server/src/task/runner.ts` — phase 5 perlu extend untuk checkpoint/resume.
- Realtime infra: reuse Redis pub/sub yang sudah dipakai connector event SSE.
