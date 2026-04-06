# Feature: Browser Automation (Plan 13)

## What it does

Per-project browser automation. Agents can control a Chromium browser via a single `browser` tool. Supports navigation, snapshots, screenshots, element interaction (click/type/hover/drag), tab management, console logs, PDF export, file upload, and dialog handling.

Enabled per-project via settings. When `browser_enabled = true`, a dedicated browser server (HTTP control server backed by Playwright) starts at `wakeUp()` and is injected as a `built_in_tool` on all agents.

## Architecture

```
RuntimeManager.wakeUp()
  ↓ check project.browser_enabled
  ↓ startBrowserServer(projectId, config)
      → Express server on 127.0.0.1:{port}
      → stored in projectBrowserServers Map
  ↓ buildBrowserTools(handle.baseUrl)
      → returns single 'browser' ToolDefinition
  ↓ injected as built_in_tools on all agents
```

Engine is an adapted port of OpenClaw browser engine (`~80 files`) living in:
```
apps/studio/server/src/browser/
  browser/           ← ported OpenClaw engine (don't modify)
  config/            ← OpenClaw config types
  gateway/           ← net helpers
  infra/             ← port/ws utilities
  security/          ← external-content wrapper
  tool-schema.ts     ← Zod schema for browser tool input
  node-server-entry.ts  ← entry for startBrowserControlServer()
```

## Public API (Tool)

Single tool: `browser` with `action` field:

| Action | Description |
|--------|-------------|
| `status` | Check browser server + active sessions |
| `start` | Launch a browser profile |
| `stop` | Close a browser profile |
| `profiles` | List available profiles |
| `tabs` | List open tabs |
| `open` | Open new tab at URL |
| `focus` | Focus a tab |
| `close` | Close tab or browser |
| `navigate` | Navigate current tab to URL |
| `snapshot` | Read page DOM/ARIA structure |
| `screenshot` | Capture screenshot (PNG/JPEG) |
| `console` | Get console log messages |
| `pdf` | Export page as PDF |
| `upload` | Trigger file chooser |
| `dialog` | Handle browser dialogs |
| `act` | Perform UI interactions (click/type/press/hover/drag/fill/etc.) |

## Configuration (DB)

`projects.browser_enabled boolean` + `projects.browser_config jsonb`:

```typescript
type BrowserProjectConfig = {
  headless?: boolean          // default: true
  executable_path?: string
  control_port?: number       // default: 8399
  timeout_ms?: number         // default: 30000
  no_sandbox?: boolean        // for Docker/Linux
  evaluate_enabled?: boolean
}
```

## API Routes

```
GET  /api/projects/:pid/browser         → config + running status
PATCH /api/projects/:pid/browser/enabled → toggle (restarts runtime)
PATCH /api/projects/:pid/browser/config  → update config
```

## Web UI

- `apps/studio/web/app/.../browser/page.tsx` — settings page with enable toggle, status badge, config form
- Sidebar: "Browser" nav item in project sidebar

## Known Limitations

- Host mode only (Playwright on server) — Chrome extension relay (profile=chrome) not yet supported
- One browser server per project; port allocation is sequential offset from `control_port`
- Requires Playwright: `bun x playwright install chromium` on server host
- No browser session persistence across project sleep/wake cycles

## Related Files

- `apps/studio/server/src/browser/` — engine
- `apps/studio/server/src/routes/browser.ts` — routes
- `apps/studio/server/src/runtime/manager.ts` — lifecycle integration
- `apps/studio/db/src/schema/projects.ts` — browser_enabled + browser_config columns
