# Jiku — Foundation Plan

> Agentic AI Platform: Multi-Company, Multi-Project, Multi-User
> Document ini adalah planning spec untuk implementasi foundation Jiku.

---

## Daftar Isi

1. [Overview](#1-overview)
2. [Monorepo Structure](#2-monorepo-structure)
3. [Package Responsibilities](#3-package-responsibilities)
4. [Core Types — @jiku/types](#4-core-types--jikutypes)
5. [Plugin SDK — @jiku/kit](#5-plugin-sdk--jikukit)
6. [Core Runtime — @jiku/core](#6-core-runtime--jikucore)
7. [Permission & Policy System](#7-permission--policy-system)
8. [Context System](#8-context-system)
9. [Conversation & Mode System](#9-conversation--mode-system)
10. [Plugin System](#10-plugin-system)
11. [Adapter Pattern](#11-adapter-pattern)
12. [Playground App](#12-playground-app)
13. [Data Flow](#13-data-flow)

---

## 1. Overview

Jiku adalah agentic AI platform dengan arsitektur multi-tenant:

```
Company → Project → Agent → Conversation (Chat / Task mode)
```

### Prinsip Utama

- **Core murni** — `@jiku/core` tidak ada operasi DB atau file langsung. Semua IO lewat adapter yang di-inject dari luar.
- **Permission lahir dari tool** — setiap tool define permission-nya sendiri. Default `*` (allow all).
- **Rules hanya untuk restrict** — tidak ada rules = default allow. Rules masuk hanya kalau mau deny atau restrict sesuatu.
- **State di dua waktu** — rules di-set saat `init` atau `updateRules`. Caller (user context) di-pass saat `run`.
- **Chat dan Task adalah Conversation** — keduanya sama-sama conversation, beda di system prompt dan environment.

---

## 2. Monorepo Structure

```
jiku/
├── packages/
│   ├── types/              @jiku/types   — shared types, zero deps
│   ├── kit/                @jiku/kit     — plugin SDK untuk plugin author
│   ├── core/               @jiku/core    — agent runtime, resolver, plugin loader
│   └── db/                 @jiku/db      — drizzle schema + query helpers (future)
│
├── apps/
│   └── playground/         @jiku/playground — testing & example, satu file index.ts
│
└── plugins/                — built-in plugins
    ├── jiku.social/
    ├── jiku.cron/
    └── jiku.skills/
```

### Dependency Graph

```
@jiku/types          (zero deps)
    ↑
    ├── @jiku/kit    (peer: ai, zod)
    ├── @jiku/core   (deps: ai, zod, hookable)
    └── @jiku/db     (deps: drizzle-orm, postgres)
         ↑
    plugins/*        (deps: @jiku/kit)
         ↑
    apps/playground  (deps: semua packages + plugins)
```

`apps/playground` adalah satu-satunya yang boleh import dan wire semuanya bersama.

---

## 3. Package Responsibilities

| Package | Tanggung Jawab | Deps |
|---------|---------------|------|
| `@jiku/types` | Interface, type, enum. Zero logic. | — |
| `@jiku/kit` | `definePlugin`, `defineTool`, `defineAgent`. SDK untuk plugin author. | `@jiku/types` |
| `@jiku/core` | `JikuRuntime`, `AgentRunner`, `PluginLoader`, `resolveScope`. Zero DB. | `@jiku/types`, `@jiku/kit`, `ai`, `zod`, `hookable` |
| `@jiku/db` | Drizzle schema, migrations, typed query helpers. | `drizzle-orm`, `postgres` |
| `plugins/*` | Built-in plugin implementations. | `@jiku/kit` |
| `apps/playground` | Wire semua, contoh step-by-step init dan run. | semua |

---

## 4. Core Types — `@jiku/types`

```typescript
// packages/types/src/index.ts

// ============================================================
// MODE
// ============================================================

export type AgentMode = 'chat' | 'task'

// ============================================================
// TOOL
// ============================================================

export interface ToolMeta {
  id: string            // raw id, tanpa prefix. contoh: 'create_post'
  name: string
  description: string
}

export interface ToolDefinition {
  meta: ToolMeta
  permission: string    // '*' | 'post:write' | dll. raw, tanpa prefix plugin
  modes: AgentMode[]    // ['chat', 'task'] | ['chat'] | ['task'] — tool jalan di mode apa
  input: ZodSchema
  execute: (args: unknown, ctx: ToolContext) => Promise<unknown>
  prompt?: string       // optional hint untuk system prompt
}

// Setelah di-load PluginLoader, tool punya id + permission yang sudah di-prefix
export interface ResolvedTool extends ToolDefinition {
  resolved_id: string         // 'jiku.social:create_post'
  resolved_permission: string // 'jiku.social:post:write' | '*'
  plugin_id: string           // 'jiku.social'
}

// ============================================================
// PLUGIN
// ============================================================

export interface PluginMeta {
  id: string            // 'jiku.social' — ini yang jadi prefix untuk semua tool + permission
  name: string
  version: string
  description?: string
}

export interface PluginSetupContext {
  tools: {
    register: (...tools: ToolDefinition[]) => void
  }
  prompt: {
    inject: (segment: string | (() => Promise<string>)) => void
  }
  hooks: HookAPI
  storage: PluginStorageAPI   // scoped per plugin per project
  provide: <K extends keyof RuntimeContext>(
    key: K,
    factory: (ctx: CallerContext) => RuntimeContext[K]
  ) => void
}

export interface PluginDefinition {
  meta: PluginMeta
  dependencies?: string[]
  setup: (ctx: PluginSetupContext) => void
  onActivated?: (ctx: CallerContext) => void | Promise<void>
  onDeactivated?: () => void | Promise<void>
}

// ============================================================
// AGENT
// ============================================================

export interface AgentMeta {
  id: string            // 'social_manager'
  name: string
  description?: string
}

export interface AgentDefinition {
  meta: AgentMeta
  base_prompt: string
  allowed_modes: AgentMode[]
  // Permission auto-generate dari meta.id:
  //   chat mode → '{meta.id}:chat'
  //   task mode → '{meta.id}:task'
  // Default: '*' (semua boleh akses)
}

// ============================================================
// POLICY & RULES
// ============================================================

export type PolicyEffect = 'allow' | 'deny'
export type ResourceType = 'agent' | 'tool'
export type SubjectType = 'role' | 'permission'

export interface PolicyRule {
  resource_type: ResourceType
  resource_id: string       // 'jiku.social:delete_post' | 'social_manager:task'
  subject_type: SubjectType
  subject: string           // 'admin' | 'jiku.social:post:delete'
  effect: PolicyEffect
  priority?: number         // higher = evaluated first. default: 0
}

// ============================================================
// CALLER — di-pass saat run(), dari JWT / DB / memory
// ============================================================

export interface CallerContext {
  user_id: string
  roles: string[]           // ['admin', 'member']
  permissions: string[]     // ['jiku.social:post:write', 'social_manager:task']
  user_data: Record<string, unknown>
  // contoh user_data:
  // {
  //   name: 'Budi',
  //   email: 'budi@example.com',
  //   company_id: 'comp-123',
  //   project_id: 'proj-456',
  //   plan: 'pro',
  //   avatar_url: '...',
  // }
}

// ============================================================
// RUNTIME CONTEXT — dapat diakses oleh tools saat execute
// ============================================================

export interface RuntimeContext {
  caller: CallerContext     // full caller context termasuk user_data
  agent: {
    id: string
    name: string
    mode: AgentMode         // mode yang sedang jalan
  }
  conversation_id: string
  // plugin namespaces di-inject via ctx.provide():
  // ctx.social, ctx.finance, dll
  [key: string]: unknown
}

export interface ToolContext {
  runtime: RuntimeContext
  storage: PluginStorageAPI
}

// ============================================================
// CONVERSATION — chat dan task sama-sama conversation
// ============================================================

export type ConversationMode = AgentMode  // 'chat' | 'task'

export interface Conversation {
  id: string
  agent_id: string
  mode: ConversationMode    // beda mode → beda system prompt + environment
  title?: string
  status: 'active' | 'completed' | 'failed'
  // task-specific fields (null kalau mode === 'chat')
  goal?: string             // task goal
  output?: unknown          // task output artifact
  created_at: Date
  updated_at: Date
}

export interface Message {
  id: string
  conversation_id: string
  role: 'user' | 'assistant' | 'tool'
  content: MessageContent[]
  created_at: Date
}

export type MessageContent =
  | { type: 'text'; text: string }
  | { type: 'tool_call'; tool_id: string; args: unknown }
  | { type: 'tool_result'; tool_id: string; result: unknown }
  | { type: 'data'; name: string; value: unknown }

// ============================================================
// RUNTIME OPTIONS — di-pass saat init JikuRuntime
// ============================================================

export interface JikuRuntimeOptions {
  plugins: PluginLoader
  storage: JikuStorageAdapter
  rules?: PolicyRule[]      // optional, default kosong (all allow)
}

// ============================================================
// RUN PARAMS — di-pass saat runtime.run()
// ============================================================

export interface JikuRunParams {
  agent_id: string
  caller: CallerContext     // dari JWT / DB / memory — layer aplikasi yang resolve
  mode: AgentMode
  input: string
  conversation_id?: string  // lanjut conversation existing, atau buat baru
}

// ============================================================
// RESOLVED SCOPE — hasil resolver
// ============================================================

export interface ResolvedScope {
  accessible: boolean
  allowed_modes: AgentMode[]
  active_tools: ResolvedTool[]
  system_prompt: string
  denial_reason?: string    // kalau accessible: false
}

// ============================================================
// ADAPTERS — interface untuk implementasi di luar core
// ============================================================

export interface JikuStorageAdapter {
  // Conversation
  getConversation(id: string): Promise<Conversation | null>
  createConversation(data: Omit<Conversation, 'id' | 'created_at' | 'updated_at'>): Promise<Conversation>
  updateConversation(id: string, updates: Partial<Conversation>): Promise<Conversation>
  listConversations(agent_id: string): Promise<Conversation[]>

  // Messages
  getMessages(conversation_id: string, opts?: { limit?: number; offset?: number }): Promise<Message[]>
  addMessage(conversation_id: string, message: Omit<Message, 'id' | 'created_at'>): Promise<Message>
  deleteMessages(conversation_id: string, ids: string[]): Promise<void>

  // Plugin storage (scoped per plugin per project)
  pluginGet(scope: string, key: string): Promise<unknown>
  pluginSet(scope: string, key: string, value: unknown): Promise<void>
  pluginDelete(scope: string, key: string): Promise<void>
  pluginKeys(scope: string, prefix?: string): Promise<string[]>
}

export interface PluginStorageAPI {
  get(key: string): Promise<unknown>
  set(key: string, value: unknown): Promise<void>
  delete(key: string): Promise<void>
  keys(prefix?: string): Promise<string[]>
}

export interface HookAPI {
  hook(event: string, handler: (payload: unknown) => Promise<void>): void
  callHook(event: string, payload?: unknown): Promise<void>
}
```

---

## 5. Plugin SDK — `@jiku/kit`

```typescript
// packages/kit/src/index.ts

import type { ToolDefinition, PluginDefinition, AgentDefinition, ToolContext, RuntimeContext } from '@jiku/types'

// Factory functions — hanya untuk type safety dan DX
export function definePlugin(def: PluginDefinition): PluginDefinition {
  return def
}

export function defineTool(def: ToolDefinition): ToolDefinition {
  return def
}

export function defineAgent(def: AgentDefinition): AgentDefinition {
  return def
}

// Helper untuk akses RuntimeContext dari dalam tool
export function getJikuContext(toolCtx: ToolContext): RuntimeContext {
  return toolCtx.runtime
}
```

### Cara Plugin Author Menulis Plugin

```typescript
// plugins/jiku.social/index.ts
import { definePlugin, defineTool } from '@jiku/kit'
import { z } from 'zod'

export default definePlugin({
  meta: {
    id: 'jiku.social',
    name: 'Social Media Manager',
    version: '1.0.0',
  },

  setup(ctx) {
    ctx.tools.register(

      defineTool({
        meta: { id: 'list_post', name: 'List Posts', description: 'List all posts' },
        permission: '*',              // semua boleh — default
        modes: ['chat', 'task'],      // jalan di semua mode
        input: z.object({ limit: z.number().optional() }),
        execute: async (args, ctx) => {
          // ctx.runtime.caller.user_data tersedia di sini
          return { posts: [] }
        }
      }),

      defineTool({
        meta: { id: 'create_post', name: 'Create Post', description: 'Create a new post' },
        permission: 'post:write',     // → resolved: 'jiku.social:post:write'
        modes: ['chat', 'task'],      // jalan di semua mode
        input: z.object({
          content: z.string(),
          platform: z.enum(['twitter', 'instagram']),
        }),
        execute: async (args, ctx) => {
          const { company_id } = ctx.runtime.caller.user_data
          return { id: 'post-123', company_id, ...args }
        }
      }),

      defineTool({
        meta: { id: 'delete_post', name: 'Delete Post', description: 'Delete a post' },
        permission: 'post:delete',    // → resolved: 'jiku.social:post:delete'
        modes: ['chat'],              // hanya di chat mode, tidak bisa di task
        input: z.object({ post_id: z.string() }),
        execute: async (args, ctx) => {
          return { deleted: true, post_id: args.post_id }
        }
      }),

    )

    // Optional: inject context ke namespace
    ctx.provide('social', (caller) => ({
      getPlatformConfig: () => ({ api_key: '...' }),
    }))
  }
})
```

---

## 6. Core Runtime — `@jiku/core`

### 6.1 File Structure

```
packages/core/src/
├── index.ts
├── runtime.ts          JikuRuntime — container utama
├── runner.ts           AgentRunner — satu per agent
├── resolver/
│   ├── scope.ts        resolveScope() — pure function
│   ├── access.ts       checkAccess() — pure function
│   └── prompt.ts       buildSystemPrompt()
├── plugins/
│   ├── loader.ts       PluginLoader — 3-phase boot
│   ├── registry.ts     SharedRegistry
│   ├── dependency.ts   topological sort (Kahn's algorithm)
│   └── hooks.ts        HookAPI wrapper
└── storage/
    └── memory.ts       MemoryStorageAdapter — untuk testing
```

### 6.2 JikuRuntime

```typescript
// packages/core/src/runtime.ts

export class JikuRuntime {
  private _agents: Map<string, AgentRunner> = new Map()
  private _rules: PolicyRule[]

  constructor(private options: JikuRuntimeOptions) {
    this._rules = options.rules ?? []
  }

  // Register agent → instantiate AgentRunner
  addAgent(def: AgentDefinition): void {
    const runner = new AgentRunner(def, this.options.plugins, this.options.storage)
    this._agents.set(def.meta.id, runner)
  }

  removeAgent(agent_id: string): void {
    this._agents.delete(agent_id)
  }

  // Update rules tanpa restart
  // Dipanggil layer aplikasi kalau admin ubah policy
  updateRules(rules: PolicyRule[]): void {
    this._rules = rules
  }

  // Entry point utama
  async run(params: JikuRunParams): Promise<void> {
    const runner = this._agents.get(params.agent_id)
    if (!runner) throw new Error(`Agent '${params.agent_id}' not found`)

    await runner.run({
      ...params,
      rules: this._rules,   // pass rules dari runtime state
    })
  }

  // Boot semua plugins
  async boot(): Promise<void> {
    await this.options.plugins.boot()
  }

  async stop(): Promise<void> {
    await this.options.plugins.stop()
  }
}
```

### 6.3 AgentRunner

```typescript
// packages/core/src/runner.ts

export class AgentRunner {
  constructor(
    private agent: AgentDefinition,
    private plugins: PluginLoader,
    private storage: JikuStorageAdapter,
  ) {}

  async run(params: JikuRunParams & { rules: PolicyRule[] }): Promise<void> {
    const { caller, mode, input, conversation_id, rules } = params

    // 1. Resolve scope — pure, no IO
    const allTools = this.plugins.getResolvedTools()
    const scope = resolveScope({
      caller,
      agent: this.agent,
      rules,
      all_tools: allTools,
      mode,
    })

    if (!scope.accessible) {
      throw new JikuAccessError(scope.denial_reason ?? 'Access denied')
    }

    if (!scope.allowed_modes.includes(mode)) {
      throw new JikuAccessError(`Mode '${mode}' not allowed for this caller`)
    }

    // Filter tools berdasarkan mode yang sedang jalan
    const modeTools = scope.active_tools.filter(t => t.modes.includes(mode))

    // 2. Get or create conversation
    let conversation = conversation_id
      ? await this.storage.getConversation(conversation_id)
      : null

    if (!conversation) {
      conversation = await this.storage.createConversation({
        agent_id: this.agent.meta.id,
        mode,
        status: 'active',
        goal: mode === 'task' ? input : undefined,
      })
    }

    // 3. Build runtime context — di-inject ke semua tools
    const runtimeCtx: RuntimeContext = {
      caller,
      agent: { id: this.agent.meta.id, name: this.agent.meta.name, mode },
      conversation_id: conversation.id,
      ...this.plugins.resolveProviders(caller),  // inject ctx.social, ctx.finance, dll
    }

    // 4. Build system prompt
    // Chat: conversational prompt
    // Task: goal-oriented prompt, more autonomous
    const systemPrompt = buildSystemPrompt({
      base: this.agent.base_prompt,
      mode,
      active_tools: modeTools,
      caller,
      plugin_segments: this.plugins.getPromptSegments(),
    })

    // 5. Get history
    const messages = await this.storage.getMessages(conversation.id)

    // 6. Run LLM loop
    await this.runLoop({
      system_prompt: systemPrompt,
      messages,
      tools: modeTools,
      input,
      conversation,
      runtime_ctx: runtimeCtx,
    })
  }
}
```

---

## 7. Permission & Policy System

### 7.1 Cara Permission Bekerja

```
Tool define permission (raw)     → 'post:write'
PluginLoader prefix saat load    → 'jiku.social:post:write'
Rules menggunakan resolved id    → { subject: 'jiku.social:post:write', ... }
Caller pass permissions[]        → ['jiku.social:post:write']
Resolver cocokkan keduanya       → allow / deny
```

### 7.2 Agent Permission

Agent auto-expose permission untuk setiap mode:

```
Agent id: 'social_manager'
  chat mode → permission: 'social_manager:chat'
  task mode → permission: 'social_manager:task'
```

Default `*` — semua bisa akses. Rules masuk hanya kalau mau restrict.

### 7.3 Resolver Logic

```typescript
// packages/core/src/resolver/scope.ts

export function resolveScope(params: {
  caller: CallerContext
  agent: AgentDefinition
  rules: PolicyRule[]
  all_tools: ResolvedTool[]
  mode: AgentMode
}): ResolvedScope {
  const { caller, agent, rules, all_tools, mode } = params

  // --- Cek agent accessible ---
  const agentResource = `${agent.meta.id}:${mode}`
  const agentAccessible = checkAccess({
    resource_type: 'agent',
    resource_id: agentResource,
    caller,
    rules,
  })

  if (!agentAccessible) {
    return { accessible: false, denial_reason: `No access to agent '${agent.meta.id}'`, allowed_modes: [], active_tools: [], system_prompt: '' }
  }

  // --- Filter modes ---
  const allowed_modes = agent.allowed_modes.filter(m =>
    checkAccess({ resource_type: 'agent', resource_id: `${agent.meta.id}:${m}`, caller, rules })
  )

  // --- Filter tools ---
  const active_tools = all_tools.filter(tool =>
    checkAccess({ resource_type: 'tool', resource_id: tool.resolved_id, caller, rules })
  )

  return {
    accessible: true,
    allowed_modes,
    active_tools,
    system_prompt: '',  // diisi oleh buildSystemPrompt
  }
}

export function checkAccess(params: {
  resource_type: ResourceType
  resource_id: string
  caller: CallerContext
  rules: PolicyRule[]
}): boolean {
  const { resource_type, resource_id, caller, rules } = params

  // Filter rules yang relevan
  const relevant = rules
    .filter(r => r.resource_type === resource_type && r.resource_id === resource_id)
    .sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0))

  // Tidak ada rules → default ALLOW (fallback *)
  if (relevant.length === 0) return true

  // Evaluasi rules — deny takes priority
  for (const rule of relevant) {
    const match =
      rule.subject_type === 'role'
        ? caller.roles.includes(rule.subject)
        : caller.permissions.includes(rule.subject)

    if (match && rule.effect === 'deny') return false
    if (match && rule.effect === 'allow') return true
  }

  // Ada rules tapi tidak ada yang match caller
  // → resource sudah di-restrict, caller tidak masuk kriteria → DENY
  return false
}
```

### 7.4 Tabel Skenario

| Rules | Caller | Result |
|-------|--------|--------|
| Tidak ada rules | siapapun | ✅ allow (default `*`) |
| `allow` untuk `role:admin` | caller role `admin` | ✅ allow |
| `allow` untuk `role:admin` | caller role `member` | ❌ deny |
| `deny` untuk `role:viewer` | caller role `viewer` | ❌ deny |
| `deny` untuk `role:viewer` | caller role `admin` | ✅ allow (tidak match) |

---

## 8. Context System

### 8.1 Hierarki Context

```
CallerContext (dari run params)
  ├── user_id
  ├── roles[]
  ├── permissions[]
  └── user_data{}           ← bebas shape, layer aplikasi yang define

RuntimeContext (dibangun oleh AgentRunner)
  ├── caller: CallerContext  ← full caller termasuk user_data
  ├── agent: { id, name, mode }
  ├── conversation_id
  └── [plugin namespaces]   ← ctx.social, ctx.finance, dll via provide()

ToolContext (dapat diakses tool saat execute)
  ├── runtime: RuntimeContext
  └── storage: PluginStorageAPI  ← scoped per plugin
```

### 8.2 Plugin Context Provider

```typescript
// Di plugin setup:
ctx.provide('social', (caller) => ({
  getConfig: () => ({ api_key: process.env.SOCIAL_API_KEY }),
  getPlatformForUser: () => caller.user_data.preferred_platform,
}))

// Di tool execute:
execute: async (args, ctx) => {
  const social = ctx.runtime.social  // type-safe via module augmentation
  const config = social.getConfig()
}
```

### 8.3 Module Augmentation (Type Safety)

```typescript
// Di plugin, extend RuntimeContext
declare module '@jiku/types' {
  interface RuntimeContext {
    social: {
      getConfig: () => { api_key: string }
      getPlatformForUser: () => string
    }
  }
}
```

---

## 9. Conversation & Mode System

### 9.1 Chat dan Task = Sama-sama Conversation

Keduanya menyimpan data yang sama. Bedanya hanya:

| | Chat Mode | Task Mode |
|--|-----------|-----------|
| **System prompt** | Conversational, helpful | Goal-oriented, autonomous |
| **Environment** | Interactive, user input per turn | Background, fire-and-forget |
| **Input** | Pesan dari user | Goal / objective |
| **Output** | Stream ke user | Output artifact di conversation |
| **`goal` field** | null | Terisi |
| **`status`** | Selalu `active` | `pending → running → completed/failed` |

### 9.2 System Prompt Builder

```typescript
// packages/core/src/resolver/prompt.ts

export function buildSystemPrompt(params: {
  base: string
  mode: AgentMode
  active_tools: ResolvedTool[]
  caller: CallerContext
  plugin_segments: string[]
}): string {
  const { base, mode, active_tools, caller, plugin_segments } = params

  const modeInstruction = mode === 'chat'
    ? 'You are having a conversation with the user. Be helpful and responsive.'
    : 'You are working autonomously on a goal. Complete the task thoroughly and produce a clear output.'

  const userCtx = `Current user: ${caller.user_data.name ?? caller.user_id} (${caller.roles.join(', ')})`

  const toolHints = active_tools
    .filter(t => t.prompt)
    .map(t => t.prompt)
    .join('\n')

  const pluginCtx = plugin_segments.join('\n')

  return [base, modeInstruction, userCtx, toolHints, pluginCtx]
    .filter(Boolean)
    .join('\n\n')
}
```

---

## 10. Plugin System

### 10.1 3-Phase Boot (dari SenkenNeo, dipertahankan)

```
Phase 1 — Scan
  Import semua plugin definitions
  Extract meta + dependencies

Phase 2 — Sort
  Topological sort via Kahn's algorithm
  Disable plugin kalau dependency missing

Phase 3 — Load
  Panggil setup(ctx) untuk setiap plugin
  Register tools, prompt segments, providers, hooks
```

### 10.2 Auto-Prefix saat Load

```typescript
// PluginLoader.load() — saat process tool registration
private prefixTool(plugin_id: string, tool: ToolDefinition): ResolvedTool {
  return {
    ...tool,
    plugin_id,
    resolved_id: `${plugin_id}:${tool.meta.id}`,
    resolved_permission: tool.permission === '*'
      ? '*'
      : `${plugin_id}:${tool.permission}`,
  }
}
```

### 10.3 Tool Mode Filtering

```typescript
// Tool hanya masuk ke active_tools kalau mode-nya match
const modeTools = scope.active_tools.filter(t => t.modes.includes(mode))

// Contoh:
defineTool({ modes: ['chat', 'task'] })  // jalan di semua mode
defineTool({ modes: ['chat'] })          // hanya chat
defineTool({ modes: ['task'] })          // hanya task
```

---

## 11. Adapter Pattern

### 11.1 Storage Adapter

Core tidak tahu implementasi storage. Layer aplikasi inject adapter:

```typescript
// Untuk testing — in-memory
import { MemoryStorageAdapter } from '@jiku/core/storage'
const storage = new MemoryStorageAdapter()

// Untuk production — postgres (future @jiku/adapter-postgres)
import { PostgresStorageAdapter } from '@jiku/adapter-postgres'
const storage = new PostgresStorageAdapter({ connection_string: '...' })

// Inject ke runtime
const runtime = new JikuRuntime({ storage, plugins, rules })
```

### 11.2 Rules sebagai Data

Rules bukan hardcoded — layer aplikasi yang load dari mana saja:

```typescript
// Dari memory (hardcoded untuk testing)
const rules: PolicyRule[] = [...]

// Dari DB (production)
const rules = await db.query.policy_rules.findMany({ where: ... })

// Inject ke runtime
const runtime = new JikuRuntime({ rules, ... })

// Update tanpa restart
runtime.updateRules(newRules)
```

### 11.3 Caller dari Mana Saja

```typescript
// Dari JWT token
const caller = decodeJWT(token)  // { user_id, roles, permissions, user_data }

// Dari DB
const user = await db.query.users.findFirst({ where: { id: userId } })
const perms = await getUserPermissions(userId, companyId)
const caller: CallerContext = {
  user_id: user.id,
  roles: [user.role],
  permissions: perms,
  user_data: { name: user.name, company_id: companyId, ... }
}

// Hardcoded untuk testing
const caller: CallerContext = {
  user_id: 'user-admin',
  roles: ['admin'],
  permissions: ['jiku.social:post:write', 'jiku.social:post:delete'],
  user_data: { name: 'Admin User', company_id: 'comp-123' }
}
```

---

## 12. Playground App

### 12.1 Tujuan

`apps/playground/index.ts` — satu file, step-by-step init dan run untuk testing tanpa server atau DB.

### 12.2 Flow

```typescript
// apps/playground/index.ts

// ============================================
// Step 1 — Init plugin loader + register plugins
// ============================================
const plugins = new PluginLoader()
plugins.register(socialPlugin)
await plugins.boot()
// Output: "jiku.social loaded — 3 tools registered"

// ============================================
// Step 2 — Define agents
// ============================================
const socialAgent = defineAgent({
  meta: { id: 'social_manager', name: 'Social Media Manager' },
  base_prompt: 'You are a social media manager. Help users manage their posts.',
  allowed_modes: ['chat', 'task'],
})

// ============================================
// Step 3 — Define rules (in-memory, simulasi dari DB)
// Kosong = semua default allow
// ============================================
const rules: PolicyRule[] = [
  // delete_post: hanya admin
  {
    resource_type: 'tool',
    resource_id: 'jiku.social:delete_post',
    subject_type: 'role',
    subject: 'admin',
    effect: 'allow',
  },
  // task mode social_manager: butuh permission khusus
  {
    resource_type: 'agent',
    resource_id: 'social_manager:task',
    subject_type: 'permission',
    subject: 'social_manager:task',
    effect: 'allow',
  },
]

// ============================================
// Step 4 — Init runtime + add agents
// ============================================
const runtime = new JikuRuntime({
  plugins,
  storage: new MemoryStorageAdapter(),
  rules,
})

runtime.addAgent(socialAgent)
await runtime.boot()

// ============================================
// Step 5 — Run sebagai Admin (semua tools aktif)
// ============================================
await runtime.run({
  agent_id: 'social_manager',
  caller: {
    user_id: 'user-admin',
    roles: ['admin'],
    permissions: ['social_manager:task', 'jiku.social:post:write', 'jiku.social:post:delete'],
    user_data: { name: 'Admin', company_id: 'comp-123' },
  },
  mode: 'chat',
  input: 'list semua post dan hapus post pertama',
})
// Active tools: list_post, create_post, delete_post ✓

// ============================================
// Step 6 — Run sebagai Member (tools terbatas)
// ============================================
await runtime.run({
  agent_id: 'social_manager',
  caller: {
    user_id: 'user-member',
    roles: ['member'],
    permissions: [],
    user_data: { name: 'Member', company_id: 'comp-123' },
  },
  mode: 'chat',
  input: 'tolong list semua post',
})
// Active tools: list_post ✓ (delete_post tidak ada karena rules deny non-admin)

// ============================================
// Step 7 — Update rules tanpa restart
// ============================================
runtime.updateRules([
  ...rules,
  {
    resource_type: 'tool',
    resource_id: 'jiku.social:create_post',
    subject_type: 'role',
    subject: 'member',
    effect: 'allow',
  },
])
// Sekarang member juga bisa create_post

// ============================================
// Step 8 — Task mode
// ============================================
await runtime.run({
  agent_id: 'social_manager',
  caller: {
    user_id: 'user-admin',
    roles: ['admin'],
    permissions: ['social_manager:task'],
    user_data: { name: 'Admin', company_id: 'comp-123' },
  },
  mode: 'task',
  input: 'Buatkan 5 post untuk campaign product launch minggu ini di Instagram dan Twitter',
})
// Task mode: agent jalan autonomous, hasilkan output artifact
```

---

## 13. Data Flow

### 13.1 Init Flow

```
plugins.register(plugin)
  ↓
plugins.boot()
  ├─ Phase 1: scan & extract meta + deps
  ├─ Phase 2: topological sort
  └─ Phase 3: setup(ctx)
       ├─ ctx.tools.register() → prefixed tools tersimpan di loader
       ├─ ctx.provide()        → context factories tersimpan
       └─ ctx.prompt.inject()  → prompt segments tersimpan

runtime = new JikuRuntime({ plugins, storage, rules })
runtime.addAgent(agentDef) → new AgentRunner(agentDef, plugins, storage)
await runtime.boot()
```

### 13.2 Run Flow

```
runtime.run(params)
  ↓
AgentRunner.run({ ...params, rules })
  ├─ resolveScope(caller, agent, rules, allTools, mode)
  │    ├─ checkAccess(agent resource)    → accessible?
  │    ├─ checkAccess(per tool)          → active_tools[]
  │    └─ filter tools by mode           → modeTools[]
  │
  ├─ get/create conversation (via storage adapter)
  │
  ├─ build RuntimeContext
  │    ├─ caller (full, termasuk user_data)
  │    ├─ agent { id, name, mode }
  │    ├─ conversation_id
  │    └─ plugin providers (ctx.social, dll)
  │
  ├─ buildSystemPrompt(base, mode, activeTools, caller, pluginSegments)
  │
  ├─ storage.getMessages(conversation_id)
  │
  └─ LLM loop (streamText)
       ├─ tool call → execute(args, { runtime: runtimeCtx, storage: pluginStorage })
       ├─ tool result → lanjut loop
       └─ done → storage.addMessage() → output
```

### 13.3 Rules Update Flow

```
Layer aplikasi (admin ubah policy di UI)
  ↓
DB update policy_rules
  ↓
Layer aplikasi fetch rules baru
  ↓
runtime.updateRules(newRules)  ← tidak perlu restart
  ↓
Run berikutnya otomatis pakai rules baru
```

---

## Catatan Implementasi

- **Bun runtime** — semua packages menggunakan Bun sebagai runtime dan package manager
- **Vercel AI SDK** — untuk LLM loop (`streamText`, `tool`)
- **Zod** — untuk tool input schema validation
- **hookable (UnJS)** — untuk plugin hook system
- **AI Provider** — multi-provider via Vercel AI SDK (Anthropic, OpenAI, Google)
- **`@jiku/core` zero DB** — tidak ada import drizzle atau postgres di core
- **`@jiku/kit` zero runtime deps** — hanya `@jiku/types` sebagai dependency

---

*Generated: 2026-04-04 | Status: Planning / Pre-implementation*