## Phase (2026-04-13) — Plan 22: Channel System v2 — SHIPPED

All 5 phases complete. End-to-end chain: Telegram group/topic → scope_key → scope conversation → AI → scope-aware reply. Inbound media now captured via event log (lazy fetch). Agents can publish to named Channel Targets. Binding editor exposes `scope_key_pattern`.

### Shipped
- [x] DB: migration `0018_plan22_channel_system_v2.sql` — `connector_scope_conversations`, `connector_targets`, `ALTER connector_bindings ADD scope_key_pattern`.
- [x] Types: `ConnectorEvent.scope_key`, `ConnectorEventMedia`, `ConnectorMediaItem`, `ConnectorContent.media_group/target_scope_key`, `ConnectorTarget.scope_key`, `ConnectorBinding.scope_key_pattern`, `ConnectorTargetRecord`, `ConnectorScopeConversationRecord`.
- [x] Kit: `ConnectorAdapter.computeScopeKey` / `targetFromScopeKey` optional methods.
- [x] DB queries: scope conversation CRUD + channel target CRUD + `getConnectorEventById`.
- [x] Event router: scope key injection (adapter-driven), scope-aware conversation resolution, `scope_key_pattern` filter in `matchesTrigger`, scope + media context in `buildConnectorContextString` (passes `eventId`).
- [x] TelegramAdapter: full rewrite — `computeScopeKey`/`targetFromScopeKey`, inbound thread_id + chat_type/title, `extractTelegramMedia` → DB metadata pipeline, `sendMessage` media/media_group/scope, 9 new actions (`fetch_media`, `send_media_group`, `send_url_media`, `send_to_scope`, `get_chat_members`, `create_invite_link`, `forward_message`, `set_chat_description`, `ban_member`).
- [x] Agent tools: `connector_list_targets`, `connector_send_to_target`, `connector_list_scopes`.
- [x] Server routes: `GET/POST/PATCH/DELETE /connectors/:id/targets`, `GET /connectors/:id/scopes`.
- [x] Web: `api.connectors.targets`/`scopes` clients; Targets card on connector detail; Scope Filter field on binding editor; `ConnectorTargetItem`/`ConnectorScopeItem`/`ConnectorBinding.scope_key_pattern` types.
- [x] Docs: ADR-056..059 logged; changelog updated.

### Relevant Files
- Plan: `docs/plans/22-channel-system-v2.md`
- DB: `apps/studio/db/src/schema/connectors.ts`, `apps/studio/db/src/queries/connector.ts`, `apps/studio/db/src/migrations/0018_plan22_channel_system_v2.sql`
- Types: `packages/types/src/index.ts`
- Kit: `packages/kit/src/index.ts`
- Server: `apps/studio/server/src/connectors/event-router.ts`, `apps/studio/server/src/connectors/tools.ts`, `apps/studio/server/src/routes/connectors.ts`
- Telegram: `plugins/jiku.telegram/src/index.ts`
- Web: `apps/studio/web/lib/api.ts`, `apps/studio/web/app/(app)/studio/companies/[company]/projects/[project]/channels/[connector]/page.tsx`, `apps/studio/web/app/(app)/studio/companies/[company]/projects/[project]/channels/[connector]/bindings/[binding]/page.tsx`

### Important Context
- Binary fs write uses the `__b64__:` string-prefix convention of `FilesystemService.write` — this is how xlsx/ods already roundtrip, so `fetch_media` reuses it rather than introducing a new binary API.
- `file_id` is Telegram-only valid-forever-per-bot, but `getFile()` URLs expire after 1h. That's why we fetch lazily, not eagerly.
- `scope_key_pattern` supports only prefix wildcards (`:*` suffix) and exact match — NOT regex — intentional simplicity.
- `touchScopeConversation` / `setScopeConversationId` are separate: touch updates last_activity_at only; setScopeConversationId binds a new conversation_id when the existing scope row has a null conversation.
- Migration journal (`meta/_journal.json`) is intentionally stuck at idx 2; the project runs migrations manually / via `db:push` — matches existing 0003-0017 precedent.

### Next Up
- Scope filter test scenarios in real Telegram supergroup with forum topics (manual QA).
- Consider a "live drafts" / incremental edit option for outbound long responses (currently sends final text after full stream drain).
- Approval system with inline buttons (explicitly deferred by plan).
