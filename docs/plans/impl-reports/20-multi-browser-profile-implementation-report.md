# Plan 20 — Multi Browser Profile + Browser Adapter System — Implementation Report

> **Status:** SHIPPED 2026-04-13.
> **Plan source:** `docs/plans/20-multi-browser-profile.md`.
> **Supersedes:** Plan 33 (single CDP endpoint per project).
> **Related feat docs:** `docs/feats/browser.md`.

---

## TL;DR

Browser feature went from **one CDP endpoint per project** to **N profiles per project, each pinned to a registered `BrowserAdapter`**. The unified `browser` tool accepts `profile_id?` and routes through `browserAdapterRegistry`. Plugins register new adapters via `ctx.browser.register(adapter)`. Shipped with two adapters:

- **`jiku.browser.vercel`** — built-in, wraps the existing CDP/Chromium path.
- **`jiku.camofox`** — plugin, Firefox with anti-fingerprinting. REST (not CDP).

A **custom action registry** (`browser_list_actions` + `browser_run_action`) was added post-ship to expose adapter-specific features (youtube_transcript, macro, links, images, downloads, stats, import_cookies for CamoFox) without bloating the shared `BrowserAction` enum.

---

## What was built (9 phases)

### Phase 1 — `BrowserAdapter` abstraction (`@jiku/kit`)

- `packages/kit/src/browser-adapter.ts` — abstract class + types:
  - `BrowserAdapterContext { profileId, projectId, agentId?, config }`
  - `BrowserAdapterResult { content: [text|image], details? }`
  - `BrowserPingResult`, `BrowserPreviewResult`
  - `BrowserCustomAction { id, displayName, description, inputSchema?, example? }` (added post-ship)
  - Abstract `execute()`, `ping()`, `preview()`; optional `additionalTools()`, `customActions`, `runCustomAction()`, `onProfileActivated`, `onProfileDeactivated`.
- `defineBrowserAdapter<T>(adapter)` helper for type-checked declaration.
- All re-exported from `packages/kit/src/index.ts`.

### Phase 2 — Registry + plugin context

- `apps/studio/server/src/browser/adapter-registry.ts` — `browserAdapterRegistry` singleton (register/get/list/has).
- `plugins/jiku.studio/src/types.ts` — `PluginBrowserAdapterAPI { register(adapter) }`.
- `plugins/jiku.studio/src/index.ts` — `StudioContributes.browser`.
- `apps/studio/server/src/plugins/ui/context-extender.ts` — injects `ctx.browser.register()` in base plugin context.
- Built-in adapter registered at module-load via side-effect import of `apps/studio/server/src/browser/index.ts` (called from server main `index.ts`). Decision: built-in is NOT a plugin to avoid race with project wakeUp.

### Phase 3 — DB schema

- Migration `apps/studio/db/src/migrations/0016_browser_profiles.sql` (Plan doc said `0009` but codebase was at `0015`):
  - Creates `browser_profiles` (uuid pk, project_id fk, name, adapter_id, config jsonb, enabled bool, is_default bool, created_at).
  - Partial unique index on `(project_id)` where `is_default = true` → at most one default per project.
  - Unique index on `(project_id, name)`.
  - Seeds one `Default` profile per existing project with `browser_enabled = true`, adapter `jiku.browser.vercel`, config copied from legacy `browser_config`.
- Drizzle schema: `apps/studio/db/src/schema/browser-profiles.ts`.
- Queries: `apps/studio/db/src/queries/browser-profiles.ts` — CRUD + `setDefault` + `getDefault` + `getAllEnabled`.
- Legacy `projects.browser_enabled` + `browser_config` columns kept (deprecated) for safety. Drop in a future migration.

### Phase 4 — `JikuBrowserVercelAdapter` + refactor

- `apps/studio/server/src/browser/adapters/jiku-browser-vercel.ts` wraps the existing CDP + tab affinity + mutex logic.
- `execute.ts` refactored: `mapToBrowserCommand`, `formatBrowserResult`, `ensureAgentTabActive`, `isReservedBrowserAction` exported as helpers so adapters can compose.
- `tab-manager.ts` + `concurrency.ts` rekeyed from `projectId` → `profileId` (a profile is one CDP endpoint; mutex serializes per-profile, not per-project).
- Config schema enriched with `.describe()` + `.default()` for proper UX.

### Phase 5 — Unified `browser` tool

- `tool-schema.ts` adds `profile_id?: string`.
- `tool.ts`: `buildBrowserTools(projectId)` is now async. Loads active profiles from DB, finds the default, builds one `browser` tool whose description lists all profiles, and routes `execute()` via `browserAdapterRegistry.get(profile.adapter_id).execute(input, ctx)`. Includes additionalTools from every distinct adapter.
- `runtime/manager.ts` call site updated to `await buildBrowserTools(projectId)`. Sleep path iterates profiles for tab cleanup.

### Phase 6 — API routes

- `apps/studio/server/src/routes/browser-profiles.ts`:
  - `GET /projects/:pid/browser/adapters` — registry list with serialized configSchema (uses `unwrapZod()` helper).
  - `GET/POST /projects/:pid/browser/profiles`
  - `GET/PATCH/DELETE /projects/:pid/browser/profiles/:profileId`
  - `POST /projects/:pid/browser/profiles/:profileId/default`
  - `POST /projects/:pid/browser/profiles/:profileId/ping`
  - `POST /projects/:pid/browser/profiles/:profileId/preview`
  - `GET /projects/:pid/browser/profiles/:profileId/status` (tab snapshot + mutex)
- Create/update validate the config via the adapter's `configSchema.safeParse()`.
- Legacy `/api/projects/:pid/browser` shim kept — operates on the default profile.
- Mounted in `apps/studio/server/src/index.ts`.

### Phase 7 — Frontend

- `apps/studio/web/app/(app)/studio/companies/[company]/projects/[project]/browser/page.tsx` — rewritten as multi-profile `<Tabs>` (one tab per profile, profile-specific status/preview/debug/config/delete).
- `profile-tab.tsx` — per-profile UI: status bar, test-connection, live preview (auto-refresh 3s), debug panel (tab table + mutex), config form, set-as-default, delete.
- `add-profile-modal.tsx` — adapter radio picker + dynamic config form.
- `config-field.tsx` — shared schema-driven control (post-ship hardening).
- `apps/studio/web/lib/api.ts` — `BrowserProfile`, `BrowserAdapterInfo`, `BrowserAdapterConfigField` types + `api.browser.*Profile*` methods.

### Phase 8 — CamoFox plugin + Docker wrapper

Originally scoped as "adapter assumes CDP-compatible". Re-scoped after reading upstream docs:

- `plugins/jiku.camofox/src/adapter.ts` — REST HTTP client (not CDP). Maps `BrowserAction`s to `POST /tabs/:id/{navigate,click,type,press,scroll,wait}`, `GET /tabs/:id/{snapshot,screenshot}`. Session model: `userId` per profile, `sessionKey` per agent, `tabId` cached in-memory. Unsupported actions throw clear errors.
- `plugins/jiku.camofox/src/types.ts` — `CamofoxConfigSchema` with `.describe()` + `.default()` on every field (`base_url`, `api_key`, `user_id`, `timeout_ms`, `screenshot_as_attachment`, `preview_url`, `proxy_host`, `proxy_port`).
- `packages/camofox/docker/Dockerfile` — self-contained: `node:20-bookworm-slim` + Firefox/Camoufox runtime libs + xvfb; `git clone --depth 1 --branch ${CAMOFOX_REF}` upstream; `npm install`; `USER node`; `RUN npx camoufox fetch` (bakes Firefox binary into image); `CMD npm start`.
- Compose files:
  - `apps/studio/server/docker-compose.browser.yml` (new) — chrome + camofox with host ports for dev.
  - `infra/dokploy/docker-compose.browser.yml` — extended with camofox service + Traefik labels (`CAMOFOX_DOMAIN`).
- `.env.example` files extended with Browser section (`CAMOFOX_REF`, `CAMOFOX_API_KEY`, `CAMOFOX_ADMIN_KEY`, `CAMOFOX_PORT`, `CAMOFOX_DOMAIN`, `MAX_SESSIONS`, `MAX_TABS_PER_SESSION`, `SESSION_TIMEOUT_MS`, `IDLE_TIMEOUT_MS`, `PROXY_*`).

### Phase 9 — Docs

- `docs/feats/browser.md` — Plan 20 status banner + post-ship hardening section.
- `docs/builder/changelog.md`, `current.md`, `tasks.md`, `decisions.md`, `memory.md` updated.

---

## Post-ship hardening (same-day iterations)

### Add Profile modal UX overhaul

- Root bug: `serializeAdapter` used `typeName.toLowerCase()` on `ZodOptional` → `"optional"` — every field dumped into a plain text Input regardless of underlying type.
- New `unwrapZod()` walks `ZodOptional`/`ZodDefault`/`ZodNullable`/`ZodEffects` to the leaf; extracts default, min/max, description, enum options.
- Shared `ConfigField` component: boolean → `Switch`, number/integer → numeric `Input` with `min`/`max`/`step`, enum → `Select`, defaults → placeholders, keys humanized.
- `initialConfigFor()` prefills modal with schema defaults.

### Modal width + scroll + footer overshoot

- `DialogContent` widened to `sm:max-w-2xl`, turned into `flex flex-col max-h-[90vh]` with scrollable body (`overflow-y-auto flex-1 min-h-0`).
- `DialogFooter` has baked-in `-mx-4 -mb-4` (assumed `p-4` on DialogContent); with `p-0` it overshot the edges. Override: `mx-0 mb-0 rounded-b-xl`.

### CamoFox correctness fixes

- **Not CDP.** Plugin rewritten as pure REST client. `@jiku/browser` dependency removed from the adapter path.
- **URL scheme blocklist.** `about:blank` rejected by CamoFox — added `preview_url` profile config (default `https://www.example.com`) and use it for the preview tab.
- **Binary Firefox fetch.** `RUN npx camoufox fetch` added to Dockerfile (after `USER node`) — without this, every POST /tabs crashed with `"Version information not found at /home/node/.cache/camoufox/version.json"`.
- **Raw PNG screenshot.** `GET /tabs/:id/screenshot` returns `image/png` bytes, not JSON. Dedicated `requestImage()` helper uses `res.arrayBuffer()` + base64.

### Chrome container stale-lock fix

`entrypoint.sh` now wipes `/data/chrome-data/Singleton{Lock,Cookie,Socket}` before launching chromium. These survive SIGKILL and cause "profile appears to be in use" on restart because the profile volume persists across container ids.

### Custom action registry

- `BrowserAdapter` extended: `customActions?: BrowserCustomAction[]` + `runCustomAction?(id, params, ctx)`.
- Two new tools in `buildBrowserTools()`: `browser_list_actions(profile_id?)` (per-adapter catalog with `input_schema`), `browser_run_action(profile_id?, action_id, params)` (Zod `safeParse` → dispatch).
- CamoFox registers 7: `youtube_transcript`, `links`, `images`, `downloads`, `macro`, `stats`, `import_cookies`.
- Pattern mirrors `ConnectorAdapter.actions` / `connector_run_action`.

---

## Decisions (ADRs)

- **ADR-051** — Custom action registry vs per-adapter extra tools. Chose registry for flat tool count + on-demand schema loading.
- **ADR-052** — CamoFox is REST, not CDP. Plugin keeps its own HTTP client; unsupported BrowserActions throw clear errors.
- **ADR-053** — `@jiku/camofox` wrapper package owns the Dockerfile. Upstream doesn't publish to any registry.
- **ADR-054** — CamoFox cookies volume is writable (not upstream's `:ro`). We want persistence, not just one-shot import.
- **ADR-055** — Adapter config UI driven by Zod schema reflection. New adapters get the full modal UI for free by writing rich Zod.

Plan-doc original decisions (D-01 .. D-06) remain valid. Only D-06 was proven wrong — CamoFox does NOT expose CDP, so the adapter was rewritten from scratch as a REST client.

---

## File inventory

| Area | Files |
|---|---|
| `@jiku/kit` | `packages/kit/src/browser-adapter.ts` (new), `packages/kit/src/index.ts` (export) |
| DB | `apps/studio/db/src/migrations/0016_browser_profiles.sql`, `schema/browser-profiles.ts`, `queries/browser-profiles.ts`, `schema/index.ts`, `index.ts` |
| Server — browser core | `apps/studio/server/src/browser/{adapter-registry,tool,tool-schema,execute,tab-manager,concurrency,config,index}.ts`, `adapters/jiku-browser-vercel.ts` (+ `-types.ts`) |
| Server — runtime / routes | `apps/studio/server/src/runtime/manager.ts`, `routes/browser-profiles.ts` (new), `routes/browser.ts` (backward-compat), `src/index.ts` |
| Studio plugin | `plugins/jiku.studio/src/{types,index}.ts`, `apps/studio/server/src/plugins/ui/context-extender.ts` |
| Web | `apps/studio/web/app/(app)/studio/companies/[company]/projects/[project]/browser/{page,add-profile-modal,profile-tab,config-field}.tsx`, `apps/studio/web/lib/api.ts` |
| CamoFox plugin | `plugins/jiku.camofox/src/{adapter,types,index}.ts`, `plugins/jiku.camofox/package.json` |
| CamoFox Docker | `packages/camofox/{package.json,README.md}`, `packages/camofox/docker/Dockerfile` |
| Chrome Docker | `packages/browser/docker/entrypoint.sh` |
| Compose / env | `apps/studio/server/docker-compose.browser.yml` (new), `apps/studio/server/.env.example`, `infra/dokploy/docker-compose.browser.yml`, `infra/dokploy/.env.example` |
| Docs | `docs/feats/browser.md`, `docs/builder/{changelog,current,tasks,decisions,memory}.md` |

---

## Pending user actions

1. Apply migration: `cd apps/studio/db && bun run db:push` (adds `0016_browser_profiles.sql`).
2. Build CamoFox image: `cd apps/studio/server && docker compose -f docker-compose.browser.yml build camofox` (first build downloads Camoufox binary, ~200 MB image).
3. Rebuild chrome image if running locally: `docker compose -f docker-compose.browser.yml build chrome` (picks up SingletonLock wipe).
4. Restart Studio server to pick up new tools + adapters.
5. In UI: each existing project with `browser_enabled=true` already has a `Default` profile auto-seeded. New profiles via **Add Profile** modal.

---

## Known follow-ups (backlog)

- Stale CamoFox tabId recovery: adapter should detect 404 on cached tabId and refresh (currently caches forever; if CamoFox evicts on `MAX_TABS_PER_SESSION` or `BROWSER_IDLE_TIMEOUT_MS`, next call fails until profile deactivates).
- Publish `jiku-camofox` image to a private registry so deploys don't rebuild from git clone every time.
- Per-phase `BrowserCustomAction` result typing (currently all return `BrowserAdapterResult` with JSON-encoded text) — could add structured typed results.
- Extend action registry to `JikuBrowserVercelAdapter` if any CDP-specific custom actions emerge (none today).
