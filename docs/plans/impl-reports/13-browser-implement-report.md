# Plan 13 / 33 — Browser Automation Implementation Report

**Date:** 2026-04-09 (final)
**Status:** ✅ COMPLETE
**Plans:** `docs/plans/13-browser.md` (original, abandoned) → Plan 33 (rebuild, shipped)
**Feature doc:** `docs/feats/browser.md`
**ADRs:** ADR-026 (Plan 13 marked failed), ADR-034 (attachment references, no URLs)

---

## Executive Summary

Plan 13 ported ~80 files of OpenClaw engine code into Studio in an attempt to
add browser automation. It failed to work end-to-end (headless-only, CDP
timeouts, untestable, schema enum drift) and was marked failed in ADR-026.

Plan 33 replaced it with a clean rebuild on three layers:

1. **`@jiku/browser`** — a new ~600 line standalone package wrapping Vercel
   `agent-browser` (Rust CLI) over CDP, with a hardened Docker container.
2. **Studio integration** in `apps/studio/server/src/browser/` — flat
   OpenAI-safe Zod schema for 33 actions, runtime mapper to `BrowserCommand`,
   screenshot persistence via the new unified attachment service.
3. **Studio UI** — CDP-only settings page with a Live Preview box for visual
   confirmation of browser state.

The full session arc on 2026-04-09 spans:

- Initial Plan 33 ship (engine swap + attachment system).
- A cleanup pass that closed integration leaks between the new backend and
  the old Plan-13-era surfaces (config types, UI page, web API types).
- A docker container fix after the user reported "blank wallpaper, no
  Chromium" (root cause: missing `--no-sandbox` on Docker Desktop, plus a
  silent `su browser -c` failure mode and a socat race against chromium
  startup).
- An OpenAI schema fix after the user reported `Invalid schema for function
  'builtin_browser': ... got 'type: "None"'` (root cause: `z.discriminatedUnion`
  serializes to `anyOf` at the JSON Schema root, which OpenAI rejects).
- A Live Preview UI feature so users can see the current browser state from
  the settings page without opening noVNC separately.
- Removal of stale Plan-13 docker artifacts that nothing referenced anymore.

End result: production-grade browser automation, screenshots stored as
first-class attachments, no URLs in the database, visual feedback in the UI,
and a documented set of gotchas to prevent regression.

---

## Architecture

```
┌──────────────────────────────────────────────────────┐
│ Agent Runtime (apps/studio/server/runtime/manager.ts)│
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
                          └────────────────────────┬───────────┘
                                                   │ spawn
                          ┌────────────────────────▼───────────┐
                          │ agent-browser CLI (Rust)           │
                          │   --cdp http://localhost:9222      │
                          └────────────────────────┬───────────┘
                                                   │ CDP
                          ┌────────────────────────▼───────────┐
                          │ Docker container                   │
                          │   Chromium + Xvfb + Fluxbox        │
                          │   socat (9222 → 19222) + noVNC     │
                          └────────────────────────────────────┘
```

### Key design decisions

1. **CLI bridge over library port.** agent-browser is a Rust binary; spawning
   it per command is simpler and crash-isolated.
2. **Stateless per command.** No shared browser server, no Node child
   process, no start/stop lifecycle in the runtime.
3. **CDP-only project config.** Single endpoint stored in
   `projects.browser_config.cdp_url`. Plan 13's managed-mode fields are gone.
4. **Screenshots are attachments.** Returned as
   `{ type: 'image', attachment_id, storage_key, mime_type }`. Persisted via
   `persistContentToAttachment()` from the Plan 33 unified attachment system.
5. **Flat `z.object` for the tool schema.** OpenAI's function calling API
   requires `type: "object"` at the JSON Schema root. A `z.discriminatedUnion`
   serializes to `anyOf` and breaks this. The schema is flat with `action` as
   the required enum and per-action requirements enforced at runtime.
6. **`--no-sandbox` in Docker.** Docker Desktop on macOS/Windows does not
   expose unprivileged user namespaces, so Chromium's zygote dies without it.
   Standard for headful Chromium in Docker; safe inside an isolated container.

---

## Unified Attachment System (Plan 33)

The browser feature is the first consumer of the new attachment persistence
service. Future tool outputs (connector exports, plugin outputs) should reuse
the same path.

### Database schema (`project_attachments`)

New columns added in `0008_add_attachment_source_tracking.sql`:

- `source_type VARCHAR(32) DEFAULT 'user_upload'` — origin tag
  (`user_upload`, `browser`, `connector_export`, `plugin_output`, ...)
- `metadata JSONB` — arbitrary source-specific data (e.g. screenshot URL,
  viewport, selector).
- Index on `source_type` for filtering.

### Types (`packages/types/src/index.ts`)

```typescript
export interface ContentPersistOptions {
  projectId: string
  data: Buffer
  mimeType: string
  filename: string
  sourceType: string
  conversationId?: string
  agentId?: string
  userId?: string
  scope?: 'per_user' | 'shared'
  metadata?: Record<string, unknown>
}

export interface ContentPersistResult {
  attachmentId: string
  storageKey: string
  mimeType: string
  sizeBytes: number
  // NO url field — URLs generated on-demand
}

export type ToolContentPart =
  | { type: 'text'; text: string }
  | { type: 'image'; attachment_id: string; storage_key: string; mime_type: string }
  | { type: 'document'; attachment_id: string; storage_key: string; mime_type: string; file_name: string }
  | { type: 'audio'; attachment_id: string; storage_key: string; mime_type: string }
```

### Persister (`apps/studio/server/src/content/persister.ts`)

1. Generate storage key: `jiku/attachments/{projectId}/{scope}/{uuid}.{ext}`
2. Upload buffer via filesystem adapter (S3/RustFS).
3. Insert `project_attachments` row with `source_type` + `metadata`.
4. Return `{ attachmentId, storageKey, mimeType, sizeBytes }`.

### Serving layers

| Endpoint | Auth | Consumer |
|----------|------|----------|
| `GET /api/attachments/:id/inline?token=JWT` | JWT in query | UI (`<img>`, downloads) |
| `GET /files/view?key=&token=HMAC` | HMAC proxy token | External LLM providers (vision) |
| `POST /projects/:pid/attachments/:id/token` | JWT | Mints HMAC token |

### LLM delivery path

`apps/studio/server/src/routes/chat.ts` resolves `attachment://{id}` per
request based on the agent's `file_delivery` setting:

- `proxy_url` → mint HMAC token, build `/files/view?...` URL, send to LLM.
- `base64` → download from S3, inline as `data:mime;base64,...`.

### UI rendering path

`packages/ui/src/components/ai-elements/tool.tsx` (`ToolOutput`) handles
attachment references natively. The `token` prop is passed from
`conversation-viewer.tsx` via `getToken()`. The
`useAttachmentUrl()` hook (`apps/studio/web/hooks/use-attachment-url.ts`)
provides the same for any other component.

---

## Studio integration

### Tool schema — flat `z.object`

`apps/studio/server/src/browser/tool-schema.ts` exports `BROWSER_ACTIONS` (33
entries: navigation, observation, interaction, wait, tabs, eval, cookies,
storage, batch). Tab and cookies operations are flattened from the nested
`BrowserCommand` form (`{action: 'tab', operation: 'list'}`) into top-level
actions (`tab_list`) so the LLM sees a single flat enum.

```typescript
export const BrowserToolInputSchema = z.object({
  action: z.enum(BROWSER_ACTIONS),
  // every other field optional, with .describe() pointing to the action(s) that need it
  url: z.string().optional(),
  ref: z.string().optional(),
  text: z.string().optional(),
  // ...
})
```

### Mapper + per-action validation

`apps/studio/server/src/browser/execute.ts` has a `need()` helper that throws
clearly when an LLM omits a required field, and a `mapToBrowserCommand()`
that rebuilds the nested form before calling `execBrowserCommand`. The
`never`-typed default branch over `BrowserAction` gives compile-time
exhaustiveness.

```typescript
function need<T>(value: T | undefined | null, action: BrowserAction, field: string): T {
  if (value === undefined || value === null) {
    throw new Error(`Browser action '${action}' requires field '${field}'`)
  }
  return value
}

function mapToBrowserCommand(input: BrowserToolInput): BrowserCommand {
  switch (input.action) {
    case 'open':       return { action: 'open', url: need(input.url, 'open', 'url') }
    case 'tab_list':   return { action: 'tab', operation: 'list' }
    case 'cookies_set':return { action: 'cookies', operation: 'set', cookie: need(input.cookie, 'cookies_set', 'cookie') }
    // ... 30 more cases
    default: { const _e: never = input.action; throw new Error(...) }
  }
}
```

### Screenshot persistence

```typescript
if (input.action === 'screenshot' && result.success && result.data) {
  const screenshot = result.data as ScreenshotData
  if (!screenshotAsAttachment) {
    return { content: [{ type: 'text', text: JSON.stringify({ ... }) }] }
  }
  const attachment = await persistContentToAttachment({
    projectId,
    data: Buffer.from(screenshot.base64, 'base64'),
    mimeType: `image/${screenshot.format ?? 'png'}`,
    filename: `screenshot-${Date.now()}.${screenshot.format ?? 'png'}`,
    sourceType: 'browser',
    metadata: { action: 'screenshot' },
  })
  return {
    content: [{
      type: 'image',
      attachment_id: attachment.attachmentId,
      storage_key: attachment.storageKey,
      mime_type: attachment.mimeType,
    }],
  }
}
```

### Runtime manager

`apps/studio/server/src/runtime/manager.ts` calls `buildBrowserTools(projectId,
browserCfg.config)` from `resolveSharedTools()` whenever a project boots
(`wakeUp`) or its config changes (`syncProjectTools`). All
`startBrowserServer` / `stopBrowserServer` lifecycle code from Plan 13 was
removed — there is no server to start anymore.

### REST API (`routes/browser.ts`)

| Method | Path | Purpose |
|--------|------|---------|
| `GET` | `/projects/:pid/browser` | `{ enabled, config }` |
| `PATCH` | `/projects/:pid/browser/enabled` | toggle on/off → `syncProjectTools` |
| `PATCH` | `/projects/:pid/browser/config` | update config → `syncProjectTools` |
| `POST` | `/projects/:pid/browser/ping` | test CDP via `/json/version` |
| `POST` | `/projects/:pid/browser/preview` | one-shot screenshot + title + url, never persisted |

`BrowserConfigSchema` (Zod) accepts only `cdp_url`, `timeout_ms`,
`evaluate_enabled`, `screenshot_as_attachment` — anything else is silently
stripped.

---

## Studio UI

### Settings page (`browser/page.tsx`)

Sections (top to bottom):

1. **Status bar** — derives tone (`idle` / `unknown` / `ok` / `error`) from
   the latest ping result. "Test connection" button always visible while
   enabled.
2. **Live Preview** — 16:9 box with the latest screenshot, manual Refresh
   button, Auto-refresh toggle (3s interval), title/url overlay, all states
   handled. `useRef` guard against overlapping requests.
3. **Browser Automation** — enable toggle.
4. **CDP Endpoint** — single `cdp_url` input.
5. **Advanced** — `timeout_ms`, `screenshot_as_attachment` toggle,
   `evaluate_enabled` toggle.

### API client

`apps/studio/web/lib/api.ts` exposes `api.browser.{get,setEnabled,updateConfig,ping,preview}`
plus `BrowserProjectConfig`, `BrowserPingResult`, `BrowserPreviewResult`
types. The fake `status: { running, port }` field that lingered from Plan 13
was removed.

---

## Docker container

`packages/browser/docker/Dockerfile` (Debian bookworm) installs Chromium,
Xvfb, Fluxbox, x11vnc, noVNC, websockify, dbus, dbus-x11, socat, curl. Runs
as root inside the container.

`packages/browser/docker/entrypoint.sh` order:

1. **dbus-daemon** — chromium logs warnings without it.
2. **Xvfb** on `:99`, with UNIX socket readiness probe.
3. **Fluxbox** WM, log → `/var/log/jiku-browser/fluxbox.log`.
4. **Chromium** with `--no-sandbox`, `--remote-debugging-address=127.0.0.1`,
   `--remote-debugging-port=19222`, `--remote-allow-origins=*`,
   `--user-data-dir=/data/chrome-data`, log → `chromium.log`.
5. **CDP readiness probe** — `curl http://127.0.0.1:19222/json/version`
   (60 attempts × 0.5s). On failure: print last 50 lines of `chromium.log`
   to stderr and `exit 1`.
6. **socat** forwards `0.0.0.0:9222 → 127.0.0.1:19222`.
7. **x11vnc** on `:5900`.
8. **`exec websockify`** as PID 1 — noVNC web client on `:6080`. `exec` so
   SIGTERM propagates.

Per-process logs in `/var/log/jiku-browser/{xvfb,fluxbox,chromium,socat,x11vnc}.log`.

---

## Critical bugs hit (and how they were diagnosed)

### Bug 1: "Chromium doesn't open in noVNC, only Fluxbox wallpaper"

**Symptom:** `docker compose up` succeeded, noVNC reachable, but only
Fluxbox + taskbar visible. socat spammed `Connection refused` to port 19222.

**Root cause:** chromium's zygote aborted with `No usable sandbox!` because
Docker Desktop on macOS doesn't expose unprivileged user namespaces. The old
entrypoint relied on running chromium as a non-root `browser` user without
`--no-sandbox`. Two secondary contributors:
- `su browser -c` was unreliable because `useradd -r` may set the shell to
  `nologin`, in which case `su -c` exits silently.
- socat started 2 seconds after chromium with no readiness check, so even if
  chromium had started slowly the proxy would still have raced.

**Fix:** rewrote entrypoint with `--no-sandbox`, dbus, CDP readiness probe
via `curl`, per-process logs, `exec websockify` as PID 1. Dropped the
non-root user.

**Diagnosis path:** the user shared full container logs. The smoking gun
was on line 1: `ERROR:zygote_host_impl_linux.cc:128] No usable sandbox!`.

### Bug 3: `Host header is specified and is not an IP address or localhost` from another docker service

**Symptom:** the chrome container worked perfectly when accessed from
`localhost` (locally and from inside the container itself) but failed in
production Dokploy deployments where the Studio app reaches the chrome
service via its compose alias (`bitorex-...-chrome-1`):

```
$ curl http://bitorex-...-chrome-1:9222/json/version
Host header is specified and is not an IP address or localhost.
```

The Studio /preview endpoint and the agent browser tool both surfaced as
"connection failed" with no useful detail.

**Root cause:** chromium's DevTools HTTP handler enforces a DNS rebinding
protection — every `/json/*` request whose `Host` header is not `localhost`,
`127.0.0.1`, or an IP literal gets rejected. The previous entrypoint
forwarded public port 9222 → internal port 19222 with
`socat TCP-LISTEN:9222 ... TCP:127.0.0.1:19222`. socat is purely TCP-level
and passed the Host header through unchanged. Local calls happened to use
`localhost:9222` (Host header `localhost`) and worked; production calls
used the docker service hostname and chromium refused.

**Fix:** replaced `socat` with `nginx-light` as the public CDP listener.
nginx forwards to `127.0.0.1:19222` and unconditionally rewrites the Host
header via `proxy_set_header Host "localhost"`. WebSocket upgrades for the
CDP socket are passed through with `proxy_set_header Upgrade $http_upgrade`.
The entrypoint runs a follow-up `curl` readiness check after starting nginx
and fails fast with the nginx error log on failure.

**Diagnosis path:** the user shared the exact chromium error message
(`Host header is specified...`) plus a side-by-side curl from inside vs
outside the chrome container. The inside-localhost vs outside-hostname
pattern is the canonical signature of chromium's rebinding check. nginx with
header rewriting is the well-known fix.

**Lesson:** "TCP forward" is not "HTTP forward". When fronting an HTTP
service that has security checks on inbound headers (Host, Origin, etc.),
use an HTTP-aware proxy. socat / iptables / kernel TCP forwarding will pass
the headers through unchanged and silently break.

---

### Bug 2: `Invalid schema for function 'builtin_browser': ... got 'type: "None"'`

**Symptom:** any chat in a browser-enabled project failed at the LLM
function-calling layer.

**Root cause:** the cleanup pass earlier in the session rewrote
`tool-schema.ts` as a `z.discriminatedUnion` over `action`.
`zod-to-json-schema` (used by AI SDK's `zodSchema()`) converts a
discriminated union to `{ "anyOf": [...] }` at the JSON Schema root, with no
top-level `type`. OpenAI's function calling API rejects that.

**Fix:** rewrote the schema as a flat `z.object` with `action` as a required
enum and every other field optional. Per-action requirements moved to a
`need()` helper in `mapToBrowserCommand`. Added a `BROWSER_ACTIONS` const as
the single source of truth for the enum. Memory updated.

**Lesson:** "OpenAI tool schemas must be `type: object` at the root" is now
documented in `docs/builder/memory.md` so future tool authors don't repeat
this.

---

## Files Changed / Added / Deleted

### Added (Plan 33 ship)
- `packages/browser/` — entire package (~600 lines + 52 tests)
- `apps/studio/server/src/content/persister.ts` — unified attachment service
- `apps/studio/server/src/content/index.ts` — re-export
- `apps/studio/web/hooks/use-attachment-url.ts` — JWT-injected attachment URLs
- `apps/studio/db/src/migrations/0008_add_attachment_source_tracking.sql`

### Modified (Plan 33 ship + cleanup pass + bug fixes)
- `packages/types/src/index.ts` — `ToolContentPart`, `ContentPersistResult`,
  `ContentPersistOptions`
- `packages/ui/src/components/ai-elements/tool.tsx` — `ToolOutput` renders
  attachment refs; `token` prop added
- `packages/browser/docker/Dockerfile` — added dbus + curl, dropped non-root
  user
- `packages/browser/docker/entrypoint.sh` — full rewrite with `--no-sandbox`,
  readiness probe, per-process logs, `exec websockify`
- `apps/studio/db/src/schema/attachments.ts` — `source_type`, `metadata`
- `apps/studio/db/src/queries/browser.ts` — `BrowserProjectConfig` trimmed to
  CDP-only fields
- `apps/studio/server/src/browser/tool-schema.ts` — flat `z.object` with 33
  actions
- `apps/studio/server/src/browser/tool.ts` — static type imports, eval gating,
  expanded description
- `apps/studio/server/src/browser/execute.ts` — runtime mapper + `need()`
  validator + screenshot persistence
- `apps/studio/server/src/browser/config.ts` — minimal `resolveCdpEndpoint`
- `apps/studio/server/src/browser/index.ts` — per-project CDP map
- `apps/studio/server/src/routes/browser.ts` — minimal Zod schema, ping,
  **new preview endpoint**
- `apps/studio/server/src/runtime/manager.ts` — removed
  `startBrowserServer`/`stopBrowserServer` lifecycle, refreshed comments
- `apps/studio/web/lib/api.ts` — `BrowserProjectConfig`, `BrowserPingResult`,
  `BrowserPreviewResult`, `api.browser.preview()`
- `apps/studio/web/app/(app)/studio/companies/[company]/projects/[project]/browser/page.tsx`
  — full rewrite as CDP-only with Live Preview box

### Deleted
- `apps/studio/server/src/browser/browser/*` — ~80 files of OpenClaw port
- `apps/studio/server/docker-compose.browser.yml` — Plan 13 linuxserver/chromium compose
- `apps/studio/server/browser-init/chromium-cdp.sh` — Plan 13 init script
- `apps/studio/server/browser-init/` — empty directory removed
- `infra/dokploy/Dockerfile.browser` — orphaned, never referenced

### Docs
- `docs/feats/browser.md` — full rewrite, single source of truth
- `docs/builder/current.md` — Plan 33 marked done
- `docs/builder/changelog.md` — full session entries
- `docs/builder/memory.md` — added gotchas: tool schema must be flat
  `z.object`, browser config is CDP-only, chromium needs `--no-sandbox` in
  Docker, browser container log paths
- `docs/builder/tasks.md` — closed Plan 13 cleanup tasks; added Plan 33 to
  Done section

---

## Verification

### Smoke test (manual)

```bash
# 1. Start the browser container
cd packages/browser
docker compose down && docker compose up -d --build

# 2. Confirm CDP is reachable
curl -s http://localhost:9222/json/version
# expected: {"Browser":"Chrome/...","webSocketDebuggerUrl":"..."}

# 3. (Optional) open noVNC viewer — should show about:blank in Chromium
open http://localhost:6080/vnc.html

# 4. Studio: Browser settings page → Enable → set cdp_url to ws://localhost:9222 → Save
# 5. Click "Test connection" → expected: "CDP reachable · Chrome/<ver> · Xms"
# 6. Click "Refresh" in Live Preview → expected: about:blank screenshot appears
# 7. Toggle "Auto refresh" → preview updates every 3s
# 8. Chat with an agent in that project → ask it to "open https://example.com and screenshot"
# 9. Expected: agent calls browser tool, screenshot appears in chat as a persisted attachment
```

### Container health checks

```bash
# Inspect chromium logs from inside the container
docker exec -it $(docker compose -f packages/browser/docker-compose.yml ps -q chrome) \
  tail /var/log/jiku-browser/chromium.log

# Should show clean startup, no "No usable sandbox" error.
```

### What was verified

- ✅ `bun run dev` — server boots, all plugins load, all runtimes boot.
- ✅ `bun run db:push` — migrations applied cleanly.
- ✅ Container builds + starts; chromium reaches CDP within ~5 attempts.
- ✅ Test connection from Studio UI returns latency + browser version.
- ✅ Live Preview captures screenshots end-to-end.
- ✅ Chat with browser tool no longer trips OpenAI schema validation.
- ⏳ Connector action output persistence — not yet migrated to the unified
  persister (tracked separately).

---

## Concurrency model (post-Plan-33 follow-up — 2026-04-09)

After the user asked "what happens when multiple agents share one browser?",
we added a per-project async mutex + per-agent tab affinity. agent-browser
itself only has one "active tab" per CDP endpoint, so without coordination
two agents would race on the shared state. The fix has three parts:

### 1. Per-project mutex (`concurrency.ts`)

`KeyedAsyncMutex` is a hand-written promise-chain mutex (~50 LoC, no
dependencies). `browserMutex.acquire(projectId, fn)` chains `fn` after the
previous holder for that key. Calls for different projects do not block
each other.

Every browser command — agent-initiated via `executeBrowserAction` AND
user-initiated via the `/preview` endpoint — acquires this lock before
talking to chromium. Within a project, commands run strictly sequentially.

### 2. Per-agent tab manager (`tab-manager.ts`)

`BrowserTabManager` tracks one chromium tab per agent. State shape:

```
projectId → [
  { agentId: null,    lastUsedAt }, // index 0 = system tab (about:blank from container start)
  { agentId: "uuid1", lastUsedAt }, // index 1 = first agent's tab
  ...
]
```

The order MUST mirror chromium's actual tab order (which is the order
returned by `tab_list` and the indices accepted by `tab_switch` /
`tab_close`). The mutex guarantees indexes stay coherent because no two
operations can mutate them concurrently.

`executeBrowserAction` runs this preamble inside the mutex on every call:

1. `ensureInitialized(projectId)` — record the system tab if not seen yet.
2. Look up `getAgentTabIndex(projectId, agentId)`.
3. If no tab: check `isAtCapacity()` → evict LRU agent tab if full → `tab_new`
   → `appendTab` → `tab_switch` to the new index. Otherwise: `tab_switch` to
   the existing index.
4. Run the actual command.
5. `touch(projectId, agentId)` so the LRU clock advances.

### 3. Reserved actions

`tab_new`, `tab_close`, `tab_switch`, `tab_list`, and `close` are reserved
by Studio — `executeBrowserAction` rejects them with a clear error pointing
the agent at the single-tab model. The actions still appear in the schema
enum for `BrowserCommand` parity, but the dispatcher refuses them so the LLM
can't desync our index tracking.

### 4. Idle eviction + capacity

- Per-project hard cap, default `DEFAULT_MAX_TABS_PER_PROJECT = 10`
  (including the system tab). Configurable via
  `BrowserProjectConfig.max_tabs` in 2..50. On the (max+1)th agent, the
  LRU agent tab is closed first.
- `IDLE_TAB_TIMEOUT_MS = 10 minutes`.
- `startBrowserTabCleanup()` (called from `index.ts` after the runtime
  boots) runs every 60s. It walks every tracked project, picks idle tabs
  via `pickIdleTabs()`, and closes them inside the per-project mutex. The
  interval is `unref()`'d so it doesn't pin the event loop on shutdown.
- `runtimeManager.sleep(projectId)` and the browser config PATCH routes
  call `browserTabManager.dropProject(projectId)` so stale state from a
  previous CDP endpoint doesn't survive a config change or a project
  restart.

### 5. Diagnostic endpoint + Debug panel

- `GET /api/projects/:pid/browser/status` returns:
  ```json
  {
    "enabled": true,
    "mutex": { "busy": false },
    "tabs": [
      { "index": 0, "agent_id": null, "agent_name": null, "kind": "system", "last_used_at": ..., "idle_ms": ... },
      { "index": 1, "agent_id": "uuid", "agent_name": "Researcher", "kind": "agent", "last_used_at": ..., "idle_ms": ... }
    ],
    "capacity": { "used": 2, "agent_used": 1, "max": 10 },
    "idle_timeout_ms": 600000
  }
  ```
- The Browser settings page has a new **Debug** section (visible when the
  feature is enabled) showing the mutex badge (`busy` / `idle`), a capacity
  bar, and a live tab table. Polls every 2 seconds via TanStack Query.
  Stale tabs (idle past timeout) are highlighted amber so users can see
  what the next cleanup tick will evict.

### What this gives you

- **Agent A and Agent B in the same project see independent browser state.**
  Each navigates, fills, clicks on its own page. Cookies are still shared at
  the chromium profile level (chromium constraint, not ours).
- **No race conditions on element refs.** Within an agent's command sequence,
  refs from a snapshot remain valid for the next command (unless a redirect
  or async script changes the DOM, which is the agent's own problem).
- **No throughput parallelism.** Commands within a project run one at a
  time. For most workloads (200ms-2s of I/O per command) this is fine. For
  genuine parallelism, point each project at its own CDP endpoint /
  container — the mutex is per-project.
- **Visible diagnostics.** When debugging "agent X is stuck" or "the browser
  feels slow", the Debug panel shows whether X has a tab, whether the mutex
  is held, and how stale each tab is.

### What's NOT solved (and the workarounds)

- **Multi-server Studio.** The mutex is in-memory. If you run multiple
  Studio servers pointing at the same CDP endpoint, they don't coordinate.
  Current deployment is single-server, so not an issue today.
- **Tab indexes drift on chromium restart.** If you restart the browser
  container without restarting Studio, tracked indexes become stale.
  Recovery: toggle the browser feature off → on (which calls `dropProject`),
  or restart the Studio runtime (`sleep` → `wakeUp`).
- **Cookies are shared per chromium profile.** Two agents logging into
  different gmail accounts on the same project will conflict. Workaround:
  put them in separate projects (each with its own CDP endpoint).

---

## Known Limitations

1. **Stateless per command.** Each command spawns a fresh CLI process; no
   console logs / network state persists between calls.
2. **Ref staleness.** Element refs from a snapshot become invalid after DOM
   changes. The standard pattern is snapshot → act → snapshot.
3. **Live Preview is one-shot polling, not a stream.** 3s auto-refresh is
   acceptable for "what state is the browser in" but not for visualizing
   real-time interaction.
4. **No throughput parallelism within a project.** The per-project mutex
   serializes all browser commands. For genuine parallel browser usage,
   split agents across projects or wait for the future container-pool
   design (Plan 36-ish).
5. **In-memory concurrency state.** Mutex + tab manager are per-server.
   Multi-server Studio would need either pinning by project or a distributed
   lock. Single-server deployment is fine.

---

## Lessons Learned

1. **Don't port what you don't own.** Plan 13 tried to port ~80 files of
   OpenClaw internals. Most of it wasn't load-bearing, and debugging the
   broken subset was worse than starting over with a clean wrapper.
2. **CLI bridges beat library ports** for language-mismatched engines.
   Spawning a Rust binary per command is simpler than maintaining a thick
   Node wrapper.
3. **Storage references, not URLs.** Every time a URL is stored in the DB it
   becomes a liability when the domain, auth, or CDN changes. `id + key` with
   on-demand URL generation is strictly more flexible.
4. **Persistence should be a one-liner for tools.** The
   `persistContentToAttachment()` service makes it trivial for any tool
   (browser, connector, plugin, future exporters) to persist outputs without
   touching S3, DB, or auth code.
5. **OpenAI function schemas must be `type: object` at the root.** Discriminated
   unions in Zod serialize to `anyOf` and break this. Use a flat object with
   runtime per-discriminator validation instead.
6. **Headful Chromium in Docker needs `--no-sandbox` on macOS/Windows.**
   Docker Desktop doesn't expose unprivileged user namespaces. This is not a
   security regression because the container itself is the isolation
   boundary.
7. **Always check container logs first.** "Blank wallpaper, no chromium" was
   diagnosed in seconds once we had `chromium.log` instead of stdout-only
   noise from socat retry loops. Per-process log files in
   `/var/log/jiku-browser/` are now baked into the entrypoint for future
   debugging.
8. **Race conditions love `sleep 2`.** The original entrypoint started socat
   2 seconds after chromium. The fix is a real readiness probe, not a longer
   sleep.
9. **Half-baked is worse than not-built.** The Plan-13-era settings page
   continued to render Managed/Remote tabs and headless toggles long after
   the backend stopped honoring them. Users could "configure" things that
   silently did nothing. CLAUDE.md's no-half-baked rule exists for exactly
   this failure mode.
