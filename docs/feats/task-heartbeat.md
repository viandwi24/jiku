# Feature: Task Mode, Heartbeat & Run History (Plan 11)

## What it does

- **Task Mode** — agents spawn `task` conversations via `run_task` tool. Runs autonomously without waiting for user input. Can be background (detached) or awaited with timeout.
- **Heartbeat** — per-agent scheduled autonomous run. Agent "wakes up" periodically, evaluates, optionally spawns tasks. Conversations of type `heartbeat`.
- **Run History** — paginated table of all conversations across all types. View-only with ConversationViewer (readonly mode).

## Conversation Types

All runs use the `conversations` table, differentiated by `type`:
- `chat` — interactive user conversation (default)
- `task` — autonomous agent task (spawned by agent or system)
- `heartbeat` — scheduled autonomous run

Additional columns added to `conversations`:
- `type`, `metadata jsonb`, `run_status`, `caller_id`, `parent_conversation_id`
- `started_at`, `finished_at`, `error_message`

## Task Spawning

`run_task` tool is always active in `chat` and `task` modes. When called:
1. `spawnTask()` creates a new `task` conversation with `parent_conversation_id` pointing to caller
2. `runTaskConversation()` executes the task via `runtimeManager.run()`
3. Returns task conversation ID + status

Task lifecycle tools (`task_complete`, `task_fail`) are active only inside task conversations.

## Heartbeat Scheduler

`HeartbeatScheduler` (`apps/studio/server/src/task/heartbeat.ts`):
- setTimeout-based, per-agent scheduling
- `scheduleAgent(agentId, nextRunAt)` — registers next heartbeat
- `triggerHeartbeat(agentId)` — fires immediately
- `rescheduleAgent(agentId)` — recalculates next run from cron expression
- `stopAll()` — clears all pending timeouts on server shutdown
- Integrated into `RuntimeManager.wakeUp()` / `syncAgent()` / `stopAll()`

Heartbeat config stored on `agents` table: `heartbeat_enabled`, `heartbeat_cron`, `heartbeat_prompt`, `heartbeat_last_run_at`, `heartbeat_next_run_at`.

## Run History UI

- `apps/studio/web/app/.../runs/page.tsx` — server-side paginated table. Filters by type/status.
- `apps/studio/web/app/.../runs/[conv]/page.tsx` — run detail with `ConversationViewer mode="readonly"` — same context/tools/memory preview as chat.
- "Runs" nav item in project sidebar.

## API Routes

```
GET  /api/projects/:pid/runs          → paginated run history (type/status filter)
POST /api/conversations/:id/cancel    → cancel running conversation
GET  /api/agents/:aid/heartbeat       → get heartbeat config
PATCH /api/agents/:aid/heartbeat      → update config
POST /api/agents/:aid/heartbeat/trigger → manual trigger
```

## Related Files

- `apps/studio/server/src/task/runner.ts` — runTaskConversation, spawnTask
- `apps/studio/server/src/task/tools.ts` — run_task, task_complete, task_fail tools
- `apps/studio/server/src/task/heartbeat.ts` — HeartbeatScheduler
- `apps/studio/server/src/routes/runs.ts`, `routes/heartbeat.ts`
- `apps/studio/web/app/.../runs/page.tsx`, `runs/[conv]/page.tsx`
- `apps/studio/web/app/.../agents/[agent]/heartbeat/page.tsx`
