## Phase
Plans 1–14 all implemented. Route security audit complete. Agent visibility feature complete.

## Currently Working On
- Idle / no active task.

## Relevant Files (Most Recently Worked On)

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


### Browser Automation (Plan 13)
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

## Next Up
- DB migration: `cd apps/studio/db && bun run db:push` — applies Plan 12 schema (project_roles, project_memberships, invitations, superadmin_transfers)
- Plan 12 nice-to-have: `usePermissions()` hook for sidebar permission-gating
- Verify Telegram bot end-to-end: send message → typing indicator → get_datetime tool call
