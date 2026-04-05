## Phase
Plan 11 complete — Task Mode, Heartbeat & Run History

## Currently Working On
- Plan 11 implemented. Run `bun run db:push` to apply schema changes before testing.

## Relevant Files
- `apps/studio/db/src/schema/conversations.ts` — extended with type, metadata, run_status, caller_id, parent_conversation_id, started_at, finished_at
- `apps/studio/db/src/schema/agents.ts` — extended with heartbeat_* fields
- `apps/studio/db/src/queries/conversation.ts` — new: createTaskConversation, listRunsByProject
- `apps/studio/server/src/task/runner.ts` — runTaskConversation, spawnTask
- `apps/studio/server/src/task/tools.ts` — buildRunTaskTool, buildTaskLifecycleTools
- `apps/studio/server/src/task/heartbeat.ts` — HeartbeatScheduler, heartbeatScheduler singleton
- `apps/studio/server/src/routes/runs.ts` — GET /projects/:pid/runs, POST /conversations/:id/cancel
- `apps/studio/server/src/routes/heartbeat.ts` — GET/PATCH /agents/:aid/heartbeat, POST trigger
- `apps/studio/web/app/.../runs/page.tsx` — Run History page
- `apps/studio/web/app/.../runs/[conv]/page.tsx` — Run Detail page
- `apps/studio/web/app/.../agents/[agent]/heartbeat/page.tsx` — Heartbeat settings tab

## Important Context / Temporary Decisions
- Connector system uses in-memory rate limiting (not Redis) — sufficient for single-server.
- SSE auth uses token as query param (EventSource doesn't support custom headers).
- HeartbeatScheduler uses setTimeout (not a real cron library) — simplified 5-field cron parsing. Sufficient for hourly/daily schedules. Upgrade to a cron library if sub-minute schedules are needed.
- run_task tool injected via built_in_tools in wakeUp/syncAgent. The tool's caller context getter is a stub — the real caller is inherited at call time via the tool execute context.
- Conversations schema: `user_id` is now nullable (heartbeat/task convs have no user).

## Next Up
- Run `bun run db:push` to apply schema changes (conversations + agents tables)
- Test: trigger a heartbeat manually, view in Runs page
- Plan 12 or backlog items
