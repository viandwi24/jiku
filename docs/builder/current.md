## Phase
Post Plan 10/11 — Connector system polish (parallel track) + core runtime improvements

## Currently Working On
- All core runtime improvements completed (tool persistence, real-time, get_datetime, Telegram context).
- Channels & Connector system polish continues as a parallel track.

## Relevant Files (Core track — recently completed)
- `packages/core/src/runner.ts` — tool parts now saved to DB (all steps, tool-invocation parts with state:'result'); history loading reconstructs tool/assistant model messages
- `apps/studio/server/src/runtime/stream-registry.ts` — added `buffer[]` per active run + `bufferChunk()` + `getBuffer()`
- `apps/studio/server/src/routes/chat.ts` — `GET /conversations/:id/live-parts` endpoint; `bufferChunk` wired in drain loop
- `apps/studio/server/src/connectors/event-router.ts` — registers to streamRegistry, tees stream; timezone context injection; `LANG_TO_TIMEZONE` map
- `apps/studio/server/src/system/tools.ts` *(new)* — `get_datetime` system tool
- `apps/studio/server/src/runtime/manager.ts` — `systemTools` injected first in all agents
- `plugins/jiku.telegram/src/index.ts` — emits `metadata.language_code` + `metadata.client_timestamp` on message events
- `apps/studio/web/hooks/use-live-conversation.ts` *(new)* — polling hook for readonly/run-detail pages
- `apps/studio/web/components/chat/conversation-viewer.tsx` — uses `useLiveConversation` in readonly mode

## Relevant Files (Connector track — parallel)
- `plugins/jiku.connector/src/index.ts` *(new)* — `@jiku/plugin-connector` contributes `ctx.connector.register()`
- `plugins/jiku.telegram/src/index.ts` — depends on `@jiku/plugin-connector`, uses `ctx.connector.register()`; markdown via `telegramify-markdown`, multi-chunk long messages
- `apps/studio/server/src/index.ts` — registers `ConnectorPlugin` before `TelegramPlugin`
- `apps/studio/db/src/schema/connectors.ts` — `output_adapter + output_config` jsonb (no `agent_id` at root)
- `apps/studio/server/src/connectors/event-router.ts` — typing indicator (setInterval 4s), `output_adapter/output_config` flow
- `apps/studio/server/src/routes/connectors.ts` — pairing approve uses `output_adapter + output_config`
- `apps/studio/web/lib/api.ts` — `ConnectorBinding` uses `output_adapter + output_config`; `ConversationOutputConfig` / `TaskOutputConfig`

## Important Context / Temporary Decisions
- Tool persistence: uses `result.steps` (not `result.text`) to collect all steps' toolCalls+toolResults. Each step emits tool-invocation parts then a text part. Single `addMessage` call with all parts at end of run.
- History reconstruction: assistant messages with tool parts → `{ role: 'assistant', content: [text-call, tool-call, ...] }` + `{ role: 'tool', content: [tool-result, ...] }` per AI SDK `ToolContent` type.
- Live-parts buffer: in-memory only (no DB writes per chunk). Clients poll at 400ms. `autoDetect` polls `/status` every 2s to start polling when a run begins (handles pre-opened tabs).
- Connector timezone: `LANG_TO_TIMEZONE` map in event-router covers 35+ locales. `buildConnectorContextString` adds server time + estimated user local time to system context.
- `ConnectorPlugin` uses a module-level mutable ref `_registerFn` so `contributes()` closure and `setup()` share the same pointer — required because `contributes()` runs before `setup()`.
- Zod standardized on v3.25.76 across all workspace packages (hoisted via root `package.json`).
- Telegram: `MarkdownV2` parse mode + `telegramify-markdown`. Chunk limit 4000 chars.
- `sendTyping` repeats every 4s with `setInterval`, cleared in `finally` block.
- `output_config` jsonb — `agent_id` + optional `conversation_mode` for conversation adapter.
- `jiku.connector.telegram` (old plugin dir) superseded by `jiku.telegram`.

## Next Up
- DB migration: `cd apps/studio/db && bun run db:push` (applies `persona_prompt` column)
- Verify Telegram bot end-to-end: send message → typing indicator → get_datetime tool call → tool shown in chat history after refresh
