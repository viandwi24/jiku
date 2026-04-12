# Plugin UI

## What it does

Plugins contribute React UI to Studio — sidebar items, full pages, settings sections, chat actions, dashboard widgets — with a shared `ctx` that exposes plugin-scoped HTTP handlers, tools, KV storage, Studio REST API passthrough, toasts, navigation, and theming.

Plugin UI bundles are **fully isolated**: each plugin is a self-contained ESM bundle (built with tsup), carries its own React instance, is loaded by the browser via dynamic URL import, and mounted into a host-provided `<div>`. A crashing or type-erroring plugin cannot break Studio's build or runtime.

## Architecture

```
Server boot
  └─ discoverPluginsFromFolder('plugins/')
       └─ register each PluginDefinition with shared loader
       └─ context-extender injects http / events / connector per plugin

Browser
  ├─ GET /api/plugins/ui-registry?project=P     (authed — mints signed URLs)
  ├─ GET /api/plugins/:id/ui/Dashboard.js?sig=HMAC&exp=…   (signed URL; no header)
  │   └─ plugin bundle renders into own React root inside Studio's <div>
  └─ GET /api/plugins/:id/api/*?project=P       (authed — passthrough to ctx.http)
```

## Public API

### Plugin-facing (`@jiku/kit/ui`)
- `defineUI({ assetsDir, entries })` — declare slot entries.
- `defineMountable<C>(Component)` — wrap a React component into an island; `C` parameterizes the ctx type.
- `usePluginQuery(ctx, op, input?)` / `usePluginMutation(ctx, op)` — plain `useState`/`useEffect` hooks (React-instance agnostic).
- `PluginPage` / `PluginSection` / `PluginCard` / `PluginSkeleton` — layout primitives.
- `PluginContext`, `PluginComponentProps<C>`, slot types.

### Studio host anchor (`@jiku-plugin/studio`)
- `StudioPlugin` — no-op plugin. Plugins declare `depends: [StudioPlugin]` to get typed `ctx.http` / `ctx.events` / `ctx.connector` in `setup()`.
- `StudioComponentProps` — UI prop type with `ctx.studio: PluginStudioHost`.
- Types: `PluginHttpAPI`, `PluginEventsAPI`, `PluginConnectorAPI`, `PluginStudioApi`, `PluginStudioHost`, `ConnectorAdapter` (re-exported).

### Developer CLI (`apps/cli/` — binary `jiku`)
- `jiku` — interactive Ink TUI (arrow nav, `b` build, `w` watch, `r` refresh, `q` quit).
- `jiku plugin list|info|build|watch|create` — scriptable sub-commands. `build`/`watch` without an id are cwd-aware (builds only the plugin the cwd lives in, else all).
- Placeholder namespaces: `jiku agent`, `jiku db`, `jiku dev`.
- Full reference: [`docs/dev/plugin/cli.md`](../dev/plugin/cli.md).

### Server HTTP surface
- `GET /api/plugins/ui-registry?project=:p` — manifest with signed asset URLs.
- `GET /api/plugins/:id/ui/:file` — **public** (rate-limited, HMAC-verified, prod `.map` 404).
- `GET|PUT|DELETE /api/plugins/:id/storage` — KV scoped to (project, plugin).
- `GET /api/plugins/:id/tools` / `POST /api/plugins/:id/tools/:toolId/invoke`.
- `ALL /api/plugins/:id/api/*` — passthrough to `ctx.http` handlers.
- `GET /api/plugins/:id/events?project=:p` — SSE stream (client-side auth pending).
- `GET /api/plugins/:id/inspector` — manifest + routes + live metrics.
- `GET /api/plugins/audit` — audit log feed.

### Web surface
- `<PluginUIProvider projectId>` at studio/layout level — fetches registry, wraps sidebar + project tree.
- `<Slot name=...>` / `<SlotIsland>` — island renderer with `PluginErrorBoundary` + mount/unmount lifecycle.
- `/plugin-pages/[pluginId]/[[...sub]]` — host route for `project.page` entries.
- `/plugins/inspector` — inspector w/ "Reload plugin" (invalidates mount cache).
- Active-plugins tab split into **System** / **Project** sections with sticky headers.

## Security

- **Signed URL** HMAC-SHA256 over `(pluginId, file, exp)` with `JWT_SECRET`. 10 min TTL. Rotated on each registry refetch.
- **Rate limit** 120 req/min per IP on asset router.
- **Prod sourcemap gate** — `NODE_ENV=production` → `.map` returns 404.
- **Path traversal guard**, `X-Content-Type-Options: nosniff`, `Cross-Origin-Resource-Policy: cross-origin`.
- Plugin bundles are **not** per-user gated — any authed Studio user can fetch. Per-user logic must live in `ctx.api` / `ctx.tools` handlers.
- Plugin authors MUST NOT put secrets in `src/ui/*.tsx` (bundle is publicly readable by any authed user).

Full threat model + operator checklist: [`docs/dev/plugin/security.md`](../dev/plugin/security.md).

## Known limitations (fase 1)

- `ctx.files.*` and `ctx.secrets.*` are stubs. Wiring to filesystem + credentials vault is follow-up work.
- `ctx.api.stream` not implemented (only `query` + `mutate`).
- Client-side SSE subscription auth not wired (mount-runtime doesn't use `ctx.events.on` yet).
- `ctx.ui.openModal` / `global.modal` slot deferred.
- Third-party plugin sandboxing deferred to Plan 18 (origin isolation, code signing, per-publisher keys).

## Related files

- **Core**: `packages/core/src/plugins/{loader.ts,discover.ts}`
- **Kit**: `packages/kit/src/ui/{index.ts,mountable.tsx,hooks.ts,wrappers.tsx,slots.ts,context-types.ts,define-ui.ts}`
- **Types**: `packages/types/src/plugin-ui.ts`, `BasePluginContext` in `packages/types/src/index.ts`
- **Studio anchor**: `plugins/jiku.studio/src/{index.ts,types.ts}`
- **Server**: `apps/studio/server/src/routes/{plugin-assets,plugin-ui}.ts`, `apps/studio/server/src/plugins/ui/*`, `apps/studio/server/src/plugins/narration.ts`
- **Web**: `apps/studio/web/lib/plugins/*`, `apps/studio/web/components/plugin/*`, `apps/studio/web/app/(app)/studio/layout.tsx`, `apps/studio/web/app/(app)/studio/companies/[company]/projects/[project]/{plugin-pages,plugins/inspector}/**`
- **CLI**: `apps/cli/src/**`
- **Demo plugin**: `plugins/jiku.analytics/**`
- **DB**: `apps/studio/db/src/schema/plugin_audit_log.ts`, migration `0010_plugin_ui.sql`
- **Docs**: `docs/dev/plugin/{overview,context-api,slots,cli,security}.md`, impl report `docs/plans/impl-reports/17-plugin-ui-implementation-report.md`
