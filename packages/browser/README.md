# @jiku/browser

HTTP bridge server for [Vercel agent-browser](https://github.com/vercel-labs/agent-browser) CLI. Exposes a REST API that manages browser profiles (CDP connections) and proxies 30+ browser automation commands to the `agent-browser` binary with parsed responses and AI-friendly error hints.

## Architecture

```
Client  →  BrowserAgentServer (Express)  →  agent-browser CLI  →  Chrome (CDP)
                                                                      ↑
                                                              Docker container
                                                           (Chromium + noVNC + CDP)
```

- **CLI bridge**: every API call spawns `agent-browser --cdp <endpoint> --json <command>`
- **Parsed responses**: raw CLI JSON output is parsed into `BrowserResult<T>` with structured data + error hints
- **Profile store**: in-memory map of CDP connection configs
- **Docker**: Chromium with CDP on `:9222` and noVNC viewer on `:6080`

## Quick Start

```bash
# 1. Start the Chrome container
cd packages/browser
docker compose up -d

# 2. Start the server
bun run dev
```

Server listens on `http://localhost:4100`. NoVNC viewer at `http://localhost:6080`.

## Features

- 30+ browser commands covering navigation, interaction, observation, tabs, storage
- AI-friendly error hints for common failures (stale refs, timeouts, CDP issues)
- Parsed JSON responses — no raw stdout/stderr
- Profile management for multiple CDP connections
- Docker setup with Chromium + noVNC for visual debugging
- Auto CDP endpoint resolution (`ws://` → `http://`)
- Auto-connect on first use per endpoint

## Command Reference

### Navigation

| Command | Body | Description |
|---------|------|-------------|
| `open` | `{ url }` | Navigate to URL |
| `back` | `{}` | Go back |
| `forward` | `{}` | Go forward |
| `reload` | `{}` | Reload page |
| `close` | `{}` | Close session |

### Observation

| Command | Body | Description |
|---------|------|-------------|
| `snapshot` | `{ interactive?, compact?, selector?, depth? }` | Accessibility tree with element refs |
| `screenshot` | `{ path?, full?, annotate? }` | Capture screenshot |
| `pdf` | `{ path }` | Export as PDF |
| `get` | `{ subcommand, ref?, attr? }` | Query DOM (`text`, `html`, `value`, `attr`, `title`, `url`, `count`, `box`, `styles`) |

### Interaction

| Command | Body | Description |
|---------|------|-------------|
| `click` | `{ ref, newTab? }` | Click element |
| `dblclick` | `{ ref }` | Double-click |
| `fill` | `{ ref, text }` | Clear and type |
| `type` | `{ ref, text }` | Type without clearing |
| `press` | `{ key }` | Press key (`Enter`, `Tab`, `Control+a`) |
| `hover` | `{ ref }` | Hover element |
| `focus` | `{ ref }` | Focus element |
| `check` | `{ ref }` | Check checkbox |
| `uncheck` | `{ ref }` | Uncheck checkbox |
| `select` | `{ ref, values[] }` | Select dropdown option(s) |
| `drag` | `{ src, dst }` | Drag and drop |
| `upload` | `{ ref, files[] }` | Upload files |
| `scroll` | `{ direction, pixels? }` | Scroll (up/down/left/right) |
| `scrollintoview` | `{ ref }` | Scroll element into view |

### Wait

| Command | Body | Description |
|---------|------|-------------|
| `wait` | `{ ref?, text?, url?, ms? }` | Wait for condition |

### Tabs

| Command | Body | Description |
|---------|------|-------------|
| `tab` | `{ operation: "list" }` | List all tabs |
| `tab` | `{ operation: "new", url? }` | Open new tab |
| `tab` | `{ operation: "close", index? }` | Close tab |
| `tab` | `{ operation: "switch", index }` | Switch to tab |

### JavaScript

| Command | Body | Description |
|---------|------|-------------|
| `eval` | `{ js }` | Execute JavaScript |

### Cookies & Storage

| Command | Body | Description |
|---------|------|-------------|
| `cookies` | `{ operation: "get" }` | Get cookies |
| `cookies` | `{ operation: "set", cookie: {...} }` | Set cookie |
| `cookies` | `{ operation: "clear" }` | Clear cookies |
| `storage` | `{ storageType: "local" \| "session" }` | Read web storage |

### Batch

| Command | Body | Description |
|---------|------|-------------|
| `batch` | `{ commands: string[] }` | Execute multiple commands |

## API Endpoints

### Profiles

| Method | Endpoint | Description |
|--------|----------|-------------|
| `POST` | `/api/profiles` | Create profile `{ id, type: "cdp", config: { endpoint } }` |
| `GET` | `/api/profiles` | List all profiles |
| `GET` | `/api/profiles/:id` | Get profile |
| `PATCH` | `/api/profiles/:id` | Update profile config |
| `DELETE` | `/api/profiles/:id` | Delete profile |

### Browser Control

All browser commands are available as `POST /api/profiles/:id/<command>` with the command body. Or use the generic endpoint:

```
POST /api/profiles/:id/execute    # Body: full BrowserCommand object
```

### Health

```
GET /api/health
```

## Response Format

```json
{
  "success": true,
  "data": {
    "success": true,
    "data": { "title": "Google", "url": "https://google.com/" },
    "error": null,
    "hint": null
  }
}
```

On error:

```json
{
  "success": true,
  "data": {
    "success": false,
    "data": null,
    "error": "Element not found for ref @e5",
    "hint": "The element ref is no longer valid. Run a snapshot to get fresh element refs before interacting."
  }
}
```

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `BROWSER_AGENT_PORT` | `4100` | Server port |
| `BROWSER_AGENT_HOST` | `0.0.0.0` | Server host |
| `AGENT_BROWSER_BIN` | auto-resolved | Path to agent-browser binary |

## Docker (Chromium + noVNC)

```bash
docker compose up -d
```

- **CDP**: `ws://localhost:9222` — browser profile endpoint
- **noVNC**: `http://localhost:6080` — visual browser viewer

## Usage Example

```bash
# Create profile
curl -X POST http://localhost:4100/api/profiles \
  -H 'Content-Type: application/json' \
  -d '{ "id": "main", "type": "cdp", "config": { "endpoint": "ws://localhost:9222" } }'

# Navigate
curl -X POST http://localhost:4100/api/profiles/main/open \
  -H 'Content-Type: application/json' \
  -d '{ "url": "https://google.com" }'

# Snapshot (interactive elements only)
curl -X POST http://localhost:4100/api/profiles/main/snapshot \
  -H 'Content-Type: application/json' \
  -d '{ "interactive": true }'

# Fill search box (ref from snapshot)
curl -X POST http://localhost:4100/api/profiles/main/fill \
  -H 'Content-Type: application/json' \
  -d '{ "ref": "@e15", "text": "jiku ai" }'

# Press Enter
curl -X POST http://localhost:4100/api/profiles/main/press \
  -H 'Content-Type: application/json' \
  -d '{ "key": "Enter" }'

# Manage tabs
curl -X POST http://localhost:4100/api/profiles/main/tab \
  -H 'Content-Type: application/json' \
  -d '{ "operation": "new", "url": "https://example.com" }'

# Generic execute (any command)
curl -X POST http://localhost:4100/api/profiles/main/execute \
  -H 'Content-Type: application/json' \
  -d '{ "action": "eval", "js": "document.title" }'
```

## Programmatic Usage

```typescript
import { execBrowserCommand } from "@jiku/browser";

const result = await execBrowserCommand("ws://localhost:9222", {
  action: "snapshot",
  interactive: true,
});

if (result.success) {
  console.log(result.data); // { origin, refs, snapshot }
} else {
  console.log(result.error); // error message
  console.log(result.hint);  // AI-friendly recovery suggestion
}
```
