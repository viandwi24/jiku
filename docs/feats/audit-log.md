# Audit Log (Plan 18)

## What it does

Structured, queryable log of sensitive actions across Studio. Captures who did what, to which resource, when, from which IP, and with what metadata — for incident response, compliance evidence, and debugging unexpected state changes.

Replaces the old "just tail server logs" approach for anything security-relevant.

## Event types covered

`tool.invoke`, `tool.blocked`, `file.write`, `file.delete`, `file.read`,
`secret.get`, `secret.create`, `secret.delete`,
`auth.login`, `auth.logout`, `auth.login_failed`, `auth.register`,
`member.invite`, `member.remove`, `member.role_changed`,
`permission.granted`, `permission.revoked`,
`plugin.activated`, `plugin.deactivated`,
`agent.created`, `agent.deleted`.

## Writing an event

From a route handler:

```ts
import { audit, auditContext } from '../audit/logger.ts'

audit.secretCreate({ ...auditContext(req), project_id: projectId }, cred.id, cred.name)
```

From non-HTTP code (e.g. a service class), construct `AuditContext` manually — `{ actor_id, actor_type, project_id, ... }`. Writes are fire-and-forget; do not `await` them.

To capture tool invocations, do NOT instrument individual tools. The core runner's `ToolHooks` already fires `onInvoke` / `onBlocked` / `onError` per tool call — `RuntimeManager.buildToolHooks(projectId)` wires Studio's audit helper into every runtime.

## Reading / UI

Admin-facing page: **Settings → Observability → Audit Log** (`/settings/audit`).

Features: filter by event type + resource type, client-side search across visible rows, detail drawer with full metadata JSON, CSV export (streams all matches up to 10k rows).

## Public API

- `GET /api/projects/:pid/audit-logs?event_type=&actor_id=&resource_type=&from=&to=&page=&per_page=` — paginated list, requires `settings:read`.
- `GET /api/projects/:pid/audit-logs/:id` — single entry detail.
- `GET /api/projects/:pid/audit-logs/export?…` — CSV download (uses same filters).

## Known limitations

- Fire-and-forget writes: under extreme DB pressure a few entries may be lost. Acceptable — correctness of user action > completeness of audit trail.
- No retention policy yet. Table will grow indefinitely. Deferred until operational concern (add a nightly prune job or time-based partitioning).
- Legacy `plugin_audit_log` table still exists and is still written to by `routes/plugin-ui.ts`. Its reader (plugin-ui's internal audit endpoint) is separate from the `audit_logs` UI.

## Related files

- `apps/studio/db/src/schema/audit_logs.ts`
- `apps/studio/db/src/queries/audit.ts`
- `apps/studio/db/src/migrations/0011_plan18_audit_and_permissions.sql`
- `apps/studio/server/src/audit/logger.ts`
- `apps/studio/server/src/routes/audit.ts`
- `apps/studio/web/app/(app)/studio/companies/[company]/projects/[project]/settings/audit/page.tsx`
- `packages/core/src/runner.ts` (ToolHooks firing points)
- `apps/studio/server/src/runtime/manager.ts` (`buildToolHooks`)
