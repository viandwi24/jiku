# Feature: Permission, Role & Policy System

## What it does

Three complementary access control layers, presented together under **Settings → Access Control** (Plan 18 UX consolidation):

1. **Roles & Permissions** (project membership level) — controls which Studio pages and API endpoints a user can access within a project.
2. **Policies & Rules** (agent tool level, runtime) — controls which tools each caller can invoke when chatting with or running an agent, with conditional rules (caller attributes, channel, time, etc.).
3. **Plugin Permissions** (per-member capability grant, Plan 18) — binary grants of plugin-declared capabilities (e.g. `telegram:send_message`), enforced in the core runner before every tool execute against `ToolMeta.required_plugin_permission`.

All three are visible in the settings sidebar under the "Access Control" group. Sub-pages: Members, Roles, Agent Access, Policies, Plugin Permissions.

**Policies vs Plugin Permissions** — these are not duplicates:
- Plugin Permissions = "does this member have the key?" (static capability).
- Policies = "given they have the key, can they use it now, from this channel, on this resource?" (contextual rule).

Both must pass — plugin permission check fires first (in `packages/core/src/runner.ts` before `execute()`), then existing policy rules evaluate as before.

---

## Layer 1: Roles & Permissions

### How it works

Every user who joins a project gets a `project_membership` record. Each membership can have:
- A **role** (which carries a list of permission strings like `chats:read`, `agents:write`)
- **Superadmin** flag (bypasses all permission checks)

When a user hits a backend route, `requirePermission(permission)` middleware resolves the project, loads their membership, and checks if their role's permissions include the required string.

### Permission strings

Format: `resource:action`

| Permission | What it gates |
|-----------|--------------|
| `chats:read` | View conversations |
| `chats:create` | Start new conversations |
| `memory:read` | View memory browser |
| `memory:write` | Add memory entries |
| `memory:delete` | Delete memory |
| `runs:read` | View run history |
| `agents:read` | View agents list and settings |
| `agents:write` | Edit agent settings |
| `agents:create` | Create new agents |
| `agents:delete` | Delete agents |
| `channels:read` | View channels/connectors |
| `channels:write` | Manage connectors and bindings |
| `plugins:read` | View plugins |
| `plugins:write` | Enable/disable/configure plugins |
| `settings:read` | View project settings |
| `settings:write` | Edit project settings |
| `members:read` | View project members |
| `members:write` | Invite/remove members, assign roles |
| `roles:write` | Create, edit, delete roles |
| `cron_tasks:read` / `cron_tasks:write` | View / create+edit cron tasks |
| `skills:read` / `skills:write` | View / create+edit skills |
| `commands:read` / `commands:write` | View / create+edit slash commands |
| `browser:read` / `browser:write` | View / configure browser profiles |
| `disk:read` / `disk:write` | Browse+download / upload+delete+edit project filesystem |
| `usage:read` | View LLM usage metrics |
| `console:read` | View plugin/connector console streams |
| `runs:cancel` | Cancel running task/heartbeat runs (chat cancels are always owner-only — ADR-094) |

### Backend middleware

```typescript
// apps/studio/server/src/middleware/permission.ts

// Middleware factory — use in routes
export function requirePermission(permission: string): RequestHandler

// Resolves project_id from:
//   1. req.params['pid']        (direct project routes)
//   2. req.params['aid']        (agent routes — auto-looks up agent.project_id)
//   3. res.locals['project_id'] (previously resolved)
async function resolveProjectId(req, res): Promise<string | null>

// Example usage
router.get('/projects/:pid/agents', requirePermission('agents:read'), handler)
router.patch('/agents/:aid', requirePermission('agents:write'), handler)
```

### Frontend hooks

**File:** `apps/studio/web/lib/permissions.ts`

```typescript
// By projectId
const { can, isSuperadmin, isMember, isLoading } = useProjectPermission(projectId)

// By company+project slugs (resolves ID internally)
const { can } = useProjectPermissionBySlugs(companySlug, projectSlug)

// can() returns true while loading (optimistic — prevents UI flash)
// can() returns true for superadmin regardless of permission
if (can('agents:write')) { /* show edit button */ }
```

### Frontend guard components

**File:** `apps/studio/web/components/permissions/permission-guard.tsx`

```tsx
// Inline: hide/show a block based on permission
<PermissionGuard projectId={id} permission="agents:write" fallback={<p>No access</p>}>
  <Button>Edit Agent</Button>
</PermissionGuard>

// Page-level: shows "Access Denied" or "Permission Required" UI
<ProjectPageGuard companySlug={company} projectSlug={project} permission="chats:read">
  {children}
</ProjectPageGuard>

// HOC: wraps a page component — reads company+project from params automatically
export default withPermissionGuard(MyPage, 'runs:read')
// Requires: page accepts params: Promise<{ company: string; project: string }>
```

**All project pages are guarded** via `withPermissionGuard`:
- `chats/page.tsx` → `chats:read`
- `runs/page.tsx` → `runs:read`
- `memory/page.tsx` → `memory:read`
- `agents/page.tsx` → `agents:read`
- `plugins/page.tsx` → `plugins:read`
- `channels/page.tsx` → `channels:read`
- `usage/page.tsx` → `settings:read`
- `disk/page.tsx` → `agents:read`
- `browser/page.tsx` → `agents:read`

**Sidebar filtering:** `apps/studio/web/components/sidebar/project-sidebar.tsx`  
Each nav item declares a `permission` string. Items are hidden when user lacks that permission.

### Managing roles (UI)

Location: `settings/permissions/page.tsx` (project settings → Permissions tab)

- **Members tab**: list members, assign/change roles, grant/revoke superadmin, remove members, invite new members
- **Roles tab**: create/edit/delete custom roles with checkbox-based permission editor + preset import

---

## Layer 2: Policies & Rules (Tool-level)

### How it works

Policies define which tools each caller can invoke on an agent. A policy contains one or more rules:

```
Policy: "Marketing Tools"
  Rule 1: resource=jiku.social:delete_post, subject=role:viewer, effect=deny
  Rule 2: resource=jiku.social:create_post, subject=*, effect=allow
```

Rules are evaluated in priority order. If no rule matches, the tool is **allowed by default**.

### Logic

| Rules | Caller | Result |
|-------|--------|--------|
| No rules | anyone | ✅ allow (open by default) |
| `allow` for `role:admin` | caller is `admin` | ✅ allow |
| `allow` for `role:admin` | caller is `member` | ❌ deny (no matching allow) |
| `deny` for `role:viewer` | caller is `viewer` | ❌ deny |
| `deny` for `role:viewer` | caller is `admin` | ✅ allow (rule doesn't match) |
| `permission: '*'` | anyone | ✅ always allow (bypass) |

### Runtime evaluation

```typescript
// packages/core/src/resolver/access.ts
checkAccess(rules, caller): 'allow' | 'deny'

// CallerContext passed to agent runner
interface CallerContext {
  user_id: string
  roles: string[]
  permissions: string[]
  is_superadmin: boolean
}
```

### Reusable policy config component

**File:** `apps/studio/web/components/permissions/agent-policy-config.tsx`

```tsx
// Full mode — agent settings page
<AgentPolicyConfig
  agentId={agentId}
  companyId={companyId}
  projectId={projectId}
/>

// Compact mode — inside accordion (project settings policies page)
<AgentPolicyConfig
  agentId={agentId}
  companyId={companyId}
  projectId={projectId}
  compact
/>
```

Features:
- **Attach existing policy** — from company-level policy library
- **Create & attach** — new policy with optional initial rule
- **Detach policy** — remove from agent (policy itself stays in library)
- **Rule viewer** — expand policy to see/delete individual rules
- **User permission overrides** — each user can self-restrict which tools they allow the agent to use

### Where to configure policies (UI)

1. **Per agent** — `agents/[agent]/permissions/page.tsx` → full policy editor
2. **All agents in one place** — `settings/policies/page.tsx` → accordion per agent, compact editor

---

## Known Limitations

- No role inheritance (role A extends role B)
- Policy rules are exact-match on `resource_id` — no wildcards
- Rules evaluated sequentially by priority — no AND/OR combinations
- No permission audit log yet

## Related Files

- `apps/studio/server/src/middleware/permission.ts` — backend guard middleware
- `apps/studio/web/lib/permissions.ts` — frontend hooks
- `apps/studio/web/components/permissions/permission-guard.tsx` — guard components
- `apps/studio/web/components/permissions/agent-policy-config.tsx` — reusable agent policy editor
- `apps/studio/db/src/queries/acl.ts` — ACL DB queries
- `packages/types/src/index.ts` — PERMISSIONS const, ROLE_PRESETS
- `packages/core/src/resolver/access.ts` — checkAccess() pure function
