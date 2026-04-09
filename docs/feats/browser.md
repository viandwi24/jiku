# Feature: Browser Automation

> **STATUS: SHIPPED (Plan 33, 2026-04-09).** Plan 13 (OpenClaw port) was
> abandoned and replaced by `@jiku/browser` — a clean ~600 line CLI bridge to
> [Vercel agent-browser](https://github.com/vercel-labs/agent-browser) over
> CDP, plus a hardened Docker container with noVNC.

This file is the single source of truth for the browser feature across the
package, the Studio backend, and the Studio UI. For internal package details
see `packages/browser/SKILL.md` and `packages/browser/README.md`. For the full
implementation arc see
`docs/plans/impl-reports/13-browser-implement-report.md`.

---

## What it does

Each Studio project can opt into a browser tool. When enabled, every agent in
the project gains a single `browser` tool with 33 actions covering navigation,
observation (snapshot/screenshot/pdf/get), interaction (click/fill/type/...),
waits, tabs, eval, cookies, storage, and batch. Screenshots are persisted as
attachments via the unified `persistContentToAttachment()` service so they
flow through the same auth, gallery, and LLM-delivery pipeline as user
uploads.

The browser itself runs in a separate Docker container (Chromium + Xvfb +
Fluxbox + noVNC). The Studio settings page shows a Live Preview box so users
can confirm what state the browser is in without opening a separate noVNC tab.

---

## Architecture

```
┌──────────────────────────────────────────────────────┐
│ Agent Runtime (apps/studio/server)                   │
│   buildBrowserTools(projectId, config) ─────────┐    │
└──────────────────────────────────────────────────┼───┘
                                                   │
                          ┌────────────────────────▼───────────┐
                          │ apps/studio/server/src/browser/    │
                          │   tool-schema.ts — flat z.object   │
                          │   tool.ts        — ToolDefinition  │
                          │   execute.ts     — mapper +        │
                          │                    persistence     │
                          │   config.ts      — CDP resolver    │
                          │   index.ts       — per-project map │
                          └────────────────────────┬───────────┘
                                                   │
                          ┌────────────────────────▼───────────┐
                          │ @jiku/browser (packages/browser)   │
                          │   execBrowserCommand(cdp, command) │
                          │   parser, profile, spawner         │
                          └────────────────────────┬───────────┘
                                                   │ spawn
                          ┌────────────────────────▼───────────┐
                          │ agent-browser CLI (Rust binary)    │
                          │   --cdp http://localhost:9222      │
                          └────────────────────────┬───────────┘
                                                   │ CDP
                          ┌────────────────────────▼───────────┐
                          │ Docker container                   │
                          │   Chromium + Xvfb + Fluxbox        │
                          │   socat (9222 → 19222) + noVNC     │
                          │   :9222 CDP, :6080 noVNC viewer    │
                          └────────────────────────────────────┘
```

### Key design decisions

1. **CLI bridge, not library port.** agent-browser is a Rust binary. Spawning
   it per command is simpler than maintaining a Node wrapper, and it's
   crash-isolated.
2. **Stateless per command.** No shared browser server, no Node child
   process, no start/stop lifecycle. The runtime just resolves the CDP
   endpoint at tool-build time and the rest is fire-and-forget per call.
3. **CDP-only project config.** A single CDP endpoint per project, stored in
   `projects.browser_config.cdp_url`. No managed mode, no headless toggle, no
   executable path. The route Zod schema strips anything else on save.
4. **Screenshots are attachments, not base64.** `executeBrowserAction()`
   intercepts the `screenshot` action and calls `persistContentToAttachment()`
   from Plan 33's unified persister. Tool output returns
   `{ type: 'image', attachment_id, storage_key, mime_type }` — never a URL.
5. **Flat `z.object` for the tool schema.** OpenAI's function calling API
   rejects schemas without `type: "object"` at the JSON Schema root. A
   `z.discriminatedUnion` would serialize to `anyOf` and break this. Instead,
   the schema is flat with `action` as the required enum and every other
   field optional; per-action requirements are enforced at runtime by the
   `need()` helper in `mapToBrowserCommand`.

---

## Studio integration (`apps/studio/server/src/browser/`)

| File | Purpose |
|------|---------|
| `tool-schema.ts` | Flat `z.object` schema. Exports `BROWSER_ACTIONS`, `BrowserToolInputSchema`, `BrowserToolInput`, `BrowserAction`. |
| `tool.ts` | `buildBrowserTools(projectId, config)` — emits a single `ToolDefinition` (`id: 'browser'`, `group: 'browser'`). Eval is gated behind `evaluate_enabled`. |
| `execute.ts` | `executeBrowserAction(input, options)` — runs the action via `execBrowserCommand`. Maps the flat input to `BrowserCommand` (rebuilding nested `tab`/`cookies` operations). For screenshots, persists to attachments unless `screenshot_as_attachment === false`, in which case it returns base64 inline. |
| `config.ts` | `resolveCdpEndpoint(config)` — defaults to `ws://localhost:9222`. |
| `index.ts` | `registerBrowserCdp` / `unregisterBrowserCdp` / `getCdpEndpoint` — per-project CDP map (used internally; tools currently resolve directly from config). |

### Wiring

`apps/studio/server/src/runtime/manager.ts` calls `buildBrowserTools(projectId,
browserCfg.config)` from `resolveSharedTools()` whenever a project boots
(`wakeUp`) or its config changes (`syncProjectTools`). The resulting tool is
appended to every agent's `built_in_tools` along with connector, filesystem,
skill, cron, and MCP tools.

### Action set (33)

| Group | Actions |
|-------|---------|
| Navigation | `open`, `back`, `forward`, `reload`, `close` |
| Observation | `snapshot`, `screenshot`, `pdf`, `get` |
| Interaction | `click`, `dblclick`, `fill`, `type`, `press`, `hover`, `focus`, `check`, `uncheck`, `select`, `drag`, `upload`, `scroll`, `scrollintoview` |
| Wait | `wait` |
| Tabs | `tab_list`, `tab_new`, `tab_close`, `tab_switch` |
| JavaScript | `eval` (gated by `evaluate_enabled`) |
| Cookies & storage | `cookies_get`, `cookies_set`, `cookies_clear`, `storage` |
| Batch | `batch` |

`tab_*` and `cookies_*` are flattened from the nested `BrowserCommand`
operations in `@jiku/browser` so the LLM sees a single flat enum.

### Per-action field requirements

The schema is flat — `need()` in `execute.ts` enforces these at runtime:

| Action | Required fields |
|--------|-----------------|
| `open` | `url` |
| `pdf` | `path` |
| `get` | `subcommand` (`text`/`html`/`value`/`attr`/`title`/`url`/`count`/`box`/`styles`/`cdp-url`) |
| `click`, `dblclick`, `hover`, `focus`, `check`, `uncheck`, `scrollintoview` | `ref` |
| `fill`, `type` | `ref`, `text` |
| `press` | `key` |
| `select` | `ref`, `values` |
| `drag` | `src`, `dst` |
| `upload` | `ref`, `files` |
| `scroll` | `direction` |
| `tab_switch` | `index` |
| `eval` | `js` |
| `cookies_set` | `cookie` |
| `storage` | `storageType` |
| `batch` | `commands` |

Optional everywhere else (`snapshot`, `screenshot`, `wait`, `back`, `forward`,
`reload`, `close`, `tab_list`, `tab_new`, `tab_close`, `cookies_get`,
`cookies_clear`).

---

## Project config (`BrowserProjectConfig`)

Stored in `projects.browser_config` (jsonb), enabled flag in
`projects.browser_enabled` (boolean).

```typescript
interface BrowserProjectConfig {
  cdp_url?: string                  // default: 'ws://localhost:9222'
  timeout_ms?: number               // default: 30000
  evaluate_enabled?: boolean        // default: false
  screenshot_as_attachment?: boolean // default: true
}
```

The DB query type lives in `apps/studio/db/src/queries/browser.ts`. The web
type mirrors it in `apps/studio/web/lib/api.ts`. Plan 13 fields (`mode`,
`headless`, `executable_path`, `control_port`, `no_sandbox`) were removed
entirely.

---

## REST API (`apps/studio/server/src/routes/browser.ts`)

| Method | Path | Purpose |
|--------|------|---------|
| `GET`   | `/api/projects/:pid/browser` | Returns `{ enabled, config }`. |
| `PATCH` | `/api/projects/:pid/browser/enabled` | Toggle the feature on/off. Calls `runtimeManager.syncProjectTools()`. |
| `PATCH` | `/api/projects/:pid/browser/config` | Update config. Strips unknown fields via Zod. Calls `syncProjectTools()`. |
| `POST`  | `/api/projects/:pid/browser/ping` | Tests CDP reachability via `GET /json/version`. Returns `{ ok, latency_ms?, browser?, cdp_url?, error? }`. |
| `POST`  | `/api/projects/:pid/browser/preview` | One-shot screenshot via `execBrowserCommand`, plus best-effort `get title` / `get url`. Returns `{ ok, data?: { base64, format, title, url }, error?, hint? }`. **Never persisted.** |

All routes require `settings:read` (GET / ping / preview) or `settings:write`
(enabled / config) via `requirePermission`.

---

## UI — Browser settings page

`apps/studio/web/app/(app)/studio/companies/[company]/projects/[project]/browser/page.tsx`

Sections (top to bottom):

1. **Status bar** — derives tone (`idle` / `unknown` / `ok` / `error`) from
   the most recent `pingMutation` result. Always shows a "Test connection"
   button when the feature is enabled.
2. **Live Preview** _(only when enabled)_ — 16:9 box with the latest
   screenshot. Manual **Refresh** button + **Auto refresh** switch (3s
   interval). Title + URL overlay on the screenshot. Loading / empty / error
   states all handled. Uses a `useRef` (`previewInFlight`) to drop overlapping
   requests when auto-refresh ticks faster than a screenshot completes.
3. **Browser Automation** — enable toggle.
4. **CDP Endpoint** — single `cdp_url` input (placeholder
   `ws://localhost:9222`).
5. **Advanced** — `timeout_ms`, `screenshot_as_attachment` toggle,
   `evaluate_enabled` toggle.

API client lives in `apps/studio/web/lib/api.ts` under `api.browser.*`:
`get`, `setEnabled`, `updateConfig`, `ping`, `preview`. The `useAttachmentUrl`
hook (`apps/studio/web/hooks/use-attachment-url.ts`) handles authenticated
URLs for any persisted screenshot displayed elsewhere in the app (the live
preview box uses inline base64 instead and bypasses the attachment system).

---

## Docker container (`packages/browser/docker/`)

`Dockerfile` (Debian bookworm) installs Chromium, Xvfb, Fluxbox, x11vnc,
noVNC, websockify, dbus, socat, curl. Runs as root inside the container.

`entrypoint.sh` order:

1. **dbus-daemon** — chromium logs warnings without it.
2. **Xvfb** on `$DISPLAY` (`:99`), with a UNIX socket readiness probe.
3. **Fluxbox** WM, log redirected to `/var/log/jiku-browser/fluxbox.log`.
4. **Chromium** with `--no-sandbox`, `--remote-debugging-address=127.0.0.1`,
   `--remote-debugging-port=19222`, `--remote-allow-origins=*`,
   `--user-data-dir=/data/chrome-data`, log to `chromium.log`.
5. **CDP readiness probe** — `curl http://127.0.0.1:19222/json/version`
   (60 attempts × 0.5s). On failure, prints the last 50 lines of
   `chromium.log` to stderr and `exit 1`.
6. **socat** forwards `0.0.0.0:9222 → 127.0.0.1:19222` (both `/json/*` HTTP
   and the WebSocket upgrade traverse this same TCP forward).
7. **x11vnc** on `:5900`.
8. **`exec websockify`** as PID 1 — noVNC web client on `:6080`. `exec` is
   important so SIGTERM from Docker propagates and `docker compose down`
   shuts the container down cleanly.

Per-process logs live in `/var/log/jiku-browser/{xvfb,fluxbox,chromium,
socat,x11vnc}.log` inside the container. When debugging "blank wallpaper, no
chromium", the fastest path is `docker exec <id> tail
/var/log/jiku-browser/chromium.log`.

### Why `--no-sandbox`

Docker Desktop on macOS and Windows does **not** expose unprivileged user
namespaces to containers, so chromium's zygote dies at startup with `No usable
sandbox!` without `--no-sandbox`. The earlier non-root-without-sandbox design
was based on a wrong assumption and produced exactly that failure mode (only
Fluxbox wallpaper visible in noVNC, socat spam "Connection refused"). We're
already in an isolated container, so `--no-sandbox` is the standard pattern
and safe in this context.

---

## Response shape (`BrowserResult<T>`)

```typescript
interface BrowserResult<T> {
  success: boolean
  data: T | null
  error: string | null
  hint: string | null  // AI-friendly recovery suggestion
}
```

Hint patterns (in `packages/browser/src/parser.ts`) cover: stale element refs,
multiple element matches, not interactable / hidden / detached, timeouts,
navigation/network errors, CDP connect failures, file-not-found, dialog
blocking. The LLM sees these directly in the tool result and uses them to
self-correct (e.g. "snapshot again to refresh refs").

---

## Multi-user / tab isolation

- agent-browser operates on the **active tab only**.
- Two users on the same project profile will collide (shared active tab
  state). Tab management commands exist (`tab_*`) but there is no concurrent
  tab isolation.
- For true multi-user: separate browser container per user. Deferred.

---

## File inventory

### Package
```
packages/browser/
├── src/
│   ├── index.ts              # Public exports
│   ├── types.ts              # BrowserCommand, BrowserResult, Profile
│   ├── server.ts             # BrowserAgentServer (Express)
│   ├── spawner.ts            # execCommand, execBrowserCommand, resolveCdpEndpoint
│   ├── parser.ts             # parseCommandResult + AI hint generator
│   ├── profile-manager.ts    # In-memory profile CRUD
│   ├── main.ts               # Standalone server entry point
│   ├── examples/cdp.ts       # Full example: navigate → snapshot → fill → search → screenshot
│   └── tests/                # 52 tests (profile, spawner, parser, server)
├── docker/
│   ├── Dockerfile            # Debian + Chromium + Xvfb + noVNC + socat + dbus
│   └── entrypoint.sh         # Hardened: --no-sandbox, readiness probe, per-process logs
├── docker-compose.yml        # Ports 9222 (CDP), 6080 (noVNC)
├── SKILL.md                  # Detailed command reference + patterns
└── README.md                 # Quick start + API docs
```

### Studio backend
```
apps/studio/server/src/browser/
├── tool-schema.ts            # Flat z.object + BROWSER_ACTIONS + BrowserToolInput
├── tool.ts                   # buildBrowserTools(projectId, config)
├── execute.ts                # executeBrowserAction + mapToBrowserCommand + need()
├── config.ts                 # resolveCdpEndpoint(config)
└── index.ts                  # Per-project CDP endpoint map

apps/studio/server/src/routes/browser.ts   # GET/PATCH config, ping, preview
apps/studio/server/src/content/persister.ts # persistContentToAttachment (Plan 33)
```

### Studio web
```
apps/studio/web/lib/api.ts                                            # api.browser.* + types
apps/studio/web/hooks/use-attachment-url.ts                           # JWT-injected attachment URLs
apps/studio/web/app/(app)/studio/companies/[company]/projects/[project]/browser/page.tsx
```

### DB
```
apps/studio/db/src/queries/browser.ts      # BrowserProjectConfig type + queries
apps/studio/db/src/schema/projects.ts      # browser_enabled, browser_config columns
apps/studio/db/src/schema/attachments.ts   # source_type, metadata columns (Plan 33)
apps/studio/db/src/migrations/0008_add_attachment_source_tracking.sql
```

---

## Quick verification

```bash
# 1. Start the browser container
cd packages/browser
docker compose up -d --build

# 2. Confirm CDP is reachable
curl -s http://localhost:9222/json/version
# expected: {"Browser":"Chrome/...","webSocketDebuggerUrl":"..."}

# 3. (Optional) open noVNC viewer
open http://localhost:6080/vnc.html

# 4. In Studio: enable Browser for a project, set cdp_url to ws://localhost:9222,
#    Save, click "Test connection" (should succeed), then click Refresh in
#    Live Preview (should show about:blank).

# 5. Chat with an agent in that project. The browser tool should appear in
#    the tools list and be invokable (e.g. "open https://example.com").
```

---

## Known limitations

- **Single active tab.** Concurrent users on the same project conflict.
- **Stateless per command.** Each command spawns a fresh CLI process; no
  console logs / network state persists between calls.
- **Ref staleness.** Element refs from a snapshot become invalid after DOM
  changes. The standard pattern is: snapshot → act → snapshot.
- **Live Preview is one-shot.** The 3s auto-refresh polls — it's not a
  streaming MJPEG/WebRTC feed. Acceptable for "what state is the browser in
  right now" but not for visualizing real-time interaction.

---

## vs Plan 13 (OpenClaw port)

| Aspect | Plan 13 (failed) | @jiku/browser (shipped) |
|--------|------------------|--------------------------|
| Engine | Ported OpenClaw (~80 files) | agent-browser CLI (Rust binary) |
| Connection | Playwright + CDP (broken) | CLI spawn + CDP via socat proxy |
| Visibility | Headless only (failed) | Visible in noVNC, Live Preview in Studio |
| Schema | Stale OpenClaw enum (most actions silently rejected by Zod) | Flat z.object, OpenAI-safe, 33 actions |
| Container | linuxserver/chromium + init script that didn't run | Custom Debian image, hardened entrypoint, --no-sandbox |
| Code size | ~9000 lines | ~600 lines (package) + ~400 (Studio integration) |
| Tests | None | 52 (in `packages/browser/src/tests`) |
| Config | mode/headless/executable_path/control_port/no_sandbox | cdp_url + timeout_ms + evaluate_enabled + screenshot_as_attachment |
| Screenshots | base64 inline | persisted as attachments via Plan 33 unified persister |
