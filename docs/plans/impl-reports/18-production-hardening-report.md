# Plan 18 — Production Hardening — Implementation Report

Date: 2026-04-12
Status: Shipped (pending `bun install` + `db:push` + server restart)

## 1. Rate Limiting

- New middleware: `apps/studio/server/src/middleware/rate-limit.ts`
  - `globalRateLimit` (300/min per user/IP) — applied in `index.ts` on `/api`.
  - `chatRateLimit` (20/min) — applied to `POST /conversations/:id/chat`.
  - `authRateLimit` (10/15min, IP-only) — applied to `/login`, `/register` only (NOT `/me`).
  - `credentialRateLimit` (30/min) — applied via `router.use` in credentials router.
  - `uploadRateLimit` (10/min) — applied to `POST /projects/:pid/files/upload` and `POST /projects/:pid/attachments/upload`.
- Keyed by `res.locals.user_id` (from JWT middleware) with IP fallback.
- Standard `RateLimit-*` headers enabled; 429 responses include `retry_after`.
- Dep added to `apps/studio/server/package.json`: `express-rate-limit ^7.4.1` (needs `bun install`).

## 2. Audit Log

- New DB table `audit_logs` (schema: `apps/studio/db/src/schema/audit_logs.ts`) with indexes on project/company/actor/event.
- Queries: `apps/studio/db/src/queries/audit.ts` — `insertAuditLog`, `listAuditLogs`, `getAuditLog`, `exportAuditLogs`.
- Server helper `apps/studio/server/src/audit/logger.ts`: `audit.*` convenience + `auditContext(req)` extractor; writes are fire-and-forget.
- Coverage integrated:
  - `auth.login` / `auth.login_failed` / `auth.register` — `routes/auth.ts`.
  - `secret.create` / `secret.delete` — `routes/credentials.ts`.
  - `file.write` / `file.delete` — `filesystem/service.ts`.
  - `member.invite` — `routes/acl-invitations.ts`.
  - `member.role_changed` / `member.remove` — `routes/acl-members.ts`.
  - `permission.granted` / `permission.revoked` — `routes/plugin-permissions.ts`.
  - `tool.invoke` / `tool.blocked` — wired via `ToolHooks` in `packages/core` runner + `buildToolHooks(projectId)` in `runtime/manager.ts`.
- Routes: `routes/audit.ts` — `GET /projects/:pid/audit-logs`, `GET /projects/:pid/audit-logs/:id`, `GET /projects/:pid/audit-logs/export` (CSV).
- Settings UI: `settings/audit/page.tsx` — DataTable + filters (event_type, resource_type, client-side search) + detail Sheet with full metadata JSON + Export CSV button. Tab added to settings/layout.tsx.
- Note: the pre-existing plugin-specific `plugin_audit_log` (Plan 17) is left intact for backwards compat. `audit_logs` is the new superset used going forward.

## 3. Plugin Policy Enforcement

- `ToolMeta.required_plugin_permission?: string` added to `@jiku/types`.
- `CallerContext.granted_plugin_permissions?: string[]` and `is_superadmin?: boolean` added.
- New DB table `plugin_granted_permissions` (per-membership, per-plugin, per-permission) with unique constraint on (membership_id, plugin_id, permission).
- Queries in `apps/studio/db/src/queries/plugin_permissions.ts`: `getGrantedPluginPermissions`, `grantPluginPermission`, `revokePluginPermission`, `listProjectPluginPermissions`, `listMemberPluginPermissions`, `replaceMemberPluginPermissions`.
- Enforcement: `packages/core/src/runner.ts` wraps every tool `execute`/`executeStream` with `enforcePermission()` that checks `caller.granted_plugin_permissions` (superadmin bypass) and throws + fires `toolHooks.onBlocked` on deny.
- `RuntimeManager.run()` enriches caller with `getGrantedPluginPermissions(user_id, project_id)` + membership.is_superadmin before dispatch.

## 4. Tool Hot-Unregister

- `JikuRuntime.removeAgent()` already existed; added `getAgentIds()` + `setToolHooks()` for completeness.
- `AgentRunner.setToolHooks()` added.
- `RuntimeManager.activatePlugin()` / `deactivatePlugin()` now call `syncProjectTools(projectId)` so newly added/removed plugin tools propagate to all agents without a server restart.
- `RuntimeManager.unregisterBrowserTools(projectId)` helper added (re-syncs tools after browser engine teardown).

## 5. Plugin Policy UI + API

- Routes: `routes/plugin-permissions.ts` — list project grants, list/replace member grants, grant single, revoke single. All audited via `audit.permissionGranted/Revoked`.
- Web API client: `api.pluginPermissions.*` in `lib/api.ts` with types `PluginPermissionGrant`.
- Settings page: `settings/plugin-permissions/page.tsx` — grants grouped by plugin_id, per-row revoke, grant dialog (member + plugin_id + permission input). Tab added to settings/layout.tsx.

## Migration

- New migration file `0011_plan18_audit_and_permissions.sql` — creates `audit_logs` + `plugin_granted_permissions` with indexes. Apply via `cd apps/studio/db && bun run db:push` (or bun run db:migrate).

## Pending user actions

1. `bun install` at repo root — pulls `express-rate-limit`.
2. `cd apps/studio/db && bun run db:push` — applies 0011 migration.
3. Restart `apps/studio/server` — picks up new middleware chain, tool hooks, plugin-permission enforcement, and new routes.
4. (Optional) Open Studio → Project → Settings → **Audit Log** to confirm events start appearing, and **Plugin Permissions** to grant per-member plugin capabilities.

## Post-ship UX revision — Settings navigation consolidation

Follow-up in same session: the horizontal tab bar on project settings was
replaced with a vertical sidebar (GitHub-style) and access-control pages
were grouped under one section so admins can see all permission-related
configuration in one place without hopping between distant tabs.

- `apps/studio/web/app/(app)/studio/companies/[company]/projects/[project]/settings/layout.tsx`
  rewritten — 220px sidebar + content grid, three groups:
  - **Project** — General, Credentials, MCP Servers
  - **Access Control** — Members, Roles, Agent Access, Policies, Plugin Permissions
  - **Observability** — Audit Log
- Members / Roles / Agent Access stay on `/settings/permissions` but the
  internal `<Tabs>` is now URL-controlled via `?tab=roles` / `?tab=agents`,
  so the sidebar can deep-link and highlight the correct sub-tab.
- Memory and Filesystem configs are **not** in the sidebar — they live on
  their own dedicated `/memory` and `/disk` pages (unchanged).

Policies vs Plugin Permissions distinction, surfaced to admins via
grouping:

| Page                | Axis                        | Nature      |
|---------------------|-----------------------------|-------------|
| Policies            | agent × user × conditions   | Rule engine (runtime) |
| Plugin Permissions  | member × plugin permission  | Capability grant (static) |

## Deferred (per plan §8)

- Message encryption at rest.
- StreamRegistry persistence (Redis).
- WebSocket (SSE still enough).
- Per-project rate limit config (current global-only is acceptable for MVP).
- Audit log retention policy (no auto-purge yet).
