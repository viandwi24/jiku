# Jiku Plugin System V2 — Planning Document

> Revisi dari foundation plan §10  
> Focus: Typed dependency injection, circular dep detection, context bridging  
> Status: **PLANNING**  
> Date: 2026-04-04

---

## Daftar Isi

1. [Overview & Motivasi](#1-overview--motivasi)
2. [Perubahan dari V1](#2-perubahan-dari-v1)
3. [Core Concepts](#3-core-concepts)
4. [Type System](#4-type-system)
5. [definePlugin V2](#5-defineplugin-v2)
6. [Dependency Resolution](#6-dependency-resolution)
7. [Circular Dependency Detection](#7-circular-dependency-detection)
8. [PluginLoader V2](#8-pluginloader-v2)
9. [Context Bridge Pattern](#9-context-bridge-pattern)
10. [Playground Implementation Plan](#10-playground-implementation-plan)
11. [File Changes](#11-file-changes)

---

## 1. Overview & Motivasi

### Problem di V1

Plugin system V1 menggunakan `dependencies: string[]` — hanya untuk sort priority via Kahn's algorithm. Tidak ada type safety antar plugin.

```typescript
// V1 — string only, no types
definePlugin({
  dependencies: ['senken.finance'],
  setup(ctx) {
    ctx.finance  // ← tidak ada types, harus tau sendiri
  }
})
```

### Solusi V2

Plugin bisa `depends` ke plugin lain via **string** (sort only) atau **instance** (sort + type inference). Plugin juga punya field `contributes` — untuk expose context ke dependent-nya.

`contributes` bisa berupa:
- **Object langsung** — paling simple
- **Sync function** — kalau perlu sedikit logic
- **Async function** — kalau perlu async init (connect DB, dll)

`contributes` dijalankan saat `boot()` sebelum `setup()` dipanggil — sehingga ctx sudah lengkap ketika `setup()` jalan. `contributes` tidak menerima `ctx` karena fungsinya murni expose sesuatu, bukan consume dari siapapun.

```typescript
// V2 — instance depends, ctx otomatis typed
import { JikuPluginServer } from '@jiku/plugin-server'

definePlugin({
  depends: [JikuPluginServer],
  setup(ctx) {
    ctx.server.get('/webhook', handler)  // ← fully typed
  }
})
```

---

## 2. Perubahan dari V1

### `@jiku/types`

| Yang Berubah | V1 | V2 |
|---|---|---|
| `PluginDefinition` | `dependencies?: string[]` | `depends?: PluginDependency[]` |
| `PluginDefinition` generic | tidak ada | `PluginDefinition<TContributes>` |
| `contributes` field | tidak ada | `contributes?: Contributes<TContributes>` |
| `PluginSetupContext` | fixed shape | `BasePluginContext & MergeContributes<Deps>` |

### `@jiku/kit`

| Yang Berubah | V1 | V2 |
|---|---|---|
| `definePlugin` | `(def) => def` | generic dengan type inference dari `depends[]` + return type `contributes` |

### `@jiku/core` — PluginLoader

| Yang Berubah | V1 | V2 |
|---|---|---|
| Input deps | `string[]` | `PluginDependency[]` (normalize ke string untuk sort) |
| Circular dep | tidak ada check | deteksi via DFS 3-color, throw `PluginCircularDepError` |
| Missing dep | disable plugin | disable + warning message detail |
| `contributes` resolve | tidak ada | resolve sebelum `setup()`, merge ke ctx |
| `override()` | tidak ada | inject implementasi actual untuk bridge pattern |

---

## 3. Core Concepts

### 3.1 `PluginDependency` — Dua Bentuk

```typescript
type PluginDependency = string | PluginDefinition<any>
```

| Bentuk | Contoh | Sort Priority | Type Inference |
|--------|--------|---------------|----------------|
| String | `'jiku.cron'` | ✅ | ❌ |
| Instance | `JikuPluginServer` | ✅ | ✅ |

**Kapan pakai string:**
- Plugin hanya perlu "load setelah X"
- Tidak butuh akses `ctx` dari dependency
- Dependency adalah plugin third-party tanpa type definitions

**Kapan pakai instance:**
- Plugin butuh akses `ctx.server`, `ctx.database`, dll dari dependency
- Mau dapat TypeScript error kalau salah pakai context

### 3.2 `contributes` — Tiga Bentuk

```typescript
// Bentuk 1 — object langsung (paling simple)
contributes: {
  server: { get: ..., post: ... }
}

// Bentuk 2 — sync function
contributes: () => ({
  server: { get: ..., post: ... }
})

// Bentuk 3 — async function (untuk yang perlu async init)
contributes: async () => {
  const client = await connectDatabase()
  return {
    database: {
      query: (sql: string) => client.query(sql),
    }
  }
}
```

**Rules:**
- `contributes` tidak menerima `ctx` parameter — fungsinya murni expose, bukan consume
- Kalau butuh ctx untuk setup sesuatu, itu ranah `setup(ctx)`
- Return value dari `contributes` → otomatis merge ke `ctx` dependent plugins

### 3.3 Boot Timing

```
register()
  → simpan plugin definitions + contributes reference (belum dijalankan)

boot()
  Phase 1 → scan + build dependency graph
  Phase 2 → circular detection → topological sort → missing detection
  Phase 3 → untuk setiap plugin (urut dari hasil sort):
               a. resolve contributes
                  object      → pakai langsung
                  () => T     → panggil, await hasilnya
                  () => P<T>  → panggil, await hasilnya
               b. cache hasil contributes
               c. build ctx = BasePluginContext + contributes dari semua instance deps
               d. jalankan setup(ctx)
```

### 3.4 Circular Dependency

```
A depends B → B depends C → C depends A  ← circular!

Tanpa deteksi → Kahn's algorithm infinite loop → server freeze
Dengan deteksi → throw PluginCircularDepError sebelum boot, pesan jelas
```

### 3.5 Bridge Pattern

```
@jiku/plugin-server (published)
  contributes → noop placeholder { server: {}, ws: {} }
  setup       → kosong

apps/studio-server
  loader.override('@jiku/plugin-server', {
    contributes: async () => ({ server: honoApp, ws: wsServer })
  })

Plugin yang depends @jiku/plugin-server
  → dapat ctx.server yang real (Hono)
  → tidak tahu implementasi dari mana
```

---

## 4. Type System

### 4.1 `Contributes` Type

```typescript
// packages/types/src/plugin.ts

type MaybePromise<T> = T | Promise<T>
type ContributesValue = Record<string, unknown>

// Tiga bentuk yang didukung
type Contributes<TValue extends ContributesValue> =
  | TValue                     // object langsung
  | (() => TValue)             // sync function
  | (() => Promise<TValue>)    // async function
```

### 4.2 Type Utilities

```typescript
// Extract TContributes dari PluginDefinition instance
type ExtractContributes<T> =
  T extends PluginDefinition<infer C> ? C : never

// Merge contributes dari semua instance deps
// String deps di-skip — tidak punya type info
type MergeContributes<Deps extends PluginDependency[]> =
  UnionToIntersection<
    ExtractContributes<Extract<Deps[number], PluginDefinition<any>>>
  >

// Standard helper
type UnionToIntersection<U> =
  (U extends any ? (x: U) => void : never) extends (x: infer I) => void
    ? I
    : never
```

### 4.3 PluginDefinition Generic

```typescript
interface PluginDefinition<
  TContributes extends ContributesValue = {}
> {
  meta: PluginMeta
  depends?: PluginDependency[]
  contributes?: Contributes<TContributes>
  setup: (ctx: BasePluginContext & TContributes) => void
  onActivated?: (runtimeCtx: RuntimeContext) => void | Promise<void>
  onDeactivated?: () => void | Promise<void>
}

type PluginDependency = string | PluginDefinition<any>
```

### 4.4 BasePluginContext

```typescript
// Selalu ada, tidak bergantung dependency apapun
interface BasePluginContext {
  tools: {
    register: (...tools: ToolDefinition[]) => void
  }
  prompt: {
    inject: (segment: string | (() => Promise<string>)) => void
  }
  hooks: HookAPI
  storage: PluginStorageAPI
}
```

---

## 5. definePlugin V2

### 5.1 Signature

```typescript
// packages/kit/src/define.ts

export function definePlugin<
  Deps extends PluginDependency[] = [],
  TContributes extends ContributesValue = {}
>(def: {
  meta: PluginMeta
  depends?: [...Deps]
  contributes?: Contributes<TContributes>
  setup: (ctx: BasePluginContext & MergeContributes<[...Deps]>) => void
  onActivated?: (runtimeCtx: RuntimeContext) => void | Promise<void>
  onDeactivated?: () => void | Promise<void>
}): PluginDefinition<TContributes> {
  return def as unknown as PluginDefinition<TContributes>
}
```

### 5.2 Contoh — Plugin expose context (object)

```typescript
export const MockServerPlugin = definePlugin({
  meta: { id: '@jiku/plugin-server', name: 'Server Bridge', version: '1.0.0' },

  // Object langsung — paling simple
  contributes: {
    server: {
      get: (path: string, handler: any) => {},
      post: (path: string, handler: any) => {},
    }
  },

  setup(ctx) {
    // ctx hanya BasePluginContext
  }
})
```

### 5.3 Contoh — Plugin expose context (async function)

```typescript
export const DatabasePlugin = definePlugin({
  meta: { id: 'jiku.database', name: 'Database', version: '1.0.0' },

  // Async — perlu init dulu
  contributes: async () => {
    const client = await connectDatabase()
    return {
      database: {
        query: async (sql: string) => client.query(sql),
        insert: async (table: string, data: unknown) => client.insert(table, data),
      }
    }
  },

  setup(ctx) {
    // ctx hanya BasePluginContext
    ctx.tools.register(...)
  }
})
```

### 5.4 Contoh — Plugin depends instance (dapat types)

```typescript
import { DatabasePlugin } from './database'

export const SocialPlugin = definePlugin({
  meta: { id: 'jiku.social', name: 'Social Media', version: '1.0.0' },
  depends: [DatabasePlugin],  // ← instance

  // SocialPlugin juga bisa contribute ke dependent-nya
  contributes: () => ({
    social: {
      getPlatforms: () => ['twitter', 'instagram'] as string[],
    }
  }),

  setup(ctx) {
    ctx.database.query('posts')  // ✅ typed — dari DatabasePlugin.contributes
    // ctx.social ❌ — itu yang DIA contribute ke orang lain, bukan yang DIA dapat

    ctx.tools.register(
      defineTool({
        meta: { id: 'list_post', name: 'List Posts', description: 'List all posts' },
        permission: '*',
        modes: ['chat', 'task'],
        input: z.object({ limit: z.number().optional() }),
        execute: async (args) => ({ posts: [] })
      })
    )
  }
})
```

### 5.5 Contoh — Mix string dan instance

```typescript
import { JikuPluginServer } from '@jiku/plugin-server'
import { SocialPlugin } from 'jiku.social'

export const WebhookPlugin = definePlugin({
  meta: { id: 'jiku.webhook', name: 'Webhook', version: '1.0.0' },
  depends: [
    'jiku.cron',       // string → sort only, load setelah cron
    JikuPluginServer,  // instance → ctx.server + ctx.ws
    SocialPlugin,      // instance → ctx.social
  ],
  setup(ctx) {
    ctx.server.get('/webhook', handler)  // ✅ typed
    ctx.ws.on('message', handler)        // ✅ typed
    ctx.social.getPlatforms()            // ✅ typed
    // ctx.cron ❌ — string dep, tidak ada types
  }
})
```

---

## 6. Dependency Resolution

### 6.1 Normalize Dependencies

```typescript
// packages/core/src/plugins/dependency.ts

function normalizeDeps(depends: PluginDependency[]): string[] {
  return depends.map(d =>
    typeof d === 'string' ? d : d.meta.id
  )
}

function getInstanceDeps(
  depends: PluginDependency[]
): PluginDefinition<any>[] {
  return depends.filter(
    (d): d is PluginDefinition<any> => typeof d !== 'string'
  )
}
```

### 6.2 PluginNode

```typescript
interface PluginNode {
  id: string
  def: PluginDefinition<any>
  deps: string[]                        // normalized, untuk sort
  instanceDeps: PluginDefinition<any>[] // untuk merge contributes ke ctx
}

function buildGraph(
  plugins: PluginDefinition<any>[]
): Map<string, PluginNode> {
  const graph = new Map<string, PluginNode>()
  for (const def of plugins) {
    graph.set(def.meta.id, {
      id: def.meta.id,
      def,
      deps: normalizeDeps(def.depends ?? []),
      instanceDeps: getInstanceDeps(def.depends ?? []),
    })
  }
  return graph
}
```

### 6.3 Resolve Contributes

```typescript
// Dijalankan di Phase 3 boot, sebelum setup() masing-masing plugin
async function resolveContributes(
  contributes: Contributes<any> | undefined
): Promise<Record<string, unknown>> {
  if (!contributes) return {}

  if (typeof contributes === 'function') {
    return await contributes()  // handle sync dan async sekaligus
  }

  return contributes  // object langsung
}
```

### 6.4 Missing Dependency Detection

```typescript
function detectMissing(
  graph: Map<string, PluginNode>
): Map<string, string[]> {
  const missing = new Map<string, string[]>()
  for (const [id, node] of graph) {
    const missingDeps = node.deps.filter(dep => !graph.has(dep))
    if (missingDeps.length > 0) missing.set(id, missingDeps)
  }
  return missing
}
```

---

## 7. Circular Dependency Detection

### 7.1 Algorithm — DFS 3-Color Marking

```
WHITE → belum dikunjungi
GRAY  → sedang di call stack (sedang diproses)
BLACK → sudah selesai

Kalau saat DFS ketemu node GRAY → ada cycle → throw error
```

```typescript
// packages/core/src/plugins/dependency.ts

type NodeColor = 'white' | 'gray' | 'black'

export class PluginCircularDepError extends Error {
  constructor(public cycle: string[]) {
    const path = [...cycle, cycle[0]].join(' → ')
    super(
      `Circular dependency detected: ${path}\n\n` +
      `Involved plugins:\n` +
      cycle.map(id => `  - ${id}`).join('\n') +
      `\n\nFix: Remove one of the dependencies to break the cycle.`
    )
    this.name = 'PluginCircularDepError'
  }
}

export function detectCircular(graph: Map<string, PluginNode>): void {
  const color = new Map<string, NodeColor>()
  for (const id of graph.keys()) color.set(id, 'white')

  const stack: string[] = []

  function dfs(id: string): void {
    color.set(id, 'gray')
    stack.push(id)

    const node = graph.get(id)
    if (!node) { stack.pop(); color.set(id, 'black'); return }

    for (const dep of node.deps) {
      if (color.get(dep) === 'gray') {
        const cycle = stack.slice(stack.indexOf(dep))
        throw new PluginCircularDepError(cycle)
      }
      if (color.get(dep) === 'white' && graph.has(dep)) {
        dfs(dep)
      }
    }

    stack.pop()
    color.set(id, 'black')
  }

  for (const id of graph.keys()) {
    if (color.get(id) === 'white') dfs(id)
  }
}
```

### 7.2 Contoh Output Error

```
PluginCircularDepError: Circular dependency detected:
  plugin.x → plugin.y → plugin.z → plugin.x

Involved plugins:
  - plugin.x
  - plugin.y
  - plugin.z

Fix: Remove one of the dependencies to break the cycle.
```

---

## 8. PluginLoader V2

### 8.1 Interface

```typescript
export interface PluginLoaderInterface {
  register(...plugins: PluginDefinition<any>[]): void
  override(pluginId: string, newDef: Partial<PluginDefinition<any>>): void
  boot(): Promise<void>
  stop(): Promise<void>
  isLoaded(id: string): boolean
  getLoadOrder(): string[]
  getResolvedTools(filter?: { modes?: AgentMode[] }): ResolvedTool[]
  getPromptSegments(): string[]
  resolveProviders(caller: CallerContext): Record<string, unknown>
}
```

### 8.2 Boot Flow Lengkap

```typescript
async boot(): Promise<void> {
  // Terapkan overrides
  const allDefs = [...this._plugins.values()].map(def => {
    const ov = this._overrides.get(def.meta.id)
    return ov ? { ...def, ...ov } : def
  })

  // Phase 1 — Build graph
  const graph = buildGraph(allDefs)

  // Phase 2a — Circular detection (throw kalau ada cycle)
  detectCircular(graph)

  // Phase 2b — Missing detection (warn + disable, lanjut boot)
  const missing = detectMissing(graph)
  for (const [id, missingDeps] of missing) {
    console.warn(
      `[jiku] ⚠ Plugin "${id}" disabled\n` +
      `  Reason: missing dependencies: ${missingDeps.join(', ')}`
    )
    graph.delete(id)
  }

  // Phase 2c — Topological sort
  const sorted = topoSort(graph)  // Kahn's algorithm

  // Phase 3 — Load (urut dari hasil sort)
  const contributesCache = new Map<string, Record<string, unknown>>()

  for (const id of sorted) {
    const node = graph.get(id)!

    // 3a: Resolve contributes plugin ini
    const contributed = await resolveContributes(node.def.contributes)
    contributesCache.set(id, contributed)

    // 3b: Merge contributes dari semua instance deps
    const mergedFromDeps: Record<string, unknown> = {}
    for (const instanceDep of node.instanceDeps) {
      const depContributes = contributesCache.get(instanceDep.meta.id) ?? {}
      Object.assign(mergedFromDeps, depContributes)
    }

    // 3c: Build ctx dan jalankan setup
    const ctx = this.buildSetupContext(node, mergedFromDeps)
    node.def.setup(ctx)

    console.log(`[jiku] ✓ Plugin "${id}" loaded`)
  }
}
```

### 8.3 Override Method

```typescript
// Partial override — bisa ganti hanya contributes, atau hanya setup, atau keduanya
override(
  pluginId: string,
  newDef: Partial<PluginDefinition<any>>
): void {
  this._overrides.set(pluginId, newDef)
}
```

---

## 9. Context Bridge Pattern

### 9.1 `@jiku/plugin-server` — Noop Plugin (Published)

```typescript
// Published sebagai @jiku/plugin-server
// Noop — contributes placeholder, studio yang override dengan actual

export interface ServerAPI {
  get: (path: string, handler: unknown) => void
  post: (path: string, handler: unknown) => void
  put: (path: string, handler: unknown) => void
  delete: (path: string, handler: unknown) => void
  use: (middleware: unknown) => void
}

export interface WebSocketAPI {
  on: (event: string, handler: (data: unknown) => void) => void
  emit: (event: string, data: unknown) => void
  broadcast: (event: string, data: unknown) => void
}

export const JikuPluginServer = definePlugin({
  meta: { id: '@jiku/plugin-server', name: 'Jiku Server Bridge', version: '1.0.0' },

  // Noop placeholder — shape ada, implementasi kosong
  contributes: () => ({
    server: {
      get: () => {}, post: () => {}, put: () => {},
      delete: () => {}, use: () => {},
    } as ServerAPI,
    ws: {
      on: () => {}, emit: () => {}, broadcast: () => {},
    } as WebSocketAPI,
  }),

  setup(ctx) {}  // noop
})
```

### 9.2 Studio Override — Inject Hono Actual

```typescript
// apps/studio-server/src/plugin-bridge.ts

export function createServerBridge(app: Hono, wsServer: WebSocketServer) {
  return {
    contributes: async () => ({
      server: {
        get: (path: string, h: any) => app.get(path, h),
        post: (path: string, h: any) => app.post(path, h),
        put: (path: string, h: any) => app.put(path, h),
        delete: (path: string, h: any) => app.delete(path, h),
        use: (mw: any) => app.use(mw),
      },
      ws: {
        on: (event: string, h: any) => wsServer.on(event, h),
        emit: (event: string, data: any) => wsServer.emit(event, data),
        broadcast: (event: string, data: any) => wsServer.broadcast(event, data),
      },
    })
  }
}

// Di bootstrap:
const loader = new PluginLoader()
loader.register(JikuPluginServer, WebhookPlugin)
loader.override('@jiku/plugin-server', createServerBridge(app, wsServer))
await loader.boot()
```

---

## 10. Playground Implementation Plan

`apps/playground/index.ts` — 7 steps, demo semua fitur V2.

### Step 1 — contributes async

```typescript
const DatabasePlugin = definePlugin({
  meta: { id: 'mock.database', name: 'Mock Database', version: '1.0.0' },
  contributes: async () => {
    await new Promise(r => setTimeout(r, 50))  // simulasi async init
    const store: Record<string, unknown[]> = {}
    return {
      database: {
        query: async (table: string) => store[table] ?? [],
        insert: async (table: string, data: unknown) => {
          store[table] = [...(store[table] ?? []), data]
        },
      }
    }
  },
  setup(ctx) { console.log('[mock.database] setup done') }
})
```

### Step 2 — depends instance (typed ctx)

```typescript
const SocialPlugin = definePlugin({
  meta: { id: 'jiku.social', name: 'Social Media', version: '1.0.0' },
  depends: [DatabasePlugin],
  contributes: () => ({
    social: { getPlatforms: () => ['twitter', 'instagram'] as string[] }
  }),
  setup(ctx) {
    ctx.database.query('posts')  // ✅ typed

    ctx.tools.register(
      defineTool({
        meta: { id: 'list_post', name: 'List Posts', description: 'List all posts' },
        permission: '*',
        modes: ['chat', 'task'],
        input: z.object({ limit: z.number().optional() }),
        execute: async () => ({ posts: [] })
      }),
      defineTool({
        meta: { id: 'create_post', name: 'Create Post', description: 'Create a post' },
        permission: 'post:write',
        modes: ['chat', 'task'],
        input: z.object({ content: z.string(), platform: z.string() }),
        execute: async (args) => ({ id: 'post-1', ...args })
      }),
    )
  }
})
```

### Step 3 — depends string (sort only)

```typescript
const AnalyticsPlugin = definePlugin({
  meta: { id: 'jiku.analytics', name: 'Analytics', version: '1.0.0' },
  depends: ['jiku.social'],  // string — sort only
  setup(ctx) {
    // ctx.database ❌, ctx.social ❌ — string dep, no types
    // tapi dijamin load SETELAH jiku.social
    console.log('[analytics] loaded after social ✓')
  }
})
```

### Step 4 — Circular dependency (error, tidak freeze)

```typescript
const PluginX = definePlugin({ meta: { id: 'plugin.x' }, depends: ['plugin.y'], setup() {} })
const PluginY = definePlugin({ meta: { id: 'plugin.y' }, depends: ['plugin.z'], setup() {} })
const PluginZ = definePlugin({ meta: { id: 'plugin.z' }, depends: ['plugin.x'], setup() {} })

console.log('\n--- Step 4: Circular dep detection ---')
try {
  const testLoader = new PluginLoader()
  testLoader.register(PluginX, PluginY, PluginZ)
  await testLoader.boot()
} catch (e) {
  if (e instanceof PluginCircularDepError) {
    console.error('[Expected]', e.message)
  }
}
// Output: Circular dependency detected: plugin.x → plugin.y → plugin.z → plugin.x
```

### Step 5 — Missing dependency (warning, plugin disabled)

```typescript
const OrphanPlugin = definePlugin({
  meta: { id: 'jiku.orphan' },
  depends: ['does.not.exist'],
  setup() { console.log('❌ tidak akan pernah dipanggil') }
})

console.log('\n--- Step 5: Missing dep ---')
const missingLoader = new PluginLoader()
missingLoader.register(OrphanPlugin)
await missingLoader.boot()
// Output: [jiku] ⚠ Plugin "jiku.orphan" disabled
//   Reason: missing dependencies: does.not.exist
```

### Step 6 — Override / bridge pattern

```typescript
const MockServerPlugin = definePlugin({
  meta: { id: '@jiku/plugin-server' },
  contributes: () => ({ server: { get: () => {} } }),
  setup(ctx) {}
})

const WebhookPlugin = definePlugin({
  meta: { id: 'jiku.webhook' },
  depends: [MockServerPlugin],
  setup(ctx) {
    ctx.server.get('/webhook', () => {  // ✅ typed
      console.log('[Webhook] handler called')
    })
  }
})

console.log('\n--- Step 6: Override bridge ---')
const routes: { method: string; path: string }[] = []
const bridgeLoader = new PluginLoader()
bridgeLoader.register(MockServerPlugin, WebhookPlugin)
bridgeLoader.override('@jiku/plugin-server', {
  contributes: () => ({
    server: {
      get: (path: string, handler: any) => {
        routes.push({ method: 'GET', path })
        console.log(`[ActualServer] GET ${path} registered`)
        handler()
      }
    }
  })
})
await bridgeLoader.boot()
console.log('Routes:', routes)
```

### Step 7 — Full runtime flow

```typescript
console.log('\n--- Step 7: Full runtime ---')

const plugins = new PluginLoader()
plugins.register(DatabasePlugin, SocialPlugin, AnalyticsPlugin)
await plugins.boot()

const runtime = new JikuRuntime({
  plugins,
  storage: new MemoryStorageAdapter(),
  rules: [],
})

runtime.addAgent(defineAgent({
  meta: { id: 'social_manager', name: 'Social Media Manager' },
  base_prompt: 'You are a social media manager.',
  allowed_modes: ['chat', 'task'],
}))

await runtime.boot()

const result = await runtime.run({
  agent_id: 'social_manager',
  caller: {
    user_id: 'user-admin',
    roles: ['admin'],
    permissions: ['jiku.social:post:write'],
    user_data: { name: 'Admin' }
  },
  mode: 'chat',
  input: 'list semua post yang ada',
})

for await (const chunk of result.stream) {
  if (chunk.type === 'text-delta') process.stdout.write(chunk.textDelta)
  if (chunk.type === 'data-jiku-usage') console.log('\n[Usage]', chunk.data)
}
```

---

## 11. File Changes

### Files yang Diubah

```
packages/types/src/index.ts
  → Tambah: MaybePromise<T>, ContributesValue, Contributes<TValue>
  → Tambah: PluginDependency = string | PluginDefinition<any>
  → Ubah:   PluginDefinition → generic PluginDefinition<TContributes>
  → Ubah:   dependencies: string[] → depends: PluginDependency[]
  → Tambah: contributes?: Contributes<TContributes>
  → Tambah: ExtractContributes, MergeContributes, UnionToIntersection

packages/kit/src/index.ts
  → Ubah: definePlugin<Deps, TContributes> — generic dengan type inference

packages/core/src/plugins/dependency.ts
  → Tambah: PluginNode interface (dengan instanceDeps)
  → Tambah: PluginCircularDepError
  → Tambah: detectCircular() — DFS 3-color
  → Ubah:   normalizeDeps() — handle PluginDependency[]
  → Tambah: getInstanceDeps()
  → Tambah: buildGraph()
  → Tambah: resolveContributes() — handle 3 bentuk

packages/core/src/plugins/loader.ts
  → Tambah: _overrides Map
  → Tambah: override() method
  → Ubah:   boot() — circular detection + contributes resolve + merge ctx
  → Ubah:   buildSetupContext() — merge contributes dari instanceDeps
```

### Files Tidak Berubah

```
packages/core/src/runtime.ts
packages/core/src/runner.ts
packages/core/src/resolver/*
packages/core/src/storage/memory.ts
packages/core/src/providers.ts
```

### Files Baru / Replace

```
apps/playground/index.ts   → replace dengan V2 demo (7 steps)
```

---

## Checklist Implementasi

### `@jiku/types`
- [ ] `MaybePromise<T>`, `ContributesValue`
- [ ] `Contributes<TValue>` — object | sync fn | async fn
- [ ] `PluginDependency = string | PluginDefinition<any>`
- [ ] `PluginDefinition<TContributes>` generic
- [ ] `depends?` field (replace `dependencies`)
- [ ] `contributes?` field
- [ ] `ExtractContributes`, `MergeContributes`, `UnionToIntersection`

### `@jiku/kit`
- [ ] `definePlugin<Deps, TContributes>` — generic
- [ ] setup ctx = `BasePluginContext & MergeContributes<Deps>`

### `@jiku/core` — `dependency.ts`
- [ ] `PluginNode` dengan `instanceDeps`
- [ ] `PluginCircularDepError` — pesan dengan cycle path + fix hint
- [ ] `detectCircular()` — DFS 3-color
- [ ] `normalizeDeps()` — string | instance
- [ ] `getInstanceDeps()` — filter instance saja
- [ ] `buildGraph()` → `Map<string, PluginNode>`
- [ ] `resolveContributes()` — object | fn | async fn

### `@jiku/core` — `loader.ts`
- [ ] `_overrides: Map<string, Partial<PluginDefinition<any>>>`
- [ ] `override()` method
- [ ] `boot()` phase 2a — `detectCircular()`
- [ ] `boot()` phase 2b — missing detection + warn
- [ ] `boot()` phase 3 — resolve contributes → merge → setup
- [ ] `buildSetupContext()` — merge contributes dari instanceDeps

### `apps/playground`
- [ ] Step 1 — contributes async
- [ ] Step 2 — depends instance (typed)
- [ ] Step 3 — depends string (sort only)
- [ ] Step 4 — circular dep detection
- [ ] Step 5 — missing dep warning
- [ ] Step 6 — override bridge pattern
- [ ] Step 7 — full runtime flow

---

*Generated: 2026-04-04 | Status: Planning — Ready for Implementation*