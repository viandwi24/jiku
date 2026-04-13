# Feature: Channels & Connector System (Plan 10 + Plan 22 revision)

## What it does

Connectors allow agents to receive input from and send output to third-party platforms (Telegram, Discord, etc.) in a unified way. All runs go through `runtime.run()` — no special paths. Binding rules route incoming events to specific agents and adapter types.

## Channels UI revision (2026-04-13)

- **Project channels page is tabbed**: `Connectors | Messages | Events`. Tab + filters live in URL search params (`?tab=events&connector_id=...`).
- **Project-level paginated lists** with cursor (keyset on `(created_at, id) DESC`) + filters (connector, direction, event_type|—, status, date range): `GET /projects/:pid/connector-events`, `GET /projects/:pid/connector-messages`. Cursors are base64(`<iso>|<uuid>`).
- **Project-level SSE streams** (`/stream` suffix) with same filters; `sse-hub.ts` is a shared in-memory pub/sub. Broadcast happens after each insert in `event-router.ts` (via `logEv`/`logMsg` wrappers) and `tools.ts` (after `connector_send` / `connector_run_action`). EventSource auth via `?token=` query (added to `authMiddleware`).
- **Events have direction** (`inbound` | `outbound`). Outbound entries are written for bot-initiated sends (event_type = `send_message`) and `runAction` calls (event_type = action id, e.g. `send_reaction`). DB column added with default `'inbound'`; old rows are inbound by definition.
- **Raw payload preserved** on both events and messages (`raw_payload jsonb`). Inbound: webhook handler stores `req.body` on `event.raw_payload` before routing. Outbound: adapter `sendMessage`/`runAction` results captured. Visible in the detail Sheet drawer.
- **Connector detail Events/Messages buttons** redirect to channels?tab=…&connector_id=…; old per-connector pages removed.

## Plan 22 additions (2026-04-13)

- **`scope_key` conversation isolation** (ADR-056): multi-chat platforms (Telegram groups, forum topics) now get per-scope conversations. DMs keep using `identity.conversation_id`. New table `connector_scope_conversations(connector_id, scope_key, agent_id, conversation_id)`.
- **Named Channel Targets** (ADR-057): `connector_targets` table + REST CRUD + agent tools `connector_list_targets / connector_send_to_target / connector_list_scopes / connector_create_target / connector_update_target / connector_delete_target / connector_save_current_scope`. Agents can register destinations by name and address them from cron tasks.
- **Media pipeline via event log** (ADR-058): `ConnectorEventMedia` carries metadata only (type, name, mime, size); `file_id` stored in `connector_events.metadata`. Agent fetches via `connector_run_action("fetch_media", { event_id, save_path })`. Lazy-fetch, restart-safe, auditable.
- **Scope filter on bindings** (ADR-059): `connector_bindings.scope_key_pattern` (`null` / `group:*` / `dm:*` / exact / `group:X:topic:N`). Prefix wildcard only.
- **TelegramAdapter overhaul**: `computeScopeKey / targetFromScopeKey`, `thread_id` + `chat_type` + `chat_title` in inbound events, 9 new actions (`fetch_media`, `send_media_group`, `send_url_media`, `send_to_scope`, `get_chat_members`, `create_invite_link`, `forward_message`, `set_chat_description`, `ban_member`), `sendMessage` media / media_group / scope support.
- **`/reset` command** intercepted in event-router: clears current scope's `conversation_id` (DM = identity; group/topic = scope row). History preserved.
- **Streaming typing simulation (Telegram)** per-send via `ConnectorContent.simulate_typing` (ADR-065). Auto-reply defaults true; agent tools default false. Progressive reveal in 3 stages with `\n\n⚪` indicator at 2-second intervals.
- **Connector usage log parity**: `event-router` captures `data-jiku-usage` + `data-jiku-meta` + `data-jiku-run-snapshot` chunks and calls `recordLLMUsage({ source: 'chat' })` — Telegram conversations now appear in Usage Log.
- **Audit log actor guard**: non-UUID actor ids (`connector:<uuid>`) nulled, preserved in `metadata.actor_label`, `actor_type` set to `'connector'`.
- **Enriched `[Connector Context]` string**: now includes `Connector ID`, `Chat ref: chat_id=..., thread_id=...`, `Chat scope`, `Chat: <title> (<type>)`, plus a `Media available: ... event_id: "..."` hint when inbound contains media.
- **Agent-side Target CRUD**: `connector_create_target / connector_update_target / connector_delete_target / connector_save_current_scope` let agents register their own destinations without admin setup.
- **Telegram `editMessage`** now respects markdown (parse_mode MarkdownV2 + escape via telegramify-markdown).

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
