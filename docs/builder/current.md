## Phase
Usage monitor enhancement — charts, total tokens, estimated cost.

## Currently Working On
- Completed: usage monitor enhancement across agent usage page, project usage page, and project dashboard.

## Relevant Files (Most Recently Worked On)

### Usage Monitor Enhancement (this session)
- `apps/studio/web/lib/usage.ts` — Added `aggregateByDay()`, `aggregateByAgent()`, `estimateTotalCost()` helpers
- `apps/studio/web/components/usage/usage-charts.tsx` — New: `TokenUsageAreaChart` (stacked area) and `AgentUsageBarChart` (horizontal bar)
- `apps/studio/web/app/(app)/studio/companies/[company]/projects/[project]/agents/[agent]/usage/page.tsx` — Stats 3→5 cards, area chart added
- `apps/studio/web/app/(app)/studio/companies/[company]/projects/[project]/usage/page.tsx` — Stats 3→5 cards, 2-column chart grid (filter-aware)
- `apps/studio/web/app/(app)/studio/companies/[company]/projects/[project]/page.tsx` — Activity card now shows real total token count

## Relevant Files (Most Recently Worked On)

### Conversation Management (this session)
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
- Run `bun run db:push` to apply `0003_add_conversation_deleted_at.sql` migration
- Test: create conversation → first message should trigger title generation and appear in sidebar
- Test: click conversation title in header to edit inline
- Test: click trash icon in sidebar to soft-delete conversation with AlertDialog confirm
- Resume previous backlog tasks
