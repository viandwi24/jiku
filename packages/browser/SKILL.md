# @jiku/browser — AI Browser Automation Bridge

## Overview

`@jiku/browser` is an HTTP bridge server that wraps the [Vercel agent-browser](https://github.com/vercel-labs/agent-browser) CLI for AI agent browser automation. It exposes a REST API for profile management and browser control, with parsed responses and AI-friendly error hints.

## Architecture

```
AI Agent (tool call in apps/studio/server)
    |
    v
@jiku/browser (Express HTTP API)
    |
    v
agent-browser CLI (Rust binary, spawned per command)
    |  --cdp flag
    v
Chrome/Chromium (via CDP - Chrome DevTools Protocol)
    |
    v
Docker container (Chromium + Xvfb + noVNC + nginx CDP proxy)
```

### Key Design Decisions

- **CLI bridge, not library** — agent-browser is a Rust binary. We spawn it per command and parse JSON output.
- **CDP-only profiles** — each profile stores a CDP endpoint. Every command connects via `--cdp`, keeping things stateless per command.
- **Pre-connect pattern** — agent-browser requires `connect <endpoint>` before `--cdp` works. We auto-run this once per endpoint (cached in-memory).
- **Parsed responses** — raw CLI stdout is parsed into `BrowserResult<T>` with structured data + AI-friendly error hints.
- **nginx HTTP proxy in Docker** — Chromium's DevTools handler rejects `/json/*` requests whose `Host` header is not `localhost`/`127.0.0.1`/an IP (DNS rebinding protection). nginx listens on public port 9222, forwards to internal port 19222, and unconditionally rewrites the Host header to `localhost`. Required for any cross-container CDP access; passes through WebSocket upgrades for the CDP socket.

## Interaction Pattern for AI Agents

The standard loop an AI agent follows:

```
1. SNAPSHOT  → get page elements with refs (@e1, @e2, ...)
2. DECIDE    → pick an action based on snapshot
3. ACT       → click/fill/type using refs
4. OBSERVE   → snapshot again to see result
5. REPEAT
```

### Element Refs

Snapshots return element references like `@e1`, `@e2`. These refs are used in interaction commands:

```json
// Snapshot returns:
{ "snapshot": "- combobox \"Search\" [ref=e15]\n- button \"Submit\" [ref=e18]" }

// Agent uses refs:
{ "action": "fill", "ref": "@e15", "text": "search query" }
{ "action": "click", "ref": "@e18" }
```

Refs are valid until the DOM changes significantly. After navigation or major DOM updates, re-snapshot to get fresh refs.

## Command Reference

### Navigation (5 commands)

| Action | Parameters | Description |
|--------|-----------|-------------|
| `open` | `url: string` | Navigate to URL |
| `back` | — | Go back in history |
| `forward` | — | Go forward in history |
| `reload` | — | Reload current page |
| `close` | — | Close browser/session |

### Observation (4 commands)

| Action | Parameters | Description |
|--------|-----------|-------------|
| `snapshot` | `interactive?`, `compact?`, `selector?`, `depth?` | Get accessibility tree with element refs |
| `screenshot` | `path?`, `full?`, `annotate?` | Capture screenshot (annotate adds numbered labels) |
| `pdf` | `path: string` | Export page as PDF |
| `get` | `subcommand`, `ref?`, `attr?` | Query DOM info |

**`get` subcommands:** `text`, `html`, `value`, `attr <name>`, `title`, `url`, `count`, `box`, `styles`, `cdp-url`

**`snapshot` flags:**
- `-i` / `interactive` — only interactive elements (recommended for AI)
- `-c` / `compact` — remove empty structural elements
- `-d` / `depth` — limit tree depth
- `-s` / `selector` — scope to CSS selector

### Interaction (15 commands)

| Action | Parameters | Description |
|--------|-----------|-------------|
| `click` | `ref`, `newTab?` | Click element |
| `dblclick` | `ref` | Double-click element |
| `fill` | `ref`, `text` | Clear field and type text |
| `type` | `ref`, `text` | Type text without clearing |
| `press` | `key` | Press keyboard key (Enter, Tab, Control+a, etc.) |
| `hover` | `ref` | Hover over element |
| `focus` | `ref` | Focus element |
| `check` | `ref` | Check checkbox |
| `uncheck` | `ref` | Uncheck checkbox |
| `select` | `ref`, `values[]` | Select dropdown option(s) |
| `drag` | `src`, `dst` | Drag from one element to another |
| `upload` | `ref`, `files[]` | Upload files to file input |
| `scroll` | `direction`, `pixels?` | Scroll page (up/down/left/right) |
| `scrollintoview` | `ref` | Scroll element into viewport |

### Wait (1 command)

| Action | Parameters | Description |
|--------|-----------|-------------|
| `wait` | `ref?`, `text?`, `url?`, `ms?` | Wait for element, text, URL pattern, or fixed time |

### Tabs (4 operations)

| Action | Operation | Parameters | Description |
|--------|-----------|-----------|-------------|
| `tab` | `list` | — | List all open tabs |
| `tab` | `new` | `url?` | Open new tab |
| `tab` | `close` | `index?` | Close tab (current if no index) |
| `tab` | `switch` | `index` | Switch to tab by index |

### JavaScript (1 command)

| Action | Parameters | Description |
|--------|-----------|-------------|
| `eval` | `js: string` | Execute JavaScript in page context |

### Cookies & Storage (3 commands)

| Action | Operation/Params | Description |
|--------|-----------------|-------------|
| `cookies` | `operation: "get"` | Get all cookies |
| `cookies` | `operation: "set"`, `cookie: {...}` | Set a cookie |
| `cookies` | `operation: "clear"` | Clear all cookies |
| `storage` | `storageType: "local" \| "session"` | Read web storage |

### Batch (1 command)

| Action | Parameters | Description |
|--------|-----------|-------------|
| `batch` | `commands: string[]` | Execute multiple commands sequentially |

## Response Format

All commands return `BrowserResult<T>`:

```typescript
{
  success: boolean;
  data: T | null;      // Parsed data from agent-browser
  error: string | null; // Error message if failed
  hint: string | null;  // AI-friendly recovery suggestion
}
```

### Error Hints

When commands fail, the `hint` field provides actionable guidance:

| Error Pattern | Hint |
|--------------|------|
| Element not found | "Run a snapshot to get fresh element refs before interacting." |
| Multiple elements matched | "Run a snapshot with interactive mode to get more specific refs." |
| Not interactable | "Try scrolling it into view, closing any overlays, or waiting for animations." |
| Timeout | "The page may still be loading. Try waiting longer." |
| CDP connect failed | "Verify the browser container is running and the CDP endpoint is correct." |
| File not found | "Ensure the target directory exists." |
| Frame detached | "Run a snapshot to get the current page state." |

## File Structure

```
packages/browser/
├── src/
│   ├── index.ts              # Public exports
│   ├── types.ts              # BrowserCommand, BrowserResult, Profile types
│   ├── server.ts             # BrowserAgentServer (Express, cmdHandler factory)
│   ├── spawner.ts            # execCommand, execBrowserCommand, resolveCdpEndpoint
│   ├── parser.ts             # parseCommandResult + AI error hint generation
│   ├── profile-manager.ts    # In-memory profile CRUD
│   ├── main.ts               # Standalone server entry point
│   ├── examples/
│   │   └── cdp.ts            # Full example: navigate, snapshot, fill, search
│   └── tests/
│       ├── profile-manager.test.ts
│       ├── spawner.test.ts
│       ├── parser.test.ts
│       └── server.test.ts
├── docker/
│   ├── Dockerfile            # Debian + Chromium + Xvfb + noVNC + nginx
│   ├── nginx.conf            # CDP HTTP proxy with Host rewrite + WS support
│   └── entrypoint.sh         # Container startup script
├── docker-compose.yml        # Chrome container config
└── package.json
```

## Integration with apps/studio/server

This package is a library. Tool definitions for AI agents are created in `apps/studio/server`, not here. The typical integration:

```typescript
import { BrowserAgentServer, execBrowserCommand } from "@jiku/browser";

// Option A: Use the HTTP server
const server = new BrowserAgentServer({ port: 4100 });
await server.start();

// Option B: Use execBrowserCommand directly (no HTTP server needed)
const result = await execBrowserCommand("ws://localhost:9222", {
  action: "snapshot",
  interactive: true,
});
```

## Limitations

- **Single active tab** — agent-browser operates on the active tab. Two concurrent users on the same profile will conflict.
- **Stateless per command** — each command spawns a fresh CLI process. No persistent page state (console logs, network requests) between commands.
- **Ref staleness** — element refs from snapshots become invalid after DOM changes. Always re-snapshot after navigation.
