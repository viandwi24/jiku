# Console

Live in-process log streams for plugin/adapter instances. Read-only for the UI. Session-scoped — logs clear on server restart.

## What it does

Any plugin code can push structured log lines to a named console. The Studio UI can render those lines live via SSE, with pagination back into a tempfile for history beyond the in-memory window.

Primary consumer: Telegram bot + userbot adapters, surfaced in the Channels → Connectors tab via a "Console" button per connector.

## Architecture

- **Registry** (`apps/studio/server/src/console/registry.ts`): per-id state carrying a 100–200 entry ring buffer, an NDJSON tempfile handle, observer set for SSE. On server start the entire `os.tmpdir()/jiku-console/` dir is wiped.
- **Storage model**: memory oscillates between 100 and 200 entries. When ring hits 200, oldest 100 are batched into `appendFile` → ring keeps newest 100. File rotates at 10MB (one `.log.1` backup).
- **Routes** (`apps/studio/server/src/console/router.ts`):
  - `GET /api/console/:id/snapshot` — returns the ring (up to ~200 newest entries).
  - `GET /api/console/:id/history?before_ts=<ms>&limit=100` — reverse-scans the tempfile.
  - `GET /api/console/:id/stream` — SSE live tail (auth via `?token=`).
- **Plugin API** (`ctx.console`): exposed via `@jiku-plugin/studio` contributes. `ctx.console.get(id, title?)` returns a `PluginConsoleLogger` with `info/warn/error/debug(msg, meta?)`.
- **UI** (`apps/studio/web/components/console/console-panel.tsx`): `<ConsolePanel consoleId="..." />`. Loads snapshot, subscribes SSE, reverse-paginates on scroll, level filter + pause/clear controls.

## ID convention

`<plugin_id>:<scope>:<instance_id>` — e.g. `jiku.telegram.bot:connector:7c4e2...`. Shared across backend + frontend. For Telegram, helpers `botConsoleId(connectorId)` and `userConsoleId(connectorId)` are exported from the plugin.

## UI surfaces

Three places a user can see a console:
1. **Project-level page** (`/console`): lists every active console scoped to the current project's connectors, with live indicator + filter. Sidebar entry under "Config". Gated by `console:read`. Picking a session renders the panel on the right.
2. **Connector detail page** (`/channels/[id]`): embeds the console inline as a terminal-styled block (black bg / green text via `<ConsolePanel variant="terminal" />`). No Sheet / Drawer — always visible when the page is open.
3. **Programmatic** via `<ConsolePanel consoleId="..." />` — any other page can drop the panel in.

`<ConsolePanel>` props: `consoleId` (required), `title?`, `height?` (number or CSS string, default 420), `variant: 'default' | 'terminal'`. Snapshot + SSE + history pagination are all internal.

## Wiring a new plugin

1. In the adapter class, add `attachConsole(api: PluginConsoleAPI)` and a `private con(id): PluginConsoleLogger | null` resolver.
2. In the plugin `setup(ctx)`, call `adapter.attachConsole(ctx.console)` BEFORE `ctx.connector.register(adapter)`.
3. Emit from key lifecycle points: activate/deactivate, inbound ingest, outbound send success/failure, queue events (flood wait, retry, latched conditions).

## Known limitations

- **Session-scoped only**: logs are lost on server restart. For audit trails use `connector_events` / `logConnectorEvent`.
- **No server-side filtering**: snapshot returns the whole ring; UI filters by level client-side. Fine for 200 entries; would be inefficient if we raise the ring cap.
- **No in-place level gating**: every call serializes + broadcasts. Don't log hot-path per-byte; log events/decisions.
- **Per-process**: doesn't survive failover or multi-instance deploys. Would need a broker (Redis pubsub) if the Studio runs multi-replica.

## Related files

- `apps/studio/server/src/console/registry.ts`
- `apps/studio/server/src/console/router.ts`
- `apps/studio/server/src/plugins/ui/context-extender.ts`
- `plugins/jiku.studio/src/types.ts`
- `apps/studio/web/components/console/console-panel.tsx`
- `apps/studio/web/lib/api.ts` (`api.console`)
- `apps/studio/web/components/channels/connectors-tab.tsx` (Console button)
- `plugins/jiku.telegram/src/bot-adapter.ts`, `user-adapter.ts` (first consumer)
