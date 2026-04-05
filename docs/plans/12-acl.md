# Plan 12 — Auth & ACL System

> Status: Planning Done  
> Depends on: Plan 3 (Studio Base — auth JWT sudah ada)  
> Layer: App layer  
> Priority: P1 — wajib sebelum production multi-user

---

## 1. Overview & Goals

Jiku sekarang sudah punya JWT auth dasar. Plan 12 extend menjadi sistem ACL yang proper:

- **Flexible roles** per project — admin buat role sendiri dengan action permissions
- **Superadmin** — role khusus pemilik project, tidak bisa dihapus, bisa di-gift
- **Invite by email** — user diundang ke company, di-assign ke project + role
- **Invite Center** — panel di company untuk lihat dan manage semua invite
- **Agent restriction** — per user, agent mana yang bisa diakses
- **Tool restriction** — per user per agent, tool mana yang diblocked
- **Action-based permissions** — permission sebagai string array di role, extensible tanpa migration

---

## 2. Permission System Design

### Action strings

Semua permissions adalah action strings dengan format `resource:action`:

```typescript
// packages/types/src/permissions.ts

export const PERMISSIONS = {
  // Chat
  CHATS_READ:    'chats:read',      // lihat dan buka conversation
  CHATS_CREATE:  'chats:create',    // mulai conversation baru

  // Memory
  MEMORY_READ:   'memory:read',     // lihat memory browser
  MEMORY_WRITE:  'memory:write',    // tambah memory manual
  MEMORY_DELETE: 'memory:delete',   // hapus memory

  // Runs
  RUNS_READ:     'runs:read',       // lihat run history

  // Agents
  AGENTS_READ:   'agents:read',     // lihat agent list + settings (read)
  AGENTS_WRITE:  'agents:write',    // edit agent settings
  AGENTS_CREATE: 'agents:create',   // buat agent baru
  AGENTS_DELETE: 'agents:delete',   // hapus agent

  // Channels
  CHANNELS_READ:  'channels:read',  // lihat channels
  CHANNELS_WRITE: 'channels:write', // manage connectors + bindings

  // Plugins
  PLUGINS_READ:  'plugins:read',    // lihat plugins
  PLUGINS_WRITE: 'plugins:write',   // enable/disable plugin

  // Project Settings
  SETTINGS_READ:  'settings:read',  // lihat project settings
  SETTINGS_WRITE: 'settings:write', // edit project settings

  // Members & Roles
  MEMBERS_READ:  'members:read',    // lihat member list
  MEMBERS_WRITE: 'members:write',   // invite/remove member, assign role
  ROLES_WRITE:   'roles:write',     // buat/edit/hapus roles

} as const

export type Permission = typeof PERMISSIONS[keyof typeof PERMISSIONS]

// Preset role templates (untuk UX — admin bisa pilih template lalu customize)
export const ROLE_PRESETS = {
  admin: {
    name: 'Admin',
    permissions: Object.values(PERMISSIONS), // semua
  },
  manager: {
    name: 'Manager',
    permissions: [
      'chats:read', 'chats:create',
      'memory:read', 'memory:write',
      'runs:read',
      'agents:read',
      'channels:read',
      'plugins:read',
      'settings:read',
      'members:read',
    ],
  },
  member: {
    name: 'Member',
    permissions: [
      'chats:read', 'chats:create',
      'memory:read',
      'runs:read',
      'agents:read',
    ],
  },
  viewer: {
    name: 'Viewer',
    permissions: [
      'chats:read',
      'runs:read',
      'agents:read',
    ],
  },
} satisfies Record<string, { name: string; permissions: Permission[] }>
```

### Permission check utility

```typescript
// packages/core/src/acl.ts

export function hasPermission(
  userPermissions: Permission[],
  required: Permission,
  isSuperadmin: boolean,
): boolean {
  if (isSuperadmin) return true
  return userPermissions.includes(required)
}

export function hasAnyPermission(
  userPermissions: Permission[],
  required: Permission[],
  isSuperadmin: boolean,
): boolean {
  if (isSuperadmin) return true
  return required.some(p => userPermissions.includes(p))
}

// Resolve effective permissions untuk user di project
export async function resolveUserPermissions(
  userId: string,
  projectId: string,
): Promise<ResolvedPermissions> {
  const membership = await getProjectMembership(userId, projectId)
  if (!membership) return { granted: false, permissions: [], isSuperadmin: false }

  const role = await getRole(membership.role_id)

  return {
    granted: true,
    isSuperadmin: membership.is_superadmin,
    permissions: role?.permissions ?? [],
    agentRestrictions: membership.agent_restrictions,  // { agent_id: boolean }
    toolRestrictions: membership.tool_restrictions,    // { agent_id: { tool_name: boolean } }
  }
}

export interface ResolvedPermissions {
  granted: boolean
  isSuperadmin: boolean
  permissions: Permission[]
  agentRestrictions: Record<string, boolean>         // false = blocked
  toolRestrictions: Record<string, Record<string, boolean>>  // false = blocked
}
```

---

## 3. DB Schema

### 3.1 Companies — extend

```sql
-- Sudah ada, tidak perlu perubahan besar
-- Tambah: owner_id untuk track siapa yang buat
ALTER TABLE companies
  ADD COLUMN owner_id uuid REFERENCES users(id);
```

### 3.2 `project_roles` — custom roles per project

```sql
CREATE TABLE project_roles (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id  uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name        text NOT NULL,                    -- 'Admin', 'CEO', 'Karyawan', dll
  description text,
  permissions text[] NOT NULL DEFAULT '{}',    -- ['chats:read', 'memory:read', ...]
  is_default  boolean NOT NULL DEFAULT false,  -- role default untuk invited user
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),

  UNIQUE (project_id, name)
);

CREATE INDEX idx_roles_project ON project_roles(project_id);
```

### 3.3 `project_memberships` — user di project

```sql
CREATE TABLE project_memberships (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id     uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  user_id        uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role_id        uuid REFERENCES project_roles(id) ON DELETE SET NULL,

  -- Superadmin flag
  is_superadmin  boolean NOT NULL DEFAULT false,

  -- Agent-level restriction (override per user)
  -- { "agent_uuid": true/false } → false = blocked
  agent_restrictions  jsonb NOT NULL DEFAULT '{}',

  -- Tool-level restriction (override per user per agent)
  -- { "agent_uuid": { "tool_name": false } }
  tool_restrictions   jsonb NOT NULL DEFAULT '{}',

  joined_at      timestamptz NOT NULL DEFAULT now(),

  UNIQUE (project_id, user_id)
);

CREATE INDEX idx_memberships_project ON project_memberships(project_id);
CREATE INDEX idx_memberships_user    ON project_memberships(user_id);
```

### 3.4 `company_memberships` — user di company

```sql
CREATE TABLE company_memberships (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id  uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  is_owner    boolean NOT NULL DEFAULT false,   -- company owner
  joined_at   timestamptz NOT NULL DEFAULT now(),

  UNIQUE (company_id, user_id)
);

CREATE INDEX idx_company_memberships_company ON company_memberships(company_id);
CREATE INDEX idx_company_memberships_user    ON company_memberships(user_id);
```

### 3.5 `invitations` — invite system

```sql
CREATE TABLE invitations (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id  uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,

  -- Target: siapa yang diundang
  email       text NOT NULL,

  -- Project access yang diberikan saat invite diterima
  -- [{ project_id, role_id }]
  project_grants jsonb NOT NULL DEFAULT '[]',

  -- Status
  status      text NOT NULL DEFAULT 'pending'
                CHECK (status IN ('pending', 'accepted', 'declined', 'expired', 'cancelled')),

  -- Invited by
  invited_by  uuid NOT NULL REFERENCES users(id),

  -- Expiry
  expires_at  timestamptz NOT NULL DEFAULT (now() + interval '7 days'),

  -- Kalau sudah diterima
  accepted_by uuid REFERENCES users(id),
  accepted_at timestamptz,

  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_invitations_company ON invitations(company_id);
CREATE INDEX idx_invitations_email   ON invitations(email, status);
```

### 3.6 Superadmin transfer log

```sql
CREATE TABLE superadmin_transfers (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id    uuid NOT NULL REFERENCES projects(id),
  from_user_id  uuid NOT NULL REFERENCES users(id),
  to_user_id    uuid NOT NULL REFERENCES users(id),
  transferred_at timestamptz NOT NULL DEFAULT now()
);
```

---

## 4. Invite Flow

### Flow lengkap

```
Admin buka Invite Center di company
  → Input email + pilih project(s) + pilih role per project
  → System cek: apakah email sudah punya akun Jiku?
    
    Kalau sudah punya akun:
      → Buat invitation record (status: pending)
      → Kirim email notifikasi: "Kamu diundang ke Company X"
      → User buka Invite Center di dashboard mereka
      → User terima → system buat company_membership + project_membership(s)
      → Invite status → accepted

    Kalau belum punya akun:
      → Buat invitation record (status: pending)
      → Kirim email dengan link register
      → User register → otomatis proses invite → masuk company + project
```

### Invite Center — dua sisi

**Sisi Admin (di Company settings):**
```
/studio/companies/[company]/settings/invitations

Pending Invites:
  john@example.com  → Project A (Admin), Project B (Member)  [Cancel]
  jane@example.com  → Project A (Viewer)                     [Cancel]

Sent History:
  bob@example.com   → accepted 2 days ago
  alice@example.com → expired
```

**Sisi User (di dashboard):**
```
/studio/invitations  ← global, tidak per company

Pending Invitations:
  ┌─ Acme Corp ──────────────────────────────────────┐
  │  Invited by: John Doe                             │
  │  Access: Project Alpha (Admin), Project Beta (Member) │
  │  Expires: in 5 days                              │
  │  [Accept]  [Decline]                             │
  └──────────────────────────────────────────────────┘
```

---

## 5. Superadmin Rules

```
- Setiap project punya minimal 1 superadmin (yang buat project)
- Superadmin bisa di-gift ke user lain yang sudah jadi member project
- Gift superadmin = user lain JUGA jadi superadmin (bukan transfer, additive)
- Superadmin tidak bisa dihapus permissionnya via role
- Superadmin tetap bisa di-restrict di level agent (self-imposed, dia yang set)
- Superadmin bisa remove superadmin status dari user lain
- Tidak ada limit jumlah superadmin per project
```

### Gift superadmin flow

```
Superadmin buka project settings → Members
  → Klik user → "Grant Superadmin"
  → Konfirmasi dialog
  → Update is_superadmin = true
  → Log ke superadmin_transfers
```

---

## 6. Agent & Tool Restriction

### Di mana dikonfigurasi?

**Agent restriction** — di agent settings → tab "Permissions":

```
┌─ Agent: Aria — Permissions ──────────────────────┐
│                                                    │
│  Default access                                    │
│  ○ All members with agents:read permission        │
│  ● Specific members only                          │
│                                                    │
│  Allowed members:                                  │
│  ┌──────────────────────────────────────────────┐ │
│  │ John Doe (superadmin)  always allowed        │ │
│  │ Jane Smith             [Remove]              │ │
│  │ [+ Add member]                               │ │
│  └──────────────────────────────────────────────┘ │
│                                                    │
│  Tool restrictions per member                      │
│  ┌──────────────────────────────────────────────┐ │
│  │ Jane Smith                                   │ │
│  │   memory_delete    [✓ Allow] [✗ Block]       │ │
│  │   connector_send   [✓ Allow] [✗ Block]       │ │
│  └──────────────────────────────────────────────┘ │
└────────────────────────────────────────────────────┘
```

### Cara simpan di DB

```typescript
// Di project_memberships.agent_restrictions
{
  "agent-uuid-aria": false,    // blocked dari agent Aria
  "agent-uuid-max": true,      // explicitly allowed (atau tidak ada key = follow default)
}

// Di project_memberships.tool_restrictions
{
  "agent-uuid-aria": {
    "memory_delete": false,    // tool ini diblocked untuk user ini di agent ini
    "connector_send": false,
  }
}
```

### Permission check di runtime.run()

```typescript
// Di CallerContext — sudah ada di Plan 3
// Extend dengan resolved permissions

interface CallerContext {
  user_id: string | null
  roles: string[]
  permissions: Permission[]         // dari role
  is_superadmin: boolean
  agent_restrictions: Record<string, boolean>
  tool_restrictions: Record<string, Record<string, boolean>>
  user_data?: Record<string, unknown>
}

// Di AgentRunner — filter tools berdasarkan caller
function filterToolsForCaller(
  tools: Tool[],
  agentId: string,
  caller: CallerContext,
): Tool[] {
  if (caller.is_superadmin) return tools  // superadmin dapat semua

  const agentAllowed = caller.agent_restrictions[agentId] ?? true  // default allow
  if (!agentAllowed) throw new ForbiddenError('Access to this agent is restricted')

  const blockedTools = caller.tool_restrictions[agentId] ?? {}

  return tools.filter(tool => {
    const toolAllowed = blockedTools[tool.name] ?? true  // default allow
    return toolAllowed
  })
}
```

---

## 7. Middleware — Server-side Auth Guards

```typescript
// apps/studio/server/src/middleware/auth.ts

// Sudah ada: verifyJWT middleware
// Tambah: permission check middleware

export function requirePermission(permission: Permission) {
  return async (req: Request, res: Response, next: NextFunction) => {
    const { userId, projectId } = req

    const resolved = await resolveUserPermissions(userId, projectId)

    if (!resolved.granted) {
      return res.status(403).json({ error: 'Not a member of this project' })
    }

    if (!hasPermission(resolved.permissions, permission, resolved.isSuperadmin)) {
      return res.status(403).json({ error: `Missing permission: ${permission}` })
    }

    req.resolvedPermissions = resolved
    next()
  }
}

// Usage di routes:
router.get('/api/memories', requirePermission('memory:read'), memoryHandler)
router.delete('/api/memories/:id', requirePermission('memory:delete'), deleteMemoryHandler)
router.post('/api/agents', requirePermission('agents:create'), createAgentHandler)
```

---

## 8. Frontend — Permission-aware UI

### `usePermissions()` hook

```typescript
// apps/studio/web/hooks/use-permissions.ts

export function usePermissions() {
  const { data } = useQuery({
    queryKey: ['permissions', projectId],
    queryFn: () => api.auth.getMyPermissions(projectId),
    staleTime: 60_000,
  })

  return {
    isSuperadmin: data?.is_superadmin ?? false,
    can: (permission: Permission) => {
      if (data?.is_superadmin) return true
      return data?.permissions.includes(permission) ?? false
    },
    canAccessAgent: (agentId: string) => {
      if (data?.is_superadmin) return true
      return data?.agent_restrictions[agentId] ?? true
    },
  }
}

// Usage:
const { can, canAccessAgent } = usePermissions()

// Di sidebar — hide menu kalau tidak punya permission
{can('memory:read') && <SidebarItem href="/memory">Memory</SidebarItem>}

// Di agent list — grey out agent yang tidak bisa diakses
{agents.map(agent => (
  <AgentCard
    key={agent.id}
    agent={agent}
    disabled={!canAccessAgent(agent.id)}
  />
))}

// Di tombol — disable kalau tidak punya permission
<Button
  disabled={!can('agents:write')}
  onClick={handleSave}
>
  Save
</Button>
```

---

## 9. Routes

### Auth routes (extend yang sudah ada)

```
GET  /api/auth/me                          → user profile + company list
GET  /api/auth/invitations                 → list pending invitations untuk user ini
POST /api/auth/invitations/:id/accept      → terima invite
POST /api/auth/invitations/:id/decline     → tolak invite
```

### Company routes

```
GET    /api/companies/:cid/members                  → list members
DELETE /api/companies/:cid/members/:uid             → remove member dari company

GET    /api/companies/:cid/invitations              → list invitations (admin only)
POST   /api/companies/:cid/invitations              → kirim invite baru
DELETE /api/companies/:cid/invitations/:iid         → cancel invite
```

### Project roles routes

```
GET    /api/projects/:pid/roles              → list roles
POST   /api/projects/:pid/roles              → buat role baru
PATCH  /api/projects/:pid/roles/:rid         → update role (name, permissions)
DELETE /api/projects/:pid/roles/:rid         → hapus role
```

### Project members routes

```
GET    /api/projects/:pid/members                       → list members + role
PATCH  /api/projects/:pid/members/:uid/role             → ganti role user
PATCH  /api/projects/:pid/members/:uid/superadmin       → grant/revoke superadmin
PATCH  /api/projects/:pid/members/:uid/agent-restrictions  → update agent restrictions
PATCH  /api/projects/:pid/members/:uid/tool-restrictions   → update tool restrictions
DELETE /api/projects/:pid/members/:uid                  → remove dari project

GET    /api/projects/:pid/members/me/permissions        → resolved permissions untuk current user
```

---

## 10. UI

### Route structure baru

```
/studio/
  invitations/                          → Global invite center (user lihat pending invites)

/studio/companies/[company]/
  settings/
    members/page.tsx                    → Company members list
    invitations/page.tsx                → Invite center (admin kirim + lihat history)

/studio/companies/[company]/projects/[project]/
  settings/
    members/page.tsx                    → Project members + roles
    roles/page.tsx                      → Manage roles
    roles/new/page.tsx                  → Buat role baru
    roles/[role]/page.tsx               → Edit role + permissions

/studio/companies/[company]/projects/[project]/agents/[agent]/
  permissions/page.tsx                  → Agent access + tool restrictions (selesaikan stub)
```

### Project Members Page

```
┌─ Project Members ──────────────────────────────────┐
│  [+ Invite Member]                                  │
│                                                     │
│  Name          Role        Superadmin   Actions     │
│  ──────────────────────────────────────────────    │
│  John Doe      —           ★ Owner      [...]       │
│  Jane Smith    Manager     —            [Edit] [Remove] │
│  Bob Wilson    Member      —            [Edit] [Remove] │
└─────────────────────────────────────────────────────┘
```

### Roles Page

```
┌─ Roles ────────────────────────────────────────────┐
│  [+ New Role]   [Import preset ▼]                  │
│                                                     │
│  Manager  ·  8 permissions  ·  2 members  [Edit]   │
│  Member   ·  3 permissions  ·  5 members  [Edit]   │
│  Viewer   ·  1 permission   ·  1 member   [Edit]   │
└─────────────────────────────────────────────────────┘
```

### Role Editor

```
┌─ Edit Role: Manager ───────────────────────────────┐
│  Name: [Manager              ]                      │
│  Description: [Can manage most features...]         │
│  Default role: [ ] (auto-assign ke invited user)   │
│                                                     │
│  Permissions                                        │
│  ┌───────────────────────────────────────────────┐ │
│  │ Chats                                         │ │
│  │   [✓] chats:read    [✓] chats:create          │ │
│  │                                               │ │
│  │ Memory                                        │ │
│  │   [✓] memory:read   [✓] memory:write          │ │
│  │   [ ] memory:delete                           │ │
│  │                                               │ │
│  │ Agents                                        │ │
│  │   [✓] agents:read   [ ] agents:write          │ │
│  │   [ ] agents:create [ ] agents:delete         │ │
│  │                                               │ │
│  │ ... (semua permission groups)                 │ │
│  └───────────────────────────────────────────────┘ │
│                                                     │
│  [Save]  [Delete Role]                             │
└─────────────────────────────────────────────────────┘
```

### Invite Dialog

```
┌─ Invite Member ────────────────────────────────────┐
│  Email                                              │
│  [john@example.com                    ]            │
│                                                     │
│  Project Access                                     │
│  ┌───────────────────────────────────────────────┐ │
│  │ [✓] Project Alpha    Role: [Manager      ▼]   │ │
│  │ [ ] Project Beta     Role: [Member       ▼]   │ │
│  │ [ ] Project Gamma    Role: [Viewer       ▼]   │ │
│  └───────────────────────────────────────────────┘ │
│                                                     │
│  [Send Invite]                                     │
└─────────────────────────────────────────────────────┘
```

### Global Invite Center (user dashboard)

```
/studio/invitations

┌─ Pending Invitations ──────────────────────────────┐
│                                                     │
│  ┌─ Acme Corp ──────────────────────────────────┐  │
│  │  Invited by John Doe · expires in 5 days     │  │
│  │  Access:                                     │  │
│  │    Project Alpha → Manager                   │  │
│  │    Project Beta  → Member                    │  │
│  │  [Accept]  [Decline]                         │  │
│  └──────────────────────────────────────────────┘  │
│                                                     │
│  No more pending invitations                        │
└─────────────────────────────────────────────────────┘
```

---

## 11. Implementation Checklist

### @jiku/types

- [ ] `Permission` type + `PERMISSIONS` const
- [ ] `ROLE_PRESETS` const
- [ ] `ResolvedPermissions` interface
- [ ] Extend `CallerContext`: `permissions`, `is_superadmin`, `agent_restrictions`, `tool_restrictions`
- [ ] `ProjectRole`, `ProjectMembership`, `CompanyMembership`, `Invitation` types

### @jiku/core

- [ ] `hasPermission()`, `hasAnyPermission()` utilities
- [ ] `resolveUserPermissions()` (dipanggil di server)
- [ ] `filterToolsForCaller()` — filter tools berdasarkan tool_restrictions
- [ ] Integrate `filterToolsForCaller()` di `AgentRunner.run()`

### @jiku-studio/db

- [ ] Migration: `project_roles` table
- [ ] Migration: `project_memberships` table
- [ ] Migration: `company_memberships` table
- [ ] Migration: `invitations` table
- [ ] Migration: `superadmin_transfers` table
- [ ] Migration: `companies.owner_id` kolom
- [ ] Drizzle schema semua tabel baru
- [ ] `createRole`, `updateRole`, `deleteRole`, `listRoles` queries
- [ ] `getProjectMembership`, `createMembership`, `updateMembership`, `removeMembership` queries
- [ ] `listProjectMembers` — join users + roles
- [ ] `createInvitation`, `listInvitations`, `getInvitationByEmail`, `updateInvitationStatus` queries
- [ ] `resolveUserPermissions()` — DB query version (join memberships + roles)
- [ ] Seed: auto-create superadmin membership saat project dibuat

### apps/studio/server

- [ ] `requirePermission(permission)` middleware
- [ ] `requireSuperadmin()` middleware
- [ ] Extend `buildCallerContext()` — include resolved permissions
- [ ] Email service: `sendInvitationEmail(email, invitationId, companyName, inviterName)`
- [ ] Invitation accept flow: buat memberships dari `project_grants`
- [ ] Auto-create company + project membership saat user buat company/project pertama kali
- [ ] Routes: `/api/auth/invitations` (list, accept, decline)
- [ ] Routes: `/api/companies/:cid/members` + `/invitations`
- [ ] Routes: `/api/projects/:pid/roles` (CRUD)
- [ ] Routes: `/api/projects/:pid/members` (list, edit role, restrictions, remove)
- [ ] Routes: `/api/projects/:pid/members/me/permissions`
- [ ] Apply `requirePermission()` ke semua existing routes yang perlu

### apps/studio/web

- [ ] `usePermissions()` hook
- [ ] Permission-aware sidebar — hide items kalau tidak punya permission
- [ ] Route: `/studio/invitations` — global invite center
- [ ] Route: `/studio/.../settings/members` — company members
- [ ] Route: `/studio/.../settings/invitations` — invite center (admin)
- [ ] Route: `/studio/.../settings/members` — project members
- [ ] Route: `/studio/.../settings/roles` — roles list
- [ ] Route: `/studio/.../settings/roles/[role]` — role editor dengan permission checkboxes
- [ ] `InviteDialog` component — email + project grants
- [ ] `RoleEditor` component — permission checkboxes grouped by resource
- [ ] `MemberRow` component — role badge, superadmin star, actions
- [ ] Selesaikan stub `agents/[agent]/permissions/page.tsx` — agent access + tool restrictions
- [ ] Disable/hide UI elements berdasarkan permissions (`can()` dari `usePermissions()`)
- [ ] Redirect ke `/unauthorized` kalau akses halaman tanpa permission

---

## 12. Defer ke Plan Berikutnya

- **Role inheritance** — role A extends role B
- **Permission audit log** — siapa yang ubah permission kapan
- **Bulk invite** — invite multiple email sekaligus
- **Plugin Policy Extension** — plugin bisa define + validate custom policy rules sendiri (Plan tersendiri)

---

*Plan 12 — Auth & ACL System*  
*Depends on: Plan 3 (Studio Base)*  
*Generated: 2026-04-05*