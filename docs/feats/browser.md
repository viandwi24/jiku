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
2. **Stateless per command at the spawner level**, but **serialized per
   project at the dispatcher level** (see Concurrency model below). The
   runtime resolves the CDP endpoint at tool-build time and every command
   acquires a per-project mutex before talking to chromium.
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
6. **Per-agent tab affinity.** Each agent in a project gets its own chromium
   tab. Studio's tab manager creates the tab on first use and `tab_switch`es
   to it before every command. Tab indexes are tracked in memory and stay
   coherent because the per-project mutex serializes all chromium-mutating
   ops. See Concurrency model below.

---

## Studio integration (`apps/studio/server/src/browser/`)

| File | Purpose |
|------|---------|
| `tool-schema.ts` | Flat `z.object` schema. Exports `BROWSER_ACTIONS`, `BrowserToolInputSchema`, `BrowserToolInput`, `BrowserAction`. |
| `tool.ts` | `buildBrowserTools(projectId, config)` — emits a single `ToolDefinition` (`id: 'browser'`, `group: 'browser'`). Eval is gated behind `evaluate_enabled`. Pulls `agentId` from `ctx.runtime.agent.id` and forwards to `executeBrowserAction`. |
| `execute.ts` | `executeBrowserAction(input, options)` — acquires the per-project mutex, ensures the agent owns a chromium tab and that it's currently active, runs the action via `execBrowserCommand`, formats the result. Reserved actions (`tab_*`, `close`) are rejected with a clear error. |
| `concurrency.ts` | `KeyedAsyncMutex` (~50 lines, no deps) and the `browserMutex` singleton — per-key promise chain that serializes all browser commands within a project. |
| `tab-manager.ts` | `BrowserTabManager` — per-project tab affinity tracker. State: ordered list of `TrackedTab` per project, where index 0 is the system tab and index 1..N are agent-owned. Methods: `ensureInitialized`, `getAgentTabIndex`, `appendTab`, `touch`, `pickEvictionCandidate`, `removeTab`, `pickIdleTabs`, `dropProject`, `snapshot`. Also exports `startBrowserTabCleanup()` (idle eviction loop). |
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
  max_tabs?: number                  // default: 10, range: 2..50
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
| `PATCH` | `/api/projects/:pid/browser/enabled` | Toggle the feature on/off. Calls `syncProjectTools()` and `browserTabManager.dropProject()` so stale tab indexes don't survive a re-enable. |
| `PATCH` | `/api/projects/:pid/browser/config` | Update config. Strips unknown fields via Zod. Calls `syncProjectTools()` and `dropProject()` (CDP endpoint may have changed). |
| `POST`  | `/api/projects/:pid/browser/ping` | Tests CDP reachability via `GET /json/version`. Returns `{ ok, latency_ms?, browser?, cdp_url?, error? }`. |
| `POST`  | `/api/projects/:pid/browser/preview` | One-shot screenshot via `execBrowserCommand`, plus best-effort `get title` / `get url`. **Acquires the per-project mutex** so it cannot race with an in-flight agent command. Does NOT switch tabs — shows whichever tab is currently active. Returns `{ ok, data?: { base64, format, title, url }, error?, hint? }`. Never persisted. |
| `GET`   | `/api/projects/:pid/browser/status` | Diagnostic snapshot of the per-project tab manager + mutex. Returns `{ enabled, mutex: { busy }, tabs: [...], capacity: { used, agent_used, max }, idle_timeout_ms }`. Polled by the Debug panel in the settings page. |

All routes require `settings:read` (GET / ping / preview / status) or
`settings:write` (enabled / config) via `requirePermission`.

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
3. **Debug** _(only when enabled)_ — diagnostics for the concurrency model:
   - **Mutex badge** (`busy` / `idle`)
   - **Capacity bar** + count chip (`N / 10 tabs`, red when full)
   - **Tab table** with `index`, owner (agent name or `system`), `kind`,
     and idle duration. Stale tabs (idle past timeout) are highlighted amber.
   - Footer text explains the rules ("idle tabs evicted after 10m, LRU on
     overflow")
   - Polls `GET /browser/status` every 2 seconds via TanStack Query.
4. **Browser Automation** — enable toggle.
5. **CDP Endpoint** — single `cdp_url` input (placeholder
   `ws://localhost:9222`).
6. **Advanced** — `timeout_ms`, `screenshot_as_attachment` toggle,
   `evaluate_enabled` toggle.

API client lives in `apps/studio/web/lib/api.ts` under `api.browser.*`:
`get`, `setEnabled`, `updateConfig`, `ping`, `preview`, `status`. Types:
`BrowserProjectConfig`, `BrowserPingResult`, `BrowserPreviewResult`,
`BrowserStatus`, `BrowserStatusTab`. The `useAttachmentUrl` hook
(`apps/studio/web/hooks/use-attachment-url.ts`) handles authenticated URLs for
any persisted screenshot displayed elsewhere in the app (the live preview box
uses inline base64 instead and bypasses the attachment system).

---

## Docker container (`packages/browser/docker/`)

`Dockerfile` (Debian bookworm) installs Chromium, Xvfb, Fluxbox, x11vnc,
noVNC, websockify, dbus, **nginx-light**, curl. Runs as root inside the
container.

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
6. **nginx CDP proxy** (`/etc/jiku/nginx.conf`) — listens on
   `0.0.0.0:9222`, forwards to `127.0.0.1:19222`, **rewrites `Host` to
   `localhost`**, passes through WebSocket upgrades. Without this rewrite,
   chromium's DNS rebinding protection rejects every cross-container request
   with `"Host header is specified and is not an IP address or localhost."`.
   The script verifies the proxy is actually serving via a follow-up curl
   and `exit 1`s with the nginx error log on failure.
7. **x11vnc** on `:5900`.
8. **`exec websockify`** as PID 1 — noVNC web client on `:6080`. `exec` is
   important so SIGTERM from Docker propagates and `docker compose down`
   shuts the container down cleanly.

Per-process logs live in `/var/log/jiku-browser/{xvfb,fluxbox,chromium,
nginx-error,x11vnc}.log` inside the container. When debugging:

| Symptom | Look at |
|---------|---------|
| Blank wallpaper in noVNC, no chromium window | `chromium.log` (usually a sandbox / GPU issue) |
| `Host header is specified and is not an IP address or localhost` from app side | `nginx-error.log` (nginx didn't start) — should never happen if `nginx-error.log` is empty, in which case the chrome service alias / firewall is the problem |
| Container won't start | stdout of `docker compose logs chrome` — entrypoint dumps a `[entrypoint] FATAL: ...` line on every fatal path |

### Why `--no-sandbox`

Docker Desktop on macOS and Windows does **not** expose unprivileged user
namespaces to containers, so chromium's zygote dies at startup with `No usable
sandbox!` without `--no-sandbox`. The earlier non-root-without-sandbox design
was based on a wrong assumption and produced exactly that failure mode (only
Fluxbox wallpaper visible in noVNC, socat spam "Connection refused"). We're
already in an isolated container, so `--no-sandbox` is the standard pattern
and safe in this context.

### Why nginx instead of socat for the CDP proxy

Chromium's DevTools HTTP handler enforces a DNS rebinding protection: every
`/json/*` request whose `Host` header is not `localhost`, `127.0.0.1`, or an
IP address is rejected with `"Host header is specified and is not an IP
address or localhost."`. The previous design used `socat TCP-LISTEN:9222 ...
TCP:127.0.0.1:19222` which is purely TCP and lets the Host header through
unchanged. That worked locally (`curl http://localhost:9222/...`) but
**silently failed in production** as soon as the chrome service was reached
from another docker service via its compose alias (e.g.
`bitorex-...-chrome-1`) — chromium saw `Host: bitorex-...-chrome-1` and
refused.

The fix is an HTTP-aware proxy that **rewrites the Host header** to
`localhost` before forwarding. nginx with `proxy_set_header Host "localhost"`
is ~10MB extra in the image, supports WebSocket upgrades natively (which
agent-browser needs for the CDP socket), and lives entirely inside the
chrome container so all clients (Studio app, manual `curl` from another
host, future SDKs) get the fix for free.

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

## Concurrency model

agent-browser operates on the **active tab only** in chromium, so two
agents talking to the same CDP endpoint simultaneously would race on the
shared "active tab" state — element refs would go stale, fills would
overwrite each other, navigations would interleave. Studio addresses this
with a **per-project async mutex + per-agent tab affinity**.

### Per-project mutex

`KeyedAsyncMutex` in `apps/studio/server/src/browser/concurrency.ts` is a
hand-written promise-chain mutex keyed by `projectId`. Every browser command
(both agent-initiated via `executeBrowserAction` and user-initiated via the
`/preview` endpoint) acquires `browserMutex.acquire(projectId, ...)` before
talking to chromium. Calls for different projects do NOT block each other.

Within a project, commands run **strictly sequentially**. This is the
correctness boundary: an agent's `snapshot` and follow-up `click` are
guaranteed to see the same DOM, because no other agent can mutate the page
between them.

### Per-agent tab affinity

`BrowserTabManager` in `apps/studio/server/src/browser/tab-manager.ts` tracks
which chromium tab belongs to which agent. The state is purely in-memory and
shaped like:

```
projectId → [
  { agentId: null,    lastUsedAt: ... },  // index 0 = system tab
  { agentId: "uuid1", lastUsedAt: ... },  // index 1 = first agent's tab
  { agentId: "uuid2", lastUsedAt: ... },  // index 2 = second agent's tab
  ...
]
```

The order MUST mirror chromium's actual tab order (which matches what
`tab_list` returns by index). The mutex guarantees indexes stay coherent —
no two operations can mutate them concurrently, and our tracker always
appends/removes in lockstep with the corresponding chromium operation.

`executeBrowserAction` runs this preamble inside the mutex on every call:

```
1. ensureInitialized(projectId)
2. let idx = getAgentTabIndex(projectId, agentId)
3. if (idx === null):
     a. if (isAtCapacity(projectId)):
          evict the LRU agent tab via tab_close + removeTab()
     b. tab_new in chromium
     c. idx = appendTab(projectId, agentId)
     d. tab_switch idx (defensive — don't trust agent-browser auto-activate)
   else:
     a. tab_switch idx
4. run the actual command
5. touch(projectId, agentId)
```

### Reserved actions

The agent CAN'T call `tab_new`, `tab_close`, `tab_switch`, `tab_list`, or
`close` directly — Studio reserves them so the LLM doesn't desync the tab
manager. Calling any of them throws a clear error pointing the agent at the
single-tab model. The actions still appear in `BROWSER_ACTIONS` for parity
with `@jiku/browser`'s `BrowserCommand`, but the dispatcher rejects them at
runtime.

### Capacity & idle eviction

- **Hard cap:** per-project, configurable via
  `BrowserProjectConfig.max_tabs` (default `DEFAULT_MAX_TABS_PER_PROJECT =
  10`, allowed 2..50, including the system tab at index 0). On the (max+1)th
  agent, the LRU agent tab is closed first.
- **Idle timeout:** `IDLE_TAB_TIMEOUT_MS = 10 minutes`. A background loop
  (`startBrowserTabCleanup()`, started from `index.ts`, runs every 60s)
  walks every tracked project, picks tabs idle past the threshold, and
  closes them inside the per-project mutex.
- **Lifecycle hooks:** `runtimeManager.sleep(projectId)` and the `enabled` /
  `config` PATCH routes call `browserTabManager.dropProject(projectId)` so
  stale state from a previous CDP endpoint doesn't survive a config change
  or a project shutdown.

### What this gives you

- **Agent A and Agent B in the same project see independent browser state.**
  Each navigates, fills, clicks on its own page. Cookies are still shared
  at the chromium profile level — that's a chromium constraint.
- **No race conditions on element refs.** Within an agent's command sequence,
  refs from a snapshot remain valid for the next command (unless something
  else changed the DOM, e.g. a redirect or async script).
- **No throughput parallelism.** Commands within a project run one at a
  time. For most workloads (each command is 200ms-2s of I/O) this is fine;
  if you genuinely need parallel browser sessions, point each project at
  its own CDP endpoint / container.
- **Visible diagnostics.** The Debug panel in the settings page shows the
  live tab table + mutex state, refreshed every 2 seconds. When debugging
  "agent X is stuck", you can confirm whether X has a tab and whether the
  mutex is blocked on someone else's command.

### Limitations

- **In-memory state.** If you run multiple Studio server instances pointing
  at the same CDP endpoint, the mutex doesn't coordinate across them. The
  current deployment model is single-server, so this isn't an issue today.
- **Tab indexes drift on chromium restart.** If you restart the browser
  container without restarting Studio, the tab manager's indexes become
  stale. Recovery: toggle the browser feature off → on (which calls
  `dropProject`), or restart the Studio runtime (`sleep` → `wakeUp`).
- **Cookies are shared per chromium profile.** Two agents logging into
  different accounts at gmail.com on the same project will conflict —
  chromium stores one set of cookies per profile. Workaround: separate
  projects (each with its own CDP endpoint / container).

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
