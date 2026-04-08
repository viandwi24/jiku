# Feature: Browser Automation — @jiku/browser

> **STATUS: REBUILT** — Plan 13 (failed OpenClaw port) replaced with `@jiku/browser` package.
> New architecture: CLI bridge to [Vercel agent-browser](https://github.com/vercel-labs/agent-browser) via CDP.

## What it does

Per-project browser automation. `@jiku/browser` is a library package (`packages/browser/`) that provides:

1. **BrowserAgentServer** — Express HTTP API for profile management + 30+ browser commands
2. **execBrowserCommand()** — Direct function call to execute browser commands (no HTTP server needed)
3. **Docker container** — Chromium + Xvfb + noVNC + socat for visual browser with CDP access
4. **Parsed responses** — AI-friendly `BrowserResult<T>` with structured data + error hints

Tool definitions for AI agents are created in `apps/studio/server`, not in this package.

## Architecture

```
apps/studio/server (tool definition)
    |
    v
@jiku/browser — execBrowserCommand()
    |
    v
agent-browser CLI (Rust binary, spawned per command)
    |  --cdp flag + pre-connect
    v
Chrome/Chromium (via CDP)
    |
    v
Docker container (Chromium + Xvfb + noVNC + socat proxy)
  - Port 9222: CDP (socat → internal 19222)
  - Port 6080: noVNC web viewer
```

### Key Design Decisions

- **CLI bridge** — agent-browser is a Rust binary, not a Node library. We spawn it per command.
- **Pre-connect** — `agent-browser connect <endpoint>` runs once per endpoint (cached in-memory Set). Required before `--cdp` flag works.
- **socat proxy** — Chrome HTTP `/json/version` not accessible from outside container natively. socat forwards 0.0.0.0:9222 → 127.0.0.1:19222.
- **ws:// → http:// conversion** — `resolveCdpEndpoint()` converts `ws://localhost:9222` to `http://localhost:9222` (the format agent-browser expects).
- **Screenshot as base64** — agent-browser saves to temp file, we read it, base64-encode, delete temp file. Client handles saving if needed.
- **Non-root Chromium** — Container runs Chromium as `browser` user (no `--no-sandbox` needed, no warning banner).

## Commands (30+)

### Navigation (5)
`open`, `back`, `forward`, `reload`, `close`

### Observation (4)
`snapshot` (with interactive/compact/depth/selector), `screenshot` (returns base64), `pdf`, `get` (text/html/value/attr/title/url/count/box/styles)

### Interaction (15)
`click`, `dblclick`, `fill`, `type`, `press`, `hover`, `focus`, `check`, `uncheck`, `select`, `drag`, `upload`, `scroll`, `scrollintoview`

### Wait (1)
`wait` (ref/text/url/ms)

### Tabs (4)
`tab list`, `tab new`, `tab close`, `tab switch`

### JavaScript (1)
`eval`

### Cookies & Storage (3)
`cookies` (get/set/clear), `storage` (local/session)

### Batch (1)
`batch`

## Response Format

```typescript
interface BrowserResult<T> {
  success: boolean;
  data: T | null;
  error: string | null;
  hint: string | null;  // AI-friendly recovery suggestion
}
```

Error hints cover: stale refs, timeouts, not interactable, CDP failures, file not found, frame detached, dialog blocking.

## Profile Management

In-memory store. Each profile = `{ id, type: "cdp", config: { endpoint } }`.

- One profile per project (1 project = 1 browser = 1 CDP endpoint)
- CRUD via HTTP API or `ProfileManager` class directly

## Multi-User / Tab Isolation

- agent-browser operates on the **active tab only**
- Two users on the same profile will conflict (shared active tab state)
- Tab management (`tab list/new/close/switch`) available but no concurrent tab isolation
- For true multi-user: separate browser container per user (future)

## Related Files

```
packages/browser/
├── src/
│   ├── index.ts              # Public exports
│   ├── types.ts              # BrowserCommand (30+ actions), BrowserResult, Profile
│   ├── server.ts             # BrowserAgentServer (Express, cmdHandler factory)
│   ├── spawner.ts            # execCommand, execBrowserCommand, resolveCdpEndpoint, ensureConnected
│   ├── parser.ts             # parseCommandResult + AI error hint generation (10 patterns)
│   ├── profile-manager.ts    # In-memory profile CRUD
│   ├── main.ts               # Standalone server entry point
│   ├── examples/cdp.ts       # Full example: navigate → snapshot → fill → search → screenshot
│   └── tests/                # 52 tests (profile, spawner, parser, server)
├── docker/
│   ├── Dockerfile            # Debian + Chromium + Xvfb + noVNC + socat
│   └── entrypoint.sh         # Startup: Xvfb → Fluxbox → Chromium (non-root) → socat → VNC → noVNC
├── docker-compose.yml        # Ports: 9222 (CDP), 6080 (noVNC)
├── SKILL.md                  # Detailed command reference + patterns
└── README.md                 # Quick start + API docs
```

## vs Old Plan 13 (OpenClaw Port)

| Aspect | Plan 13 (old) | @jiku/browser (new) |
|--------|---------------|---------------------|
| Engine | Ported OpenClaw (~80 files) | agent-browser CLI (Rust binary) |
| Connection | Playwright + CDP (broken) | CLI spawn + CDP via socat proxy |
| Visibility | Headless only (failed) | Visible in noVNC |
| Package | Inside apps/studio/server | Standalone packages/browser |
| Code size | ~9000 lines | ~600 lines |
| Tests | None | 52 tests |
