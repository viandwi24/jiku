# Plan 17 — Plugin UI System

> **Status:** Draft
> **Owner:** TBD
> **Target:** Production-grade, developer-first plugin UI yang fleksibel, aman, dan punya DX setara VS Code Extension / Grafana Plugin.
> **Depends on:** Plan 2 (plugin system), Plan 7 (plugin v3), Plan 14/16 (filesystem), Plan 12 (ACL), `@jiku/ui`, `@jiku/kit`.

---

## 1. Goals & Non-Goals

### Goals
1. Plugin bebas membuat UI React apapun (full page, widget, panel, modal) — bukan terbatas form config.
2. Plugin bundle tipis karena `react`, `react-dom`, `@jiku/ui`, `@jiku/kit/ui` di-share via import map.
3. DX kelas satu: `bun create jiku-plugin` → `bun run dev` → HMR live di Studio.
4. Perfect secara UI/UX: theme konsisten (dark/light), error boundary per plugin, loading/skeleton standar, CSS tidak bocor, a11y lolos audit.
5. Aman by default: permission tiap slot, asset hash immutable, audit log per plugin action.
6. Versioning jelas: `ui.apiVersion` + policy kompatibilitas.
7. Future-proof: slot baru bisa ditambah tanpa breaking plugin lama; kontrak `ctx` additive-only per versi.
8. First-party plugin (`jiku.connector`, `jiku.cron`, `jiku.skills`, `jiku.telegram`, `jiku.social`) bermigrasi ke sistem ini.

### Non-Goals (fase 1)
- Plugin marketplace publik.
- Plugin berbayar / lisensi.
- Plugin framework non-React (Vue/Svelte) — pakai iframe escape hatch di fase 3.
- Sandbox keamanan untuk plugin third-party untrusted (masuk Plan 18).
- Plugin bisa modifikasi route core Studio.

---

## 2. User Stories

### Plugin Developer (fokus utama)
- Sebagai dev plugin, saya jalankan `bun create jiku-plugin analytics` dan mendapatkan template siap pakai (UI + server + tools).
- Saya jalankan `bun run dev`, buka Studio di browser, toggle "Load dev plugin", dan UI saya muncul langsung.
- Edit komponen → refresh instant tanpa kehilangan state chat.
- Saya dapat autocomplete TypeScript penuh di `ctx.api`, `ctx.tools`, `ctx.files`.
- Stack trace error menunjuk ke file asli saya (source map).
- Saya bisa run plugin dalam mode standalone (mock `ctx`) untuk prototyping cepat.

### Studio User
- Saya install plugin → muncul di sidebar, dashboard, atau settings sesuai slot-nya — **konsisten dengan UI core** (theme, spacing, typography).
- Plugin yang crash tidak bikin seluruh Studio pecah — muncul fallback jelas dengan tombol "Reload plugin" dan link ke error log.
- Plugin lambat tidak freeze host — ada loading skeleton standar.
- Saya bisa disable/enable plugin per project tanpa restart.
- Tiap action plugin yang sensitif minta konfirmasi (pakai `ctx.ui.confirm`).

### Jiku Maintainer
- Saya dapat audit log: plugin X memanggil tool Y oleh user Z jam sekian.
- Saya bisa pin versi API plugin; plugin dengan `apiVersion` tidak kompatibel ditolak saat load.
- Telemetri: render time, error rate, API latency per plugin.

---

## 3. Architecture Overview

```
┌──────────────────────────────────────────────────────────────────┐
│  Studio Web (Next.js)                                            │
│                                                                  │
│  ┌─── PluginUIProvider ────────────────────────────────────┐     │
│  │                                                          │     │
│  │  SlotRegistry ← registry manifest (REST)                 │     │
│  │       │                                                   │     │
│  │       ▼                                                   │     │
│  │  <Slot name="sidebar.item" /> ← render all entries       │     │
│  │       │                                                   │     │
│  │       ▼                                                   │     │
│  │  PluginEntry ── error boundary ── <Suspense>             │     │
│  │       │                                                   │     │
│  │       └── dynamic import(pluginAssetUrl)                  │     │
│  │                │                                          │     │
│  │                ▼                                          │     │
│  │        <PluginComponent ctx={ctx} />                      │     │
│  │                                                          │     │
│  │  ctx = { api, tools, files, ui, storage, secrets, ...  } │     │
│  └──────────────────────────────────────────────────────────┘     │
│                                                                  │
│  Import map shares: react, react-dom, @jiku/ui, @jiku/kit/ui     │
└──────────────────────────────────────────────────────────────────┘
                             │
                             ▼
┌──────────────────────────────────────────────────────────────────┐
│  Studio Server                                                   │
│                                                                  │
│  GET /api/plugins/ui-registry  → manifest per project            │
│  GET /api/plugins/:id/ui/*      → static asset (hash, immutable) │
│  /api/plugins/:id/api/*         → namespaced plugin API          │
│  /api/plugins/:id/events        → SSE (plugin → web)             │
│                                                                  │
│  PluginUIAssetStore   (filesystem / object store)                │
│  PluginAPIRouter      (route per plugin, auth scoped)            │
│  PluginManifestStore  (DB: enabled plugins, versions)            │
└──────────────────────────────────────────────────────────────────┘
                             │
                             ▼
┌──────────────────────────────────────────────────────────────────┐
│  Plugin Package (e.g. plugins/jiku.analytics)                    │
│                                                                  │
│  plugin.ts            definePlugin + defineUI entries            │
│  ui/*.tsx             React components                           │
│  server/*             tools, routes, hooks                       │
│  vite.config.ts       pakai createPluginBuild() dari @jiku/kit   │
│                                                                  │
│  bun run dev  → Vite dev server (ESM + HMR)                      │
│  bun run build → dist/ui/*.js (hash, manifest.json)              │
└──────────────────────────────────────────────────────────────────┘
```

### Prinsip Kunci
- **ESM native, import map** — tidak ada Module Federation bundler. Browser modern saja.
- **Host-owned routing** — plugin tidak punya router sendiri; path plugin didelegasikan via `project.page` slot yang menerima sub-path (`/plugins/:pluginId/*`).
- **Context injection, bukan global** — plugin tidak boleh import dari `@jiku-studio/*` langsung. Semua akses lewat `ctx` (dari `@jiku/kit/ui`).
- **Additive-only API** — breaking change naikkan `apiVersion` major, host support N-1.

---

## 4. Slot Registry

Slot = titik tempat plugin UI di-mount. Kontrak stabil, typed strict.

### Slot Awal (Fase 1)

| Slot ID | Lokasi | Props yang diterima | Jumlah |
|---------|--------|--------------------|--------|
| `sidebar.item` | Sidebar utama project | `{ ctx }` | many |
| `project.page` | Halaman full di `/projects/:p/plugins/:id/*` | `{ ctx, subPath }` | 1 per plugin |
| `agent.page` | Halaman full di `/agents/:a/plugins/:id/*` | `{ ctx, subPath }` | 1 per plugin |
| `agent.settings.tab` | Tab di settings agent | `{ ctx }` | many |
| `project.settings.section` | Section di settings project | `{ ctx }` | many |
| `dashboard.widget` | Widget di landing project | `{ ctx, size }` | many |
| `chat.compose.action` | Tombol di composer chat | `{ ctx, conversation }` | many |
| `chat.message.action` | Action per message | `{ ctx, message }` | many |
| `conversation.panel.right` | Side panel kanan chat | `{ ctx, conversation }` | many |
| `command.palette.item` | Item Cmd+K | `{ ctx }` (provider pattern) | many |
| `global.modal` | Modal fullscreen via `ctx.ui.openModal` | `{ ctx, props }` | on-demand |

### Aturan Slot
- Tiap slot ID punya TypeScript interface props di `@jiku/kit/ui/slots.ts`.
- Slot baru ditambah tanpa menaikkan apiVersion major.
- Slot dihapus → major bump + deprecation window 2 versi.
- Plugin mendaftar slot via manifest; host render pakai `<Slot name="..." />` dengan memo + stable key.

### SlotRegistry API (internal web)

```ts
registry.list(slotId, filter?) → PluginEntry[]
registry.mount(slotId, element, opts) → unsubscribe()
registry.subscribe(slotId, callback) // reactive updates
```

---

## 5. Manifest Schema

Manifest di-generate saat build + juga bisa di-declare inline di `definePlugin`.

### `plugin.manifest.json` (versi build)
```jsonc
{
  "id": "jiku.analytics",
  "version": "1.2.0",
  "apiVersion": "1",
  "displayName": "Analytics",
  "description": "Project-level analytics dashboard",
  "icon": "chart-line",
  "permissions": ["analytics:read", "analytics:export"],
  "ui": {
    "entries": [
      {
        "slot": "sidebar.item",
        "id": "nav",
        "module": "./ui/nav.js",
        "meta": { "label": "Analytics", "icon": "chart-line", "order": 20 }
      },
      {
        "slot": "project.page",
        "id": "dashboard",
        "module": "./ui/Dashboard.js",
        "meta": { "path": "analytics", "title": "Analytics" }
      }
    ],
    "assets": {
      "Dashboard.js": "sha384-abc123...",
      "nav.js": "sha384-def456..."
    }
  },
  "server": {
    "routes": ["./server/routes.js"],
    "tools": ["./server/tools.js"]
  }
}
```

### `defineUI` (source-level, type-safe)
```ts
import { definePlugin, defineUI } from '@jiku/kit'

export default definePlugin({
  id: 'jiku.analytics',
  version: '1.2.0',
  permissions: ['analytics:read', 'analytics:export'],

  ui: defineUI({
    entries: [
      {
        slot: 'sidebar.item',
        id: 'nav',
        component: () => import('./ui/nav'),
        meta: { label: 'Analytics', icon: 'chart-line', order: 20 },
      },
      {
        slot: 'project.page',
        id: 'dashboard',
        component: () => import('./ui/Dashboard'),
        meta: { path: 'analytics', title: 'Analytics' },
      },
    ],
  }),

  setup(ctx) { /* server-side */ },
})
```

Build step mengubah `component: () => import(...)` menjadi `module: "./ui/Dashboard.js"` di manifest.

---

## 6. PluginContext Contract

Kontrak paling mahal untuk diubah — **lock dulu di fase 1**. Versi awal: `apiVersion: "1"`.

```ts
// @jiku/kit/ui
export interface PluginContext {
  // ─── Identity ──────────────────────────────────────────
  plugin: { id: string; version: string }
  project: { id: string; slug: string; name: string }
  agent?: { id: string; slug: string; name: string }  // hanya di slot agent.*
  conversation?: { id: string; mode: 'chat' | 'task' }
  user: { id: string; role: 'owner' | 'admin' | 'member' }

  // ─── Plugin API (namespaced ke server plugin) ─────────
  api: {
    query<T = unknown>(op: string, input?: unknown): Promise<T>
    mutate<T = unknown>(op: string, input?: unknown): Promise<T>
    stream<T = unknown>(op: string, input?: unknown): AsyncIterable<T>
    // React hooks (menggunakan TanStack Query host)
    useQuery<T = unknown>(op: string, input?: unknown, opts?: QueryOpts): QueryResult<T>
    useMutation<T = unknown, V = unknown>(op: string): MutationResult<T, V>
  }

  // ─── Tools (invoke tool milik plugin sendiri / tool lain dengan permission) ─
  tools: {
    list(filter?: { plugin?: string }): ToolInfo[]
    invoke<T = unknown>(toolId: string, input: unknown): Promise<T>
  }

  // ─── Filesystem virtual (Plan 16) ─────────────────────
  files: {
    list(path: string): Promise<FileEntry[]>
    read(path: string): Promise<Uint8Array>
    readText(path: string): Promise<string>
    write(path: string, data: Uint8Array | string, opts?: { expectedVersion?: number }): Promise<FileEntry>
    upload(file: File, destDir: string): Promise<FileEntry>
    search(query: string): Promise<FileEntry[]>
  }

  // ─── Storage KV (per plugin, per project) ──────────────
  storage: {
    get<T = unknown>(key: string): Promise<T | null>
    set<T = unknown>(key: string, value: T): Promise<void>
    delete(key: string): Promise<void>
    list(prefix?: string): Promise<string[]>
  }

  // ─── Secrets (integrasi credentials core, encrypted) ───
  secrets: {
    get(key: string): Promise<string | null>
    set(key: string, value: string): Promise<void>
    delete(key: string): Promise<void>
  }

  // ─── UI helpers ────────────────────────────────────────
  ui: {
    toast(opts: { title: string; description?: string; variant?: 'default'|'success'|'error'|'warning' }): void
    confirm(opts: { title: string; description?: string; destructive?: boolean }): Promise<boolean>
    openModal<T = unknown>(modalId: string, props?: unknown): Promise<T>
    closeModal(result?: unknown): void
    navigate(to: string): void              // host router, relatif thd slot
    openPluginPage(pluginId: string, subPath?: string): void
    theme: { mode: 'light' | 'dark'; tokens: Record<string, string> }
  }

  // ─── Events (plugin ↔ plugin ↔ host) ──────────────────
  events: {
    emit(topic: string, payload?: unknown): void
    on(topic: string, handler: (payload: unknown) => void): () => void  // returns unsubscribe
  }

  // ─── Permissions ───────────────────────────────────────
  permissions: {
    has(permission: string): boolean
    require(permission: string): void   // throws PluginPermissionError
  }

  // ─── Telemetry (structured log) ────────────────────────
  log: {
    info(msg: string, meta?: Record<string, unknown>): void
    warn(msg: string, meta?: Record<string, unknown>): void
    error(msg: string, meta?: Record<string, unknown>): void
  }
}
```

### Aturan Tambahan
- Semua `api.*` otomatis namespaced ke `/api/plugins/:id/api/...`.
- `tools.invoke` melewati permission checker sama persis seperti agent invoke tool.
- `storage` disimpan di tabel `plugin_storage (plugin_id, project_id, key, value_jsonb)`.
- `secrets` re-use `credentials` table dengan scope baru `plugin:<id>`.
- `events` scope default: **project** (tidak bocor lintas project).

---

## 7. Loader Runtime (Web)

### Boot Sequence
1. Studio web mount → `PluginUIProvider` fetch `GET /api/plugins/ui-registry?project=:p`.
2. Response: daftar plugin aktif + manifest + URL asset + SRI hash.
3. Registry diisi (in-memory, reactive via TanStack Query).
4. Import map di-inject ke `<head>` (sekali, saat boot) mapping `react`, `react-dom`, `@jiku/ui`, `@jiku/kit/ui` ke versi host.
5. Slot components render: `<Slot name="sidebar.item" />` iterate entries dan lazy `import(asset.url)`.

### PluginEntry Component
```tsx
function PluginEntry({ entry, ctx }) {
  return (
    <ErrorBoundary fallback={<PluginErrorFallback entry={entry} />}>
      <Suspense fallback={<PluginSkeleton slot={entry.slot} />}>
        <LazyPluginModule entry={entry} ctx={ctx} />
      </Suspense>
    </ErrorBoundary>
  )
}
```

### Caching
- Prod: URL asset pakai content hash → `Cache-Control: public, immutable, max-age=31536000`.
- Dev: `Cache-Control: no-store`, URL dari dev server.
- Registry response: cache 30 detik + SSE invalidation saat plugin enable/disable.

### Hot Re-registry
- Server broadcast SSE `plugin.registry.changed` → web re-fetch registry → SlotRegistry diff → slot yang berubah re-render.

---

## 8. Server: Asset Serving & Plugin API

### Asset Store
- Saat plugin di-install/upgrade, server ekstrak build artifact ke `storage/plugins/:id/:version/*`.
- File di-serve via `GET /api/plugins/:id/ui/:version/:file` dengan hash verification + CSP nonce.
- Versi lama tetap diserve sampai semua client migrasi (soft retire, 24h).

### Plugin API Router
- Plugin daftarkan handler via `plugin.route()` di server code.
- Otomatis ter-mount di `/api/plugins/:id/api/*`.
- Middleware auto: auth, rate limit (per plugin + per user), permission check (plugin harus punya permission sesuai manifest), audit log.

Contoh plugin server:
```ts
definePlugin({
  setup(pluginCtx) {
    pluginCtx.http.get('/summary', async (req) => {
      const { projectId } = req
      return { visits: 1234, ... }
    })
  },
})
```

Plugin UI: `ctx.api.query('summary')` → `GET /api/plugins/jiku.analytics/api/summary`.

### Registry Endpoint
```
GET /api/plugins/ui-registry?project=:p
→ {
  "apiVersion": "1",
  "plugins": [ { manifest, assetBaseUrl, enabled, health } ]
}
```

### Events SSE
```
GET /api/plugins/:id/events?project=:p
→ stream events dari server ke UI (subscription per topic)
```

---

## 9. `@jiku/kit` Build Preset

Plugin dev tidak perlu paham Vite/Rollup internals.

### `createPluginBuild()`
```ts
// vite.config.ts di plugin
import { defineConfig } from 'vite'
import { createPluginBuild } from '@jiku/kit/build'

export default defineConfig(createPluginBuild({
  entries: ['./ui/Dashboard.tsx', './ui/nav.tsx', './ui/Settings.tsx'],
  pluginId: 'jiku.analytics',
}))
```

Preset set:
- `build.lib`: ESM, tiap entry jadi satu file output.
- `rollupOptions.external`: `react`, `react-dom`, `@jiku/ui`, `@jiku/ui/*`, `@jiku/kit/ui`, `@jiku/types`.
- Output path: `dist/ui/*.js`, plus `dist/plugin.manifest.json` (di-generate otomatis).
- Hash filenames di mode build.
- Sourcemap `hidden-source-map` → di-upload ke server terpisah (untuk stack trace), tidak di-expose publik.
- CSS: scoped via CSS Modules atau Tailwind layer `@layer plugin.{id}`.
- Static assets (png, svg): inline kalau <4KB, else emit + hash.

### CLI `@jiku/kit`
- `bun x jiku-plugin dev` — scaffold + watch + serve.
- `bun x jiku-plugin build` — produksi.
- `bun x jiku-plugin typecheck` — cek kontrak slot (props mismatch → error).
- `bun x jiku-plugin validate` — lint manifest, check permission, check bundle size budget (< 50KB gzipped warning, < 200KB error).

---

## 10. Dev Mode

### Mode 1: Load dari Dev Server
1. Plugin author: `cd plugins/my-plugin && bun run dev` → Vite jalan di `:5180`.
2. Studio: Settings → Plugins → "Dev plugins" → tambah URL `http://localhost:5180`.
3. Atau env: `JIKU_PLUGIN_DEV_URLS=http://localhost:5180,http://localhost:5181`.
4. Studio web fetch manifest dari dev server, import module dari sana.
5. Vite HMR WS otomatis jalan (karena module emang dari Vite) → edit file → component refresh in-place, state utuh.

### Mode 2: Standalone Preview
- `bun x jiku-plugin dev --standalone` — buka halaman minimal di `http://localhost:5180/preview?entry=Dashboard` dengan `ctx` mock.
- Mock `ctx` berisi data fixture (project dummy, agent dummy, API mocked via MSW).
- Cocok untuk prototyping cepat tanpa Studio.

### Mode 3: Full Integration Test
- `bun x jiku-plugin dev --studio` — spawn Studio dev instance + attach plugin.
- Butuh Postgres + S3 lokal (docker-compose disediakan di template).

### HMR untuk Server Code
- Plugin server code watch via `bun --watch`.
- PluginLoader server dengarkan file change → unload plugin registry → re-register.
- Tools lama di-drain (conversation aktif selesai dulu), tools baru take over.
- Web dapat SSE `plugin.registry.changed` → refetch.

### Plugin Inspector (di Studio Settings → Developer)
- List plugin aktif + mode (prod/dev).
- Tiap plugin: status, versi, apiVersion, slot terisi, render count, render time avg, error count, last error (stack trace).
- Tombol: reload plugin, clear cache, toggle dev mode, copy manifest.
- Live log stream dari `ctx.log.*` per plugin.
- Network panel: request ke `/api/plugins/:id/api/*` dengan timing.

### Scaffolding
```
bun create jiku-plugin my-plugin
```
Generate:
```
my-plugin/
├── plugin.ts                definePlugin({...})
├── ui/
│   ├── Dashboard.tsx        contoh halaman full
│   ├── Settings.tsx         contoh settings tab
│   └── nav.tsx              contoh sidebar item
├── server/
│   ├── tools.ts             contoh defineTool
│   └── routes.ts            contoh plugin.http.get
├── shared/
│   └── types.ts             shared types UI ↔ server
├── fixtures/                untuk standalone mode
├── vite.config.ts
├── tsconfig.json            extends @jiku/kit/tsconfig
├── package.json
└── README.md
```

---

## 11. Permission & Security

### Manifest Permission
Plugin declare permission di manifest. Saat install:
- User owner review daftar permission.
- Server validate permission valid (di whitelist core).
- Simpan granted permission di `plugin_installations (project_id, plugin_id, granted_permissions jsonb)`.

### Runtime Check
- `ctx.tools.invoke` → check plugin punya permission + user punya role.
- `ctx.files.write` → check filesystem permission scope.
- `ctx.secrets.*` → hanya plugin sendiri, tidak bisa baca secret plugin lain.
- Setiap call di-audit log (plugin_id, user_id, action, timestamp, outcome).

### CSP
- Production: `script-src 'self' 'nonce-{N}'` — asset plugin di-serve dari origin sama.
- Plugin tidak boleh `eval`, `new Function`, inline script.
- Dev mode: CSP dilonggarkan untuk dev URL saja (via env `JIKU_PLUGIN_DEV_URLS`).

### Isolation
- Tiap plugin component dibungkus `<PluginBoundary>` dengan:
  - React ErrorBoundary (catch render error)
  - CSS container (`.plugin-root[data-plugin-id]`)
  - Scope event (tidak bubble ke host kecuali whitelisted)

### Tidak di Fase 1
- Sandbox proses (iframe + origin berbeda) — masuk Plan 18 untuk plugin third-party.
- Code signing manifest — masuk Plan 18.

---

## 12. CSS Isolation & Theming

### Strategi
- **Tailwind CSS 4 dengan `@layer`** — plugin pakai `@layer plugin` yang prioritasnya di bawah core.
- **Design token** di-expose via CSS variable global (`--jiku-color-accent`, `--jiku-radius`, dsb).
- Plugin **dianjurkan** pakai `@jiku/ui` components; kalau bikin sendiri, wajib konsumsi token (tidak hardcode warna).
- Utility class bernamespace: `.jp-` prefix untuk plugin (lint rule).
- Container query: plugin harus responsive terhadap ukuran slot, bukan viewport.

### Theme Switching
- `ctx.ui.theme` reactive; plugin subscribe ke `theme.mode` change.
- `@jiku/ui` otomatis handle dark/light → plugin gratis ikut kalau pakai components.

### Typography & Spacing
- `@jiku/kit/ui` export `<PluginPage>`, `<PluginSection>`, `<PluginCard>` wrapper yang apply spacing & heading hierarchy konsisten.
- Contoh:
  ```tsx
  <PluginPage title="Analytics" actions={<Button>Export</Button>}>
    <PluginSection title="Overview">...</PluginSection>
  </PluginPage>
  ```
  Ini menjamin UX konsisten lintas plugin tanpa membatasi konten.

### A11y
- Lint rule di build: alt text wajib, heading hierarchy valid, focus ring visible.
- `@jiku/ui` sudah a11y-compliant; wrapper inherit.

---

## 13. Versioning & Compatibility

### `apiVersion` Semantics
- Major `1`, `2`, ... — breaking contract `ctx` atau slot.
- Host support **current + previous major** (2 versi paralel di import map).
- Plugin declare `apiVersion: "1"` di manifest; jika host tidak support, plugin ditolak dengan UI jelas (tombol "Update plugin").

### Slot Evolution
- Tambah slot → tidak breaking.
- Tambah props optional → tidak breaking.
- Ubah props / hapus slot → major bump, deprecation 1 versi (warning di console + inspector).

### `@jiku/ui` Compat
- `@jiku/ui` major version terkait dengan `apiVersion`. Major bump UI → major bump apiVersion.

---

## 14. Error Handling & Telemetry

### Error Boundary
- Per-plugin error boundary dengan fallback UI:
  - Icon warning
  - Judul: "Plugin '{name}' failed to load"
  - Pesan singkat (dari error.message)
  - Tombol: Reload, Report, Disable
  - Kalau dev mode: tampilkan stack trace.
- Host tetap fungsional meski 1 plugin crash.

### Telemetry
- Tiap mount: `plugin.render { pluginId, slot, durationMs }`
- Tiap error: `plugin.error { pluginId, slot, message, stack }`
- Tiap API call: `plugin.api { pluginId, op, statusCode, durationMs }`
- Tiap tool invoke: `plugin.tool.invoke { ... }`
- Simpan 30 hari, visualisasi di Plugin Inspector.

### Graceful Degradation
- Load timeout 10 detik → tampilkan fallback "Plugin took too long".
- Retry strategy: exponential backoff (1s, 3s, 10s, max 3x), lalu manual.

---

## 15. Database Changes

Migration baru: `0010_plugin_ui.sql`.

```sql
CREATE TABLE plugin_installations (
  id uuid PRIMARY KEY,
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  plugin_id text NOT NULL,
  version text NOT NULL,
  api_version text NOT NULL,
  enabled boolean NOT NULL DEFAULT true,
  granted_permissions jsonb NOT NULL DEFAULT '[]',
  config jsonb NOT NULL DEFAULT '{}',
  installed_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(project_id, plugin_id)
);

CREATE TABLE plugin_storage (
  id uuid PRIMARY KEY,
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  plugin_id text NOT NULL,
  key text NOT NULL,
  value jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(project_id, plugin_id, key)
);

CREATE TABLE plugin_assets (
  id uuid PRIMARY KEY,
  plugin_id text NOT NULL,
  version text NOT NULL,
  file_path text NOT NULL,
  content_hash text NOT NULL,
  size_bytes bigint NOT NULL,
  uploaded_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(plugin_id, version, file_path)
);

CREATE TABLE plugin_audit_log (
  id uuid PRIMARY KEY,
  project_id uuid,
  plugin_id text NOT NULL,
  user_id uuid,
  action text NOT NULL,
  target text,
  outcome text NOT NULL,
  meta jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON plugin_audit_log (plugin_id, created_at DESC);
CREATE INDEX ON plugin_audit_log (project_id, created_at DESC);
```

---

## 16. Migration Path untuk Plugin Existing

Plugin built-in: `jiku.connector`, `jiku.cron`, `jiku.skills`, `jiku.telegram`, `jiku.social`.

### Strategi
- Plan 17 tidak memaksa migrasi langsung; plugin lama tetap jalan (server side).
- Tambah UI entries per plugin bertahap (fase 5 di milestone).
- Tidak ada breaking change di plugin server API.

### Contoh: `jiku.connector` ditambahi UI
- Slot: `project.settings.section` → panel list connector.
- Slot: `sidebar.item` → link ke halaman channel.
- Slot: `project.page` (path `connectors`) → full management UI.

Pemilik plugin tinggal tambahkan `ui: defineUI({ entries: [...] })` di `definePlugin`.

---

## 17. Milestones

### M1 — Foundation (2 minggu)
- [ ] Types: `PluginContext`, `SlotProps`, `ManifestSchema` di `@jiku/kit/ui`.
- [ ] Slot registry + `<Slot>` component di `apps/studio/web`.
- [ ] PluginUIProvider + ErrorBoundary + Suspense wrappers.
- [ ] Import map injection di root layout.
- [ ] Registry endpoint (`GET /api/plugins/ui-registry`) — minimal: return manifest dari plugin aktif.
- [ ] DB migration `0010_plugin_ui.sql`.
- [ ] Plugin Inspector UI minimal (list aktif + status).

**Exit criteria:** Plugin dummy dengan 1 slot (`sidebar.item`) bisa mount di Studio, render "Hello".

### M2 — Loader & API (2 minggu)
- [ ] Asset serving endpoint + content hash + SRI.
- [ ] Plugin API router (`/api/plugins/:id/api/*`) + auth + permission middleware.
- [ ] `ctx.api.*` implementation (query, mutate, stream, hooks).
- [ ] `ctx.tools.invoke` wired ke runtime.
- [ ] `ctx.files.*` wired ke filesystem service.
- [ ] `ctx.storage` + `ctx.secrets` + `ctx.ui` helpers.
- [ ] `ctx.events` SSE pipeline.

**Exit criteria:** Plugin analytics demo bisa: render halaman, fetch data dari API-nya, invoke tool, tampilkan toast.

### M3 — Build Preset & DX (2 minggu)
- [ ] `@jiku/kit/build` dengan `createPluginBuild()`.
- [ ] CLI `jiku-plugin` (dev, build, typecheck, validate).
- [ ] `bun create jiku-plugin` scaffolding.
- [ ] Dev mode load dari URL (host support).
- [ ] Standalone preview mode dengan mock `ctx`.
- [ ] Source map pipeline.

**Exit criteria:** `bun create jiku-plugin hello` → `bun run dev` → muncul di Studio tanpa konfigurasi tambahan.

### M4 — Polish UI/UX (1 minggu)
- [ ] `<PluginPage>`, `<PluginSection>`, `<PluginCard>`, `<PluginSkeleton>` wrappers.
- [ ] Theme token propagation.
- [ ] CSS isolation & layer strategy.
- [ ] Error fallback UI + retry.
- [ ] Loading skeleton per slot.
- [ ] A11y audit pass (axe-core di CI).

**Exit criteria:** Lighthouse a11y ≥ 95 di halaman plugin demo. Visual regression snapshot lolos untuk 10 variasi slot.

### M5 — Migration First-Party Plugins (1 minggu)
- [ ] `jiku.connector` tambah UI entries.
- [ ] `jiku.cron` tambah UI entries.
- [ ] `jiku.skills` tambah UI entries.
- [ ] `jiku.telegram` + `jiku.social` contoh showcase.
- [ ] Dokumentasi author-facing di `docs/dev/plugin/`.

**Exit criteria:** Minimal 3 plugin first-party pakai sistem baru, tanpa regression fungsional.

### M6 — Observability & Hardening (1 minggu)
- [ ] Plugin Inspector full (metrics, log stream, network panel).
- [ ] Telemetry pipeline.
- [ ] Rate limiting per plugin.
- [ ] Audit log viewer.
- [ ] Bundle size budget enforcement.
- [ ] Load test 20 plugin konkuren.

**Exit criteria:** 20 plugin aktif, p95 initial load < 1.5s, error rate < 0.5% di demo.

**Total:** ~9 minggu (1 developer fokus) atau ~5 minggu (2 developer paralel).

---

## 18. Acceptance Criteria (Perfect, bukan asal jalan)

### Fungsional
- ✅ Plugin dengan 3 slot berbeda render semua tanpa error.
- ✅ HMR edit komponen → update < 500ms tanpa full reload.
- ✅ `ctx.api.query` round-trip < 100ms di local.
- ✅ Plugin crash → host tetap responsif, fallback muncul < 100ms.
- ✅ Disable plugin → UI hilang < 1 detik tanpa reload halaman.
- ✅ Upgrade plugin → versi baru live di semua client < 10 detik.

### UI/UX
- ✅ Theme dark/light konsisten 100% (visual regression lolos).
- ✅ Spacing, typography, radius match design system core (pakai token).
- ✅ Keyboard navigation lolos semua slot.
- ✅ Focus ring visible di semua interactive element.
- ✅ Mobile/tablet responsive untuk slot yang applicable.
- ✅ Loading skeleton muncul dalam 50ms saat lazy load.

### DX
- ✅ `bun create jiku-plugin` → jalan di bawah 30 detik.
- ✅ TypeScript autocomplete penuh di `ctx.*`.
- ✅ Error plugin → stack trace menunjuk ke file source asli.
- ✅ Dev mode reload tidak butuh restart Studio.
- ✅ Dokumentasi author: 1 tutorial end-to-end + reference per slot + changelog.

### Performa
- ✅ Bundle plugin minimal (hello world) < 5KB gzipped.
- ✅ Plugin demo realistic < 50KB gzipped.
- ✅ TTI Studio tidak degrade > 100ms saat 10 plugin aktif.
- ✅ Initial registry fetch < 200ms di local.

### Keamanan
- ✅ CSP aktif di production, tidak ada inline script.
- ✅ Plugin tidak bisa akses `localStorage` host (gunakan `ctx.storage`).
- ✅ Audit log lengkap untuk semua `ctx.tools.invoke` + `ctx.files.write` + `ctx.secrets.*`.
- ✅ Permission ditolak → error jelas, tidak silent fail.

---

## 19. Open Questions / Risks

| # | Risk / Question | Mitigasi |
|---|-----------------|----------|
| Q1 | `@jiku/ui` saat ini compatible di-external via import map? | Audit dulu di M1 spike. Kalau tidak, tambah build step re-export ESM flat. |
| Q2 | React 19 server components interop? | Plugin UI = client component only di fase 1. Slot yang server component tidak support. |
| Q3 | Next.js 16 + dynamic import URL external — ada limitasi? | Spike di M1: test `import(/* webpackIgnore */ url)` atau `await import(url)` native di App Router. |
| Q4 | Multiple React instance bug (useContext not shared) | Hindari dengan strict externals + single import map. Add runtime warning kalau dua instance terdeteksi. |
| Q5 | Bundle size @jiku/ui terlalu besar untuk shared? | Split `@jiku/ui` per component export, plugin tree-shake lewat sub-path import. |
| R1 | Plugin jahat (first-party yang di-compromise) | M6: CSP ketat, audit log, bundle review, permission minimum. Plan 18 untuk sandbox. |
| R2 | Breaking change Next.js / React | Pin versi, versioning apiVersion, test matrix di CI. |
| R3 | Konflik CSS Tailwind antar plugin | Layer strategy + container query + lint rule. Review di M4. |
| R4 | DX Vite dev URL tidak auto-detect | Convention `.jiku-plugin.json` di root plugin + auto-scan folder `plugins/*`. |

---

## 20. Follow-up Plans

- **Plan 18 — Plugin Sandbox & Third-Party Marketplace:** iframe escape hatch, origin isolation, code signing, plugin store UI.
- **Plan 19 — Plugin Telemetry Deep Dive:** performance budget enforcement, real-user monitoring, automated alert.
- **Plan 20 — Plugin Composition:** plugin depends on plugin, shared UI primitives across plugins, plugin-ke-plugin API.

---

## 21. Deliverables

### Code
- `packages/kit/src/ui/` — context types, slot types, defineUI.
- `packages/kit/src/build/` — Vite preset, CLI.
- `packages/kit/bin/jiku-plugin` — CLI entry.
- `apps/studio/web/lib/plugins/` — registry, loader, provider, boundary.
- `apps/studio/web/app/(app)/studio/.../plugins/[pluginId]/*` — project.page/agent.page routing.
- `apps/studio/server/src/plugins/ui/` — registry endpoint, asset store, API router.
- `apps/studio/db/src/migrations/0010_plugin_ui.sql`.
- `plugins/jiku.connector/ui/*`, `plugins/jiku.cron/ui/*`, `plugins/jiku.skills/ui/*` — contoh migrasi.
- `packages/create-jiku-plugin/` — scaffolding package.

### Docs
- `docs/dev/plugin/overview.md` — intro & quickstart.
- `docs/dev/plugin/context-api.md` — reference `ctx.*` lengkap.
- `docs/dev/plugin/slots.md` — reference tiap slot.
- `docs/dev/plugin/manifest.md` — schema manifest.
- `docs/dev/plugin/tutorial.md` — end-to-end: bikin plugin analytics.
- `docs/dev/plugin/migration-guide.md` — upgrade plugin lama.
- `docs/feats/plugin-ui.md` — feature doc.

### Tests
- Unit: registry, loader, manifest validator, slot registration.
- Integration: full plugin boot → slot mount → `ctx.api` call.
- E2E (Playwright): install plugin demo, edit dev mode, error recovery, disable/enable.
- Visual regression: 10 slot variation × dark/light.

---

## Ringkasan

Plan ini membangun plugin UI yang **benar-benar fleksibel** (plugin author bebas React apapun), **developer-first** (scaffolding + HMR + inspector + standalone preview), **konsisten UI/UX** (design token, wrapper konsisten, error/loading standar, a11y), **aman** (permission + audit + CSP), dan **future-proof** (slot additive, apiVersion, migration path jelas).

Bentuk akhir: plugin author tinggal `bun create jiku-plugin → bun run dev` dan UI mereka langsung muncul di Studio dengan DX setara VS Code extension atau Grafana plugin, tanpa kompromi di sisi user experience host.
