## Phase
Idle / next backlog item. Plan 33 (Browser rebuild + unified attachment system)
fully shipped on 2026-04-09 — see the impl report at
`docs/plans/impl-reports/13-browser-implement-report.md`.

## Currently Working On
- _(nothing active)_ — Plan 33 closed end-to-end. Pick the next item from
  `docs/builder/tasks.md`.

## Plan 33 — Browser Rebuild — DONE (2026-04-09)

Final state of the browser feature after the full session arc:

- **Engine:** `packages/browser/` — CLI bridge to Vercel `agent-browser` over
  CDP, plus Docker container (Chromium + Xvfb + Fluxbox + noVNC + socat).
  Container entrypoint hardened with `--no-sandbox`, dbus, CDP readiness
  probe, per-process logs in `/var/log/jiku-browser/*.log`, and `exec
  websockify` as PID 1 for clean SIGTERM propagation.
- **Studio integration:** `apps/studio/server/src/browser/` — flat `z.object`
  tool schema (33 actions: navigation/observation/interaction/wait/tabs/eval/
  cookies/storage/batch). The mapper in `execute.ts` validates per-action
  field requirements via `need()` and rebuilds nested `tab`/`cookies`
  operations before calling `execBrowserCommand`. Screenshots persist via
  `persistContentToAttachment()` (Plan 33 unified attachments) by default,
  configurable via `screenshot_as_attachment` per project.
- **Config:** CDP-only — `cdp_url`, `timeout_ms`, `evaluate_enabled`,
  `screenshot_as_attachment`. All Plan 13 fields (`mode`, `headless`,
  `executable_path`, `control_port`, `no_sandbox`) dropped from DB + web
  types + UI.
- **REST API:** `GET/PATCH /projects/:pid/browser`, `PATCH .../enabled`,
  `PATCH .../config`, `POST .../ping`, `POST .../preview`. The `preview`
  endpoint takes a one-shot screenshot (+ best-effort title/url) and returns
  it inline, never persisted — used by the Live Preview box in the UI.
- **Settings page:** rewritten as a single CDP-only page with a Live Preview
  box (16:9, manual Refresh + 3s auto-refresh toggle, title/url overlay,
  loading/empty/error states, concurrent-request guard).
- **Critical fix during the session:** the schema was first rewritten as a
  `z.discriminatedUnion`, which serializes to `anyOf` at the JSON Schema root
  and broke OpenAI function calling with `Invalid schema for function
  'builtin_browser': ... got 'type: "None"'`. Replaced with a flat `z.object`
  + runtime `need()` validation. Memory updated to prevent regression.
- **Plan 13 cleanup:** deleted `apps/studio/server/docker-compose.browser.yml`,
  `apps/studio/server/browser-init/chromium-cdp.sh`, and
  `infra/dokploy/Dockerfile.browser`. All ~80 OpenClaw engine files removed
  earlier in the session.

See `docs/plans/impl-reports/13-browser-implement-report.md` for the full
breakdown.

## Relevant Files (Most Recently Worked On)

### Cron Task System (2026-04-07 — complete implementation)
- `apps/studio/db/src/schema/cron_tasks.ts` — New `cron_tasks` table schema
- `apps/studio/db/src/schema/agents.ts` — Added `cron_task_enabled: boolean DEFAULT true`
- `apps/studio/db/src/migrations/0004_add_cron_tasks.sql` — Migration for both tables
- `apps/studio/db/src/queries/cron_tasks.ts` — CRUD queries (create, get, list, update, delete, increment run count, get enabled)
- `apps/studio/server/src/cron/scheduler.ts` — `CronTaskScheduler` class (croner-based)
- `apps/studio/server/src/cron/tools.ts` — Four cron tools (build functions for list/create/update/delete)
- `apps/studio/server/src/routes/cron-tasks.ts` — 6 REST endpoints (list, create, get, update, delete, trigger)
- `apps/studio/web/lib/api.ts` — `CronTask` interface + `api.cronTasks.*` methods
- `apps/studio/web/components/cron/cron-expression-input.tsx` — Realtime cron preview component (cronstrue)
- `apps/studio/web/app/(app)/studio/companies/[company]/projects/[project]/cron-tasks/page.tsx` — List page
- `apps/studio/web/app/(app)/studio/companies/[company]/projects/[project]/cron-tasks/new/page.tsx` — Create page
- `apps/studio/web/app/(app)/studio/companies/[company]/projects/[project]/cron-tasks/[id]/page.tsx` — Edit/view page
- `apps/studio/web/app/(app)/studio/companies/[company]/projects/[project]/agents/[agent]/task/page.tsx` — Added `cron_task_enabled` toggle

### Usage Monitor Enhancement (previous session)
- `apps/studio/web/lib/usage.ts` — Added `aggregateByDay()`, `aggregateByAgent()`, `estimateTotalCost()` helpers
- `apps/studio/web/components/usage/usage-charts.tsx` — New: `TokenUsageAreaChart` (stacked area) and `AgentUsageBarChart` (horizontal bar)
- `apps/studio/web/app/(app)/studio/companies/[company]/projects/[project]/agents/[agent]/usage/page.tsx` — Stats 3→5 cards, area chart added
- `apps/studio/web/app/(app)/studio/companies/[company]/projects/[project]/usage/page.tsx` — Stats 3→5 cards, 2-column chart grid (filter-aware)
- `apps/studio/web/app/(app)/studio/companies/[company]/projects/[project]/page.tsx` — Activity card now shows real total token count

## Relevant Files (Most Recently Worked On)

### Connector Tools Enhancement (this session - 2026-04-08)
- `apps/studio/server/src/connectors/tools.ts` — Added `connector_list` tool for agent to discover connector IDs
  - Lists all connectors in project with status, returns: `{ id, plugin_id, display_name, status }`
  - Agent workflow: call `connector_list()` → find connector by display_name → use UUID in `connector_send()`
- `docs/builder/memory.md` — Added gotcha: "Connector tools: always call connector_list first"

### Conversation Management (previous session)
- `apps/studio/server/src/title/generate.ts` — Auto-generates conversation title using agent's LLM (max 50 chars, fire-and-forget)
- `apps/studio/server/src/routes/chat.ts` — Hook to trigger title generation after first message
- `apps/studio/server/src/routes/conversations.ts` — Added `PATCH /conversations/:id/title` for manual title updates, `DELETE /conversations/:id` for soft delete
- `apps/studio/db/src/schema/conversations.ts` — Added `deleted_at timestamp` column for soft delete
- `apps/studio/db/src/queries/conversation.ts` — Added `softDeleteConversation()` function, updated `getConversationsByProject` to filter deleted conversations
- `apps/studio/db/src/migrations/0003_add_conversation_deleted_at.sql` — Migration for deleted_at column
- `apps/studio/web/lib/api.ts` — Added `api.conversations.rename(convId, title)` and `api.conversations.delete(convId)`
- `apps/studio/web/components/chat/conversation-viewer.tsx` — Added inline title edit (click pencil icon, Enter/blur to save, Escape to cancel), removed Avatar component
- `apps/studio/web/components/chat/conversation-list-panel.tsx` — Updated to show title as primary text + agent name as secondary, added delete trash icon with AlertDialog confirm
- `apps/studio/web/app/(app)/studio/companies/[company]/projects/[project]/settings/general/page.tsx` — Replaced native `confirm()` with `AlertDialog` for delete project

## Previous Sessions

### Plan 12: Route Security Audit + Agent Visibility (completed this session)
- `apps/studio/server/src/middleware/permission.ts` — `loadPerms` now exported
- `apps/studio/server/src/routes/memory.ts` — inline loadPerms guard on DELETE
- `apps/studio/server/src/routes/connectors.ts` — `requireConnectorPermission` factory, all 16 connector routes guarded
- `apps/studio/server/src/routes/credentials.ts` — `checkCredentialPermission` helper, project-scoped creds guarded
- `apps/studio/server/src/routes/preview.ts` — guarded with requirePermission / inline loadPerms
- `apps/studio/server/src/routes/conversations.ts` — inline loadPerms guard on GET routes
- `apps/studio/server/src/routes/runs.ts` — inline loadPerms guard on GET + cancel
- `apps/studio/server/src/routes/attachments.ts` — requirePermission on all 4 attachment endpoints
- `apps/studio/server/src/routes/projects.ts` — requirePermission on PATCH + usage
- `apps/studio/server/src/routes/policies.ts` — requireCompanyMember / requirePolicyCompanyMember
- `apps/studio/server/src/routes/agents.ts` — agent visibility filtering by agentRestrictions
- `apps/studio/web/components/permissions/agent-visibility-config.tsx` — new reusable visibility component
- `apps/studio/web/app/.../settings/permissions/page.tsx` — added "Agent Access" tab
- `apps/studio/web/app/.../agents/[agent]/permissions/page.tsx` — AgentVisibilityConfig at top

### Task System Enhancements (completed previous session)
- `apps/studio/db/src/schema/agents.ts` — added `task_allowed_agents text[]|null` column
- `apps/studio/server/src/task/tools.ts` — added `buildListAgentsTool()`, delegation permission check in `run_task`
- `apps/studio/server/src/task/heartbeat.ts` — guard: skip schedule/trigger if task mode not in `allowed_modes`
- `apps/studio/server/src/runtime/manager.ts` — injects `listAgentsTool` alongside `runTaskTool` in all 3 registration paths
- `packages/core/src/runner.ts` — `serializeToolSchema()` converts Zod → JSON Schema for preview API response
- `apps/studio/web/lib/api.ts` — added `task_allowed_agents` to `Agent` interface
- `apps/studio/web/app/.../agents/[agent]/tools/page.tsx` — tools list only (delegation moved out)
- `apps/studio/web/app/.../agents/[agent]/task/page.tsx` — new page: task delegation config
- `apps/studio/web/app/.../agents/[agent]/layout.tsx` — added "task" nav item
- `apps/studio/web/app/.../agents/[agent]/memory/page.tsx` — fixed desync bug: useEffect replaces initialized flag


### Browser Automation (Plan 13) — ⚠️ FAILED IMPLEMENTATION
- Code exists but is **marked as failed** — does not meet planning requirements
- Root cause: browser tool runs a headless Playwright instance (new process), NOT the visible Chromium at localhost:4000 (noVNC / LinuxServer container). CDP init script (`chromium-cdp.sh`) does not run, so remote attach mode silently falls back to headless. User sees no browser activity in the noVNC viewer.
- **Will be removed before MVP release** — see backlog task and ADR-026
- `apps/studio/server/src/browser/` — OpenClaw browser engine (ported), tool-schema.ts, routes/browser.ts
- `apps/studio/web/app/.../browser/page.tsx` — browser settings page
- `apps/studio/server/src/runtime/manager.ts` — injects browser tools at wakeUp() if browser_enabled

### Filesystem (Plan 14)
- `apps/studio/db/src/schema/filesystem.ts` — `project_filesystem_config` + `project_files` tables
- `apps/studio/server/src/filesystem/service.ts` — FilesystemService (list/read/write/move/delete)
- `apps/studio/server/src/filesystem/adapter.ts` — S3FilesystemAdapter (S3/RustFS)
- `apps/studio/server/src/filesystem/tools.ts` — fs_list, fs_read, fs_write, fs_move, fs_delete, fs_search
- `apps/studio/web/app/.../disk/page.tsx` — file manager UI
- `apps/studio/web/app/.../settings/filesystem/page.tsx` — filesystem config settings

### Chat Attachments (added alongside Plan 14)
- `apps/studio/db/src/schema/attachments.ts` — `project_attachments` table for chat image uploads
- `apps/studio/server/src/routes/chat.ts` — attachment upload/serve endpoints
- `apps/studio/web/components/ui/image-gallery.tsx` — fullscreen image gallery preview with minimap/navigation
- `apps/studio/web/components/chat/conversation-viewer.tsx` — renders attachment images, wires gallery preview

## Important Context / Temporary Decisions
- DB tool part format: `{ type: 'tool-invocation', toolInvocationId, toolName, args, state: 'result', result }` — DB storage format.
- UI tool part format (AI SDK v6): `{ type: 'dynamic-tool', toolCallId, toolName, state: 'output-available', input, output }` — convert via `dbPartsToUIParts()` in `apps/studio/web/lib/messages.ts`.
- Filesystem route is `/disk` (not `/files`) — UI page lives at `disk/page.tsx`.
- S3 adapter uses `forcePathStyle: true` — required for RustFS/MinIO compatibility.
- Content cache: files ≤ 50 KB stored in `content_cache` column (avoids round-trip to S3).
- Browser engine is ported OpenClaw code in `apps/studio/server/src/browser/browser/` — ~80 files. Entry point is `browser/server.ts`.
- Attachments are ephemeral (per-conversation) — separate from project_files (persistent virtual disk).
- Image gallery: click image in chat → fullscreen overlay with prev/next nav + minimap strip. Click outside to close.
- ConnectorPlugin uses module-level `_registerFn` ref — contributes() runs before setup().
- Zod v3.25.76 standardized across all workspace packages (hoisted via root package.json).

### Skills (Plan 15 + filesystem migration)
- `apps/studio/db/src/schema/skills.ts` — `project_skills` + `agent_skills` only (no `project_skill_files`)
- `apps/studio/db/src/queries/skills.ts` — CRUD + assignment queries (file queries removed)
- `apps/studio/db/src/migrations/0001_unique_wong.sql` — updated (no `project_skill_files` table)
- `apps/studio/server/src/skills/service.ts` — SkillService using FilesystemService; `skillFsPath()` helper
- `apps/studio/server/src/skills/tools.ts` — `buildSkillTools(agentId, projectId)` using filesystem
- `apps/studio/server/src/routes/skills.ts` — CRUD + assignments; creates/deletes skill folder on filesystem
- `apps/studio/server/src/runtime/manager.ts` — `buildSkillTools(a.id, projectId)` in all 3 paths
- `apps/studio/web/components/filesystem/file-explorer.tsx` — NEW reusable component with `rootPath` prop
- `apps/studio/web/app/.../disk/page.tsx` — uses FileExplorer component (extracted)
- `apps/studio/web/app/.../skills/page.tsx` — FileExplorer scoped to `/skills/{slug}/`
- `apps/studio/web/lib/api.ts` — removed SkillFileItem + file methods from api.skills

## Important Context / Temporary Decisions
- Skills files stored at `/skills/{slug}/` in the project filesystem (not in DB)
- `project_skill_files` table eliminated — filesystem is the source of truth
- `FileExplorer` component at `components/filesystem/file-explorer.tsx` — accepts `rootPath` to restrict navigation
- Creating a skill auto-seeds `/skills/{slug}/index.md` if filesystem is configured
- Deleting a skill calls `fs.deleteFolder('/skills/{slug}')` to clean up files

## Next Up
- Run `bun run db:push` to apply all pending migrations including `0004_add_cron_tasks.sql`
- Test cron tasks end-to-end: create task → add agent → enable cron_task_enabled → verify cron execution
- Test CronExpressionInput preview: valid expressions show green, invalid show red
- Resume previous backlog tasks
