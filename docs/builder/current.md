## Phase
Idle — Plan 10 complete

## Currently Working On
- Nothing active.

## Relevant Files
- (none active)

## Important Context / Temporary Decisions
- Connector system uses in-memory rate limiting (not Redis) — sufficient for single-server.
- SSE auth uses token as query param (EventSource doesn't support custom headers).
- `telegramConnectorAdapter` is a named export from the telegram plugin so it can be registered directly in the server registry.
- `defineConnector()` calls `connector:register` hook but the registry wiring is done directly in server bootstrap (not via hooks) for simplicity.

## Next Up
- DB migration: `bun run db:push` — applies all new connector tables + persona columns
- Test: add a Telegram connector in the UI, create a binding, watch events flow
- Plan 11 (Heartbeat mode) or backlog items
