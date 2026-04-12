# Plan 17 — Plugin UI System — Implementation Report

**Status:** Landed — isolated runtime, auto-discovery gateway, CLI tooling, Studio host anchor, hardened asset serving.
**Shipped:** 2026-04-12 (revised)
**Spec:** `docs/plans/17-plugin-ui.md`

---

## Architecture (final)

### Isolation model

Each plugin's UI is a **self-contained ESM bundle**:
- Built with `tsup` — React + ReactDOM + `@jiku/kit/ui` wrappers bundled into the plugin output.
- Served from `/api/plugins/:id/ui/*.js` by the Studio server.
- Loaded by the browser via opaque dynamic `import(url)` (bypassing Turbopack/webpack bundle-analysis via `new Function('u', 'return import(u)')`).
- Mounted into a host-provided `<div>` with its own React root.

Consequences:
- **Build isolation** — Studio's Next.js never touches plugin source. A TS error in a plugin cannot break Studio.
- **Runtime isolation** — each plugin owns its React instance. A render crash is caught by `PluginErrorBoundary` at the island boundary; Studio stays up.
- **Hot reload** — `invalidatePlugin()` in `mount-runtime.ts` bumps a per-plugin bust counter; existing islands re-fetch a fresh bundle without reloading Studio.

### Gateway (plugin loader)

Single source of truth at server boot:

```
apps/studio/server/src/index.ts
  └─ discoverPluginsFromFolder('<repo>/plugins')
       └─ readdir → each subfolder with package.json
            └─ dynamic import(pkg.module)
                 └─ sharedLoader.register(defaultExport)
```

Every surface reads from this loader: tool runtime, UI manifest, HTTP handlers, asset serving. No hardcoded plugin list anywhere.

### Studio host anchor (`@jiku-plugin/studio`)

A no-op plugin whose only job is to expose Studio-specific ctx surfaces via the plugin system's native `contributes` + `depends` mechanism — **no TypeScript module augmentation**, no magic imports.

```ts
// plugins/jiku.studio/src/index.ts
interface StudioContributes {
  http: PluginHttpAPI
  events: PluginEventsAPI
  connector: PluginConnectorAPI
}

const StudioPlugin = definePlugin({
  meta: { id: 'jiku.studio', ... },
  contributes: () => ({} as unknown as StudioContributes),  // shape-only
  setup() {},
})
```

Runtime values are supplied per-plugin by the Studio server's `extendPluginContext(pluginId, baseCtx)` — the loader's merge order (`{ ...extended, ...mergedFromDeps }`) preserves the extender's bindings because `contributes` returns empty `{}`.

Plugins depending on Studio declare `depends: [StudioPlugin]`, and `MergeContributes<Deps>` gives them typed `ctx.http` / `ctx.events` / `ctx.connector`.

UI side: `@jiku-plugin/studio` exports `StudioPluginContext` (adds `studio: PluginStudioHost`) and `StudioComponentProps` — plugin UI authors use these as the prop type:

```tsx
import type { StudioComponentProps } from '@jiku-plugin/studio'
function Dashboard({ ctx }: StudioComponentProps) { ctx.studio.api.get(...) }
export default defineMountable(Dashboard)
```

`defineMountable` is generic (`defineMountable<C extends PluginContext>`) and infers from the component's prop type.

### Security (hardened asset serving)

| Control | Implementation |
|---|---|
| **Signed URLs** | `ui-registry` (authed) mints HMAC-SHA256 over `(pluginId, file, exp)` using `JWT_SECRET`. TTL 10 min. Asset router verifies before serving. |
| **Rate limit** | In-memory 120 req/min per IP → `429 Retry-After`. |
| **Prod sourcemap gate** | `.map` returns 404 when `NODE_ENV=production`; dev still serves unsigned `.map` for DevTools. |
| **Path traversal guard** | `resolve()` + prefix check. |
| **CORS + nosniff** | `Access-Control-Allow-Origin: *`, `Cross-Origin-Resource-Policy: cross-origin`, `X-Content-Type-Options: nosniff`. |

Full threat model + operator checklist: [`docs/plugin-dev/security.md`](../../plugin-dev/security.md).

### Developer tooling (`jiku` CLI)

New workspace app `apps/cli/` (commander + Ink). Isolated from server/web runtime — tsup/Ink/commander deps never leak to the client bundle.

Commands:

- `jiku` — interactive Ink TUI (arrow nav, `b` build, `w` watch, `r` refresh, `q` quit)
- `jiku plugin list [--json]`
- `jiku plugin info <id>`
- `jiku plugin build [id]` — cwd-aware: inside a plugin folder → that plugin only; otherwise all plugins with UI
- `jiku plugin watch [id]` — same cwd-aware resolution
- `jiku plugin create <id> [-n name]` — scaffold new plugin with `@jiku-plugin/studio` dep + template UI
- Placeholders: `jiku agent`, `jiku db`, `jiku dev` (stubs for future namespaces)

Run via `bun run jiku ...` from anywhere in the workspace.

---

## What landed

### Core (`@jiku/core`)

- `packages/core/src/plugins/discover.ts` — `discoverPluginsFromFolder(root)` reads each subdir, dynamic-imports the entry, returns `DiscoveredPlugin[]`.
- `packages/core/src/plugins/loader.ts` — `setContextExtender(fn)` so a host can augment each plugin's setup ctx with its own runtime bindings.

### Kit (`@jiku/kit`)

- Subpath export `@jiku/kit/ui`.
- `defineMountable<C>(Component)` — wraps a React component into an island `Mountable` whose `mount(el, ctx, meta)` creates its own React root.
- `usePluginQuery(ctx, op)` / `usePluginMutation(ctx, op)` — plain `useState`/`useEffect` hooks, work with any React instance (plugin-bundled).
- `PluginPage` / `PluginSection` / `PluginCard` / `PluginSkeleton` — layout primitives matching Studio design tokens.
- `PluginComponentProps<C>` / `PluginContext` / slot types / `UIEntry` / `defineUI`.

### Types (`@jiku/types`)

- `BasePluginContext` kept host-agnostic (no Studio-specific fields).
- `ContributesValue = object` (relaxed from `Record<string, unknown>` so specific interfaces satisfy without index signatures).
- `PluginUIDefinition` / `PluginUIEntry` — slot manifest types.

### Studio host anchor (`@jiku-plugin/studio` — new)

- `plugins/jiku.studio/` — workspace package, no-op plugin.
- `src/types.ts` — `PluginHttpAPI`, `PluginEventsAPI`, `PluginConnectorAPI`, `PluginStudioApi`, `PluginStudioHost`, `ConnectorAdapter` re-export.
- `src/index.ts` — `StudioPlugin` with `contributes: () => ({} as unknown as StudioContributes)`; exports `StudioPluginContext` + `StudioComponentProps`.

### Server (`apps/studio/server`)

- `src/plugins/ui/signer.ts` — HMAC signed URL mint/verify.
- `src/plugins/ui/registry.ts` — builds ui-registry with signed `assetUrl`s.
- `src/plugins/ui/http-registry.ts` — per-plugin HTTP handler map.
- `src/plugins/ui/event-bus.ts` — in-memory pub/sub for SSE.
- `src/plugins/ui/metrics.ts` — per-plugin API/tool/error counters.
- `src/plugins/ui/context-extender.ts` — wires `http`, `events`, `connector` runtime per plugin.
- `src/routes/plugin-assets.ts` — public asset router with signature check + rate limit + prod .map gate. Middleware-based (Express 5 regex route robustness).
- `src/routes/plugin-ui.ts` — authed routes: ui-registry, storage, tools/invoke, `/api/*` passthrough, events SSE, inspector, audit.
- `src/plugins/narration.ts` — internal Studio-only prompt-injection plugin (moved out of jiku.studio since that one is pure types now).
- `src/index.ts` — registers pluginAssetsRouter BEFORE authed routers (fixes 401 fall-through); auto-discovers all `plugins/*/`; explicitly registers `NarrationPlugin`.

### Web (`apps/studio/web`)

- `lib/plugins/mount-runtime.ts` — opaque dynamic import, module cache, per-plugin bust counter + `usePluginBustVersion` hook, signed-URL-aware URL builder.
- `lib/plugins/slot.tsx` — `<Slot>` + `<SlotIsland>` island renderer with error boundary, Suspense-free mount, reload button.
- `lib/plugins/provider.tsx` — `<PluginUIProvider>` fetches ui-registry, exposes `entriesBySlot`.
- `lib/plugins/build-ctx.tsx` — constructs `StudioPluginContext` (ctx.api / tools / storage / ui / studio.api / events / permissions / log).
- `lib/plugins/boundary.tsx` — `PluginErrorBoundary`.
- `lib/plugins/api-client.ts` — typed fetch helpers to server endpoints.
- `components/plugin/plugin-sidebar-slot.tsx` — renders sidebar group "Plugins" with auto-generated links for `project.page` entries + custom `sidebar.item` slot renderers.
- `components/plugin/plugin-page-host.tsx` — host for the full-page plugin route.
- `components/plugin/active-plugins.tsx` — **split into System / Project groups** with sticky headers.
- `app/(app)/studio/layout.tsx` — wraps sidebar + project tree in `<PluginUIProvider>` (provider lives above sidebar so sidebar sees the registry).
- `app/(app)/studio/companies/[company]/projects/[project]/plugin-pages/[pluginId]/[[...sub]]/page.tsx` — project.page host.
- `app/(app)/studio/companies/[company]/projects/[project]/plugins/inspector/page.tsx` — inspector with "Reload plugin" button.
- Plugins tab top-right has an **Inspector** link.

### DB

- `apps/studio/db/src/schema/plugin_audit_log.ts` — new table.
- `apps/studio/db/src/schema/plugins.ts` — `project_plugins.granted_permissions` + `ui_api_version` columns.
- `apps/studio/db/src/queries/plugin_audit.ts` — `writeAuditLog` / `listAuditLog`.
- `apps/studio/db/src/migrations/0010_plugin_ui.sql` — manual SQL (user runs `db:push`).

### CLI (`apps/cli` — new)

- `src/index.ts` — commander root + default Ink TUI.
- `src/commands/plugin/{list,info,build,watch,create,index}.ts`.
- `src/commands/placeholders.ts` — stub namespaces for `agent`, `db`, `dev`.
- `src/tui/App.tsx` — Ink TUI with build/watch actions.
- `src/lib/{workspace,discover,builder,scaffold}.ts` — workspace root finder, plugin listing, tsup wrapper (child_process), scaffold template writer.

### Demo plugin (`@jiku/plugin-analytics` — new)

- `plugins/jiku.analytics/` — `depends: [StudioPlugin]`, uses `ctx.http?.get`, registers a project tool, UI entries for `project.page` + `project.settings.section`.
- `src/ui/Dashboard.tsx` — demonstrates `usePluginQuery`, `ctx.tools.invoke`, `ctx.ui.toast`, and `ctx.studio.api.get(...)` (fetching agents from the host).
- `src/ui/Settings.tsx` — minimal settings card.
- `tsup.config.ts` — `noExternal: [/^@jiku\//, /^@jiku-plugin\//, 'react', 'react-dom', 'react-dom/client']`, ESM browser bundle.

### First-party plugin migrations

- **`jiku.connector`** — **deleted.** Connector functionality (`ctx.connector.register`) is now part of `@jiku-plugin/studio`'s contributes. Runtime wired through the existing `connector:register` hook in the server's context-extender.
- **`jiku.telegram`** — `depends: [StudioPlugin]`, workspace dep `@jiku/plugin-connector` removed.
- **`jiku.cron`** — reverted to pre-Plan-17 state (runtime cron feature is built-in via the system's cron-task service; no UI attached).
- **`jiku.skills`**, **`jiku.social`** — unchanged (no UI entries added this sprint).

### Docs (new / updated)

- `docs/plugin-dev/overview.md` — flow, directory layout, minimal plugin, build/run via CLI.
- `docs/plugin-dev/cli.md` — full `jiku` CLI reference.
- `docs/plugin-dev/context-api.md` — `ctx.*` reference including `ctx.studio.api`.
- `docs/plugin-dev/slots.md` — slot contract table + fase-1 wiring status.
- `docs/plugin-dev/security.md` — threat model, controls, do-not-do checklist, operator setup.
- `docs/feats/plugin-ui.md` — feature doc.
- `docs/builder/current.md` + `changelog.md` updated.

---

## Running end-to-end

```bash
# 1. Install (picks up all new workspace packages)
bun install

# 2. Apply DB changes
cd apps/studio/db && bun run db:push && cd ../../..

# 3. Build plugin UI bundles
bun run jiku plugin build                 # all plugins with UI
# or: cd plugins/jiku.analytics && bun run jiku plugin build   (cwd-aware)

# 4. Run Studio
cd apps/studio/server && bun dev          # server — auto-discovers plugins
# (separate terminal)
cd apps/studio/web && bun dev

# 5. In Studio → any project → Plugins → enable "Analytics"
#    Sidebar "Plugins" group shows Analytics link.
#    Click → project-page dashboard renders the bundle via signed URL.
#    Tool invocations, API queries, ctx.studio.api.get() all work.
#    /plugins/inspector → manifest, routes, metrics, audit log + Reload button.

# Dev loop
bun run jiku plugin watch                 # rebuild on change
# In Studio → Inspector → Reload plugin    (or just refresh the page)

# Interactive TUI
bun run jiku
```

---

## Deployment (Dokploy / Docker)

`infra/dokploy/Dockerfile` runs plugin UI builds as part of the image pipeline. Multi-stage flow:

```
base           — oven/bun:1 + supervisor + node
  ↓
deps           — copy every workspace package.json + bun install
  ↓
plugin-builder — COPY . . && bun run jiku plugin build       ← Plan 17 step
  ↓
web-builder    — cd apps/studio/web && bun run build
  ↓
runner         — node_modules + source + built plugin dist + built .next
                 → supervisord starts server + web
```

The CLI is workspace-aware and runs from `/app`. Because cwd is the workspace root, `jiku plugin build` with no id builds **all** plugins with UI entries. The resulting `plugins/*/dist/ui/*.js` files ship in the final image and are served by the asset router at runtime. No runtime build step — the image already contains the bundles.

Operator notes:
- The `deps` stage lists every workspace `package.json` — adding a new plugin folder requires adding its COPY line so bun can resolve `workspace:*`.
- `NODE_ENV=production` is set in `plugin-builder` + `runner`. The asset router refuses `.map` files when that's set.
- `apps/cli/package.json` is included in the image so operators can `docker exec <app> bun run jiku plugin list` for live diagnostics.
- `JWT_SECRET` must be a strong random value — signed asset URLs rely on it.
- DB migrations (`db:push`) are intentionally NOT run at image build time. Run them as a pre-deploy step in Dokploy (or via `docker exec <app> cd apps/studio/db && bun run db:push`).

---

## Security quick-reference

- Asset URLs are signed with 10-min TTL HMAC. Unsigned / expired / mismatched URLs return `401`.
- Asset endpoint rate-limited to 120 req/min per IP.
- `NODE_ENV=production` disables `.map` serving.
- `JWT_SECRET` MUST be set to a strong random value in production.
- Plugin authors MUST NOT reference `process.env.*` in `src/ui/*.tsx` — it gets inlined into the publicly-fetchable bundle.
- Plugin bundles are readable by any authenticated user of Studio (signed URL ≠ per-user ACL). Any per-user-gated logic must live in authed server routes (`ctx.http?.get` handlers or `ctx.tools`).

---

## Explicitly deferred (follow-ups)

- `ctx.files.*` + `ctx.secrets.*` wiring to filesystem + credentials vault.
- `ctx.api.stream` (full SSE streaming beyond the event bus).
- Client-side SSE subscription auth (needs query-string token flow similar to signed URLs).
- `ctx.ui.openModal` / `global.modal` slot.
- Bundle-size budget enforcement + a11y CI.
- Migration of `jiku.skills` / `jiku.social` to contribute UI (pattern is now trivial).
- Third-party plugin sandboxing (Plan 18) — origin isolation, code signing, marketplace, per-publisher keys.

---

## Open questions answered in the final design

| Spec risk | Outcome |
|---|---|
| Q1. `@jiku/ui` importable via import map? | N/A — plugins bundle their own copies; no shared imports via import map. |
| Q2. React 19 server components interop? | Plugin UI = client component only. Confirmed. |
| Q3. Next.js 16 + dynamic `import(url)`? | Works via `new Function('u', 'return import(u)')` to bypass Turbopack's resolver. |
| Q4. Multiple React instances? | **By design** — every plugin owns its React. Isolation guarantee. |
| Q5. `@jiku/ui` bundle size concern? | Moot — plugins bundle only what they use; not externalized. |
| R1. Plugin compromise | First-party only this phase; audit log + CSP nosniff + signed URLs. Sandboxing → Plan 18. |
| R2. Next.js/React breaking changes | Pinned versions; plugin's own React isolates from Studio upgrades. |
| R3. CSS conflict across plugins | Tailwind + scoped classes in plugin bundles; no global collisions observed. |
| R4. DX Vite dev URL auto-detect | Replaced by `jiku plugin watch` + `invalidatePlugin` hot-reload. |
