# Plan 20 — Multi Browser Profile + Browser Adapter System

> Status: Planning Done
> Depends on: Plan 13 (Browser Automation), Plan 17 (Plugin UI), Plan 19 (Skills/Memory)
> Layer: App layer + Plugin layer
> Goal: Extend browser dari satu CDP endpoint per project jadi banyak profile per project, dengan sistem adapter yang bisa didaftarkan oleh plugin.

---

## 1. Overview

Browser saat ini adalah **satu endpoint CDP per project**. Satu project = satu browser container = satu config. Plan 20 upgrade ini menjadi **sistem multi-profile**:

- Satu project bisa punya **banyak Browser Profile**
- Setiap profile memilih **Browser Adapter** yang dipakai
- Admin bisa tambah, enable/disable, atau hapus profile
- Plugin bisa **mendaftarkan adapter baru** lewat `ctx.browser.registerAdapter()`
- Unified `browser` tool tetap satu — tapi sekarang routing ke profile tertentu via `profile_id` param (opsional, default ke profile yang di-mark default)

### Adapters yang dikirim di Plan 20

| Adapter | ID | Keterangan |
|---------|-----|-----------|
| **Jiku Browser Agent** | `jiku.browser.vercel` | Adapter existing. CDP ke Vercel agent-browser Docker. Powered by [agent-browser](https://github.com/vercel-labs/agent-browser). |
| **CamoFox** | `jiku.camofox` | Adapter baru via plugin `jiku.camofox`. CDP ke CamoFox browser — Firefox-based, anti-fingerprint. |

### Apa yang berubah secara arsitektur

```
SEBELUM:
  projects.browser_enabled + projects.browser_config
    ↓ (satu config)
  buildBrowserTools(projectId, config) → satu ToolDefinition (id: 'browser')

SESUDAH:
  browser_profiles (tabel baru, N profile per project)
    ↓ setiap profile punya adapter_id + config + enabled
  BrowserAdapterRegistry (registry global, diisi oleh plugin + built-in)
    ↓
  buildBrowserTools(projectId, profiles, registry)
    → satu ToolDefinition (id: 'browser') dengan profile_id param + dynamic description
    → optional additional tools dari setiap adapter yang aktif
```

---

## 2. Phase 1 — BrowserAdapter Abstraction (`@jiku/kit`)

### 2.1 Tipe Baru di `packages/kit/src/index.ts`

```typescript
// packages/kit/src/index.ts — tambah export

export type { BrowserAdapter, BrowserAdapterContext, BrowserAdapterResult } from './browser-adapter.ts'
export { defineBrowserAdapter } from './browser-adapter.ts'
```

### 2.2 `packages/kit/src/browser-adapter.ts` (file baru)

```typescript
import type { ZodObject, ZodRawShape } from 'zod'
import type { ToolDefinition } from '@jiku/types'

export interface BrowserAdapterContext {
  profileId: string
  projectId: string
  agentId?: string
  /** Resolved config (already validated by adapter's configSchema) */
  config: unknown
}

export interface BrowserAdapterResult {
  content: Array<
    | { type: 'text'; text: string }
    | { type: 'image'; data: string; mimeType: string }
  >
  details?: unknown
}

export interface BrowserPingResult {
  ok: boolean
  latency_ms?: number
  browser?: string
  cdp_url?: string
  error?: string
}

export interface BrowserPreviewResult {
  ok: boolean
  data?: {
    base64: string
    format: 'png' | 'jpeg'
    title?: string
    url?: string
  }
  error?: string
  hint?: string
}

export abstract class BrowserAdapter {
  /** Unique adapter ID — kebab.dot format, e.g. 'jiku.browser.vercel' */
  abstract readonly id: string

  /** Short display name shown in the adapter selector UI */
  abstract readonly displayName: string

  /** One-paragraph description explaining what this adapter does */
  abstract readonly description: string

  /** Zod schema for adapter-specific profile config. Used to:
   *  1. Validate config on save
   *  2. Generate config form fields in the UI (future)
   */
  abstract readonly configSchema: ZodObject<ZodRawShape>

  /**
   * Execute a browser action for an agent.
   * Receives the resolved, validated config from the profile.
   * Must handle the full BrowserToolInput action set.
   */
  abstract execute(
    input: unknown,          // BrowserToolInput (typed in execute.ts)
    ctx: BrowserAdapterContext
  ): Promise<BrowserAdapterResult>

  /**
   * Test connectivity with the given profile config.
   * Called by the ping endpoint and the "Test Connection" button in the UI.
   */
  abstract ping(config: unknown): Promise<BrowserPingResult>

  /**
   * Capture a one-shot preview screenshot.
   * Should acquire the per-profile mutex internally.
   */
  abstract preview(config: unknown): Promise<BrowserPreviewResult>

  /**
   * Optional: register adapter-specific extra tools alongside the unified `browser` tool.
   * These tools are added to every agent in the project that has at least one
   * active profile using this adapter.
   */
  additionalTools?(): ToolDefinition[]

  /**
   * Called when a profile using this adapter becomes active (project wakeUp,
   * or when the profile is enabled). Use for warming up connections, etc.
   */
  onProfileActivated?(profileId: string, config: unknown): Promise<void>

  /**
   * Called when a profile using this adapter becomes inactive (project sleep,
   * profile disabled, or profile deleted).
   */
  onProfileDeactivated?(profileId: string): Promise<void>
}

export function defineBrowserAdapter<T extends BrowserAdapter>(adapter: T): T {
  return adapter
}
```

---

## 3. Phase 2 — BrowserAdapterRegistry + Plugin Context

### 3.1 Registry (Studio server)

```typescript
// apps/studio/server/src/browser/adapter-registry.ts (file baru)

import type { BrowserAdapter } from '@jiku/kit'

class BrowserAdapterRegistry {
  private adapters = new Map<string, BrowserAdapter>()

  register(adapter: BrowserAdapter): void {
    if (this.adapters.has(adapter.id)) {
      console.warn(`[browser:adapters] Adapter '${adapter.id}' already registered — skipping duplicate`)
      return
    }
    this.adapters.set(adapter.id, adapter)
    console.log(`[browser:adapters] Registered adapter: ${adapter.id} ("${adapter.displayName}")`)
  }

  get(id: string): BrowserAdapter | undefined {
    return this.adapters.get(id)
  }

  list(): BrowserAdapter[] {
    return Array.from(this.adapters.values())
  }

  has(id: string): boolean {
    return this.adapters.has(id)
  }
}

export const browserAdapterRegistry = new BrowserAdapterRegistry()
```

### 3.2 Extend Plugin Context

**Tambah tipe di `plugins/jiku.studio/src/types.ts`:**

```typescript
export interface PluginBrowserAdapterAPI {
  /** Register a browser adapter so it appears in the profile adapter selector. */
  register: (adapter: BrowserAdapter) => void
}
```

**Tambah ke `StudioContributes`** di `plugins/jiku.studio/src/index.ts`:

```typescript
interface StudioContributes {
  http: PluginHttpAPI
  events: PluginEventsAPI
  connector: PluginConnectorAPI
  fileViewAdapters: PluginFileViewAdapterAPI
  browser: PluginBrowserAdapterAPI   // NEW
}
```

**Wire di `apps/studio/server/src/plugins/ui/context-extender.ts`:**

```typescript
import { browserAdapterRegistry } from '../../browser/adapter-registry.ts'

function makeBrowserAdapter(): PluginBrowserAdapterAPI {
  return {
    register: (adapter) => browserAdapterRegistry.register(adapter),
  }
}

export function extendPluginContext(pluginId: string, baseCtx: BasePluginContext): BasePluginContext {
  return {
    ...baseCtx,
    http: makeHttp(pluginId),
    events: makeEvents(pluginId),
    connector: makeConnector(baseCtx),
    fileViewAdapters: makeFileViewAdapters(pluginId),
    browser: makeBrowserAdapter(),    // NEW
  } as BasePluginContext
}
```

### 3.3 Wire hook di `apps/studio/server/src/index.ts`

Tidak perlu hook baru — context extender langsung inject ke `ctx.browser`. Adapter registry di-import langsung.

---

## 4. Phase 3 — DB Schema

### 4.1 Tabel Baru `browser_profiles`

```sql
-- apps/studio/db/src/migrations/0009_browser_profiles.sql

CREATE TABLE browser_profiles (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id   uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name         varchar(255) NOT NULL,
  adapter_id   varchar(255) NOT NULL,   -- 'jiku.browser.vercel', 'jiku.camofox', dll
  config       jsonb NOT NULL DEFAULT '{}',
  enabled      boolean NOT NULL DEFAULT true,
  is_default   boolean NOT NULL DEFAULT false,
  created_at   timestamp NOT NULL DEFAULT now()
);

CREATE INDEX idx_browser_profiles_project ON browser_profiles(project_id);

-- hanya satu default profile per project
CREATE UNIQUE INDEX idx_browser_profiles_default
  ON browser_profiles(project_id)
  WHERE is_default = true;

-- nama profile unique per project
CREATE UNIQUE INDEX idx_browser_profiles_name
  ON browser_profiles(project_id, name);
```

### 4.2 Migration Data dari Schema Lama

```sql
-- Untuk setiap project yang punya browser_enabled = true,
-- buat satu default profile dengan adapter jiku.browser.vercel

INSERT INTO browser_profiles (project_id, name, adapter_id, config, enabled, is_default)
SELECT
  id,
  'Default',
  'jiku.browser.vercel',
  COALESCE(browser_config, '{}'),
  true,
  true
FROM projects
WHERE browser_enabled = true;

-- Kolom lama dibiarkan (deprecated), tidak di-DROP dulu untuk safety
-- Bisa di-DROP di migration berikutnya setelah verifikasi data
```

### 4.3 Drizzle Schema

```typescript
// apps/studio/db/src/schema/browser-profiles.ts (file baru)

import { pgTable, uuid, varchar, jsonb, boolean, timestamp, unique, index } from 'drizzle-orm/pg-core'
import { projects } from './projects.ts'

export const browserProfiles = pgTable('browser_profiles', {
  id:         uuid('id').primaryKey().defaultRandom(),
  projectId:  uuid('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
  name:       varchar('name', { length: 255 }).notNull(),
  adapterId:  varchar('adapter_id', { length: 255 }).notNull(),
  config:     jsonb('config').notNull().default({}),
  enabled:    boolean('enabled').notNull().default(true),
  isDefault:  boolean('is_default').notNull().default(false),
  createdAt:  timestamp('created_at').notNull().defaultNow(),
}, (t) => [
  index('idx_browser_profiles_project').on(t.projectId),
  unique('idx_browser_profiles_name').on(t.projectId, t.name),
])

export type BrowserProfile = typeof browserProfiles.$inferSelect
export type InsertBrowserProfile = typeof browserProfiles.$inferInsert
```

### 4.4 Query Functions

```typescript
// apps/studio/db/src/queries/browser-profiles.ts (file baru)

export async function getProjectBrowserProfiles(projectId: string): Promise<BrowserProfile[]>

export async function getBrowserProfile(profileId: string): Promise<BrowserProfile | null>

export async function getDefaultBrowserProfile(projectId: string): Promise<BrowserProfile | null>

export async function createBrowserProfile(data: InsertBrowserProfile): Promise<BrowserProfile>

export async function updateBrowserProfile(
  profileId: string,
  data: Partial<Pick<BrowserProfile, 'name' | 'config' | 'enabled' | 'isDefault'>>
): Promise<BrowserProfile>

export async function deleteBrowserProfile(profileId: string): Promise<void>

/** Pastikan hanya satu is_default per project saat set default */
export async function setDefaultBrowserProfile(profileId: string, projectId: string): Promise<void>
```

---

## 5. Phase 4 — JikuBrowserAdapter (Wrap Existing Logic)

Semua logic browser yang existing (CDP, execute, concurrency, tab manager) dibungkus dalam `JikuBrowserAdapter`. Tidak ada perubahan perilaku — hanya refactor ke interface adapter.

### 5.1 `apps/studio/server/src/browser/adapters/jiku-browser-vercel.ts` (file baru)

```typescript
import { BrowserAdapter } from '@jiku/kit'
import { z } from 'zod'
import { execBrowserCommand } from '@jiku/browser'
import { browserMutex } from '../concurrency.ts'
import { browserTabManager } from '../tab-manager.ts'
import { mapToBrowserCommand, formatBrowserResult } from '../execute.ts'
import { resolveCdpEndpoint } from '../config.ts'

export const JikuBrowserVercelConfigSchema = z.object({
  cdp_url:                  z.string().optional(),   // default: 'ws://localhost:9222'
  timeout_ms:               z.number().int().min(1000).max(120_000).optional(),
  evaluate_enabled:         z.boolean().optional(),
  screenshot_as_attachment: z.boolean().optional(),
  max_tabs:                 z.number().int().min(2).max(50).optional(),
})

export type JikuBrowserVercelConfig = z.infer<typeof JikuBrowserVercelConfigSchema>

export class JikuBrowserVercelAdapter extends BrowserAdapter {
  readonly id          = 'jiku.browser.vercel'
  readonly displayName = 'Jiku Browser Agent'
  readonly description = [
    'Connects to a Chromium-based browser via Chrome DevTools Protocol (CDP).',
    'Powered by Vercel agent-browser. Recommended setup: use the official Jiku',
    'Browser Docker container (Chromium + noVNC) and point cdp_url at port 9222.',
  ].join(' ')
  readonly configSchema = JikuBrowserVercelConfigSchema

  async execute(input: unknown, ctx: BrowserAdapterContext): Promise<BrowserAdapterResult> {
    const config = ctx.config as JikuBrowserVercelConfig
    const cdpEndpoint = resolveCdpEndpoint(config)
    // Pakai profileId sebagai key untuk mutex dan tab manager
    return browserMutex.acquire(ctx.profileId, async () => {
      // Pastikan agent punya tab (existing logic dari execute.ts, ganti projectId → profileId)
      await browserTabManager.ensureInitialized(ctx.profileId, cdpEndpoint)
      if (ctx.agentId) {
        let idx = browserTabManager.getAgentTabIndex(ctx.profileId, ctx.agentId)
        if (idx === null) {
          if (browserTabManager.isAtCapacity(ctx.profileId, config.max_tabs)) {
            const evict = browserTabManager.pickEvictionCandidate(ctx.profileId)
            if (evict !== null) {
              await execBrowserCommand(cdpEndpoint, { type: 'tab_close', index: evict }, { timeoutMs: config.timeout_ms })
              browserTabManager.removeTab(ctx.profileId, evict)
            }
          }
          await execBrowserCommand(cdpEndpoint, { type: 'tab_new' }, { timeoutMs: config.timeout_ms })
          idx = browserTabManager.appendTab(ctx.profileId, ctx.agentId)
        }
        await execBrowserCommand(cdpEndpoint, { type: 'tab_switch', index: idx }, { timeoutMs: config.timeout_ms })
        browserTabManager.touch(ctx.profileId, ctx.agentId)
      }
      const command = mapToBrowserCommand(input as any, config)
      const raw = await execBrowserCommand(cdpEndpoint, command, { timeoutMs: config.timeout_ms })
      return formatBrowserResult(raw, input as any, config, ctx)
    })
  }

  async ping(config: unknown): Promise<BrowserPingResult> {
    // Sama persis dengan existing ping logic di routes/browser.ts
    const cfg = config as JikuBrowserVercelConfig
    const cdpUrl = resolveCdpEndpoint(cfg)
    const httpUrl = cdpUrl.replace(/^ws/, 'http')
    const start = Date.now()
    try {
      const res = await fetch(`${httpUrl}/json/version`, { signal: AbortSignal.timeout(5000) })
      const json = await res.json()
      return { ok: true, latency_ms: Date.now() - start, browser: json.Browser, cdp_url: cdpUrl }
    } catch (err) {
      return { ok: false, error: String(err) }
    }
  }

  async preview(config: unknown): Promise<BrowserPreviewResult> {
    // Sama dengan existing /preview endpoint
    const cfg = config as JikuBrowserVercelConfig
    const cdpEndpoint = resolveCdpEndpoint(cfg)
    // ... delegate ke execBrowserCommand screenshot tanpa tab switch
  }

  override async onProfileDeactivated(profileId: string): Promise<void> {
    browserTabManager.dropProject(profileId)
  }
}

// Singleton — satu adapter instance cukup karena state ada di profileId-keyed maps
export const jikuBrowserVercelAdapter = new JikuBrowserVercelAdapter()
```

### 5.2 Register Adapter Saat Server Start

```typescript
// apps/studio/server/src/browser/index.ts — MODIFIED

import { browserAdapterRegistry } from './adapter-registry.ts'
import { jikuBrowserVercelAdapter } from './adapters/jiku-browser-vercel.ts'

// Register built-in adapter di startup — sebelum plugin setup
browserAdapterRegistry.register(jikuBrowserVercelAdapter)
```

---

## 6. Phase 5 — Update Browser Tool (Unified, Profile-Routing)

### 6.1 Update Tool Schema

```typescript
// apps/studio/server/src/browser/tool-schema.ts — MODIFIED

export const BrowserToolInputSchema = z.object({
  profile_id: z.string().optional(),   // ← NEW — opsional, default ke profile default
  action: z.enum([...BROWSER_ACTIONS]),
  // ... semua field lain tetap sama ...
})
```

### 6.2 Update `buildBrowserTools()`

```typescript
// apps/studio/server/src/browser/tool.ts — MODIFIED

import { getProjectBrowserProfiles, getDefaultBrowserProfile } from '@jiku-studio/db'
import { browserAdapterRegistry } from './adapter-registry.ts'

export async function buildBrowserTools(
  projectId: string
): Promise<ToolDefinition[]> {
  const profiles = await getProjectBrowserProfiles(projectId)
  const activeProfiles = profiles.filter(p => p.enabled)

  if (activeProfiles.length === 0) return []

  const defaultProfile = activeProfiles.find(p => p.isDefault) ?? activeProfiles[0]!

  // Collect additional tools dari setiap adapter yang dipakai
  const seenAdapters = new Set<string>()
  const additionalTools: ToolDefinition[] = []
  for (const profile of activeProfiles) {
    if (!seenAdapters.has(profile.adapterId)) {
      seenAdapters.add(profile.adapterId)
      const adapter = browserAdapterRegistry.get(profile.adapterId)
      const extra = adapter?.additionalTools?.() ?? []
      additionalTools.push(...extra)
    }
  }

  const profileListText = activeProfiles
    .map(p => `"${p.name}" (profile_id: "${p.id}"${p.isDefault ? ', default' : ''})`)
    .join(', ')

  const mainTool = defineTool({
    meta: {
      id: 'browser',
      name: 'Browser',
      description: [
        'Control the browser: navigate pages, interact with UI elements,',
        'take screenshots, extract data, run JavaScript.',
        `Available profiles: ${profileListText}.`,
        `Omit profile_id to use the default profile ("${defaultProfile.name}").`,
        'Use action=snapshot to read page content.',
        'Use action=open to navigate. Use action=click/fill/type/press to interact.',
        'Use action=screenshot to capture visual state.',
      ].join(' '),
      group: 'browser',
    },
    permission: '*',
    modes: ['chat', 'task'],
    input: BrowserToolInputSchema,
    execute: async (args, ctx) => {
      const input = args as BrowserToolInput
      const profile = input.profile_id
        ? activeProfiles.find(p => p.id === input.profile_id)
        : defaultProfile

      if (!profile) {
        throw new Error(
          `Browser profile "${input.profile_id}" not found or not active. ` +
          `Available: ${activeProfiles.map(p => p.id).join(', ')}`
        )
      }

      const adapter = browserAdapterRegistry.get(profile.adapterId)
      if (!adapter) {
        throw new Error(`Browser adapter "${profile.adapterId}" is not registered.`)
      }

      return adapter.execute(input, {
        profileId: profile.id,
        projectId,
        agentId: ctx.runtime?.agent?.id,
        config: profile.config,
      })
    },
  })

  return [mainTool, ...additionalTools]
}
```

### 6.3 Update `resolveSharedTools()` di Manager

```typescript
// apps/studio/server/src/runtime/manager.ts — MODIFIED

// Sebelum:
const browserTools = cfg.browser.enabled
  ? buildBrowserTools(projectId, cfg.browser.config)
  : []

// Sesudah (async karena perlu query profiles):
const browserTools = await buildBrowserTools(projectId)
```

### 6.4 Update `syncProjectTools()` di Manager

`syncProjectTools()` dipanggil saat config browser berubah. Dengan multi-profile, ini dipanggil setelah:
- Profile dibuat, diupdate, di-enable/disable, atau dihapus
- `is_default` berubah

Tidak perlu perubahan lain di `syncProjectTools()` — sudah rebuild tools dari scratch.

---

## 7. Phase 6 — API Routes

### 7.1 Route File Baru

```typescript
// apps/studio/server/src/routes/browser-profiles.ts (file baru)

// Semua route require requirePermission('settings:write') kecuali GET

GET    /api/projects/:pid/browser/adapters
  → List semua adapters yang terdaftar (id, displayName, description, configSchema)
  → Dipakai oleh "Add Profile" modal untuk populate dropdown

GET    /api/projects/:pid/browser/profiles
  → List semua profiles project, termasuk yang disabled

POST   /api/projects/:pid/browser/profiles
  body: { name, adapter_id, config, is_default? }
  → Validate config via adapter's configSchema
  → Buat profile baru
  → Jika is_default = true, unset is_default dari profile lain dulu
  → Call syncProjectTools(projectId)

GET    /api/projects/:pid/browser/profiles/:profileId
  → Detail satu profile

PATCH  /api/projects/:pid/browser/profiles/:profileId
  body: Partial<{ name, config, enabled, is_default }>
  → Validate config jika diubah
  → Update profile
  → Jika enabled toggle, panggil adapter.onProfileActivated/Deactivated
  → Call syncProjectTools(projectId)

DELETE /api/projects/:pid/browser/profiles/:profileId
  → Jangan hapus jika ini satu-satunya profile yang enabled (require at least 0 is fine, but warn)
  → Call adapter.onProfileDeactivated(profileId)
  → Call syncProjectTools(projectId)

POST   /api/projects/:pid/browser/profiles/:profileId/ping
  → Delegate ke adapter.ping(profile.config)

POST   /api/projects/:pid/browser/profiles/:profileId/preview
  → Delegate ke adapter.preview(profile.config)
  → Acquire mutex per profile

GET    /api/projects/:pid/browser/profiles/:profileId/status
  → Tab manager snapshot + mutex state untuk profile ini
```

### 7.2 Backward Compat — Route Lama Tetap Berfungsi

Route existing (`/api/projects/:pid/browser`) tetap ada tapi deprecated:

```typescript
// GET /api/projects/:pid/browser
// Kembalikan struktur lama tapi dari data profile terbaru:
{
  enabled: profiles.some(p => p.enabled),
  config: defaultProfile?.config ?? {},
  profiles: profiles,  // tambah field baru ini
}

// PATCH /api/projects/:pid/browser/enabled
// Toggle semua profiles sekaligus? Atau hanya default?
// → Toggle default profile saja, dan beri pesan deprecation warning di response
```

---

## 8. Phase 7 — Frontend

### 8.1 Perubahan Halaman Browser

```
apps/studio/web/app/(app)/studio/companies/[company]/projects/[project]/browser/page.tsx
```

**Layout baru (top to bottom):**

1. **Header** — "Browser Profiles" + tombol "Add Profile"
2. **Profile Tabs** — satu tab per profile. Tab aktif = profile yang sedang dilihat. Disabled profiles ditandai dengan ikon/warna pudar.
3. **Content (per profile):**
   - Status bar (ping result, test connection button)
   - Enable/disable toggle untuk profile ini
   - Live Preview (auto-refresh setiap 3s, sama seperti sekarang tapi per-profile)
   - Debug panel (tab table + mutex per profile)
   - Config section:
     - Profile name (editable)
     - Adapter info (read-only badge: adapter displayName)
     - Adapter-specific config form (field-field dari `configSchema`)
   - Tombol "Delete Profile" (di bawah, destructive)
4. **Empty state** — jika belum ada profile, tampilkan CTA "Add your first browser profile"

### 8.2 Add Profile Modal

Dipanggil dari tombol "Add Profile" di header.

```
Modal: "Add Browser Profile"

  Profile Name: [__________________________]

  Browser Adapter:
  ┌─────────────────────────────────────────────┐
  │ ◉ Jiku Browser Agent                        │
  │   Connects to Chromium via CDP. Powered by  │
  │   Vercel agent-browser. Recommended for     │
  │   standard automation tasks.                │
  ├─────────────────────────────────────────────┤
  │ ○ CamoFox                                   │
  │   Firefox-based browser with anti-          │
  │   fingerprint protection. Ideal for stealth │
  │   browsing and bot-detection bypass.        │
  └─────────────────────────────────────────────┘

  Configuration: (kolom dynamic berdasarkan adapter terpilih)
    CDP URL: [ws://localhost:9222_____________]
    (untuk Jiku Browser Agent)

  □ Set as default profile

  [Cancel]  [Create Profile]
```

### 8.3 API Client Updates (`apps/studio/web/lib/api.ts`)

```typescript
// Tambah di api object:
browser: {
  // Existing (tetap ada, deprecated)
  get: (pid) => ...,
  setEnabled: (pid, enabled) => ...,
  updateConfig: (pid, config) => ...,
  ping: (pid) => ...,
  preview: (pid) => ...,
  status: (pid) => ...,

  // NEW
  listAdapters: (pid) => client.get(`/api/projects/${pid}/browser/adapters`),
  listProfiles: (pid) => client.get(`/api/projects/${pid}/browser/profiles`),
  createProfile: (pid, data) => client.post(`/api/projects/${pid}/browser/profiles`, data),
  getProfile: (pid, profileId) => client.get(`/api/projects/${pid}/browser/profiles/${profileId}`),
  updateProfile: (pid, profileId, data) => client.patch(`/api/projects/${pid}/browser/profiles/${profileId}`, data),
  deleteProfile: (pid, profileId) => client.delete(`/api/projects/${pid}/browser/profiles/${profileId}`),
  pingProfile: (pid, profileId) => client.post(`/api/projects/${pid}/browser/profiles/${profileId}/ping`),
  previewProfile: (pid, profileId) => client.post(`/api/projects/${pid}/browser/profiles/${profileId}/preview`),
  statusProfile: (pid, profileId) => client.get(`/api/projects/${pid}/browser/profiles/${profileId}/status`),
}
```

---

## 9. Phase 8 — Plugin `jiku.camofox`

### 9.1 Struktur Plugin

```
plugins/jiku.camofox/
├── package.json
├── src/
│   ├── index.ts          ← plugin entry, register CamofoxAdapter
│   ├── adapter.ts        ← CamofoxAdapter extends BrowserAdapter
│   └── types.ts          ← CamofoxConfig type
```

### 9.2 `CamofoxAdapter`

CamoFox adalah Firefox-based browser dengan anti-fingerprinting. Repo: `https://github.com/jo-inc/camofox-browser`.

CamoFox expose CDP endpoint setelah launch, sehingga **mekanisme execute sama persis** dengan JikuBrowserAdapter — tinggal beda config:

```typescript
// plugins/jiku.camofox/src/types.ts

export const CamofoxConfigSchema = z.object({
  cdp_url:          z.string().optional(),   // CDP endpoint setelah camofox jalan
  timeout_ms:       z.number().int().min(1000).max(120_000).optional(),
  evaluate_enabled: z.boolean().optional(),
  // Camofox-specific options (disesuaikan dari repo camofox-browser):
  executable_path:  z.string().optional(),   // path ke camofox binary
  user_data_dir:    z.string().optional(),   // custom profile dir
  proxy:            z.string().optional(),   // e.g. 'socks5://127.0.0.1:1080'
})

export type CamofoxConfig = z.infer<typeof CamofoxConfigSchema>
```

```typescript
// plugins/jiku.camofox/src/adapter.ts

import { BrowserAdapter } from '@jiku/kit'
import { execBrowserCommand } from '@jiku/browser'
import { browserMutex } from '../../../apps/studio/server/src/browser/concurrency.ts'
// CATATAN: Jiku.camofox plugin boleh import dari @jiku/browser karena ini internal package.
// Tidak import dari apps/studio langsung — harus lewat shared packages.
// Tab manager juga shared via import dari @jiku/browser atau @jiku/kit.

export class CamofoxAdapter extends BrowserAdapter {
  readonly id          = 'jiku.camofox'
  readonly displayName = 'CamoFox'
  readonly description = [
    'Firefox-based browser with advanced anti-fingerprinting protection.',
    'Ideal for workflows that require bypassing bot detection or simulating',
    'realistic human browsing behavior. Powered by CamoFox.',
    'Requires CamoFox browser binary installed separately.',
  ].join(' ')
  readonly configSchema = CamofoxConfigSchema

  async execute(input: unknown, ctx: BrowserAdapterContext): Promise<BrowserAdapterResult> {
    // Mekanisme execute sama dengan JikuBrowserVercelAdapter (CDP-based)
    // Beda hanya di cdp_url dan cara resolve endpoint
    // ...
  }

  async ping(config: unknown): Promise<BrowserPingResult> {
    // Sama dengan JikuBrowserVercelAdapter.ping()
    // ...
  }

  async preview(config: unknown): Promise<BrowserPreviewResult> {
    // ...
  }
}

export const camofoxAdapter = new CamofoxAdapter()
```

```typescript
// plugins/jiku.camofox/src/index.ts

import { definePlugin } from '@jiku/kit'
import StudioPlugin from '@jiku-plugin/studio'
import { camofoxAdapter } from './adapter.ts'

export default definePlugin({
  meta: {
    id: 'jiku.camofox',
    name: 'CamoFox Browser',
    version: '1.0.0',
    description: 'Adds CamoFox as a browser adapter — Firefox-based browser with anti-fingerprinting.',
    author: 'Jiku',
    icon: 'Globe',
    category: 'browser',
  },
  depends: [StudioPlugin],
  setup(ctx) {
    ctx.browser.register(camofoxAdapter)
  },
})
```

### 9.3 Catatan Implementasi CamoFox

Sebelum mengimplementasi `CamofoxAdapter.execute()` dan `ping()`, **baca terlebih dahulu** `https://github.com/jo-inc/camofox-browser` untuk memahami:
- Apakah CamoFox expose CDP endpoint standard atau API custom
- Cara launch CamoFox (binary? API? Docker?)
- Config yang tersedia (proxy format, executable path, dll)

Jika CamoFox menggunakan CDP standard → `execute()` bisa didelegasikan ke `execBrowserCommand` dari `@jiku/browser` persis seperti `JikuBrowserVercelAdapter`.

Jika CamoFox punya API berbeda → perlu tulis execute handler sendiri, tapi tetap return `BrowserAdapterResult`.

---

## 10. Concurrency Model Update

### Perubahan Kunci: `projectId` → `profileId` di Mutex & Tab Manager

```typescript
// SEBELUM:
browserMutex.acquire(projectId, fn)
browserTabManager.getAgentTabIndex(projectId, agentId)

// SESUDAH:
browserMutex.acquire(profileId, fn)
browserTabManager.getAgentTabIndex(profileId, agentId)
```

Setiap profile adalah CDP endpoint tersendiri → tidak ada konflik antar profile dalam satu project. Mutex serialisasi per-profile, bukan per-project.

### `dropProject()` → `dropProfile()`

```typescript
// tab-manager.ts — rename method
browserTabManager.dropProfile(profileId)  // sebelumnya: dropProject(projectId)
```

Dipanggil saat:
- Profile dihapus
- Profile di-disable
- `adapter.onProfileDeactivated()` dipanggil

---

## 11. Implementation Checklist

### Phase 1 — Abstraction Layer (`@jiku/kit`)
- [ ] Buat `packages/kit/src/browser-adapter.ts` — abstract class + types
- [ ] Export dari `packages/kit/src/index.ts`

### Phase 2 — Registry + Plugin Context
- [ ] Buat `apps/studio/server/src/browser/adapter-registry.ts`
- [ ] Tambah `PluginBrowserAdapterAPI` ke `plugins/jiku.studio/src/types.ts`
- [ ] Update `StudioContributes` di `plugins/jiku.studio/src/index.ts`
- [ ] Update `context-extender.ts` — tambah `browser: makeBrowserAdapter()`
- [ ] Register built-in adapter di `apps/studio/server/src/browser/index.ts`

### Phase 3 — DB
- [ ] Buat migration SQL `0009_browser_profiles.sql`
- [ ] Buat Drizzle schema `browser-profiles.ts`
- [ ] Buat `queries/browser-profiles.ts` (semua CRUD + setDefault)
- [ ] Export dari `apps/studio/db/src/index.ts`
- [ ] Jalankan migration + verifikasi data migration lama

### Phase 4 — JikuBrowserAdapter
- [ ] Buat `apps/studio/server/src/browser/adapters/jiku-browser-vercel.ts`
- [ ] Refactor `execute.ts` — `mapToBrowserCommand` + `formatBrowserResult` jadi helper yang bisa dipanggil adapter
- [ ] Refactor `tab-manager.ts` — ganti `projectId` → `profileId` di semua method
- [ ] Refactor `concurrency.ts` — ganti `projectId` → `profileId` di mutex key
- [ ] Update `apps/studio/server/src/browser/index.ts` — register JikuBrowserVercelAdapter

### Phase 5 — Unified Browser Tool
- [ ] Update `tool-schema.ts` — tambah `profile_id?: string`
- [ ] Rewrite `tool.ts` — `buildBrowserTools(projectId)` jadi async, route ke adapter
- [ ] Update `runtime/manager.ts` — `await buildBrowserTools(projectId)`

### Phase 6 — API Routes
- [ ] Buat `routes/browser-profiles.ts` — semua endpoint profiles
- [ ] Tambah `GET /adapters` endpoint — list adapter dari registry
- [ ] Mount di `apps/studio/server/src/index.ts`
- [ ] Update `routes/browser.ts` — backward compat (deprecated notice)

### Phase 7 — Frontend
- [ ] Rewrite `browser/page.tsx` — multi-profile layout dengan tabs
- [ ] Buat `ProfileTab` component — settings + preview + debug per profile
- [ ] Buat `AddProfileModal` component — adapter selector + config form
- [ ] Update `lib/api.ts` — tambah semua `api.browser.*Profile*` methods
- [ ] Update types di `lib/api.ts` — `BrowserProfile`, `BrowserAdapter`, dll

### Phase 8 — CamoFox Plugin
- [ ] Baca repo `https://github.com/jo-inc/camofox-browser` — understand API
- [ ] Buat `plugins/jiku.camofox/package.json`
- [ ] Buat `plugins/jiku.camofox/src/types.ts` — `CamofoxConfigSchema`
- [ ] Buat `plugins/jiku.camofox/src/adapter.ts` — `CamofoxAdapter`
- [ ] Buat `plugins/jiku.camofox/src/index.ts` — plugin entry
- [ ] Register `jiku.camofox` di plugin loader config

### Phase 9 — Docs
- [ ] Update `docs/feats/browser.md` — describe multi-profile architecture
- [ ] Update `docs/builder/changelog.md`
- [ ] Update `docs/builder/current.md`

---

## 12. Key Decisions

### D-01: Satu unified `browser` tool, bukan per-profile tool
Jika ada 3 profile, expose 3 tool (`browser_main`, `browser_stealth`, `browser_archive`) akan membingungkan LLM tentang mana yang harus dipilih. Unified tool + `profile_id` param + dynamic description yang list profile names adalah pendekatan yang jauh lebih clean. LLM bisa lihat daftar profile langsung di tool description dan memilih berdasarkan nama/tujuan.

### D-02: Mutex per-profile, bukan per-project
Setiap profile adalah CDP endpoint tersendiri. Dua profile dalam satu project bisa berjalan paralel tanpa konflik. Mutex per-profile sudah cukup — tidak perlu koordinasi lintas profile.

### D-03: BrowserAdapter di `@jiku/kit`, bukan di `@jiku/types`
`@jiku/kit` sudah export `ConnectorAdapter` dan `defineTool`. Pattern yang sama untuk `BrowserAdapter` + `defineBrowserAdapter`. `@jiku/types` hanya menyimpan pure types tanpa abstract class.

### D-04: Built-in adapter (JikuBrowserVercel) tidak lewat plugin
`jiku.browser.vercel` didaftarkan langsung di server startup — bukan lewat plugin. Ini karena:
- Browser adalah built-in feature Studio, bukan optional plugin
- Menghindari race condition: plugin setup bisa telat, adapter harus ada sebelum project wakeUp
- Konsisten dengan cara connector tools lain diregister

### D-05: Data migration — buat profile dari existing config
Project yang punya `browser_enabled = true` otomatis dapat satu default profile dengan adapter `jiku.browser.vercel` dan config yang sudah ada. Zero downtime — tidak perlu user setup ulang.

### D-06: CamoFox CDP-compatibility assumption
Diasumsikan CamoFox expose CDP endpoint standard (Firefox DevTools Protocol adalah superset CDP). Jika asumsi salah setelah baca repo, `CamofoxAdapter.execute()` bisa tulis handler sendiri tanpa mengubah interface.

---

## 13. File Estimates

| Area | Files | Status |
|------|-------|--------|
| `packages/kit/` | +1 | Baru |
| `plugins/jiku.studio/` | ~2 dimodifikasi | |
| `plugins/jiku.camofox/` | +3 | Baru |
| `apps/studio/db/` | +2 baru, ~2 dimodifikasi | |
| `apps/studio/server/src/browser/` | +2 baru, ~4 dimodifikasi | |
| `apps/studio/server/src/routes/` | +1 baru, ~1 dimodifikasi | |
| `apps/studio/server/src/runtime/manager.ts` | ~1 dimodifikasi | |
| `apps/studio/web/` | ~3 dimodifikasi, +2 baru | |
| **Total** | **~20 files** | |
