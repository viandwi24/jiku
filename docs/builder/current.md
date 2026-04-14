## Phase (2026-04-14) — Plan 28: Telegram streaming outbound — SHIPPED (with revisions)

Event-router no longer drains the agent stream before touching Telegram. New optional `ConnectorAdapter.handleResolvedEvent(ctx)` hook — event-router resolves binding/identity/conversation, builds context + @file hint, then hands off a `ResolvedEventContext` with injected service callables. Telegram adapter consumes stream natively: `⌛` placeholder immediately → debounced 700ms edits → tool chunks `[🔧]` → `[☑️]` / `[❌]` → 4000-char overflow split → final MarkdownV2 with plain fallback. Stream teed back to host for SSE observers (chat web unaffected). See ADR-087. Backward compat: adapters without the hook use the legacy path.

### Post-ship revisions (same day)

1. **`message is not modified` no-op guard** — for responses with no MarkdownV2-escapable characters, the final edit rendered identical content to what the interim edit already landed. Telegram compares rendered output and returns 400. Now detected by description substring match and treated as success, not warning.
2. **Interleaved segment render** — replaced fixed-header tool list (all tools at top) with chronological `segments[]` model: consecutive text-delta appends to current text segment; consecutive tool-calls stack under current tool group; transition between types inserts `---` separator. Final MarkdownV2 render wraps tool lines in italic (`_[☑️] tool_name_`) with escaped tool names + escaped `\-\-\-` separators. Plain interim edits keep literal `---`. Matches natural narrative flow: "bot said X → ran tool Y → said Z".
3. **`ConnectorParamSpec`** extended with `'array' | 'object'` types and wider `example` value types (linter-applied user tweak) — supports more nuanced platform params going forward.

Follow-up: queue drain path (ack_queue mode dequeue) still uses legacy fake typing-sim — wire it through `handleResolvedEvent` when it becomes worth the refactor.

## Phase (2026-04-14) — Scenario 1 production prep: Commands + @file + FS permission + connector params — BACKEND SHIPPED

Driving the `docs/scenarios/1-manage-a-channel-with-agent.md` test tomorrow. All four high-priority gaps identified in §9 of the scenario are now implemented end-to-end on the backend; Commands UI shipped; FS-permission UI delegation in progress.

1. **§9.A Commands system (Plan 24)** — user-triggered `/slash` FS-first, mirrors SkillLoader architecture. New tables `project_commands`, `agent_commands`, column `agents.command_access_mode`. Core parser + registry, studio `CommandLoader`, dispatcher wired into chat route, task/cron/heartbeat runner. Routes + audit + UI (project + per-agent allow-list) live.
2. **§9.B @file reference hint (Plan 25)** — `src/references/hint.ts` scanner + injector. Inject `<user_references>` with size/mtime/large flag for every `@path` that resolves on disk. Wired in chat / task / connector inbound. Cap 20 per invocation.
3. **§9.C FS tool permission (Plan 26)** — `tool_permission` metadata on `project_files` + `project_folders`, resolver with parent-walk inheritance, gate in `fs_write`/`fs_edit`/`fs_append`/`fs_move`/`fs_delete`, routes + audit. UI delegation queued.
4. **§9.D Connector params + hint (Plan 27)** — `getParamSchema()` on `ConnectorAdapter`, `params` pass-through on `ConnectorContent`, Telegram declares 7 params (reply_to_message_id, parse_mode, disable_web_page_preview, message_thread_id, protect_content, disable_notification, allow_sending_without_reply). `connector_list` emits per-connector `param_schema` so agents self-discover.

## Deploy checklist for tomorrow
- Apply migrations `0030_plan24_commands.sql` + `0031_plan26_fs_tool_permission.sql` before server start.
- For the marketing scenario: create `/commands/marketing-channel-execute/COMMAND.md` + `/plans/marketing-channel.md` on the disk; PATCH `/reports/` folder permission to `read` so agent cannot overwrite ground-truth data during self-improve loop.
- Telegram agents should rely on `connector_list` output to read `param_schema` — no prompt changes needed, tool description already points at it.

## Relevant files
- Backend wiring: `apps/studio/server/src/commands/{loader,dispatcher}.ts`, `apps/studio/server/src/references/hint.ts`, `apps/studio/server/src/filesystem/tools.ts`, `apps/studio/server/src/connectors/tools.ts`.
- Telegram schema: `plugins/jiku.telegram/src/index.ts` — `getParamSchema()` override near `sendMessage`.
- Migrations: `apps/studio/db/src/migrations/0030_plan24_commands.sql`, `0031_plan26_fs_tool_permission.sql`.
- Scenario source: `docs/scenarios/1-manage-a-channel-with-agent.md`.

## Next up
- FS permission file-explorer context-menu UI (subagent in flight).
- Once subagent reports, run `bun run typecheck` in `apps/studio/server` + `apps/studio/web` to catch any regressions before the production test.
- Seed demo data for scenario test: a sample `/commands/marketing-channel-execute/COMMAND.md` + `/plans/marketing-channel.md` so the cron-driven marketing loop can be exercised end-to-end.
