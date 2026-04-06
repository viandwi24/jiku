# Feature: Channels & Connector System (Plan 10 + polish)

## What it does

Connectors allow agents to receive input from and send output to third-party platforms (Telegram, Discord, etc.) in a unified way. All runs go through `runtime.run()` — no special paths. Binding rules route incoming events to specific agents and adapter types.

## Core Concepts

- **Connector** — plugin implementing `ConnectorAdapter` (e.g. `jiku.telegram`)
- **Binding** — routing rule: event from X connector → agent via `conversation` or `task` adapter type
- **Connector Identity** — external user ID (Telegram user_id) mapped to Jiku user. Status: pending → approved → blocked
- **User Identity Store** — structured key-value per user per project (not memory — machine-readable exact lookup)
- **Output adapter** — how response is delivered back: `conversation` (reply to user) or `task` (autonomous background run)

## Architecture

```
External event (Telegram message)
  → ConnectorPlugin.onEvent()
  → ConnectorEventRouter.routeConnectorEvent()
      → match bindings for (project, connector)
      → create/update connector identity
      → check approval + rate limit
      → log event
      → executeConversationAdapter() or executeTaskAdapter()
          → runtimeManager.run()
          → tee stream → streamRegistry
          → drain stream → send response via adapter
```

## Plugin Architecture

Connectors are plugins with `depends: [ConnectorPlugin]`:

```ts
// ConnectorPlugin (@jiku/plugin-connector)
contributes: () => ({ connector: { register: _registerFn } })

// TelegramPlugin (plugins/jiku.telegram)
depends: [ConnectorPlugin]
setup: (ctx) => {
  ctx.connector.register(telegramAdapter)
}
```

`ConnectorPlugin` uses a module-level `_registerFn` ref so `contributes()` and `setup()` share the same pointer (contributes runs before setup).

## Binding Schema

`output_adapter: string` + `output_config: jsonb`:
- Conversation: `output_config = { agent_id, conversation_mode? }`
- Task: `output_config = { agent_id }`

No `agent_id` at root — always inside `output_config`.

## Connector Tools (built-in, injected at wakeUp)

8 tools tagged `group: 'connector'`:
- `connector_get_events`, `connector_get_thread`
- `connector_send`, `connector_react`
- `connector_binding_update`
- `identity_get`, `identity_set`, `identity_find`

## Telegram Plugin Features

- MarkdownV2 parse mode + `telegramify-markdown` for safe escaping
- Multi-chunk: splits responses at newlines near 4000-char boundary
- Typing indicator: `sendTyping()` immediately + repeated every 4s via setInterval, cleared in finally
- Timezone context: `language_code` → timezone map (35+ locales) injected into connector context string
- `metadata.language_code` + `metadata.client_timestamp` sent on message events

## System Context Injection

`buildConnectorContextString()` in `event-router.ts` adds to system prompt:
- Server timestamp + timezone
- Estimated user local time (from `language_code` → `LANG_TO_TIMEZONE` map)
- Connector identity metadata

## Web UI Pages

6 pages under `/channels`:
- `channels/page.tsx` — connector overview cards with status badge
- `channels/new/page.tsx` — 2-step: select plugin → configure
- `channels/[connector]/page.tsx` — detail + bindings list
- `channels/[connector]/bindings/[binding]/page.tsx` — binding settings + identity approval
- `channels/[connector]/events/page.tsx` — event log + SSE live stream
- `channels/[connector]/messages/page.tsx` — inbound/outbound message log

## Related Files

- `plugins/jiku.connector/src/index.ts` — ConnectorPlugin
- `plugins/jiku.telegram/src/index.ts` — TelegramPlugin
- `apps/studio/db/src/schema/connectors.ts` — 7 tables
- `apps/studio/db/src/queries/connector.ts` — full CRUD
- `apps/studio/server/src/connectors/registry.ts` — ConnectorRegistry
- `apps/studio/server/src/connectors/event-router.ts` — ConnectorEventRouter
- `apps/studio/server/src/connectors/tools.ts` — 8 built-in tools
- `apps/studio/server/src/routes/connectors.ts` — API routes + webhook
- `apps/studio/web/app/.../channels/` — 6 UI pages
