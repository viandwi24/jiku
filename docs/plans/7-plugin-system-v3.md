# Plan 7 — Plugin System V3 + Plugin Management UI

> Status: **PLANNING**
> Date: 2026-04-05
> Depends on: Plan 6 (Agent Conversation System)

---

## Daftar Isi

1. [Scope & Goals](#1-scope--goals)
2. [Plugin Categories](#2-plugin-categories)
3. [Revised Plugin Definition](#3-revised-plugin-definition)
4. [Setup Context — Final Design](#4-setup-context--final-design)
5. [Plugin Lifecycle](#5-plugin-lifecycle)
6. [Tool & Prompt Resolution per Project](#6-tool--prompt-resolution-per-project)
7. [Config Schema System](#7-config-schema-system)
8. [Core Changes](#8-core-changes)
9. [DB Schema](#9-db-schema)
10. [Server Changes](#10-server-changes)
11. [Studio Web — Plugin UI](#11-studio-web--plugin-ui)
12. [Built-in Plugins](#12-built-in-plugins)
13. [File Changes](#13-file-changes)
14. [Implementation Checklist](#14-implementation-checklist)

---

## 1. Scope & Goals

### Features

| Feature | Description | Priority |
|---------|-------------|----------|
| Plugin categories | System vs Project-scoped | P1 |
| `ctx.project.tools` / `ctx.project.prompt` | Namespaced registration | P1 |
| Remove `ctx.provide` | Replaced by `contributes` | P1 |
| Project plugin activation | Enable/disable per project | P1 |
| `configSchema` (Zod) | Per-project plugin config | P1 |
| `onProjectPluginActivated/Deactivated` | Project lifecycle hooks | P1 |
| Plugin management UI | Active + Marketplace tabs | P1 |
| Dynamic config form | JSON Schema → shadcn form | P1 |
| Built-in plugins update | jiku.cron, jiku.social, jiku.skills | P2 |

### Key Decisions

- **`ctx.provide` dihapus** — `contributes` sudah cover semua use case dengan type safety yang lebih baik
- **`ctx.project.tools` dan `ctx.project.prompt`** — namespace baru, behavior tergantung `project_scope` di meta
- **System plugin** — tidak ada `project_scope: true` → tools/prompt langsung aktif semua project
- **Project-scoped plugin** — `project_scope: true` → default MATI, hanya aktif kalau project enable

---

## 2. Plugin Categories

### System Plugin

```typescript
definePlugin({
  meta: {
    id: 'jiku.memory',
    name: 'Persistent Memory',
    // Tidak ada project_scope → system plugin
  },
  setup(ctx) {
    // Langsung aktif SEMUA project tanpa terkecuali
    ctx.project.tools.register(memoryTool)
    ctx.project.prompt.inject('You have persistent memory...')
  }
})
```

**Karakteristik:**
- Tidak kelihatan di Plugin UI (tidak bisa di-disable)
- Tools dan prompt langsung inject ke semua project
- `onProjectPluginActivated` tetap bisa ada (untuk per-project init)

### Project-Scoped Plugin

```typescript
definePlugin({
  meta: {
    id: 'jiku.social',
    name: 'Social Media Manager',
    project_scope: true,   // ← ini yang membedakan
  },
  setup(ctx) {
    // Default MATI — hanya aktif kalau project enable plugin ini
    ctx.project.tools.register(listPostTool, createPostTool)
    ctx.project.prompt.inject('You have social media tools...')
  }
})
```

**Karakteristik:**
- Kelihatan di Plugin UI (Marketplace → bisa di-activate)
- Tools dan prompt hanya inject ke project yang enable
- Bisa di-configure per project via `configSchema`

---

## 3. Revised Plugin Definition

### `@jiku/types` — PluginMeta

```typescript
export interface PluginMeta {
  id: string
  name: string
  version: string
  description?: string
  author?: string
  icon?: string             // lucide icon name atau URL
  category?: string         // 'productivity' | 'communication' | 'finance' | dll

  // NEW
  project_scope?: boolean   // default false = system plugin
}
```

### `definePlugin` — Setup Context Types

```typescript
// packages/kit/src/define.ts

export function definePlugin<
  Deps extends PluginDependency[] = [],
  TContributes extends ContributesValue = {},
  TConfig extends z.ZodObject<any> = z.ZodObject<{}>
>(def: {
  meta: PluginMeta
  depends?: [...Deps]
  contributes?: Contributes<TContributes>

  // configSchema hanya relevan kalau project_scope: true
  configSchema?: TConfig

  setup: (ctx: PluginSetupContext<MergeContributes<[...Deps]> & TContributes>) => void
  //                               ↑ own contributes + dep contributes merged

  // Project lifecycle
  onProjectPluginActivated?: (
    projectId: string,
    ctx: ProjectPluginContext<z.infer<TConfig>>
  ) => void | Promise<void>

  onProjectPluginDeactivated?: (
    projectId: string,
    ctx: ProjectPluginContext<z.infer<TConfig>>
  ) => void | Promise<void>

  // Server lifecycle
  onServerStop?: (
    ctx: PluginSetupContext<MergeContributes<[...Deps]> & TContributes>
  ) => void | Promise<void>

}): PluginDefinition<TContributes, z.infer<TConfig>>
```

---

## 4. Setup Context — Final Design

### `PluginSetupContext<TContributes>`

```typescript
export interface PluginSetupContext<TContributes = {}> extends TContributes {
  // ── PROJECT-SCOPED REGISTRATION ──────────────────────
  // Behavior tergantung plugin.meta.project_scope:
  //   false/undefined → langsung aktif semua project (system)
  //   true            → hanya aktif kalau project enable plugin ini
  project: {
    tools: {
      register: (...tools: ToolDefinition[]) => void
    }
    prompt: {
      inject: (segment: string | (() => Promise<string>)) => void
    }
  }

  // ── GLOBAL EVENT BUS ─────────────────────────────────
  // Selalu aktif, untuk komunikasi antar plugin
  hooks: HookAPI

  // ── GLOBAL STORAGE ───────────────────────────────────
  // Scoped per plugin, persists
  storage: PluginStorageAPI

  // ── OWN + DEP CONTRIBUTES ────────────────────────────
  // Merged dari contributes plugin ini + contributes dep plugins
  // Typed via generic TContributes
  // (e.g., ctx.scheduler dari own contributes)
}
```

### `ProjectPluginContext<TConfig>`

```typescript
export interface ProjectPluginContext<TConfig = {}> {
  projectId: string

  // Config yang sudah diisi user, typed dari configSchema
  // Kalau tidak ada configSchema → TConfig = {} → config = {}
  config: TConfig

  // Storage scoped ke project + plugin ini
  // ctx.storage.get('key') → data untuk project ini saja
  storage: PluginStorageAPI

  // Global event bus
  hooks: HookAPI
}
```

### Contoh Penggunaan

```typescript
const JikuCronPlugin = definePlugin({
  meta: { id: 'jiku.cron', name: 'Cron Scheduler', project_scope: true },

  contributes: async () => {
    const scheduler = new CronScheduler()
    return { scheduler }
  },

  configSchema: z.object({
    timezone: z.string().default('UTC')
      .describe('Timezone for all cron jobs'),
    max_jobs: z.number().int().min(1).max(100).default(20)
      .describe('Maximum concurrent cron jobs'),
  }),

  setup(ctx) {
    // ctx.scheduler → dari own contributes, typed otomatis
    ctx.scheduler.start()

    // Project-scoped — hanya aktif kalau project enable jiku.cron
    ctx.project.tools.register(
      defineTool({ meta: { id: 'cron_create' }, ... }),
      defineTool({ meta: { id: 'cron_list' }, ... }),
    )
    ctx.project.prompt.inject('You can schedule tasks with cron expressions...')
  },

  onProjectPluginActivated: async (projectId, ctx) => {
    // ctx.config.timezone → typed dari configSchema
    // ctx.config.max_jobs → typed
    const jobs = await ctx.storage.getData<CronJob[]>('jobs') ?? []
    for (const job of jobs) {
      ctx.scheduler.addJob(projectId, job, {
        timezone: ctx.config.timezone
      })
    }
  },

  onProjectPluginDeactivated: async (projectId, ctx) => {
    await ctx.scheduler.removeAllJobs(projectId)
  },

  onServerStop: async (ctx) => {
    await ctx.scheduler.stop()
  },
})
```

---

## 5. Plugin Lifecycle

### Boot Flow

```
Server start
  ↓
PluginLoader.boot()
  Phase 1: scan — collect all plugin definitions
  Phase 2: circular detection → topological sort
  Phase 3: untuk setiap plugin (sorted):
    a. resolve contributes → cache globally
    b. build setup ctx (base + own contributes + dep contributes)
    c. plugin.setup(ctx)
       → ctx.project.tools.register() → stored in loader, tagged with plugin.id
       → ctx.project.prompt.inject()  → stored in loader, tagged with plugin.id
       → ctx.hooks.hook()             → stored globally
    d. log: "[jiku] ✓ Plugin 'jiku.cron' loaded"
  ↓
runtimeManager.bootAll()
  → untuk setiap project:
      wakeUp(projectId)
```

### wakeUp(projectId) — Single Entry Point

```
runtimeManager.wakeUp(projectId)
  ↓
1. Load project data dari DB
2. Load enabled plugins untuk project ini:
   SELECT plugin_id, config FROM project_plugins
   WHERE project_id = ? AND enabled = true
3. Untuk setiap enabled plugin:
   a. Load plugin definition dari PluginLoader
   b. Build ProjectPluginContext (projectId, config, storage)
   c. plugin.onProjectPluginActivated(projectId, ctx)
4. Build JikuRuntime dengan resolved tools + prompts:
   tools = getResolvedTools(projectId)  ← filter by system + enabled project plugins
   runtime.addAgent(...)
5. runtime.boot()
```

### User Enable Plugin di UI

```
POST /api/projects/:pid/plugins/:pluginId/enable
  { config: { timezone: 'Asia/Jakarta', max_jobs: 10 } }
  ↓
1. Validate config against plugin.configSchema
2. Upsert project_plugins: { enabled: true, config }
3. runtimeManager.activatePlugin(projectId, pluginId, config)
   → build ProjectPluginContext
   → plugin.onProjectPluginActivated(projectId, ctx)
4. runtimeManager.syncProjectTools(projectId)
   → rebuild tools/prompt untuk project ini
   → runtime.updatePlugins(activeTools, activePrompts)
```

### User Disable Plugin di UI

```
POST /api/projects/:pid/plugins/:pluginId/disable
  ↓
1. Update project_plugins: { enabled: false }
2. runtimeManager.deactivatePlugin(projectId, pluginId)
   → plugin.onProjectPluginDeactivated(projectId, ctx)
3. runtimeManager.syncProjectTools(projectId)
   → rebuild tools/prompt tanpa plugin ini
```

---

## 6. Tool & Prompt Resolution per Project

### `getResolvedTools(projectId)`

```typescript
// packages/core/src/plugins/loader.ts

getResolvedTools(projectId: string): ResolvedTool[] {
  const enabledPluginIds = this._projectEnabledPlugins.get(projectId) ?? new Set()

  return this._registeredTools.filter(tool => {
    const plugin = this._pluginById.get(tool.plugin_id)
    if (!plugin) return false

    // System plugin → selalu aktif
    if (!plugin.meta.project_scope) return true

    // Project-scoped plugin → hanya kalau enabled
    return enabledPluginIds.has(tool.plugin_id)
  })
}

getPromptSegments(projectId: string): string[] {
  const enabledPluginIds = this._projectEnabledPlugins.get(projectId) ?? new Set()

  return this._registeredPrompts
    .filter(p => {
      const plugin = this._pluginById.get(p.plugin_id)
      if (!plugin) return false
      if (!plugin.meta.project_scope) return true
      return enabledPluginIds.has(p.plugin_id)
    })
    .map(p => typeof p.segment === 'function' ? p.segment() : p.segment)
}

// Dipanggil saat project enable/disable plugin
setProjectEnabledPlugins(projectId: string, pluginIds: string[]): void {
  this._projectEnabledPlugins.set(projectId, new Set(pluginIds))
}
```

---

## 7. Config Schema System

### Plugin Define Schema

```typescript
configSchema: z.object({
  timezone: z.string()
    .default('UTC')
    .describe('Timezone for cron jobs'),
  max_jobs: z.number().int().min(1).max(100).default(20)
    .describe('Maximum concurrent jobs'),
  retry_on_failure: z.boolean().default(true)
    .describe('Retry failed jobs automatically'),
})
```

### Server Expose JSON Schema

```typescript
// GET /api/plugins/:id/config-schema
import { zodToJsonSchema } from 'zod-to-json-schema'

const jsonSchema = zodToJsonSchema(plugin.configSchema, {
  name: plugin.meta.id,
  target: 'jsonSchema7',
})
// Response:
// {
//   type: 'object',
//   properties: {
//     timezone: { type: 'string', default: 'UTC', description: '...' },
//     max_jobs: { type: 'number', minimum: 1, maximum: 100, default: 20, description: '...' },
//     retry_on_failure: { type: 'boolean', default: true, description: '...' }
//   }
// }
```

### UI Build Dynamic Form dari JSON Schema

```typescript
// components/plugin/plugin-config-form.tsx
// Pakai react-jsonschema-form atau custom implementation

export function PluginConfigForm({ schema, defaultValues, onSubmit }) {
  // Iterate schema.properties
  // Render field sesuai type:
  //   string  → Input atau Select (kalau ada enum)
  //   number  → Input type=number dengan min/max
  //   boolean → Switch
  //   array   → Tambah/hapus items

  return (
    <form onSubmit={handleSubmit(onSubmit)}>
      {Object.entries(schema.properties).map(([key, field]) => (
        <DynamicField key={key} fieldKey={key} schema={field} />
      ))}
      <Button type="submit">Save Configuration</Button>
    </form>
  )
}

function DynamicField({ fieldKey, schema }) {
  switch (schema.type) {
    case 'string':
      return (
        <div className="space-y-1.5">
          <Label>{fieldKey}</Label>
          {schema.description && (
            <p className="text-xs text-muted-foreground">{schema.description}</p>
          )}
          <Input defaultValue={schema.default} {...register(fieldKey)} />
        </div>
      )
    case 'number':
      return (
        <div className="space-y-1.5">
          <Label>{fieldKey}</Label>
          <Input
            type="number"
            min={schema.minimum}
            max={schema.maximum}
            defaultValue={schema.default}
            {...register(fieldKey, { valueAsNumber: true })}
          />
        </div>
      )
    case 'boolean':
      return (
        <div className="flex items-center justify-between">
          <div>
            <Label>{fieldKey}</Label>
            {schema.description && (
              <p className="text-xs text-muted-foreground">{schema.description}</p>
            )}
          </div>
          <Switch defaultChecked={schema.default} {...register(fieldKey)} />
        </div>
      )
  }
}
```

---

## 8. Core Changes

### `packages/types/src/index.ts`

```typescript
// Tambah ke PluginMeta:
project_scope?: boolean

// Tambah interface baru:
PluginSetupContext<TContributes>  // replace existing PluginSetupContext
ProjectPluginContext<TConfig>

// Hapus:
// ctx.provide dari PluginSetupContext

// Update PluginDefinition:
interface PluginDefinition<TContributes, TConfig> {
  // ... existing fields ...
  configSchema?: z.ZodObject<any>
  onProjectPluginActivated?: (projectId: string, ctx: ProjectPluginContext<TConfig>) => void | Promise<void>
  onProjectPluginDeactivated?: (projectId: string, ctx: ProjectPluginContext<TConfig>) => void | Promise<void>
  onServerStop?: (ctx: PluginSetupContext<TContributes>) => void | Promise<void>
}
```

### `packages/core/src/plugins/loader.ts`

```typescript
// Tambah:
private _projectEnabledPlugins: Map<string, Set<string>> = new Map()
private _registeredTools: RegisteredTool[]   // dengan plugin_id tag
private _registeredPrompts: RegisteredPrompt[] // dengan plugin_id tag

// Revisi:
// ctx.project.tools.register → stored dengan plugin_id
// ctx.project.prompt.inject  → stored dengan plugin_id

// Tambah methods:
getResolvedTools(projectId: string): ResolvedTool[]
getPromptSegments(projectId: string): string[]
setProjectEnabledPlugins(projectId: string, pluginIds: string[]): void
activatePlugin(projectId: string, pluginId: string, config: unknown): Promise<void>
deactivatePlugin(projectId: string, pluginId: string): Promise<void>

// Hapus:
// provide() dan semua terkait ctx.provide
```

### `packages/kit/src/define.ts`

```typescript
// Update definePlugin generic:
// Tambah TConfig generic
// Update setup ctx type → PluginSetupContext<MergeContributes & TContributes>
// setup ctx include ctx.project.tools dan ctx.project.prompt
// Hapus ctx.provide dari setup ctx
```

---

## 9. DB Schema

```typescript
// apps/studio/db/src/schema/plugins.ts

// Plugin registry — semua plugin yang tersedia
export const plugins = pgTable('plugins', {
  id:          varchar('id', { length: 255 }).primaryKey(),  // 'jiku.cron'
  name:        varchar('name', { length: 255 }).notNull(),
  description: text('description'),
  version:     varchar('version', { length: 50 }).notNull(),
  author:      varchar('author', { length: 255 }),
  icon:        varchar('icon', { length: 255 }),
  category:    varchar('category', { length: 100 }),
  project_scope: boolean('project_scope').default(false),
  // JSON Schema dari zodToJsonSchema(plugin.configSchema)
  config_schema: jsonb('config_schema').default({}),
  created_at:  timestamp('created_at').defaultNow(),
})

// Project plugin activation
export const project_plugins = pgTable('project_plugins', {
  id:           uuid('id').primaryKey().defaultRandom(),
  project_id:   uuid('project_id').references(() => projects.id).notNull(),
  plugin_id:    varchar('plugin_id', { length: 255 })
                  .references(() => plugins.id).notNull(),
  enabled:      boolean('enabled').default(false),
  // Config yang sudah divalidasi oleh configSchema
  config:       jsonb('config').default({}),
  activated_at: timestamp('activated_at'),
  updated_at:   timestamp('updated_at').defaultNow(),
}, t => ({
  uq: unique().on(t.project_id, t.plugin_id)
}))
```

---

## 10. Server Changes

### Plugin Registry Seed

```typescript
// apps/studio/server/src/plugins/seed.ts
// Saat server boot, sync plugin registry ke DB

async function seedPluginRegistry(loader: PluginLoader): Promise<void> {
  const plugins = loader.getAllPlugins()

  for (const plugin of plugins) {
    await db.insert(pluginsTable)
      .values({
        id: plugin.meta.id,
        name: plugin.meta.name,
        description: plugin.meta.description,
        version: plugin.meta.version,
        author: plugin.meta.author ?? 'Jiku',
        icon: plugin.meta.icon,
        category: plugin.meta.category,
        project_scope: plugin.meta.project_scope ?? false,
        config_schema: plugin.configSchema
          ? zodToJsonSchema(plugin.configSchema)
          : {},
      })
      .onConflictDoUpdate({
        target: pluginsTable.id,
        set: { name, version, config_schema, ... }
      })
  }
}
```

### New API Routes

```
# Plugin registry
GET  /api/plugins                          → list semua plugins
GET  /api/plugins/:id                      → detail plugin
GET  /api/plugins/:id/config-schema        → JSON Schema untuk dynamic form

# Project plugin management
GET  /api/projects/:pid/plugins            → list semua plugins + status (enabled/disabled)
GET  /api/projects/:pid/plugins/active     → hanya yang enabled
POST /api/projects/:pid/plugins/:id/enable → enable + validate + save config
POST /api/projects/:pid/plugins/:id/disable → disable
PATCH /api/projects/:pid/plugins/:id/config → update config (re-validate)
```

### `JikuRuntimeManager` — New Methods

```typescript
// Dipanggil saat user enable plugin dari UI
async activatePlugin(projectId: string, pluginId: string, config: unknown): Promise<void> {
  const runtime = this.getRuntime(projectId)
  if (!runtime) return

  // Trigger lifecycle hook
  await this._loader.activatePlugin(projectId, pluginId, config)

  // Rebuild tools + prompts untuk project ini
  await this.syncProjectTools(projectId)
}

// Dipanggil saat user disable plugin dari UI
async deactivatePlugin(projectId: string, pluginId: string): Promise<void> {
  const runtime = this.getRuntime(projectId)
  if (!runtime) return

  await this._loader.deactivatePlugin(projectId, pluginId)
  await this.syncProjectTools(projectId)
}

// Rebuild active tools + prompts setelah plugin enable/disable
async syncProjectTools(projectId: string): Promise<void> {
  const runtime = this.getRuntime(projectId)
  if (!runtime) return

  const activeTools = this._loader.getResolvedTools(projectId)
  const activePrompts = this._loader.getPromptSegments(projectId)
  runtime.updatePluginContext(activeTools, activePrompts)
}
```

---

## 11. Studio Web — Plugin UI

### Route

```
/studio/companies/[company]/projects/[project]/plugins
/studio/companies/[company]/projects/[project]/plugins/[pluginId]
```

### Project Sidebar — Update

```typescript
// Tambah "Plugins" antara Chats dan Settings
{
  href: '/plugins',
  label: 'Plugins',
  icon: Puzzle,
  badge: activePluginCount,  // jumlah plugin yang enabled
}
```

### Plugins Page Layout — 2 Tabs

```
┌─────────────────────────────────────────────────────────┐
│ Project Sidebar │  Plugins                              │
│                 │                                       │
│ ○ Dashboard     │  [Active Plugins] [Marketplace]       │
│ ○ Agents    4   │  ─────────────────────────────────── │
│ ○ Chats         │                                       │
│ ● Plugins   2   │  (tab content)                        │
│ ○ Settings      │                                       │
└─────────────────────────────────────────────────────────┘
```

### Tab 1 — Active Plugins (VS Code / JetBrains style)

```
┌──────────────────────────────────────────────────────────┐
│ Active Plugins (2)                                       │
├────────────────────┬─────────────────────────────────────┤
│                    │                                     │
│ ● Cron Scheduler   │  Cron Scheduler                    │
│   jiku.cron v1.0   │  by Jiku · v1.0.0 · productivity  │
│                    │                                     │
│ ● Social Media     │  Schedule and automate tasks using │
│   jiku.social v1.0 │  cron expressions. Supports        │
│                    │  standard cron syntax and human-   │
│                    │  readable shortcuts like            │
│                    │  "every 5m" or "every 1h".         │
│                    │                                     │
│                    │  ─────────────────────────────────  │
│                    │  Configuration                      │
│                    │                                     │
│                    │  Timezone                           │
│                    │  [Asia/Jakarta________________]     │
│                    │  Timezone for all cron jobs         │
│                    │                                     │
│                    │  Max Jobs                           │
│                    │  [20_____]  (1–100)                │
│                    │                                     │
│                    │  Retry on failure                   │
│                    │  [Toggle ON]                        │
│                    │                                     │
│                    │  [Save Configuration]               │
│                    │                                     │
│                    │  ─────────────────────────────────  │
│                    │                 [Disable Plugin ×]  │
└────────────────────┴─────────────────────────────────────┘
```

### Active Plugins — Component

```typescript
// components/plugin/active-plugins.tsx

export function ActivePlugins({ projectId }) {
  const { data: activePlugins } = useActivePlugins(projectId)
  const [selectedId, setSelectedId] = useState(activePlugins?.[0]?.id)
  const selected = activePlugins?.find(p => p.id === selectedId)

  return (
    <ResizablePanelGroup direction="horizontal">
      {/* Left — plugin list */}
      <ResizablePanel defaultSize={30} minSize={20} maxSize={40}>
        <ScrollArea className="h-full">
          {activePlugins?.map(plugin => (
            <button
              key={plugin.id}
              onClick={() => setSelectedId(plugin.id)}
              className={cn(
                "w-full flex items-center gap-2.5 px-3 py-2.5 text-left",
                "hover:bg-muted/50 border-b border-border/40",
                selectedId === plugin.id && "bg-muted border-l-2 border-l-primary"
              )}
            >
              <div className={cn(
                "h-2 w-2 rounded-full shrink-0",
                plugin.enabled ? "bg-green-500" : "bg-muted-foreground"
              )} />
              <div className="min-w-0">
                <p className="text-sm font-medium truncate">{plugin.name}</p>
                <p className="text-xs text-muted-foreground">
                  {plugin.id} v{plugin.version}
                </p>
              </div>
            </button>
          ))}
        </ScrollArea>
      </ResizablePanel>

      <ResizableHandle />

      {/* Right — plugin detail + config */}
      <ResizablePanel defaultSize={70}>
        {selected && (
          <ScrollArea className="h-full">
            <PluginDetail plugin={selected} projectId={projectId} />
          </ScrollArea>
        )}
      </ResizablePanel>
    </ResizablePanelGroup>
  )
}
```

### Plugin Detail Panel

```typescript
// components/plugin/plugin-detail.tsx

export function PluginDetail({ plugin, projectId }) {
  return (
    <div className="p-6 space-y-6">
      {/* Header */}
      <div className="flex items-start gap-3">
        <div className="h-10 w-10 rounded-lg bg-muted flex items-center justify-center">
          <Puzzle className="h-5 w-5 text-muted-foreground" />
        </div>
        <div className="flex-1">
          <h2 className="font-semibold text-lg">{plugin.name}</h2>
          <p className="text-sm text-muted-foreground">
            by {plugin.author} · v{plugin.version} · {plugin.category}
          </p>
        </div>
        <Badge variant="outline" className="text-green-600 border-green-300">
          Active
        </Badge>
      </div>

      <p className="text-sm text-muted-foreground">{plugin.description}</p>

      <Separator />

      {/* Config form — hanya kalau ada configSchema */}
      {plugin.config_schema && Object.keys(plugin.config_schema.properties ?? {}).length > 0 && (
        <div>
          <h3 className="font-medium mb-4">Configuration</h3>
          <PluginConfigForm
            schema={plugin.config_schema}
            defaultValues={plugin.config}
            onSubmit={(config) => saveConfig(projectId, plugin.id, config)}
          />
        </div>
      )}

      <Separator />

      {/* Danger zone */}
      <div className="flex justify-end">
        <Button
          variant="outline"
          className="text-destructive border-destructive/30 hover:bg-destructive/5"
          onClick={() => disablePlugin(projectId, plugin.id)}
        >
          <X className="h-4 w-4 mr-2" />
          Disable Plugin
        </Button>
      </div>
    </div>
  )
}
```

### Tab 2 — Marketplace (App Store style)

```
┌──────────────────────────────────────────────────────────┐
│ Marketplace                                              │
│                                                          │
│ 🔍 Search plugins...                                    │
│                                                          │
│ [All] [Productivity] [Communication] [Finance] [Tools]  │
│                                                          │
│ ┌──────────────┐ ┌──────────────┐ ┌──────────────┐     │
│ │ 🕐           │ │ 📱           │ │ 🗂           │     │
│ │ Cron         │ │ Social Media │ │ Skills       │     │
│ │ Scheduler    │ │ Manager      │ │ & SOPs       │     │
│ │              │ │              │ │              │     │
│ │ Schedule and │ │ Manage posts │ │ Inject SOPs  │     │
│ │ automate     │ │ across       │ │ into agent   │     │
│ │ tasks...     │ │ platforms... │ │ context...   │     │
│ │              │ │              │ │              │     │
│ │ by Jiku      │ │ by Jiku      │ │ by Jiku      │     │
│ │ v1.0.0       │ │ v1.0.0       │ │ v1.0.0       │     │
│ │              │ │              │ │              │     │
│ │ ✓ Active     │ │ [Activate]   │ │ [Activate]   │     │
│ └──────────────┘ └──────────────┘ └──────────────┘     │
└──────────────────────────────────────────────────────────┘
```

### Marketplace — Activate Flow

```
User klik [Activate] di marketplace card
  ↓
Kalau plugin punya configSchema dengan required fields:
  → Buka Dialog dengan PluginConfigForm
  → User isi config → Submit

Kalau tidak ada config (atau semua optional):
  → Langsung activate dengan default values

Setelah activate:
  → POST /api/projects/:pid/plugins/:id/enable
  → Success toast: "Cron Scheduler activated"
  → Pindah ke tab "Active Plugins"
  → Plugin langsung aktif (tools inject ke agent)
```

### Marketplace Component

```typescript
// components/plugin/marketplace.tsx

export function Marketplace({ projectId }) {
  const [search, setSearch] = useState('')
  const [category, setCategory] = useState('all')
  const { data: allPlugins } = useAllPlugins()
  const { data: activePlugins } = useActivePlugins(projectId)
  const activeIds = new Set(activePlugins?.map(p => p.id))

  const filtered = allPlugins?.filter(p =>
    p.project_scope &&   // hanya tampilkan project-scoped plugins
    (category === 'all' || p.category === category) &&
    (p.name.toLowerCase().includes(search.toLowerCase()) ||
     p.description?.toLowerCase().includes(search.toLowerCase()))
  )

  return (
    <div className="p-6 space-y-4">
      {/* Search + filter */}
      <div className="flex items-center gap-3">
        <div className="relative flex-1">
          <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder="Search plugins..."
            className="pl-9"
            value={search}
            onChange={e => setSearch(e.target.value)}
          />
        </div>
      </div>

      {/* Category tabs */}
      <div className="flex gap-2 flex-wrap">
        {CATEGORIES.map(cat => (
          <Button
            key={cat.id}
            variant={category === cat.id ? 'default' : 'outline'}
            size="sm"
            onClick={() => setCategory(cat.id)}
          >
            {cat.label}
          </Button>
        ))}
      </div>

      {/* Plugin cards grid */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
        {filtered?.map(plugin => (
          <MarketplaceCard
            key={plugin.id}
            plugin={plugin}
            isActive={activeIds.has(plugin.id)}
            projectId={projectId}
          />
        ))}
      </div>
    </div>
  )
}

// Marketplace card
function MarketplaceCard({ plugin, isActive, projectId }) {
  const [activateOpen, setActivateOpen] = useState(false)
  const hasRequiredConfig = hasRequiredFields(plugin.config_schema)

  return (
    <Card className="flex flex-col">
      <CardContent className="pt-5 flex-1">
        <div className="flex items-start gap-3 mb-3">
          <div className="h-9 w-9 rounded-lg bg-muted flex items-center justify-center shrink-0">
            <Puzzle className="h-4.5 w-4.5 text-muted-foreground" />
          </div>
          <div>
            <h3 className="font-medium text-sm">{plugin.name}</h3>
            <p className="text-xs text-muted-foreground">
              by {plugin.author} · v{plugin.version}
            </p>
          </div>
        </div>
        <p className="text-xs text-muted-foreground line-clamp-3">
          {plugin.description}
        </p>
        {plugin.category && (
          <Badge variant="secondary" className="mt-3 text-xs">
            {plugin.category}
          </Badge>
        )}
      </CardContent>
      <CardFooter className="pt-0">
        {isActive ? (
          <div className="flex items-center gap-1.5 text-xs text-green-600 w-full">
            <Check className="h-3.5 w-3.5" />
            Active
          </div>
        ) : (
          <Button
            size="sm"
            className="w-full"
            onClick={() => hasRequiredConfig
              ? setActivateOpen(true)
              : activatePlugin(projectId, plugin.id, {})
            }
          >
            Activate
          </Button>
        )}
      </CardFooter>

      {/* Config dialog kalau ada required fields */}
      <ActivatePluginDialog
        plugin={plugin}
        projectId={projectId}
        open={activateOpen}
        onOpenChange={setActivateOpen}
      />
    </Card>
  )
}
```

### Activate Plugin Dialog

```typescript
// components/plugin/activate-plugin-dialog.tsx

export function ActivatePluginDialog({ plugin, projectId, open, onOpenChange }) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Activate {plugin.name}</DialogTitle>
          <DialogDescription>
            Configure this plugin for your project before activating.
          </DialogDescription>
        </DialogHeader>

        <PluginConfigForm
          schema={plugin.config_schema}
          defaultValues={{}}
          onSubmit={async (config) => {
            await activatePlugin(projectId, plugin.id, config)
            onOpenChange(false)
            toast.success(`${plugin.name} activated`)
          }}
        />
      </DialogContent>
    </Dialog>
  )
}
```

---

## 12. Built-in Plugins

### Update Plugin Definitions

```typescript
// plugins/jiku.cron/index.ts
export default definePlugin({
  meta: {
    id: 'jiku.cron',
    name: 'Cron Scheduler',
    version: '1.0.0',
    description: 'Schedule and automate tasks using cron expressions.',
    author: 'Jiku',
    icon: 'Clock',
    category: 'productivity',
    project_scope: true,   // ← tambah ini
  },
  configSchema: z.object({
    timezone: z.string().default('UTC').describe('Timezone for cron jobs'),
    max_jobs: z.number().int().min(1).max(100).default(20).describe('Max concurrent jobs'),
  }),
  // ... setup, onProjectPluginActivated, dll
})

// plugins/jiku.social/index.ts
export default definePlugin({
  meta: {
    id: 'jiku.social',
    name: 'Social Media Manager',
    version: '1.0.0',
    description: 'Manage and publish posts across social media platforms.',
    author: 'Jiku',
    icon: 'Share2',
    category: 'communication',
    project_scope: true,
  },
  // ... setup
})

// plugins/jiku.skills/index.ts
export default definePlugin({
  meta: {
    id: 'jiku.skills',
    name: 'Skills & SOPs',
    version: '1.0.0',
    description: 'Inject standard operating procedures into agent context.',
    author: 'Jiku',
    icon: 'BookOpen',
    category: 'productivity',
    project_scope: true,
  },
  configSchema: z.object({
    skills_dir: z.string().default('./skills').describe('Directory containing skill markdown files'),
    max_inject: z.number().int().min(1).max(10).default(3).describe('Maximum skills to inject per run'),
  }),
  // ... setup
})
```

---

## 13. File Changes

### New Files

```
apps/studio/db/src/schema/plugins.ts
apps/studio/db/src/queries/plugin.ts

apps/studio/server/src/plugins/seed.ts
apps/studio/server/src/routes/plugins.ts

apps/studio/web/app/(app)/studio/.../plugins/
  page.tsx                       ← main plugins page (tabs)
  layout.tsx

apps/studio/web/components/plugin/
  active-plugins.tsx
  marketplace.tsx
  plugin-detail.tsx
  plugin-config-form.tsx
  dynamic-field.tsx
  marketplace-card.tsx
  activate-plugin-dialog.tsx
```

### Modified Files

```
packages/types/src/index.ts
  → PluginMeta: tambah project_scope, author, icon, category
  → PluginDefinition: tambah configSchema, onProjectPluginActivated/Deactivated, onServerStop
  → PluginSetupContext: tambah ctx.project.tools/prompt, hapus ctx.provide
  → Tambah ProjectPluginContext<TConfig>

packages/kit/src/define.ts
  → definePlugin: tambah TConfig generic, update setup ctx type

packages/core/src/plugins/loader.ts
  → ctx.project.tools.register / ctx.project.prompt.inject
  → getResolvedTools(projectId) — filter by system + enabled
  → getPromptSegments(projectId) — same filter
  → setProjectEnabledPlugins(projectId, pluginIds)
  → activatePlugin(projectId, pluginId, config)
  → deactivatePlugin(projectId, pluginId)
  → hapus provide() dan _providers

apps/studio/server/src/runtime/manager.ts
  → wakeUp() load enabled plugins + trigger onProjectPluginActivated
  → activatePlugin() / deactivatePlugin() / syncProjectTools()

apps/studio/server/src/index.ts
  → seedPluginRegistry() saat boot
  → mount pluginsRouter

apps/studio/web/components/sidebar/project-sidebar.tsx
  → Tambah Plugins item antara Chats dan Settings

apps/studio/web/lib/api.ts
  → api.plugins.* endpoints

packages/ui/src/index.ts
  → export plugin components
```

---

## 14. Implementation Checklist

### Core — Types & Kit

- [ ] `PluginMeta` — tambah `project_scope`, `author`, `icon`, `category`
- [ ] `PluginSetupContext` — tambah `ctx.project.tools`, `ctx.project.prompt`
- [ ] `PluginSetupContext` — hapus `ctx.provide`
- [ ] `ProjectPluginContext<TConfig>` — interface baru
- [ ] `PluginDefinition` — tambah `configSchema`, `onProjectPluginActivated`, `onProjectPluginDeactivated`, `onServerStop`
- [ ] `definePlugin` — update generic dengan `TConfig`, update setup ctx type

### Core — PluginLoader

- [ ] `ctx.project.tools.register()` — simpan dengan `plugin_id` tag
- [ ] `ctx.project.prompt.inject()` — simpan dengan `plugin_id` tag
- [ ] Hapus `ctx.provide` dan semua related code
- [ ] `getResolvedTools(projectId)` — filter system + enabled project plugins
- [ ] `getPromptSegments(projectId)` — sama
- [ ] `setProjectEnabledPlugins(projectId, pluginIds)`
- [ ] `activatePlugin(projectId, pluginId, config)` — trigger lifecycle
- [ ] `deactivatePlugin(projectId, pluginId)` — trigger lifecycle
- [ ] `getAllPlugins()` — untuk seed registry

### DB

- [ ] `plugins` table — registry
- [ ] `project_plugins` table — activation per project
- [ ] Query helpers: `getProjectPlugins`, `enablePlugin`, `disablePlugin`, `updatePluginConfig`
- [ ] Migration

### Server

- [ ] `seedPluginRegistry()` — sync plugin defs ke DB saat boot
- [ ] `GET /api/plugins` — list semua
- [ ] `GET /api/plugins/:id/config-schema` — JSON Schema
- [ ] `GET /api/projects/:pid/plugins` — list + status
- [ ] `GET /api/projects/:pid/plugins/active` — enabled only
- [ ] `POST /api/projects/:pid/plugins/:id/enable` — validate config + activate
- [ ] `POST /api/projects/:pid/plugins/:id/disable`
- [ ] `PATCH /api/projects/:pid/plugins/:id/config` — update config
- [ ] `wakeUp()` — load enabled plugins + `onProjectPluginActivated`
- [ ] `activatePlugin()`, `deactivatePlugin()`, `syncProjectTools()`
- [ ] Install `zod-to-json-schema` package

### Built-in Plugins — Update

- [ ] `jiku.cron` — tambah meta fields + `configSchema` + `onProjectPluginActivated/Deactivated`
- [ ] `jiku.social` — tambah meta fields + `project_scope: true`
- [ ] `jiku.skills` — tambah meta fields + `configSchema` + `project_scope: true`
- [ ] Migrate `ctx.tools.register` → `ctx.project.tools.register`
- [ ] Migrate `ctx.prompt.inject` → `ctx.project.prompt.inject`

### Studio Web — Plugin UI

- [ ] Project sidebar: tambah Plugins item (antara Chats dan Settings)
- [ ] `/plugins` page dengan 2 tabs (Active, Marketplace)
- [ ] `ActivePlugins` — ResizablePanelGroup: list kiri + detail kanan
- [ ] `PluginDetail` — info + config form + disable button
- [ ] `PluginConfigForm` — dynamic form dari JSON Schema
- [ ] `DynamicField` — string/number/boolean renderer
- [ ] `Marketplace` — search + category filter + card grid
- [ ] `MarketplaceCard` — info + Activate button
- [ ] `ActivatePluginDialog` — config form kalau ada required fields
- [ ] `api.plugins.*` endpoints di `lib/api.ts`

---

*Generated: 2026-04-05 | Status: Planning — Ready for Implementation*