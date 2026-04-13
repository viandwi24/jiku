# Cron Tasks Feature

**Last Updated:** 2026-04-13
**Status:** Shipped + revised in Plan 22 (context column, delivery composition, prompt discipline)
**Entry Points:** `apps/studio/server/src/cron/`, `apps/studio/web/app/(app)/studio/companies/[company]/projects/[project]/cron-tasks/`

## Plan 22 revision additions

- **`cron_tasks.context jsonb`** column (migration `0020`) carries `{ origin, delivery, subject, notes }`. Schedule composition lives in `cron/context.ts:composeCronRunInput()` — called by the scheduler at fire time. Stored `prompt` is pure intent; UI prompt edits no longer destroy delivery wiring.
- **`cron_create` tool input** accepts `origin / delivery / subject` as separate structured fields. `cron_update` shallow-merges context (unspecified keys preserved).
- **Scheduler prelude**: fired runs receive `[Cron Trigger]` + `[Cron Origin]` + `[Cron Subject]` + Instruction + `[Cron Delivery]` composed from the stored context. Delivery block references bare tool names (`connector_send(...)`) since built-ins no longer use the `builtin_` prefix (ADR-064).
- **Infinite-loop guard**: `[Cron Trigger]` preamble explicitly states the reminder already exists + forbids treating Instruction as a fresh reminder request. Cron mutation tools (`cron_create/update/delete`) STAY available in cron-fired runs to support conditional / dynamic chains (ADR-063).
- **Soft rails** in `cron_create.execute`: reject prompt < 30 chars or starting with first-person patterns ("Ingatkan saya", "Remind me", etc.) — model gets a crisp rewrite hint.
- **Side-effectful dedup**: `cron_create / cron_update / cron_delete` marked `side_effectful: true` so edit-replay returns cached result instead of double-firing (ADR-060).
- **Admin visibility**: `GET /projects/:pid/cron-tasks` — anyone with `cron_tasks:write` sees the full list (previously non-superadmins saw only own rows).
- **Permission UI group**: Settings → Permissions → "Cron Tasks" (read / write).
- **Backfill migration** `0019` adds `cron_tasks:read/write` to existing `Admin` project_roles whose permissions array was stale.
- **Heartbeat scheduler** now uses croner (`nextRun()`) instead of the broken hand-rolled parser (ADR-066).

## Overview

Cron Tasks allow agents to execute recurring conversations on a schedule. Users define a cron expression (e.g., "Every Monday at 9 AM"), a prompt, and an agent. The system automatically creates and executes conversations at the scheduled times.

## Architecture

```
┌─────────────────────────────────────┐
│      Studio Admin / Agent            │
│  (defines cron tasks via REST API)   │
└──────────────┬──────────────────────┘
               │
               ▼
┌─────────────────────────────────────┐
│    CronTaskScheduler (croner)        │
│  (parses cron expr, registers jobs)  │
└──────────────┬──────────────────────┘
               │
               ▼ (scheduled time)
┌─────────────────────────────────────┐
│      triggerTask(taskId)             │
│  → createTaskConversation()          │
│  → runtime.run(...)                  │
└──────────────┬──────────────────────┘
               │
               ▼
┌─────────────────────────────────────┐
│    Conversation (task mode)          │
│  metadata.cron_task_id               │
│  metadata.trigger: 'cron_task'       │
└─────────────────────────────────────┘
```

## Database Schema

### `cron_tasks` Table

| Column | Type | Notes |
|--------|------|-------|
| id | uuid | Primary key |
| project_id | uuid | Foreign key to projects |
| name | varchar | Human-readable task name |
| description | text | Optional description |
| cron_expression | varchar | CRON syntax (e.g., "0 9 * * 1") |
| agent_id | uuid | Foreign key to agents (target for execution) |
| prompt | text | The prompt/goal for the conversation |
| caller_id | uuid | Snapshotted creator user_id |
| caller_role | varchar | Snapshotted creator role at creation time |
| caller_is_superadmin | boolean | Snapshotted creator superadmin status |
| run_count | int | Number of times executed (auto-incremented) |
| last_run_at | timestamptz | Timestamp of most recent execution |
| created_at | timestamptz | Creation timestamp |
| updated_at | timestamptz | Last modification timestamp |

### `agents` Table Extension

| Column | Type | Notes |
|--------|------|-------|
| cron_task_enabled | boolean | Default true. When false, cron tools not injected |

## Core Queries

**File:** `apps/studio/db/src/queries/cron_tasks.ts`

```ts
// Create a new cron task
createCronTask(projectId, { name, description, cron_expression, agent_id, prompt, caller_id, caller_role, caller_is_superadmin })

// Fetch single task
getCronTaskById(id)

// List all tasks for a project
getCronTasksByProject(projectId)

// List all tasks for an agent
getCronTasksByAgent(agentId)

// Update task (name, description, prompt, cron_expression only — not agent or caller)
updateCronTask(id, updates)

// Delete task
deleteCronTask(id)

// Increment run_count after successful execution
incrementRunCount(id)

// Scheduler: fetch all enabled tasks (cron_task_enabled = true on agent)
getEnabledCronTasks(projectId)
```

## Scheduler: CronTaskScheduler

**File:** `apps/studio/server/src/cron/scheduler.ts`

The `CronTaskScheduler` class manages all scheduled tasks for a project.

### Key Methods

```ts
class CronTaskScheduler {
  // Register a single task with croner
  scheduleTask(taskId: string, cronExpr: string, callback: () => void)

  // Execute a task: create conversation, run agent, increment counter
  triggerTask(taskId: string, projectId: string, runtimeManager: JikuRuntimeManager)

  // Re-schedule a task after modification
  rescheduleTask(taskId: string, cronExpr: string, callback: () => void)

  // Cancel a scheduled task
  stopTask(taskId: string)

  // Cancel all scheduled tasks (called on sleep/shutdown)
  stopAll()

  // Boot: load and schedule all enabled tasks for a project
  loadAndScheduleProject(projectId: string, runtimeManager: JikuRuntimeManager)
}
```

### Integration Points

1. **RuntimeManager.wakeUp()** — Instantiates `CronTaskScheduler` for the project, calls `loadAndScheduleProject()`
2. **RuntimeManager.syncAgent()** — Calls `scheduler.scheduleTask()` for any new cron tasks assigned to that agent
3. **RuntimeManager.stopAll()** — Calls `scheduler.stopAll()` to clean up all scheduled tasks before shutdown

## REST API

**File:** `apps/studio/server/src/routes/cron-tasks.ts`

| Method | Endpoint | Purpose | Auth |
|--------|----------|---------|------|
| GET | `/api/projects/:pid/cron-tasks` | List all cron tasks for project | `cron_tasks:read` |
| POST | `/api/projects/:pid/cron-tasks` | Create new cron task | `cron_tasks:write` |
| GET | `/api/cron-tasks/:id` | Get single cron task | `cron_tasks:read` |
| PATCH | `/api/cron-tasks/:id` | Update cron task | `cron_tasks:write` + ownership/role check |
| DELETE | `/api/cron-tasks/:id` | Delete cron task | `cron_tasks:write` + ownership/role check |
| POST | `/api/cron-tasks/:id/trigger` | Manually trigger task execution | `cron_tasks:write` |

### Security Model

- **Superadmin:** Can create, read, update, delete any task
- **Non-superadmin:** Can only create/update/delete tasks they created, and only if their role hasn't changed since creation
- **Self-protection:** Snapshotted `caller_role` and `caller_is_superadmin` prevent privilege escalation via role changes

## Agent Tools

**File:** `apps/studio/server/src/cron/tools.ts`

Four built-in tools injected into agents (only if `cron_task_enabled = true`):

1. **cron_list** — List all cron tasks in the project
2. **cron_create** — Create a new cron task
3. **cron_update** — Update an existing cron task (name, description, prompt, cron expression)
4. **cron_delete** — Delete a cron task

All tools follow the same permission model as REST API (superadmin-vs-owner, role snapshotting).

## Frontend Components

### CronExpressionInput

**File:** `apps/studio/web/components/cron/cron-expression-input.tsx`

Reusable component for entering and validating cron expressions.

**Props:**
```ts
interface CronExpressionInputProps {
  value: string
  onChange: (value: string) => void
  error?: string
}
```

**Features:**
- Real-time validation using `croner` (server validation) and `cronstrue` (display)
- Shows green checkmark icon for valid expressions
- Shows red error text for invalid expressions
- Displays human-readable description (e.g., "Every Monday at 9:00 AM")

### Pages

| Route | Purpose |
|-------|---------|
| `/cron-tasks` | List page: table view of all cron tasks with enable/edit/delete actions |
| `/cron-tasks/new` | Create page: form with CronExpressionInput, agent selector, prompt textarea |
| `/cron-tasks/:id` | Edit/view page: same form as create, pre-populated with task data |

All pages are nested under the project scope: `/studio/companies/[company]/projects/[project]/cron-tasks/`

### Agent Task Settings

**File:** `apps/studio/web/app/(app)/studio/companies/[company]/projects/[project]/agents/[agent]/task/page.tsx`

Added `cron_task_enabled` toggle on the agent task settings page. When disabled, the agent:
- Still receives cron tools (for agents to self-manage)
- But the scheduler does NOT execute cron tasks for this agent
- Existing scheduled tasks are not deleted, just skipped

## Conversation Metadata

Conversations triggered by a cron task include:

```ts
metadata: {
  cron_task_id: string  // UUID of the triggering cron task
  trigger: 'cron_task'  // Indicates source
  // ... other metadata
}
```

The conversation `type` is set to `'cron'` for easy filtering in reports/analytics.

## Permissions

**File:** `packages/types/src/index.ts`

New permissions added to `PERMISSIONS` const:

- `CRON_TASKS_READ` — List/view cron tasks
- `CRON_TASKS_WRITE` — Create/update/delete cron tasks

Default role permissions:
- **admin** — both read + write
- **manager** — both read + write
- **member** — only read
- **viewer** — no access

## Related Features

- **Task System** (`docs/feats/task-system.md`) — Cron tasks are a specific type of task mode conversation
- **Permission System** (`docs/feats/permission-policy.md`) — Cron tasks respect project-level permissions and ownership
- **Memory System** (`docs/feats/memory-system.md`) — Memory is loaded before cron task execution

## Known Limitations

1. **No timezone support** — Cron expressions are always interpreted in server timezone. Use UTC expressions for consistency.
2. **No pause state** — Tasks are either enabled or deleted. No "pause" state; use `cron_task_enabled = false` on the agent to skip execution without deletion.
3. **No history pagination** — Run history stored in `run_count` and `last_run_at` only. No full audit log of past executions. Retrieve from conversation list filtered by `metadata.cron_task_id`.

## Testing Checklist

- [ ] Create a cron task with valid CRON expression (e.g., "*/5 * * * *" for every 5 minutes)
- [ ] Verify CronExpressionInput shows green checkmark for valid, red error for invalid
- [ ] Verify human-readable description appears below input
- [ ] Create a task and wait for scheduled execution
- [ ] Check that conversation appears in conversation list with `metadata.cron_task_id` and `metadata.trigger: 'cron_task'`
- [ ] Disable `cron_task_enabled` on the agent and verify task does NOT execute
- [ ] Re-enable and verify task resumes execution
- [ ] Verify permission checks: non-superadmin can only modify own tasks
- [ ] Verify role snapshot: demote user from superadmin and verify snapshotted tasks still execute

## Future Enhancements

- Timezone support (parse timezone from cron expression or agent config)
- Task pausing (pause state separate from deletion)
- Execution history dashboard (full audit log per task)
- Rate limiting (prevent too-frequent execution)
- Dynamic prompt injection (pass variables to prompt template at execution time)
