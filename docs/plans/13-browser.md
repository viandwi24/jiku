# Plan 13 — Browser Automation (Studio App Feature)

## Overview

Browser automation sebagai **fitur di layer app Studio**, bukan plugin. Cara kerjanya mirip dengan bagaimana `systemTools`, `memoryTools`, dan `connectorTools` bekerja di `manager.ts` — disuntikkan ke agent saat `wakeUp()` jika fitur aktif untuk project tersebut.

Config browser disimpan di `projects.browser_config` (jsonb column baru), dan ada toggle `projects.browser_enabled`. UI settings ada di project settings page. Saat project `wakeUp()`, jika browser enabled → start browser server → inject browser tools ke semua agent.

**Engine:** ported dari `refs-open-alice/src/openclaw/browser/` (63 TS files), hidup di `apps/studio/server/src/browser/`.

---

## Architecture

### Posisi di Layer

```
apps/studio/server/src/
  browser/                    ← NEW — browser engine (ported dari openclaw)
    index.ts                  ← startBrowserServer(), stopBrowserServer(), BrowserServerHandle
    config.ts                 ← resolveBrowserConfig() adapted dari openclaw
    tool.ts                   ← buildBrowserTools() → ToolDefinition[]
    tool-schema.ts            ← Zod schema untuk 16 actions
    execute.ts                ← executeBrowserAction() switch handler
    openclaw/                 ← 63 files ported verbatim (adapted imports only)
      browser/
        ...

  runtime/
    manager.ts                ← MODIFIED — inject browser tools di wakeUp() & syncAgent()

apps/studio/db/src/
  schema/
    projects.ts               ← MODIFIED — tambah browser_enabled, browser_config columns
  queries/
    browser.ts                ← NEW — getBrowserConfig(), setBrowserConfig(), setBrowserEnabled()

apps/studio/web/
  app/(app)/studio/.../projects/[project]/
    settings/
      browser/
        page.tsx              ← NEW — browser settings page
  components/
    browser/
      browser-settings-form.tsx  ← NEW — form enable/config
  lib/api.ts                  ← MODIFIED — tambah api.browser.*
```

### Data Flow

```
Project wakeUp()
  ↓ getProjectById(projectId) — sudah ada
  ↓ cek project.browser_enabled
  ↓ jika true:
      startBrowserServer(projectId, project.browser_config)
        → Express server on 127.0.0.1:{port}
        → simpan handle di browserServerMap
      buildBrowserTools(serverBaseUrl)
        → return ToolDefinition[]
  ↓ inject browserTools ke built_in_tools setiap agent
  ↓ agent siap dengan browser tools

Agent run → AI calls browser tool
  ↓ tool.execute(args)
  ↓ executeBrowserAction(args, serverBaseUrl)
  ↓ HTTP ke browser server
  ↓ Playwright action
  ↓ return result ke AI
```

---

## Phase 1 — DB Schema

### 1.1 Modify `projects` Table

```typescript
// apps/studio/db/src/schema/projects.ts

export const projects = pgTable('projects', {
  id:               uuid('id').primaryKey().defaultRandom(),
  company_id:       uuid('company_id').references(() => companies.id).notNull(),
  name:             varchar('name', { length: 255 }).notNull(),
  slug:             varchar('slug', { length: 255 }).notNull(),
  memory_config:    jsonb('memory_config').default(null),
  // NEW:
  browser_enabled:  boolean('browser_enabled').notNull().default(false),
  browser_config:   jsonb('browser_config').default(null),
  created_at:       timestamp('created_at').defaultNow(),
}, t => [unique().on(t.company_id, t.slug)])
```

### 1.2 New Query File

```typescript
// apps/studio/db/src/queries/browser.ts

export type BrowserProjectConfig = {
  headless?: boolean           // default: true
  executable_path?: string     // default: auto-detect
  control_port?: number        // default: 8399
  timeout_ms?: number          // default: 30000
  no_sandbox?: boolean         // default: false
  evaluate_enabled?: boolean   // default: true
}

export async function getProjectBrowserConfig(projectId: string): Promise<{
  enabled: boolean
  config: BrowserProjectConfig
}> {
  const row = await db.query.projects.findFirst({
    where: eq(projects.id, projectId),
    columns: { browser_enabled: true, browser_config: true },
  })
  return {
    enabled: row?.browser_enabled ?? false,
    config: (row?.browser_config as BrowserProjectConfig | null) ?? {},
  }
}

export async function setProjectBrowserEnabled(projectId: string, enabled: boolean) {
  return db.update(projects)
    .set({ browser_enabled: enabled })
    .where(eq(projects.id, projectId))
}

export async function setProjectBrowserConfig(projectId: string, config: BrowserProjectConfig) {
  return db.update(projects)
    .set({ browser_config: config })
    .where(eq(projects.id, projectId))
}
```

### 1.3 Export dari `@jiku-studio/db`

Tambah export di `apps/studio/db/src/index.ts`:
```typescript
export * from './queries/browser.ts'
```

---

## Phase 2 — Port OpenClaw Browser Engine

### 2.1 Lokasi

```
apps/studio/server/src/browser/openclaw/browser/
```

Copy 63 file dari `refs-open-alice/src/openclaw/browser/` ke sini. Tidak ada modifikasi logic — hanya import paths.

### 2.2 Import Paths yang Perlu Diadaptasi

File-file yang punya import ke luar `browser/` di OpenClaw:

| Import asal | Solusi |
|-------------|--------|
| `'../config/config.js'` (loadConfig) | Hapus — ganti config dipass sebagai parameter |
| `'../logging/subsystem.js'` | Ganti dengan `import { logger } from '../../env.ts'` atau `console` |
| `'../config/paths.js'` (resolveGatewayPort) | Hapus — port dari config parameter |
| `'../config/port-defaults.js'` | Copy file ini atau inline default values |
| `'../gateway/net.js'` | Copy file ini (isLoopbackHost, isLoopbackAddress) |
| `'../infra/ports.js'` | Copy file ini (ensurePortAvailable) |
| `'../infra/ws.js'` | Copy file ini (rawDataToString) |

**Files yang perlu di-copy tambahan (dependencies):**
- `refs-open-alice/src/openclaw/config/port-defaults.ts`
- `refs-open-alice/src/openclaw/gateway/net.ts`
- `refs-open-alice/src/openclaw/infra/ports.ts`
- `refs-open-alice/src/openclaw/infra/ws.ts`

Simpan di `apps/studio/server/src/browser/openclaw/` (satu level di atas `browser/`).

### 2.3 Adapted Entry: `server.ts`

OpenClaw `server.ts` pakai `loadConfig()` global. Di Jiku, config dipass sebagai parameter:

```typescript
// apps/studio/server/src/browser/openclaw/browser/server.ts (adapted)

// SEBELUM (OpenClaw):
export async function startBrowserControlServerFromConfig() {
  const cfg = loadConfig()
  const resolved = resolveBrowserConfig(cfg.browser, cfg)
  ...
}

// SESUDAH (Jiku):
export async function startBrowserControlServer(
  resolved: ResolvedBrowserConfig
): Promise<BrowserServerState | null> {
  // Langsung pakai resolved config yang dipass
  ...
}
```

### 2.4 Adapted Entry: `config.ts`

Ganti `OpenClawConfig` type dependency:

```typescript
// apps/studio/server/src/browser/openclaw/browser/config.ts (adapted)
// Hapus import { resolveGatewayPort } from '../config/paths.js'
// Hardcode DEFAULT_BROWSER_CONTROL_PORT = 8399 atau ambil dari parameter
```

---

## Phase 3 — Browser Module di Server

### 3.1 `browser/config.ts` — Jiku Config Resolver

```typescript
// apps/studio/server/src/browser/config.ts

import type { BrowserProjectConfig } from '@jiku-studio/db'
import { resolveBrowserConfig } from './openclaw/browser/config.js'
import type { ResolvedBrowserConfig } from './openclaw/browser/config.js'

export const DEFAULT_BROWSER_CONTROL_PORT = 8399

export function resolveProjectBrowserConfig(
  cfg: BrowserProjectConfig,
  projectIndex = 0              // untuk port offset kalau multiple projects
): ResolvedBrowserConfig {
  // Map dari BrowserProjectConfig ke format yang openclaw resolveBrowserConfig paham
  const mockOpenClawConfig = {
    browser: {
      enabled: true,
      headless: cfg.headless ?? true,
      executablePath: cfg.executable_path,
      controlPort: (cfg.control_port ?? DEFAULT_BROWSER_CONTROL_PORT) + projectIndex,
      noSandbox: cfg.no_sandbox ?? false,
      evaluateEnabled: cfg.evaluate_enabled ?? true,
    }
  }
  return resolveBrowserConfig(mockOpenClawConfig.browser, mockOpenClawConfig as any)
}
```

### 3.2 `browser/index.ts` — Server Lifecycle Manager

```typescript
// apps/studio/server/src/browser/index.ts

import type { BrowserProjectConfig } from '@jiku-studio/db'
import { startBrowserControlServer } from './openclaw/browser/server.js'
import { resolveProjectBrowserConfig } from './config.js'

export type BrowserServerHandle = {
  port: number
  baseUrl: string
  stop: () => Promise<void>
}

// projectId → server handle
const projectBrowserServers = new Map<string, BrowserServerHandle>()

export async function startBrowserServer(
  projectId: string,
  config: BrowserProjectConfig
): Promise<BrowserServerHandle> {
  // Sudah running
  if (projectBrowserServers.has(projectId)) {
    return projectBrowserServers.get(projectId)!
  }

  const index = projectBrowserServers.size   // simple port offset
  const resolved = resolveProjectBrowserConfig(config, index)
  const state = await startBrowserControlServer(resolved)

  if (!state) {
    throw new Error(`Failed to start browser server for project ${projectId}`)
  }

  const handle: BrowserServerHandle = {
    port: state.port,
    baseUrl: `http://127.0.0.1:${state.port}`,
    stop: () => new Promise(resolve => state.server.close(() => resolve())),
  }

  projectBrowserServers.set(projectId, handle)
  return handle
}

export async function stopBrowserServer(projectId: string): Promise<void> {
  const handle = projectBrowserServers.get(projectId)
  if (!handle) return
  await handle.stop()
  projectBrowserServers.delete(projectId)
}

export async function stopAllBrowserServers(): Promise<void> {
  await Promise.all(
    Array.from(projectBrowserServers.keys()).map(stopBrowserServer)
  )
}

export function getBrowserServerHandle(projectId: string): BrowserServerHandle | undefined {
  return projectBrowserServers.get(projectId)
}
```

### 3.3 `browser/tool-schema.ts` — Zod Input Schema

```typescript
// apps/studio/server/src/browser/tool-schema.ts
// Porting dari refs-open-alice/src/openclaw/agents/tools/browser-tool.schema.ts
// Diganti dari TypeBox ke Zod murni

import { z } from 'zod'

export const BrowserActSchema = z.object({
  kind: z.enum(['click','type','press','hover','drag','select','fill','resize','wait','evaluate','close']),
  targetId: z.string().optional(),
  ref: z.string().optional(),
  doubleClick: z.boolean().optional(),
  button: z.string().optional(),
  modifiers: z.array(z.string()).optional(),
  text: z.string().optional(),
  submit: z.boolean().optional(),
  slowly: z.boolean().optional(),
  key: z.string().optional(),
  startRef: z.string().optional(),
  endRef: z.string().optional(),
  values: z.array(z.string()).optional(),
  fields: z.array(z.record(z.string(), z.unknown())).optional(),
  width: z.number().optional(),
  height: z.number().optional(),
  timeMs: z.number().optional(),
  textGone: z.string().optional(),
  fn: z.string().optional(),
})

export const BrowserToolInputSchema = z.object({
  action: z.enum([
    'status','start','stop','profiles','tabs','open','focus',
    'close','snapshot','screenshot','navigate','console',
    'pdf','upload','dialog','act'
  ]),
  profile: z.string().optional(),
  targetUrl: z.string().optional(),
  targetId: z.string().optional(),
  limit: z.number().optional(),
  maxChars: z.number().optional(),
  snapshotFormat: z.enum(['aria', 'ai']).optional(),
  refs: z.enum(['role', 'aria']).optional(),
  interactive: z.boolean().optional(),
  compact: z.boolean().optional(),
  depth: z.number().optional(),
  selector: z.string().optional(),
  frame: z.string().optional(),
  labels: z.boolean().optional(),
  fullPage: z.boolean().optional(),
  ref: z.string().optional(),
  element: z.string().optional(),
  type: z.enum(['png', 'jpeg']).optional(),
  level: z.string().optional(),
  paths: z.array(z.string()).optional(),
  inputRef: z.string().optional(),
  timeoutMs: z.number().optional(),
  accept: z.boolean().optional(),
  promptText: z.string().optional(),
  request: BrowserActSchema.optional(),
})

export type BrowserToolInput = z.infer<typeof BrowserToolInputSchema>
```

### 3.4 `browser/execute.ts` — Action Handler

```typescript
// apps/studio/server/src/browser/execute.ts
// Adapted dari refs-open-alice/src/openclaw/agents/tools/browser-tool.ts
// Disederhanakan: hanya host mode (profile=openclaw), tidak ada sandbox/node target

import {
  browserAct, browserArmDialog, browserArmFileChooser,
  browserConsoleMessages, browserNavigate, browserPdfSave,
  browserScreenshotAction,
} from './openclaw/browser/client-actions.js'
import {
  browserCloseTab, browserFocusTab, browserOpenTab,
  browserProfiles, browserSnapshot, browserStart, browserStatus,
  browserStop, browserTabs,
} from './openclaw/browser/client.js'
import { wrapExternalContent } from './openclaw/security/external-content.js'
import type { BrowserToolInput } from './tool-schema.js'

export async function executeBrowserAction(
  args: BrowserToolInput,
  baseUrl: string
): Promise<{ content: Array<{type: string, text?: string, data?: string, mimeType?: string}>, details?: unknown }> {
  const { action, profile } = args

  switch (action) {
    case 'status':
      return { content: [{ type: 'text', text: JSON.stringify(await browserStatus(baseUrl, { profile })) }] }

    case 'start':
      await browserStart(baseUrl, { profile })
      return { content: [{ type: 'text', text: JSON.stringify(await browserStatus(baseUrl, { profile })) }] }

    case 'stop':
      await browserStop(baseUrl, { profile })
      return { content: [{ type: 'text', text: JSON.stringify(await browserStatus(baseUrl, { profile })) }] }

    case 'profiles':
      return { content: [{ type: 'text', text: JSON.stringify({ profiles: await browserProfiles(baseUrl) }) }] }

    case 'tabs': {
      const tabs = await browserTabs(baseUrl, { profile })
      return { content: [{ type: 'text', text: JSON.stringify({ tabs }) }] }
    }

    case 'open':
      return { content: [{ type: 'text', text: JSON.stringify(await browserOpenTab(baseUrl, args.targetUrl!, { profile })) }] }

    case 'focus':
      await browserFocusTab(baseUrl, args.targetId!, { profile })
      return { content: [{ type: 'text', text: JSON.stringify({ ok: true }) }] }

    case 'close':
      if (args.targetId) await browserCloseTab(baseUrl, args.targetId, { profile })
      else await browserAct(baseUrl, { kind: 'close' }, { profile })
      return { content: [{ type: 'text', text: JSON.stringify({ ok: true }) }] }

    case 'navigate':
      return { content: [{ type: 'text', text: JSON.stringify(await browserNavigate(baseUrl, { url: args.targetUrl!, targetId: args.targetId, profile })) }] }

    case 'snapshot': {
      const snapshot = await browserSnapshot(baseUrl, { ...args, profile })
      const text = wrapExternalContent(JSON.stringify(snapshot), { source: 'browser', includeWarning: true })
      return { content: [{ type: 'text', text }], details: { format: args.snapshotFormat ?? 'ai', url: (snapshot as any).url } }
    }

    case 'screenshot': {
      const result = await browserScreenshotAction(baseUrl, { ...args, profile })
      // Return as image content
      const fs = await import('node:fs/promises')
      const data = await fs.readFile(result.path)
      return {
        content: [
          { type: 'text', text: `Screenshot saved: ${result.path}` },
          { type: 'image', data: data.toString('base64'), mimeType: args.type === 'jpeg' ? 'image/jpeg' : 'image/png' }
        ],
        details: result,
      }
    }

    case 'console': {
      const result = await browserConsoleMessages(baseUrl, { level: args.level, targetId: args.targetId, profile })
      return { content: [{ type: 'text', text: JSON.stringify(result) }] }
    }

    case 'pdf': {
      const result = await browserPdfSave(baseUrl, { targetId: args.targetId, profile })
      return { content: [{ type: 'text', text: `PDF saved: ${result.path}` }], details: result }
    }

    case 'upload':
      return { content: [{ type: 'text', text: JSON.stringify(await browserArmFileChooser(baseUrl, { paths: args.paths!, ref: args.ref, inputRef: args.inputRef, element: args.element, targetId: args.targetId, timeoutMs: args.timeoutMs, profile })) }] }

    case 'dialog':
      return { content: [{ type: 'text', text: JSON.stringify(await browserArmDialog(baseUrl, { accept: args.accept!, promptText: args.promptText, targetId: args.targetId, timeoutMs: args.timeoutMs, profile })) }] }

    case 'act':
      return { content: [{ type: 'text', text: JSON.stringify(await browserAct(baseUrl, args.request!, { profile })) }] }

    default:
      throw new Error(`Unknown browser action: ${action}`)
  }
}
```

### 3.5 `browser/tool.ts` — ToolDefinition Factory

```typescript
// apps/studio/server/src/browser/tool.ts

import { defineTool } from '@jiku/kit'
import { BrowserToolInputSchema } from './tool-schema.js'
import { executeBrowserAction } from './execute.js'
import type { ToolDefinition } from '@jiku/types'

export function buildBrowserTools(serverBaseUrl: string): ToolDefinition[] {
  return [
    defineTool({
      meta: {
        id: 'browser',
        name: 'Browser',
        description: [
          'Control the browser: navigate pages, interact with UI elements, take screenshots, extract data.',
          'Use action=status to check browser state. Use action=start to launch. Use action=snapshot to read page content.',
          'Use action=act to interact: click, type, press keys, hover, drag, fill forms.',
          'Use action=screenshot to capture visual state. Use action=navigate to go to a URL.',
        ].join(' '),
        group: 'browser',
      },
      permission: '*',
      modes: ['chat', 'task'],
      input: BrowserToolInputSchema,
      execute: async (args) => {
        return await executeBrowserAction(args as any, serverBaseUrl)
      },
    }),
  ]
}
```

---

## Phase 4 — Manager Integration

### 4.1 Modify `manager.ts`

Tambahkan browser tools di `wakeUp()` dan `syncAgent()`:

```typescript
// apps/studio/server/src/runtime/manager.ts

// Tambah import:
import { startBrowserServer, stopBrowserServer, stopAllBrowserServers, getBrowserServerHandle } from '../browser/index.js'
import { buildBrowserTools } from '../browser/tool.js'
import { getProjectBrowserConfig } from '@jiku-studio/db'

// Di wakeUp():
async wakeUp(projectId: string): Promise<void> {
  const [agentRows, rules, projectRow] = await Promise.all([
    getAgentsByProjectId(projectId),
    loadProjectPolicyRules(projectId),
    getProjectById(projectId),
  ])

  // ... existing code ...

  // NEW: Start browser server jika enabled
  let browserTools: ToolDefinition[] = []
  const browserCfg = await getProjectBrowserConfig(projectId)
  if (browserCfg.enabled) {
    try {
      const handle = await startBrowserServer(projectId, browserCfg.config)
      browserTools = buildBrowserTools(handle.baseUrl)
    } catch (err) {
      console.warn(`[browser] Failed to start browser server for project ${projectId}:`, err)
    }
  }

  // Di setiap agent setup:
  runtime.addAgent(
    defineAgent({
      ...
      built_in_tools: [
        ...systemTools,
        ...memoryTools,
        ...connectorTools,
        ...browserTools,    // NEW
        runTaskTool
      ],
    }),
    ...
  )
}

// Di sleep():
async sleep(projectId: string): Promise<void> {
  await stopBrowserServer(projectId)   // NEW
  const runtime = this.runtimes.get(projectId)
  if (runtime) await runtime.stop()
  this.runtimes.delete(projectId)
  this.storages.delete(projectId)
}

// Di stopAll():
async stopAll(): Promise<void> {
  heartbeatScheduler.stopAll()
  await stopAllBrowserServers()        // NEW
  await Promise.all(...)
  ...
}
```

### 4.2 Saat Browser Config Berubah

Perlu restart runtime project (wakeUp ulang) agar browser tools terupdate:

```typescript
// Di manager.ts:
async restartBrowser(projectId: string): Promise<void> {
  await stopBrowserServer(projectId)
  await this.sleep(projectId)
  await this.wakeUp(projectId)
}
```

---

## Phase 5 — API Routes

### 5.1 New Route File

```typescript
// apps/studio/server/src/routes/browser.ts

import { Router } from 'express'
import { authMiddleware } from '../middleware/auth.ts'
import { getProjectBrowserConfig, setProjectBrowserEnabled, setProjectBrowserConfig } from '@jiku-studio/db'
import { runtimeManager } from '../runtime/manager.ts'
import { getBrowserServerHandle } from '../browser/index.js'
import { z } from 'zod'

const router = Router()
router.use(authMiddleware)

// GET config + status
router.get('/projects/:pid/browser', async (req, res) => {
  const projectId = req.params['pid']!
  const cfg = await getProjectBrowserConfig(projectId)
  const handle = getBrowserServerHandle(projectId)
  res.json({
    enabled: cfg.enabled,
    config: cfg.config,
    status: handle ? { running: true, port: handle.port } : { running: false },
  })
})

// Enable/disable
router.patch('/projects/:pid/browser/enabled', async (req, res) => {
  const projectId = req.params['pid']!
  const { enabled } = req.body as { enabled: boolean }
  await setProjectBrowserEnabled(projectId, enabled)
  await runtimeManager.restartBrowser(projectId)
  const handle = getBrowserServerHandle(projectId)
  res.json({ ok: true, status: handle ? { running: true, port: handle.port } : { running: false } })
})

// Update config
router.patch('/projects/:pid/browser/config', async (req, res) => {
  const projectId = req.params['pid']!
  const BrowserConfigSchema = z.object({
    headless: z.boolean().optional(),
    executable_path: z.string().optional(),
    control_port: z.number().int().min(1024).max(65535).optional(),
    timeout_ms: z.number().int().min(1000).max(120000).optional(),
    no_sandbox: z.boolean().optional(),
    evaluate_enabled: z.boolean().optional(),
  })
  const parsed = BrowserConfigSchema.safeParse(req.body)
  if (!parsed.success) { res.status(400).json({ error: parsed.error.flatten() }); return }
  await setProjectBrowserConfig(projectId, parsed.data)
  // Jika sedang running, restart agar config baru berlaku
  const { enabled } = await getProjectBrowserConfig(projectId)
  if (enabled) await runtimeManager.restartBrowser(projectId)
  res.json({ ok: true, config: parsed.data })
})

export { router as browserRouter }
```

### 5.2 Mount di `index.ts`

```typescript
// apps/studio/server/src/index.ts — tambah:
import { browserRouter } from './routes/browser.ts'
app.use('/api', browserRouter)
```

---

## Phase 6 — Web UI

### 6.1 Settings Page Route

```
apps/studio/web/app/(app)/studio/companies/[company]/projects/[project]/settings/browser/page.tsx
```

Letaknya di bawah `settings/` karena ini project-level setting, bukan feature yang berdiri sendiri.

### 6.2 Navigation

Tambah "Browser" ke sidebar settings project (sama seperti "Memory", "Persona", dll).

### 6.3 Page Layout

```tsx
// page.tsx
<div className="space-y-6">
  <div>
    <h2>Browser Automation</h2>
    <p>Enable browser control for agents in this project.</p>
  </div>
  
  {/* Enable toggle */}
  <Card>
    <div className="flex items-center justify-between">
      <div>
        <Label>Enable Browser</Label>
        <p className="text-sm text-muted-foreground">
          Allow agents to control a browser — navigate, click, screenshot, extract data.
        </p>
      </div>
      <Switch checked={enabled} onCheckedChange={handleToggle} />
    </div>
  </Card>

  {/* Status badge — tampil jika enabled */}
  {enabled && (
    <div className="flex items-center gap-2">
      <div className={cn("h-2 w-2 rounded-full", running ? "bg-green-500" : "bg-yellow-500")} />
      <span className="text-sm">{running ? `Running on port ${port}` : "Starting..."}</span>
    </div>
  )}

  {/* Config form — tampil jika enabled */}
  {enabled && (
    <Card>
      <CardHeader><CardTitle>Configuration</CardTitle></CardHeader>
      <CardContent>
        <BrowserSettingsForm config={config} onSave={handleSaveConfig} />
      </CardContent>
    </Card>
  )}
</div>
```

### 6.4 Settings Form Component

```tsx
// components/browser/browser-settings-form.tsx

export function BrowserSettingsForm({ config, onSave }) {
  // Fields:
  // - Headless mode (Switch)
  // - Control port (Input number, 1024-65535)
  // - Timeout ms (Input number, 1000-120000)
  // - Disable sandbox (Switch, dengan warning "only for Docker/Linux")
  // - Allow JS evaluate (Switch)
  // - Executable path (Input text, optional)
}
```

### 6.5 API Client (`lib/api.ts`)

```typescript
browser: {
  get: (projectId: string) =>
    client.get(`/api/projects/${projectId}/browser`),
  setEnabled: (projectId: string, enabled: boolean) =>
    client.patch(`/api/projects/${projectId}/browser/enabled`, { enabled }),
  updateConfig: (projectId: string, config: BrowserProjectConfig) =>
    client.patch(`/api/projects/${projectId}/browser/config`, config),
}
```

---

## Implementation Checklist

### DB Layer (`apps/studio/db/`)
- [ ] Tambah `browser_enabled` + `browser_config` columns ke `projects` schema
- [ ] Buat migration SQL
- [ ] Buat `queries/browser.ts` (getProjectBrowserConfig, setProjectBrowserEnabled, setProjectBrowserConfig)
- [ ] Export dari `index.ts`

### Browser Engine (`apps/studio/server/src/browser/`)
- [ ] Copy 63 files dari `refs-open-alice/src/openclaw/browser/` → `openclaw/browser/`
- [ ] Copy dependency files: `port-defaults.ts`, `net.ts`, `ports.ts`, `ws.ts`
- [ ] Adapt `server.ts` — ganti `loadConfig()` → config sebagai parameter
- [ ] Adapt `config.ts` — ganti `OpenClawConfig` type dependency
- [ ] Buat `config.ts` — `resolveProjectBrowserConfig()`
- [ ] Buat `index.ts` — `startBrowserServer()`, `stopBrowserServer()`, `stopAllBrowserServers()`, `getBrowserServerHandle()`
- [ ] Buat `tool-schema.ts` — Zod schema (port dari TypeBox)
- [ ] Buat `execute.ts` — `executeBrowserAction()` switch handler
- [ ] Buat `tool.ts` — `buildBrowserTools()` → `ToolDefinition[]`

### Runtime Manager (`apps/studio/server/src/runtime/manager.ts`)
- [ ] Import browser functions
- [ ] Di `wakeUp()`: cek `browser_enabled`, start server, inject `browserTools` ke setiap agent
- [ ] Di `sleep()`: stop browser server
- [ ] Di `stopAll()`: stop all browser servers
- [ ] Tambah `restartBrowser(projectId)` method

### Routes (`apps/studio/server/src/`)
- [ ] Buat `routes/browser.ts` (GET config+status, PATCH enabled, PATCH config)
- [ ] Mount di `index.ts`

### Web UI (`apps/studio/web/`)
- [ ] Buat `app/.../settings/browser/page.tsx`
- [ ] Buat `components/browser/browser-settings-form.tsx`
- [ ] Tambah "Browser" ke project settings sidebar nav
- [ ] Tambah `api.browser.*` di `lib/api.ts`

### Dependencies
- [ ] Tambah `playwright`, `ws` ke `apps/studio/server/package.json`

---

## Key Decisions

### Kenapa di Layer App, Bukan Plugin?
Browser bukan capability yang bisa di-compose atau digabung dengan plugin lain. Ini adalah infrastructure feature seperti connector atau memory — milik server Studio, dikelola oleh runtime manager, dan hidupnya terikat ke project lifecycle (`wakeUp`/`sleep`).

### Per-Project Browser Server
Setiap project punya browser server sendiri di port unik. Isolasi penting agar session browser project A tidak tercampur dengan project B. Port offset: `control_port + project_count_index`.

### Restart Runtime saat Toggle
Saat browser di-enable/disable, runtime di-restart (`sleep` + `wakeUp`) agar `built_in_tools` yang digenerate di `wakeUp()` terupdate. Ini konsisten dengan cara `syncAgent()` dan `syncRules()` bekerja.

### Scope Awal: Host Mode Only
Fase pertama hanya mendukung `profile=openclaw` (standalone Playwright di host machine). Chrome Extension relay (`profile=chrome`) bisa ditambahkan di fase berikutnya karena butuh user install extension.

### Security: `wrapExternalContent`
Semua output dari browser (snapshot, console, tabs) di-wrap dengan marker `untrusted` sebelum dikirim ke AI — porting langsung dari OpenClaw security pattern.

---

## File Size Estimate

| Komponen | Files | LOC |
|----------|-------|-----|
| OpenClaw engine (copied) | 67 | ~8,500 |
| Browser module (baru) | 5 | ~400 |
| DB changes | 2 | ~60 |
| Manager changes | 1 (modified) | ~40 |
| Route baru | 1 | ~80 |
| Web UI | 2 | ~200 |
| **Total kode baru** | **~11** | **~780** |

~91% adalah ported code, ~9% kode baru.
