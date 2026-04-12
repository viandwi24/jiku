# Plan 18 — Production Hardening

> Status: Planning Done  
> Depends on: Plan 12 (Auth & ACL), Plan 17 (Plugin Marketplace)  
> Layer: App layer  
> Goal: Menutup gap production-readiness yang teridentifikasi dari audit 2026-04-12

---

## 1. Overview

Plan 18 adalah **finishing sprint** — menutup 5 item yang sudah partial atau belum ada sama sekali berdasarkan hasil audit:

1. **Rate Limiting** — global middleware + per-route override
2. **Plugin Policy Enforcement** — wire `granted_permissions` di tool invoke
3. **Audit Log Completion** — tambah coverage + UI di studio
4. **Tool Hot-Unregister** — granular remove tanpa restart
5. **Plugin Policy UI** — manage granted_permissions di studio

Tidak ada fitur baru besar — ini semua **wiring, enforcement, dan UI** untuk infrastruktur yang sudah ada.

---

## 2. Rate Limiting

### Strategy

Pakai `express-rate-limit` dengan 3 layer:

```
Layer 1: Global default     — semua route, limit longgar
Layer 2: Per-route override — route sensitif punya limit ketat
Layer 3: Per-user/IP        — identifier dari JWT kalau ada, fallback ke IP
```

### Config

```typescript
// apps/studio/server/src/middleware/rate-limit.ts

import rateLimit from 'express-rate-limit'

// Layer 1 — Global default
export const globalRateLimit = rateLimit({
  windowMs: 60 * 1000,        // 1 menit
  max: 300,                    // 200 req/menit per IP
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  keyGenerator: (req) => {
    // Pakai user_id dari JWT kalau ada, fallback ke IP
    return req.user?.id ?? req.ip ?? 'anonymous'
  },
  handler: (req, res) => {
    res.status(429).json({
      error: 'Too many requests',
      retry_after: Math.ceil(req.rateLimit.resetTime.getTime() / 1000),
    })
  },
})

// Layer 2 — Chat endpoint (paling mahal, hit LLM)
export const chatRateLimit = rateLimit({
  windowMs: 60 * 1000,
  max: 20,                     // 20 chat req/menit per user
  keyGenerator: (req) => req.user?.id ?? req.ip ?? 'anonymous',
  handler: (req, res) => {
    res.status(429).json({ error: 'Chat rate limit exceeded. Please wait before sending another message.' })
  },
})

// Layer 3 — Auth endpoints (brute force protection) ini khusus buat auth login yah, kala auth me jangan soalnya auth me kepake buat fetching profile kan
export const authRateLimit = rateLimit({
  windowMs: 15 * 60 * 1000,   // 15 menit
  max: 10,                     // 10 attempt per 15 menit
  keyGenerator: (req) => req.ip ?? 'anonymous',
  handler: (req, res) => {
    res.status(429).json({ error: 'Too many authentication attempts. Please try again later.' })
  },
})

// Layer 4 — Credentials / secret endpoints
export const credentialRateLimit = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  keyGenerator: (req) => req.user?.id ?? req.ip ?? 'anonymous',
})

// Layer 5 — File upload
export const uploadRateLimit = rateLimit({
  windowMs: 60 * 1000,
  max: 10,                     // 10 upload/menit
  keyGenerator: (req) => req.user?.id ?? req.ip ?? 'anonymous',
})
```

### Apply di server

```typescript
// apps/studio/server/src/index.ts

// Global — semua route
app.use(globalRateLimit)

// Per-route overrides
app.post('/api/conversations/:id/chat', chatRateLimit, chatHandler)
app.post('/api/auth/login', authRateLimit, loginHandler)
app.post('/api/auth/register', authRateLimit, registerHandler)
app.post('/api/credentials', credentialRateLimit, createCredentialHandler)
app.get('/api/credentials/:id/reveal', credentialRateLimit, revealHandler)
app.post('/api/projects/:pid/files/upload', uploadRateLimit, uploadHandler)
```

### Rate limit headers

Client dapat headers standard:
```
RateLimit-Limit: 20
RateLimit-Remaining: 15
RateLimit-Reset: 1712345678
Retry-After: 45  (hanya kalau 429)
```

---

## 3. Plugin Policy Enforcement

### Context

Kolom `granted_permissions` sudah ada di DB (manifest plugin). Yang belum: enforcement di tool invoke — siapa yang boleh invoke tool dari plugin tertentu belum dicek.

### Enforcement point

```typescript
// apps/studio/server/src/runtime/tool-invoker.ts

export async function invokeToolWithPolicyCheck(
  toolId: string,
  args: unknown,
  caller: CallerContext,
  projectId: string,
): Promise<unknown> {

  // 1. Resolve tool definition
  const tool = ToolRegistry.get(toolId)
  if (!tool) throw new NotFoundError(`Tool not found: ${toolId}`)

  // 2. Cek apakah tool punya required plugin permission
  const requiredPermission = tool.meta?.required_plugin_permission
  if (requiredPermission) {

    // 3. Load granted permissions untuk caller di project ini
    const granted = await getGrantedPluginPermissions(caller.user_id, projectId)

    // 4. Superadmin bypass
    if (!caller.is_superadmin && !granted.includes(requiredPermission)) {
      throw new ForbiddenError(
        `Permission '${requiredPermission}' required to use tool '${toolId}'`
      )
    }
  }

  // 5. Existing policy check (sudah ada sebelumnya)
  await checkPolicyRules(toolId, args, caller, projectId)

  // 6. Execute
  return tool.execute(args)
}
```

### Plugin manifest extension

```typescript
// Di defineTool() — @jiku/kit
defineTool({
  name: 'send_message',
  meta: {
    group: 'telegram',
    required_plugin_permission: 'telegram:send_message',  // ← field baru
  },
  // ...
})
```

### DB — `plugin_granted_permissions` table

```sql
CREATE TABLE plugin_granted_permissions (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id    uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  membership_id uuid NOT NULL REFERENCES project_memberships(id) ON DELETE CASCADE,
  plugin_id     text NOT NULL,
  permission    text NOT NULL,       -- 'telegram:send_message'
  granted_by    uuid REFERENCES users(id),
  created_at    timestamptz NOT NULL DEFAULT now(),

  UNIQUE (membership_id, plugin_id, permission)
);

CREATE INDEX idx_plugin_perms_project    ON plugin_granted_permissions(project_id);
CREATE INDEX idx_plugin_perms_membership ON plugin_granted_permissions(membership_id);
```

### Helper query

```typescript
// getGrantedPluginPermissions(userId, projectId) → string[]
async function getGrantedPluginPermissions(
  userId: string | null,
  projectId: string,
): Promise<string[]> {
  if (!userId) return []  // system caller → tidak ada plugin permissions

  const rows = await db.query.pluginGrantedPermissions.findMany({
    where: and(
      eq(pluginGrantedPermissions.project_id, projectId),
      // join via membership
      inArray(
        pluginGrantedPermissions.membership_id,
        db.select({ id: projectMemberships.id })
          .from(projectMemberships)
          .where(and(
            eq(projectMemberships.project_id, projectId),
            eq(projectMemberships.user_id, userId),
          ))
      )
    )
  })

  return rows.map(r => r.permission)
}
```

---

## 4. Audit Log Completion

### Coverage saat ini (partial)

```
✅ tool.invoke       — writeAuditLog() di routes/plugin-ui.ts
❌ api.call          — tidak di-audit
❌ file.write        — tidak di-audit
❌ secret.get        — tidak di-audit
❌ auth.login        — tidak di-audit
❌ member.invite     — tidak di-audit
❌ permission.change — tidak di-audit
```

### Target coverage Plan 18

```typescript
// packages/types/src/audit.ts

export type AuditEventType =
  | 'tool.invoke'
  | 'tool.blocked'           // invoke gagal karena policy/permission
  | 'file.write'
  | 'file.delete'
  | 'file.read'              // hanya untuk sensitive files
  | 'secret.get'             // credential diakses/decrypt
  | 'secret.create'
  | 'secret.delete'
  | 'auth.login'
  | 'auth.logout'
  | 'auth.login_failed'
  | 'member.invite'
  | 'member.remove'
  | 'member.role_changed'
  | 'permission.granted'
  | 'permission.revoked'
  | 'plugin.activated'
  | 'plugin.deactivated'
  | 'agent.created'
  | 'agent.deleted'

export interface AuditLog {
  id: string
  project_id: string | null    // null untuk company/auth events
  company_id: string | null
  actor_id: string | null      // null = system
  actor_type: 'user' | 'agent' | 'system'
  event_type: AuditEventType
  resource_type: string        // 'tool', 'file', 'credential', dll
  resource_id: string | null
  resource_name: string | null
  metadata: Record<string, unknown>  // detail tambahan
  ip_address: string | null
  user_agent: string | null
  created_at: string
}
```

### DB schema

```sql
CREATE TABLE audit_logs (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id    uuid REFERENCES projects(id) ON DELETE SET NULL,
  company_id    uuid REFERENCES companies(id) ON DELETE SET NULL,
  actor_id      uuid REFERENCES users(id) ON DELETE SET NULL,
  actor_type    text NOT NULL DEFAULT 'user'
                  CHECK (actor_type IN ('user', 'agent', 'system')),
  event_type    text NOT NULL,
  resource_type text NOT NULL,
  resource_id   text,
  resource_name text,
  metadata      jsonb NOT NULL DEFAULT '{}',
  ip_address    text,
  user_agent    text,
  created_at    timestamptz NOT NULL DEFAULT now()
);

-- Index untuk query UI
CREATE INDEX idx_audit_project   ON audit_logs(project_id, created_at DESC);
CREATE INDEX idx_audit_company   ON audit_logs(company_id, created_at DESC);
CREATE INDEX idx_audit_actor     ON audit_logs(actor_id, created_at DESC);
CREATE INDEX idx_audit_event     ON audit_logs(event_type, created_at DESC);
```

### writeAuditLog() helper

```typescript
// apps/studio/server/src/audit/logger.ts

export async function writeAuditLog(entry: Omit<AuditLog, 'id' | 'created_at'>) {
  // Fire and forget — audit tidak boleh block request
  db.insert(auditLogs).values(entry).catch(err =>
    console.warn('[audit] Failed to write audit log:', err)
  )
}

// Convenience helpers
export const audit = {
  toolInvoke: (ctx: AuditContext, toolId: string, args: unknown) =>
    writeAuditLog({ ...ctx, event_type: 'tool.invoke', resource_type: 'tool', resource_id: toolId, metadata: { args } }),

  toolBlocked: (ctx: AuditContext, toolId: string, reason: string) =>
    writeAuditLog({ ...ctx, event_type: 'tool.blocked', resource_type: 'tool', resource_id: toolId, metadata: { reason } }),

  fileWrite: (ctx: AuditContext, path: string, sizeBytes: number) =>
    writeAuditLog({ ...ctx, event_type: 'file.write', resource_type: 'file', resource_name: path, metadata: { size_bytes: sizeBytes } }),

  fileDelete: (ctx: AuditContext, path: string) =>
    writeAuditLog({ ...ctx, event_type: 'file.delete', resource_type: 'file', resource_name: path }),

  secretGet: (ctx: AuditContext, credentialId: string, credentialName: string) =>
    writeAuditLog({ ...ctx, event_type: 'secret.get', resource_type: 'credential', resource_id: credentialId, resource_name: credentialName }),

  authLogin: (ctx: AuditContext, email: string, success: boolean) =>
    writeAuditLog({ ...ctx, event_type: success ? 'auth.login' : 'auth.login_failed', resource_type: 'auth', metadata: { email } }),

  memberInvite: (ctx: AuditContext, email: string, projectIds: string[]) =>
    writeAuditLog({ ...ctx, event_type: 'member.invite', resource_type: 'member', metadata: { email, project_ids: projectIds } }),

  permissionChanged: (ctx: AuditContext, targetUserId: string, changes: unknown) =>
    writeAuditLog({ ...ctx, event_type: 'permission.granted', resource_type: 'permission', resource_id: targetUserId, metadata: { changes } }),
}
```

### Integration points

```
apps/studio/server/src/routes/auth.ts
  → audit.authLogin() di POST /login

apps/studio/server/src/routes/credentials.ts
  → audit.secretGet() di GET /credentials/:id/reveal
  → audit.toolInvoke() di POST /credentials (create)
  → writeAuditLog event secret.delete di DELETE /credentials/:id

apps/studio/server/src/filesystem/service.ts
  → audit.fileWrite() di write()
  → audit.fileDelete() di delete()

apps/studio/server/src/routes/members.ts
  → audit.memberInvite() di POST /invitations
  → audit.permissionChanged() di PATCH /members/:uid/role

apps/studio/server/src/runtime/tool-invoker.ts
  → audit.toolInvoke() setiap tool berhasil
  → audit.toolBlocked() setiap tool diblok policy/permission
```

### Audit Log UI di Studio

**Route baru:**
```
/studio/companies/[company]/projects/[project]/settings/audit
```

**Komponen:**

```
┌─ Audit Log ──────────────────────────────────────────────────────┐
│  [Event type ▼] [Actor ▼] [Resource ▼]  [Date range]  [Search]  │
│                                                                   │
│  Time           Actor      Event              Resource            │
│  ───────────────────────────────────────────────────────────── │
│  14:32:01       John       tool.invoke        memory_search      │
│  14:31:58       System     file.write         /src/index.ts      │
│  14:30:45       John       secret.get         OpenAI Key         │
│  14:28:12       Jane       auth.login         —                  │
│  14:25:00       John       member.invite      bob@example.com    │
│                                                                   │
│  [Klik row → drawer detail dengan full metadata JSON]            │
│                                                                   │
│               < 1 2 3 ... >   [20 per page ▼]  [Export CSV]     │
└───────────────────────────────────────────────────────────────────┘
```

**API route:**
```
GET /api/projects/:pid/audit-logs?event_type=&actor_id=&resource_type=&from=&to=&page=&per_page=
GET /api/projects/:pid/audit-logs/:id   → detail single log
GET /api/projects/:pid/audit-logs/export → CSV download
```

---

## 5. Tool Hot-Unregister

### Problem

Sekarang kalau plugin di-deactivate atau agent di-delete, tools-nya masih ada di registry sampai server restart.

### Solution

Extend `syncProjectTools()` yang sudah ada dengan explicit `removeAgent()` dan cache drain.

```typescript
// packages/core/src/runtime.ts

export class JikuRuntime {
  // Sudah ada
  async syncProjectTools(agentId: string, newTools: ToolDefinition[]) { ... }

  // BARU — remove agent dan semua tool-nya dari registry
  async removeAgent(agentId: string): Promise<void> {
    // 1. Stop any active runners untuk agent ini
    const activeRunners = this.runnerRegistry.getByAgent(agentId)
    await Promise.all(activeRunners.map(r => r.abort()))

    // 2. Remove tools dari SharedRegistry
    this.sharedRegistry.removeByAgent(agentId)

    // 3. Remove dari agent map
    this.agentMap.delete(agentId)

    // 4. Emit event untuk observer
    this.hooks.callHook('agent:removed', { agentId })
  }

  // BARU — remove specific tools dari agent (partial unregister)
  async removeAgentTools(agentId: string, toolIds: string[]): Promise<void> {
    this.sharedRegistry.removeTools(agentId, toolIds)
  }
}

// packages/core/src/registry.ts — extend SharedRegistry
export class SharedRegistry {
  // Sudah ada: register, get, list

  // BARU
  removeByAgent(agentId: string): void {
    const keysToDelete: string[] = []
    for (const [key, entry] of this.tools.entries()) {
      if (entry.agentId === agentId) keysToDelete.push(key)
    }
    keysToDelete.forEach(k => this.tools.delete(k))
  }

  removeTools(agentId: string, toolIds: string[]): void {
    for (const toolId of toolIds) {
      const key = `${agentId}:${toolId}`
      this.tools.delete(key)
    }
  }
}
```

### Integration points di RuntimeManager

```typescript
// apps/studio/server/src/runtime/manager.ts

// Saat agent di-delete
async deleteAgent(agentId: string, projectId: string) {
  const runtime = this.getRuntime(projectId)
  await runtime.removeAgent(agentId)
  // ... hapus dari DB
}

// Saat plugin di-deactivate dari project
async deactivatePlugin(pluginId: string, projectId: string) {
  const runtime = this.getRuntime(projectId)
  // Get tools yang di-contribute plugin ini
  const pluginTools = runtime.getPluginTools(pluginId)
  // Remove dari semua agent
  for (const agentId of runtime.getAgentIds()) {
    await runtime.removeAgentTools(agentId, pluginTools)
  }
  // ... deactivate plugin
}

// Saat browser session di-close / tool browser force-unregister
async unregisterBrowserTools(projectId: string, agentId: string) {
  const runtime = this.getRuntime(projectId)
  await runtime.removeAgentTools(agentId, ['browser'])
}
```

---

## 6. Plugin Policy UI

### Context

`granted_permissions` sudah ada di DB schema, tabel `plugin_granted_permissions` dibuat di section 3. Yang belum: UI untuk manage siapa dapat permission apa dari plugin tertentu.

### UI — di Project Settings → Members → Edit Member

```
┌─ Edit Member: Jane Smith ─────────────────────────────────────┐
│  Role: [Manager ▼]                                             │
│                                                                │
│  Plugin Permissions                                            │
│  ┌────────────────────────────────────────────────────────┐   │
│  │ jiku.telegram                                          │   │
│  │   [✓] telegram:send_message  — Send messages           │   │
│  │   [ ] telegram:manage_bots   — Manage bot config       │   │
│  │                                                        │   │
│  │ jiku.skills                                            │   │
│  │   [✓] skills:read            — Read skills             │   │
│  │   [✓] skills:write           — Create/edit skills      │   │
│  │                                                        │   │
│  │ (hanya plugin yang aktif di project ini yang tampil)   │   │
│  └────────────────────────────────────────────────────────┘   │
│                                                                │
│  [Save]                                                        │
└────────────────────────────────────────────────────────────────┘
```

### UI — di Plugin page (per plugin, lihat siapa yang punya permission)

```
┌─ Plugin: jiku.telegram ───────────────────────────────────────┐
│  Status: Active  |  [Deactivate]                              │
│                                                               │
│  Permissions                                                  │
│  ┌───────────────────────────────────────────────────────┐   │
│  │ telegram:send_message                                 │   │
│  │   Granted to: John (superadmin), Jane, Bob            │   │
│  │   [Manage →]                                          │   │
│  │                                                       │   │
│  │ telegram:manage_bots                                  │   │
│  │   Granted to: John (superadmin)                       │   │
│  │   [Manage →]                                          │   │
│  └───────────────────────────────────────────────────────┘   │
└───────────────────────────────────────────────────────────────┘
```

### API routes

```
GET    /api/projects/:pid/plugin-permissions              → list semua granted permissions di project
GET    /api/projects/:pid/members/:uid/plugin-permissions → permissions untuk user tertentu
PUT    /api/projects/:pid/members/:uid/plugin-permissions → update (replace all) untuk user
POST   /api/projects/:pid/plugin-permissions/grant        → grant specific permission
DELETE /api/projects/:pid/plugin-permissions/:id          → revoke specific permission
```

---

## 7. Implementation Checklist

### @jiku/types

- [ ] `AuditEventType` union type
- [ ] `AuditLog` interface
- [ ] Tambah `required_plugin_permission?: string` ke `ToolMeta`
- [ ] `PluginGrantedPermission` type

### @jiku/core

- [ ] `SharedRegistry.removeByAgent()` method
- [ ] `SharedRegistry.removeTools()` method
- [ ] `JikuRuntime.removeAgent()` method
- [ ] `JikuRuntime.removeAgentTools()` method
- [ ] `JikuRuntime.getPluginTools()` method — list tools yang di-contribute plugin tertentu
- [ ] `JikuRuntime.getAgentIds()` method

### @jiku-studio/db

- [ ] Migration: `audit_logs` table + indexes
- [ ] Migration: `plugin_granted_permissions` table + indexes
- [ ] Drizzle schema kedua tabel
- [ ] `writeAuditLog(entry)` query
- [ ] `listAuditLogs(params)` — paginated, filter by event_type/actor/resource/date
- [ ] `getAuditLog(id)` query
- [ ] `exportAuditLogs(params)` — untuk CSV
- [ ] `getGrantedPluginPermissions(userId, projectId)` query
- [ ] `grantPluginPermission(membershipId, pluginId, permission)` query
- [ ] `revokePluginPermission(id)` query
- [ ] `listMemberPluginPermissions(membershipId)` query

### apps/studio/server

- [ ] `express-rate-limit` — install dependency
- [ ] `globalRateLimit` middleware
- [ ] `chatRateLimit`, `authRateLimit`, `credentialRateLimit`, `uploadRateLimit`
- [ ] Apply rate limits ke semua route yang relevan
- [ ] `writeAuditLog()` helper + `audit.*` convenience methods
- [ ] Integration audit ke: auth routes, credential routes, filesystem service, member routes, tool invoker
- [ ] `invokeToolWithPolicyCheck()` — extend dengan plugin permission check
- [ ] `getGrantedPluginPermissions()` query helper
- [ ] `RuntimeManager.deleteAgent()` — panggil `runtime.removeAgent()`
- [ ] `RuntimeManager.deactivatePlugin()` — panggil `runtime.removeAgentTools()`
- [ ] `RuntimeManager.unregisterBrowserTools()` — untuk browser cleanup
- [ ] Routes: audit logs (list, detail, export CSV)
- [ ] Routes: plugin permissions (list, grant, revoke)

### apps/studio/web

- [ ] `AuditLogPage` — `/settings/audit` dengan DataTable + filters
- [ ] `AuditLogDrawer` — detail per log entry (full metadata JSON)
- [ ] Export CSV button di audit log page
- [ ] Tambah "Audit" di project settings navigation
- [ ] `PluginPermissionsSection` — di edit member dialog/page
- [ ] `PluginPermissionManager` — di plugin detail page (siapa yang punya permission)
- [ ] `api.auditLogs.*` methods di `lib/api.ts`
- [ ] `api.pluginPermissions.*` methods di `lib/api.ts`

---

## 8. Defer

- **Message encryption at rest** — tergantung compliance requirement, bukan blocker MVP
- **StreamRegistry persistence** — single instance OK, Redis kalau scale out
- **WebSocket** — SSE cukup, tidak ada feature yang butuh full-duplex sekarang
- **Rate limit per-project config** — untuk sekarang global config cukup
- **Audit log retention policy** — auto-delete logs > N days, defer sampai ada storage concern

---

*Plan 18 — Production Hardening*  
*Depends on: Plan 12 (Auth & ACL), Plan 17 (Plugin Marketplace)*  
*Generated: 2026-04-12*