# Jiku MVP — Planning Document

> Status: **PLANNING**
> Date: 2026-04-04
> Scope: studio/db, studio/server, studio/web, packages/ui

---

## Daftar Isi

1. [Overview](#1-overview)
2. [Monorepo Structure](#2-monorepo-structure)
3. [MVP Feature Scope](#3-mvp-feature-scope)
4. [Policy System — Review & Finalization](#4-policy-system--review--finalization)
5. [packages/ui](#5-packagesui)
6. [apps/studio/db](#6-appsstudiodb)
7. [apps/studio/server](#7-appsstudioserver)
8. [apps/studio/web](#8-appsstudioweb)
9. [Data Flow End-to-End](#9-data-flow-end-to-end)
10. [File Inventory](#10-file-inventory)
11. [Implementation Checklist](#11-implementation-checklist)

---

## 1. Overview

### Tujuan MVP

Jiku Studio MVP adalah platform agentic AI multi-tenant yang bisa:
- User register, buat company, buat project
- Buat agents di dalam project
- Chat dengan agent
- Manage permission & role per agent (termasuk self-restriction)

### Prinsip

- **Studio adalah consumer dari `@jiku/core`** — tidak modify core
- **DB hanya di studio scope** — `@jiku-studio/db`
- **UI components reusable** — extract ke `packages/ui`
- **Self-restriction** — user bisa limit permission dirinya sendiri per agent

---

## 2. Monorepo Structure

```
jiku/
├── packages/
│   ├── types/              @jiku/types
│   ├── kit/                @jiku/kit
│   ├── core/               @jiku/core
│   └── ui/                 @jiku/ui         ← NEW
│
├── apps/
│   ├── playground/         @jiku/playground
│   └── studio/
│       ├── db/             @jiku-studio/db   ← NEW
│       ├── server/         @jiku-studio/server ← NEW
│       └── web/            @jiku-studio/web  ← NEW
│
└── plugins/
    └── jiku.social/
```

### Dependency Graph

```
@jiku/types
    ↑
    ├── @jiku/kit
    ├── @jiku/core
    └── @jiku/ui              (zero runtime deps, only React)
         ↑
    @jiku-studio/db           (drizzle-orm, postgres)
         ↑
    @jiku-studio/server       (@jiku/core, @jiku-studio/db, hono)
         ↑
    @jiku-studio/web          (@jiku/ui, @jiku-studio/server types, next.js)
```

---

## 3. MVP Feature Scope

### Features

| Feature | Description |
|---------|-------------|
| Auth | Register, login, JWT + refresh token |
| Company | Buat company, invite member (future), list companies |
| Project | Buat project per company, list projects |
| Agent | Buat agent per project, config model/prompt |
| Chat | Chat sederhana dengan agent, conversation history |
| Permission | Role, permission, policy per agent — termasuk self-restriction |

### Out of Scope (Post-MVP)

- Invite member ke company
- Task mode
- Plugin management UI
- Plugin UI contributions
- Billing

---

## 4. Policy System — Review & Finalization

### 4.1 Hierarki Permission

```
Company Level
  └── Role (custom per company)
        └── Permission[] (granular keys)

Agent Level
  └── AgentUserPolicy (per user per agent)
        └── allowed_permissions: string[]   ← subset dari user's actual permissions
```

### 4.2 Self-Restriction — Konsep Final

User bisa **limit** permission mereka di context agent tertentu. Tidak bisa **tambah** permission yang tidak dimiliki.

```
User A actual permissions: ['post:write', 'post:read', 'post:delete']

AgentUserPolicy untuk User A di Agent "Social Manager":
  allowed_permissions: ['post:read']   ← self-restrict, hanya read

Effective permissions saat run:
  intersection(actual, allowed_permissions) = ['post:read']
```

Kalau tidak ada `AgentUserPolicy` → pakai actual permissions penuh (default behavior).

### 4.3 DB Schema untuk Policy

```
// Roles — per company, bisa custom
roles {
  id          uuid PK
  company_id  uuid FK
  name        string      // "Owner", "Admin", "Member", atau custom
  is_system   boolean     // system roles tidak bisa dihapus
}

// Permissions — master list, seed dari plugin definitions
permissions {
  id          uuid PK
  key         string unique  // "jiku.social:post:write"
  description string
  plugin_id   string         // plugin yang define permission ini
}

// Role → Permission mapping
role_permissions {
  role_id       uuid FK
  permission_id uuid FK
  PK(role_id, permission_id)
}

// Company Member → Role
company_members {
  id         uuid PK
  company_id uuid FK
  user_id    uuid FK
  role_id    uuid FK
  unique(company_id, user_id)
}

// Agent User Policy — self-restriction per user per agent
agent_user_policies {
  id                  uuid PK
  agent_id            uuid FK
  user_id             uuid FK
  allowed_permissions string[]   // subset dari actual permissions user
  // null = tidak ada restriction, pakai actual permissions penuh
  unique(agent_id, user_id)
}

// Policy Rules — untuk agent access + tool access
policy_rules {
  id            uuid PK
  agent_id      uuid FK
  resource_type string   // 'agent' | 'tool'
  resource_id   string   // 'social_manager:chat' | 'jiku.social:delete_post'
  subject_type  string   // 'role' | 'permission'
  subject       string   // 'admin' | 'jiku.social:post:delete'
  effect        string   // 'allow' | 'deny'
  priority      int
}
```

### 4.4 Resolve Flow di Studio Server

```typescript
// Saat user request run agent:

// 1. Load actual permissions dari DB
const member = await db.query.company_members.findFirst({
  where: and(eq(company_id, ...), eq(user_id, ...)),
  with: { role: { with: { permissions: true } } }
})
const actualPermissions = member.role.permissions.map(p => p.key)

// 2. Load self-restriction (AgentUserPolicy)
const selfPolicy = await db.query.agent_user_policies.findFirst({
  where: and(eq(agent_id, ...), eq(user_id, ...))
})

// 3. Effective permissions = intersection
const effectivePermissions = selfPolicy
  ? actualPermissions.filter(p => selfPolicy.allowed_permissions.includes(p))
  : actualPermissions

// 4. Load policy rules untuk agent ini
const rules = await db.query.policy_rules.findMany({
  where: eq(agent_id, ...)
})

// 5. Pass ke core
await runtime.run({
  agent_id: agent.id,
  caller: {
    user_id: user.id,
    roles: [member.role.name],
    permissions: effectivePermissions,   // ← effective, sudah di-intersect
    user_data: {
      name: user.name,
      email: user.email,
      company_id: company.id,
      project_id: project.id,
    }
  },
  mode: 'chat',
  input: userMessage,
})
```

### 4.5 Agent Permission UI

Di web studio, halaman edit agent punya tab **"Permissions"**:

```
Agent: "Social Media Manager"
  
  Tab: Overview | Configuration | Permissions | Danger

  [Tab: Permissions]
  
  Policy Rules
  ┌─────────────────────────────────────────────────────┐
  │ Tool              │ Required Permission  │ Effect    │
  ├─────────────────────────────────────────────────────┤
  │ list_post         │ * (everyone)         │ allow     │
  │ create_post       │ jiku.social:post:write│ allow    │
  │ delete_post       │ jiku.social:post:delete│ allow   │
  └─────────────────────────────────────────────────────┘
  [+ Add Rule]

  User Permissions
  ┌─────────────────────────────────────────────────────┐
  │ User          │ Role    │ Effective Permissions      │
  ├─────────────────────────────────────────────────────┤
  │ You (Admin)   │ Owner   │ [post:write] [post:read]  │
  │               │         │ [Edit My Permissions]      │
  ├─────────────────────────────────────────────────────┤
  │ Budi          │ Member  │ [post:read]               │
  │               │         │ [Edit]                     │
  └─────────────────────────────────────────────────────┘
```

"Edit My Permissions" → modal dimana user bisa centang/uncentang permission yang dimilikinya untuk agent ini.

---

## 5. packages/ui

### 5.1 Tujuan

Component library yang di-share antara `@jiku-studio/web` dan future plugin UI contributions. Semua component adalah **headless-friendly** — menggunakan shadcn/ui sebagai base.

### 5.2 Stack

```
- React 19
- shadcn/ui components (re-exported + extended)
- Tailwind CSS (peer dependency)
- Radix UI primitives (via shadcn)
- Lucide React (icons)
```

### 5.3 Structure

```
packages/ui/
├── src/
│   ├── components/
│   │   ├── base/              ← re-export shadcn components
│   │   │   ├── button.tsx
│   │   │   ├── input.tsx
│   │   │   ├── form.tsx
│   │   │   ├── dialog.tsx
│   │   │   ├── dropdown.tsx
│   │   │   ├── table.tsx
│   │   │   ├── tabs.tsx
│   │   │   ├── badge.tsx
│   │   │   ├── avatar.tsx
│   │   │   ├── card.tsx
│   │   │   ├── sheet.tsx
│   │   │   ├── toast.tsx
│   │   │   └── tooltip.tsx
│   │   │
│   │   ├── layout/            ← layout components
│   │   │   ├── sidebar.tsx
│   │   │   ├── header.tsx
│   │   │   ├── page-header.tsx
│   │   │   └── empty-state.tsx
│   │   │
│   │   ├── data/              ← data display
│   │   │   ├── data-table.tsx
│   │   │   ├── stat-card.tsx
│   │   │   └── permission-badge.tsx
│   │   │
│   │   └── agent/             ← agent-specific UI (reusable)
│   │       ├── chat-bubble.tsx
│   │       ├── chat-input.tsx
│   │       ├── tool-call-view.tsx
│   │       ├── tool-result-view.tsx
│   │       └── thinking-indicator.tsx
│   │
│   └── index.ts               ← barrel export semua
│
├── package.json
└── tsconfig.json
```

### 5.4 package.json

```json
{
  "name": "@jiku/ui",
  "version": "0.0.1",
  "exports": {
    ".": "./src/index.ts",
    "./components/*": "./src/components/*"
  },
  "peerDependencies": {
    "react": "^19",
    "react-dom": "^19",
    "tailwindcss": "^4"
  },
  "dependencies": {
    "@radix-ui/react-dialog": "latest",
    "class-variance-authority": "latest",
    "clsx": "latest",
    "lucide-react": "latest",
    "tailwind-merge": "latest"
  }
}
```

---

## 6. apps/studio/db

### 6.1 Tujuan

Drizzle ORM schema, migrations, dan typed query helpers. Hanya dipakai oleh `@jiku-studio/server`.

### 6.2 Structure

```
apps/studio/db/
├── src/
│   ├── schema/
│   │   ├── users.ts
│   │   ├── companies.ts
│   │   ├── roles.ts
│   │   ├── permissions.ts
│   │   ├── projects.ts
│   │   ├── agents.ts
│   │   ├── policies.ts         ← policy_rules + agent_user_policies
│   │   ├── conversations.ts
│   │   ├── messages.ts
│   │   └── index.ts            ← barrel export semua schema
│   │
│   ├── queries/                ← typed query helpers
│   │   ├── auth.ts             getUserByEmail, createUser
│   │   ├── company.ts          getCompanies, createCompany, getMember
│   │   ├── project.ts          getProjects, createProject
│   │   ├── agent.ts            getAgents, createAgent, getAgentWithPolicy
│   │   ├── policy.ts           getPolicyRules, getAgentUserPolicy, upsertAgentUserPolicy
│   │   └── conversation.ts     getConversations, getMessages, addMessage
│   │
│   ├── migrations/             ← drizzle migrations (auto-generated)
│   ├── client.ts               ← drizzle client factory
│   ├── seed.ts                 ← seed system roles + permissions
│   └── index.ts
│
├── drizzle.config.ts
└── package.json
```

### 6.3 Schema Lengkap

```typescript
// users
export const users = pgTable('users', {
  id:         uuid('id').primaryKey().defaultRandom(),
  email:      varchar('email', { length: 255 }).unique().notNull(),
  name:       varchar('name', { length: 255 }).notNull(),
  password:   varchar('password', { length: 255 }).notNull(),  // hashed
  created_at: timestamp('created_at').defaultNow(),
})

// companies
export const companies = pgTable('companies', {
  id:         uuid('id').primaryKey().defaultRandom(),
  name:       varchar('name', { length: 255 }).notNull(),
  slug:       varchar('slug', { length: 255 }).unique().notNull(),
  owner_id:   uuid('owner_id').references(() => users.id).notNull(),
  created_at: timestamp('created_at').defaultNow(),
})

// roles
export const roles = pgTable('roles', {
  id:         uuid('id').primaryKey().defaultRandom(),
  company_id: uuid('company_id').references(() => companies.id).notNull(),
  name:       varchar('name', { length: 100 }).notNull(),
  is_system:  boolean('is_system').default(false),
  created_at: timestamp('created_at').defaultNow(),
})

// permissions
export const permissions = pgTable('permissions', {
  id:          uuid('id').primaryKey().defaultRandom(),
  key:         varchar('key', { length: 255 }).unique().notNull(),
  description: text('description'),
  plugin_id:   varchar('plugin_id', { length: 255 }),
})

// role_permissions
export const role_permissions = pgTable('role_permissions', {
  role_id:       uuid('role_id').references(() => roles.id).notNull(),
  permission_id: uuid('permission_id').references(() => permissions.id).notNull(),
}, t => ({ pk: primaryKey({ columns: [t.role_id, t.permission_id] }) }))

// company_members
export const company_members = pgTable('company_members', {
  id:         uuid('id').primaryKey().defaultRandom(),
  company_id: uuid('company_id').references(() => companies.id).notNull(),
  user_id:    uuid('user_id').references(() => users.id).notNull(),
  role_id:    uuid('role_id').references(() => roles.id).notNull(),
  joined_at:  timestamp('joined_at').defaultNow(),
}, t => ({ uq: unique().on(t.company_id, t.user_id) }))

// projects
export const projects = pgTable('projects', {
  id:         uuid('id').primaryKey().defaultRandom(),
  company_id: uuid('company_id').references(() => companies.id).notNull(),
  name:       varchar('name', { length: 255 }).notNull(),
  slug:       varchar('slug', { length: 255 }).notNull(),
  created_at: timestamp('created_at').defaultNow(),
}, t => ({ uq: unique().on(t.company_id, t.slug) }))

// agents
export const agents = pgTable('agents', {
  id:            uuid('id').primaryKey().defaultRandom(),
  project_id:    uuid('project_id').references(() => projects.id).notNull(),
  name:          varchar('name', { length: 255 }).notNull(),
  description:   text('description'),
  base_prompt:   text('base_prompt').notNull(),
  allowed_modes: text('allowed_modes').array().notNull().default(['chat']),
  provider_id:   varchar('provider_id', { length: 100 }).notNull().default('anthropic'),
  model_id:      varchar('model_id', { length: 100 }).notNull().default('claude-sonnet-4-5'),
  created_at:    timestamp('created_at').defaultNow(),
})

// policy_rules — tool + agent access rules
export const policy_rules = pgTable('policy_rules', {
  id:            uuid('id').primaryKey().defaultRandom(),
  agent_id:      uuid('agent_id').references(() => agents.id).notNull(),
  resource_type: varchar('resource_type', { length: 50 }).notNull(),  // 'agent' | 'tool'
  resource_id:   varchar('resource_id', { length: 255 }).notNull(),
  subject_type:  varchar('subject_type', { length: 50 }).notNull(),   // 'role' | 'permission'
  subject:       varchar('subject', { length: 255 }).notNull(),
  effect:        varchar('effect', { length: 20 }).notNull(),          // 'allow' | 'deny'
  priority:      integer('priority').default(0),
})

// agent_user_policies — self-restriction per user per agent
export const agent_user_policies = pgTable('agent_user_policies', {
  id:                  uuid('id').primaryKey().defaultRandom(),
  agent_id:            uuid('agent_id').references(() => agents.id).notNull(),
  user_id:             uuid('user_id').references(() => users.id).notNull(),
  allowed_permissions: text('allowed_permissions').array().notNull().default([]),
  updated_at:          timestamp('updated_at').defaultNow(),
}, t => ({ uq: unique().on(t.agent_id, t.user_id) }))

// conversations
export const conversations = pgTable('conversations', {
  id:         uuid('id').primaryKey().defaultRandom(),
  agent_id:   uuid('agent_id').references(() => agents.id).notNull(),
  user_id:    uuid('user_id').references(() => users.id).notNull(),
  mode:       varchar('mode', { length: 20 }).notNull().default('chat'),
  title:      varchar('title', { length: 255 }),
  status:     varchar('status', { length: 20 }).notNull().default('active'),
  goal:       text('goal'),
  created_at: timestamp('created_at').defaultNow(),
  updated_at: timestamp('updated_at').defaultNow(),
})

// messages
export const messages = pgTable('messages', {
  id:              uuid('id').primaryKey().defaultRandom(),
  conversation_id: uuid('conversation_id').references(() => conversations.id).notNull(),
  role:            varchar('role', { length: 20 }).notNull(),
  content:         jsonb('content').notNull(),
  created_at:      timestamp('created_at').defaultNow(),
})
```

---

## 7. apps/studio/server

### 7.1 Stack

```
- Bun runtime
- Hono (HTTP + WebSocket)
- @jiku/core (JikuRuntime)
- @jiku-studio/db (queries)
- jose (JWT)
- bcrypt (password hashing)
```

### 7.2 Structure

```
apps/studio/server/
├── src/
│   ├── index.ts              ← bootstrap + lifecycle
│   ├── env.ts                ← environment variables
│   │
│   ├── middleware/
│   │   ├── auth.ts           ← JWT verify middleware
│   │   └── company.ts        ← resolve company + member middleware
│   │
│   ├── routes/
│   │   ├── auth.ts           ← POST /auth/register, /auth/login, /auth/refresh
│   │   ├── companies.ts      ← GET/POST /companies
│   │   ├── projects.ts       ← GET/POST /companies/:cid/projects
│   │   ├── agents.ts         ← GET/POST/PATCH /projects/:pid/agents
│   │   ├── policies.ts       ← GET/POST/PATCH /agents/:aid/policies
│   │   └── conversations.ts  ← GET/POST /agents/:aid/conversations
│   │
│   ├── ws/
│   │   └── chat.ts           ← WebSocket handler untuk chat streaming
│   │
│   └── runtime/
│       ├── manager.ts        ← JikuRuntimeManager — satu runtime per project
│       ├── storage.ts        ← StudioStorageAdapter (implements JikuStorageAdapter)
│       └── caller.ts         ← resolveCaller() — load permissions + self-restriction
│
└── package.json
```

### 7.3 JikuRuntimeManager

```typescript
// src/runtime/manager.ts

export class JikuRuntimeManager {
  private _runtimes: Map<string, JikuRuntime> = new Map()

  // Boot satu runtime per project
  async bootProject(projectId: string): Promise<void> {
    if (this._runtimes.has(projectId)) return

    const runtime = new JikuRuntime({
      plugins: globalPluginLoader,   // shared plugin loader
      storage: new StudioStorageAdapter(projectId),
      rules: [],  // rules di-load per-request via updateRules
    })

    // Load agents untuk project ini
    const agents = await db.query.agents.findMany({
      where: eq(projects.id, projectId)
    })
    for (const agent of agents) {
      runtime.addAgent({
        meta: { id: agent.id, name: agent.name },
        base_prompt: agent.base_prompt,
        allowed_modes: agent.allowed_modes as AgentMode[],
        provider_id: agent.provider_id,
        model_id: agent.model_id,
      })
    }

    await runtime.boot()
    this._runtimes.set(projectId, runtime)
  }

  async getRuntime(projectId: string): Promise<JikuRuntime> {
    if (!this._runtimes.has(projectId)) {
      await this.bootProject(projectId)
    }
    return this._runtimes.get(projectId)!
  }

  // Hot reload saat agent di-edit
  async reloadAgent(projectId: string, agentId: string): Promise<void> {
    const runtime = await this.getRuntime(projectId)
    const agent = await db.query.agents.findFirst({ where: eq(agents.id, agentId) })
    if (!agent) return

    runtime.removeAgent(agentId)
    runtime.addAgent({ ... })
  }

  async stopAll(): Promise<void> {
    for (const runtime of this._runtimes.values()) {
      await runtime.stop()
    }
  }
}
```

### 7.4 resolveCaller

```typescript
// src/runtime/caller.ts

export async function resolveCaller(
  userId: string,
  companyId: string,
  agentId: string,
): Promise<CallerContext> {
  // 1. Load actual permissions dari role
  const member = await db.query.company_members.findFirst({
    where: and(
      eq(company_members.user_id, userId),
      eq(company_members.company_id, companyId),
    ),
    with: {
      role: {
        with: { role_permissions: { with: { permission: true } } }
      }
    }
  })

  if (!member) throw new Error('Not a member of this company')

  const actualPermissions = member.role.role_permissions.map(rp => rp.permission.key)
  const roleName = member.role.name

  // 2. Load self-restriction (AgentUserPolicy)
  const selfPolicy = await db.query.agent_user_policies.findFirst({
    where: and(
      eq(agent_user_policies.agent_id, agentId),
      eq(agent_user_policies.user_id, userId),
    )
  })

  // 3. Effective permissions = intersection
  // Self-restriction hanya bisa KURANGI, tidak bisa TAMBAH
  const effectivePermissions = selfPolicy && selfPolicy.allowed_permissions.length > 0
    ? actualPermissions.filter(p => selfPolicy.allowed_permissions.includes(p))
    : actualPermissions

  // 4. Load user data
  const user = await db.query.users.findFirst({ where: eq(users.id, userId) })

  return {
    user_id: userId,
    roles: [roleName],
    permissions: effectivePermissions,
    user_data: {
      name: user!.name,
      email: user!.email,
      company_id: companyId,
      actual_permissions: actualPermissions,  // untuk UI "edit my permissions"
    }
  }
}
```

### 7.5 HTTP Routes

```
POST   /api/auth/register              → register user
POST   /api/auth/login                 → login, return JWT
POST   /api/auth/refresh               → refresh JWT

GET    /api/companies                  → list my companies
POST   /api/companies                  → buat company baru

GET    /api/companies/:cid/projects    → list projects
POST   /api/companies/:cid/projects    → buat project

GET    /api/projects/:pid/agents       → list agents
POST   /api/projects/:pid/agents       → buat agent
PATCH  /api/agents/:aid                → edit agent (trigger reloadAgent)
DELETE /api/agents/:aid                → hapus agent

GET    /api/agents/:aid/policies/rules          → get policy rules
POST   /api/agents/:aid/policies/rules          → tambah rule
DELETE /api/agents/:aid/policies/rules/:rid     → hapus rule

GET    /api/agents/:aid/policies/users          → list user policies untuk agent ini
PATCH  /api/agents/:aid/policies/users/:uid     → update self-restriction user
GET    /api/agents/:aid/policies/users/me       → get my policy untuk agent ini

GET    /api/agents/:aid/conversations           → list conversations
POST   /api/agents/:aid/conversations           → buat conversation baru

WS     /ws/chat/:conversation_id                → streaming chat
```

### 7.6 WebSocket Chat Handler

```typescript
// src/ws/chat.ts

export function handleChatWS(ws: WSContext, conversationId: string, userId: string) {
  ws.on('message', async (raw) => {
    const { input, agent_id, project_id, company_id } = JSON.parse(raw)

    // 1. Resolve caller (permissions + self-restriction)
    const caller = await resolveCaller(userId, company_id, agent_id)

    // 2. Load policy rules untuk agent
    const rules = await getPolicyRules(agent_id)

    // 3. Get runtime + update rules
    const runtime = await runtimeManager.getRuntime(project_id)
    runtime.updateRules(rules)

    // 4. Run
    const result = await runtime.run({
      agent_id,
      caller,
      mode: 'chat',
      input,
      conversation_id: conversationId,
    })

    // 5. Stream ke client
    for await (const chunk of result.stream) {
      ws.send(JSON.stringify(chunk))
    }

    ws.send(JSON.stringify({ type: 'done' }))
  })
}
```

### 7.7 Bootstrap & Lifecycle

```typescript
// src/index.ts

const app = new Hono()
const runtimeManager = new JikuRuntimeManager()

// Routes
app.route('/api/auth', authRouter)
app.route('/api/companies', companiesRouter)
app.route('/api/projects', projectsRouter)
app.route('/api/agents', agentsRouter)
app.route('/api/agents', policiesRouter)
app.route('/api/agents', conversationsRouter)

// WebSocket
app.get('/ws/chat/:conversation_id', upgradeWebSocket(async (c) => {
  const conversationId = c.req.param('conversation_id')
  const userId = c.get('user_id')  // dari JWT middleware
  return {
    onMessage: (event, ws) => handleChatWS(ws, conversationId, userId),
  }
}))

// Lifecycle
async function bootstrap() {
  await runMigrations()          // drizzle migrations
  await seedSystemData()         // seed default roles + permissions
  console.log('[jiku] ✓ Studio Server ready on :3001')
}

async function shutdown() {
  await runtimeManager.stopAll()
  console.log('[jiku] ✓ Studio Server stopped')
}

serve({ fetch: app.fetch, port: 3001 })
bootstrap()

process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)
```

---

## 8. apps/studio/web

### 8.1 Stack

```
- Next.js 15 (App Router)
- shadcn/ui (semua components)
- shadcn AI elements (vercel ai sdk ui)
- TanStack Query (server state)
- Zustand (client state)
- @jiku/ui (shared components)
```

### 8.2 Structure

```
apps/studio/web/
├── app/
│   ├── layout.tsx                      ← root layout, providers
│   ├── (auth)/
│   │   ├── login/page.tsx
│   │   └── register/page.tsx
│   │
│   └── (app)/
│       ├── layout.tsx                  ← app shell, sidebar
│       ├── page.tsx                    ← company selector / dashboard
│       │
│       └── [company]/
│           ├── layout.tsx              ← company layout
│           ├── page.tsx                ← company overview
│           ├── settings/page.tsx       ← company settings, roles
│           │
│           └── [project]/
│               ├── layout.tsx          ← project layout
│               ├── page.tsx            ← project overview, agent list
│               │
│               └── agents/
│                   └── [agent]/
│                       ├── layout.tsx  ← agent layout
│                       ├── page.tsx    ← agent chat (default tab)
│                       └── settings/
│                           ├── page.tsx        ← agent config
│                           └── permissions/
│                               └── page.tsx    ← permission management
│
├── components/
│   ├── providers.tsx                   ← TanStack + Zustand + Theme providers
│   ├── auth/
│   │   ├── login-form.tsx
│   │   └── register-form.tsx
│   ├── company/
│   │   ├── company-card.tsx
│   │   └── create-company-dialog.tsx
│   ├── project/
│   │   ├── project-card.tsx
│   │   └── create-project-dialog.tsx
│   ├── agent/
│   │   ├── agent-card.tsx
│   │   ├── create-agent-dialog.tsx
│   │   ├── agent-config-form.tsx
│   │   └── chat/
│   │       ├── chat-interface.tsx      ← main chat UI (shadcn AI)
│   │       ├── message-list.tsx
│   │       └── input-bar.tsx
│   └── permissions/
│       ├── policy-rules-table.tsx      ← tabel policy rules
│       ├── user-policy-list.tsx        ← list user policies
│       └── edit-my-permissions.tsx     ← self-restriction modal
│
├── lib/
│   ├── api.ts                          ← typed API client (fetch wrapper)
│   ├── ws.ts                           ← WebSocket client untuk chat
│   ├── auth.ts                         ← auth helpers, token storage
│   └── store/
│       ├── auth.store.ts               ← Zustand: user + token
│       └── sidebar.store.ts            ← Zustand: sidebar state
│
└── package.json
```

### 8.3 Key Pages

#### Company Selector (`app/(app)/page.tsx`)

```
┌────────────────────────────────────┐
│ Welcome, Budi                      │
│                                    │
│ Your Companies                     │
│ ┌──────────┐ ┌──────────┐ ┌──────┐│
│ │ Bitorex  │ │ Jiku HQ  │ │  +   ││
│ │ 3 proj   │ │ 1 proj   │ │ New  ││
│ └──────────┘ └──────────┘ └──────┘│
└────────────────────────────────────┘
```

#### Project Overview (`app/(app)/[company]/[project]/page.tsx`)

```
┌──────────────────────────────────────────┐
│ Bitorex / Trading Platform               │
│                                          │
│ Agents                          [+ New]  │
│ ┌────────────────────────────────────┐   │
│ │ 🤖 Social Manager    [Chat] [Edit] │   │
│ │ 🤖 Finance Analyst   [Chat] [Edit] │   │
│ └────────────────────────────────────┘   │
└──────────────────────────────────────────┘
```

#### Agent Chat (`app/(app)/[company]/[project]/agents/[agent]/page.tsx`)

```
┌─────────────────────────────────────────┐
│ Social Media Manager          [Settings]│
├─────────────────────────────────────────┤
│                                         │
│  [assistant] Halo! Saya Social Media   │
│  Manager. Ada yang bisa saya bantu?    │
│                                         │
│  [user] List semua post                │
│                                         │
│  [assistant] Berikut post yang ada:    │
│  1. Hello World — Twitter              │
│  2. Product Launch — Instagram         │
│                                         │
├─────────────────────────────────────────┤
│  Type a message...            [Send →] │
└─────────────────────────────────────────┘
```

#### Permission Management (`app/(app)/[company]/[project]/agents/[agent]/settings/permissions/page.tsx`)

```
┌─────────────────────────────────────────────┐
│ Social Manager / Permissions                │
│                                             │
│ Policy Rules                      [+ Add]   │
│ ┌─────────────────────────────────────────┐ │
│ │ Tool          │ Permission   │ Effect   │ │
│ ├─────────────────────────────────────────┤ │
│ │ list_post     │ * (all)      │ allow  ✓ │ │
│ │ create_post   │ post:write   │ allow  ✓ │ │
│ │ delete_post   │ post:delete  │ allow  ✓ │ │
│ └─────────────────────────────────────────┘ │
│                                             │
│ User Permissions                            │
│ ┌─────────────────────────────────────────┐ │
│ │ User    │ Role  │ Permissions           │ │
│ ├─────────────────────────────────────────┤ │
│ │ You ★  │ Owner │ [write][read][delete] │ │
│ │         │       │ [Edit My Permissions] │ │
│ ├─────────────────────────────────────────┤ │
│ │ Budi    │ Member│ [read]               │ │
│ │         │       │ [Edit]               │ │
│ └─────────────────────────────────────────┘ │
└─────────────────────────────────────────────┘
```

**Edit My Permissions Modal:**

```
┌───────────────────────────────────────┐
│ Edit My Permissions — Social Manager  │
│                                       │
│ Your role (Owner) grants:             │
│ ☑ jiku.social:post:write             │
│ ☑ jiku.social:post:read              │
│ ☑ jiku.social:post:delete            │
│                                       │
│ Uncheck to limit your access for     │
│ this agent. You can always re-enable.│
│                                       │
│ [Cancel]              [Save Changes] │
└───────────────────────────────────────┘
```

### 8.4 Chat Implementation

Menggunakan **shadcn AI elements** + WebSocket untuk streaming:

```typescript
// components/agent/chat/chat-interface.tsx
'use client'

import { useChat } from '@/lib/ws'
import { ChatBubble, ChatInput, ThinkingIndicator } from '@jiku/ui'

export function ChatInterface({ agentId, conversationId }: Props) {
  const { messages, input, setInput, send, isLoading } = useChat({
    agentId,
    conversationId,
  })

  return (
    <div className="flex flex-col h-full">
      <div className="flex-1 overflow-y-auto p-4 space-y-4">
        {messages.map(msg => (
          <ChatBubble key={msg.id} message={msg} />
        ))}
        {isLoading && <ThinkingIndicator />}
      </div>

      <ChatInput
        value={input}
        onChange={setInput}
        onSend={() => send(input)}
        disabled={isLoading}
      />
    </div>
  )
}
```

---

## 9. Data Flow End-to-End

### Register & Setup

```
User register → POST /api/auth/register
  → hash password, create user
  → return JWT

User buat company → POST /api/companies
  → create company
  → create "Owner" system role untuk company
  → add user sebagai member dengan role Owner
  → return company

User buat project → POST /api/companies/:cid/projects
  → create project
  → return project

User buat agent → POST /api/projects/:pid/agents
  → create agent di DB
  → runtime.addAgent() di project runtime
  → return agent
```

### Chat Flow

```
User buka chat → GET /api/agents/:aid/conversations
  → load conversations
  → tampil di UI

User kirim message → WS /ws/chat/:conversation_id
  1. resolveCaller(userId, companyId, agentId)
     → load actual permissions dari DB
     → load self-restriction dari agent_user_policies
     → effective = intersection(actual, self_restriction)
  
  2. getPolicyRules(agentId)
     → load rules dari DB
  
  3. runtime.updateRules(rules)
     → rules di-hot swap ke runtime
  
  4. runtime.run({ caller, agent_id, mode: 'chat', input })
     → resolveScope(caller.permissions, rules, allTools)
     → buildSystemPrompt(base, mode, activeTools, caller)
     → streamText(model, messages, activeTools, systemPrompt)
  
  5. Stream chunks ke WS client
     → client render stream chunk by chunk
```

### Permission Update Flow

```
User edit self-restriction → PATCH /api/agents/:aid/policies/users/me
  { allowed_permissions: ['jiku.social:post:read'] }
  
  → validate: allowed_permissions ⊆ actual_permissions
  → upsert agent_user_policies
  
  → next chat run → resolveCaller → load self-restriction baru
  → effective permissions otomatis berubah
```

---

## 10. File Inventory

```
packages/ui/
  src/components/base/*          ← re-export shadcn
  src/components/layout/*        ← sidebar, header, empty-state
  src/components/data/*          ← data-table, stat-card, permission-badge
  src/components/agent/*         ← chat-bubble, chat-input, tool-call-view
  src/index.ts

apps/studio/db/
  src/schema/*.ts                ← 9 schema files
  src/queries/*.ts               ← 5 query helper files
  src/client.ts
  src/seed.ts
  src/migrations/*
  drizzle.config.ts

apps/studio/server/
  src/index.ts
  src/env.ts
  src/middleware/auth.ts
  src/middleware/company.ts
  src/routes/auth.ts
  src/routes/companies.ts
  src/routes/projects.ts
  src/routes/agents.ts
  src/routes/policies.ts
  src/routes/conversations.ts
  src/ws/chat.ts
  src/runtime/manager.ts
  src/runtime/storage.ts
  src/runtime/caller.ts

apps/studio/web/
  app/layout.tsx
  app/(auth)/login/page.tsx
  app/(auth)/register/page.tsx
  app/(app)/layout.tsx
  app/(app)/page.tsx
  app/(app)/[company]/layout.tsx
  app/(app)/[company]/page.tsx
  app/(app)/[company]/settings/page.tsx
  app/(app)/[company]/[project]/layout.tsx
  app/(app)/[company]/[project]/page.tsx
  app/(app)/[company]/[project]/agents/[agent]/page.tsx
  app/(app)/[company]/[project]/agents/[agent]/settings/page.tsx
  app/(app)/[company]/[project]/agents/[agent]/settings/permissions/page.tsx
  components/providers.tsx
  components/auth/*.tsx
  components/company/*.tsx
  components/project/*.tsx
  components/agent/**/*.tsx
  components/permissions/*.tsx
  lib/api.ts
  lib/ws.ts
  lib/auth.ts
  lib/store/auth.store.ts
  lib/store/sidebar.store.ts
```

---

## 11. Implementation Checklist

### `packages/ui`
- [ ] Init package dengan React + Tailwind peer deps
- [ ] Setup shadcn/ui base components (re-export)
- [ ] `layout/sidebar.tsx` — collapsible sidebar
- [ ] `layout/header.tsx` — breadcrumb + user menu
- [ ] `layout/empty-state.tsx` — empty state dengan icon + CTA
- [ ] `data/data-table.tsx` — generic sortable table
- [ ] `data/permission-badge.tsx` — badge untuk permission key
- [ ] `agent/chat-bubble.tsx` — user + assistant message bubble
- [ ] `agent/chat-input.tsx` — textarea + send button
- [ ] `agent/tool-call-view.tsx` — expandable tool call display
- [ ] `agent/thinking-indicator.tsx` — loading dots animation

### `apps/studio/db`
- [ ] Init Drizzle ORM + postgres
- [ ] Schema: users, companies, roles, permissions
- [ ] Schema: role_permissions, company_members
- [ ] Schema: projects, agents
- [ ] Schema: policy_rules, agent_user_policies
- [ ] Schema: conversations, messages
- [ ] Query helpers: auth, company, project, agent, policy, conversation
- [ ] Seed: system roles (Owner, Admin, Member) + default permissions
- [ ] Migration setup

### `apps/studio/server`
- [ ] Init Hono + Bun
- [ ] JWT middleware (jose)
- [ ] Auth routes (register, login, refresh)
- [ ] Company routes (list, create)
- [ ] Project routes (list, create)
- [ ] Agent routes (list, create, update, delete)
- [ ] Policy routes (rules CRUD, user policy CRUD)
- [ ] Conversation routes (list, create)
- [ ] `JikuRuntimeManager` (boot per project, reload agent, stop all)
- [ ] `StudioStorageAdapter` (implements JikuStorageAdapter via DB)
- [ ] `resolveCaller()` (actual permissions + self-restriction intersection)
- [ ] WebSocket chat handler + streaming
- [ ] Bootstrap + graceful shutdown

### `apps/studio/web`
- [ ] Init Next.js 15 + shadcn/ui + TanStack Query + Zustand
- [ ] Auth store (Zustand)
- [ ] API client (typed fetch wrapper)
- [ ] WS client (untuk chat streaming)
- [ ] Auth pages (login, register)
- [ ] App layout (sidebar, header)
- [ ] Company selector page
- [ ] Company detail + project list
- [ ] Project detail + agent list
- [ ] Agent chat page
- [ ] Agent settings page
- [ ] Agent permissions page
  - [ ] Policy rules table + add/delete rule
  - [ ] User policy list
  - [ ] Edit My Permissions modal (self-restriction)

---

*Generated: 2026-04-04 | Status: Planning — Ready for Implementation*