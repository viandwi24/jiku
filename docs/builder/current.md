## Phase (2026-04-14) — Trigger modes + auto-register topics + group pairing UX — SHIPPED

Follow-ups to the connector binding + observability work:

1. **Proper `mention` + `reply` detection** — Telegram adapter caches `bot.api.getMe()` on activate. Message handler scans `msg.entities` + `msg.caption_entities` for `type='mention'` matching `@<botUsername>` and `type='text_mention'` with `user.id === botUserId`. Reply-to-bot check ignores synthetic forum-topic pointer. Flags exposed as `event.metadata.bot_mentioned` / `event.metadata.bot_replied_to`. `matchesTrigger` consults these; `reply` case added (was falling through). DMs implicitly pass.
2. **Customizable trigger_mode** — migration `0029_binding_trigger_custom.sql` adds `trigger_mention_tokens text[]`, `trigger_commands text[]`, `trigger_keywords_regex boolean`. `mention` supports custom tokens (substring); `command` supports whitelist with Telegram `/cmd@bot` format; `keyword` accepts regex. UI binding detail shows conditional fields per mode with examples.
3. **Group pairing UI — topic-aware name** — lazy group-pairing + `GroupPairingRow` now include topic label. Auto-generated `display_name = "Pending group pairing: <Chat> → <Topic>"`; UI splits into chat title + violet topic badge. Approve flow preserves topic suffix in final binding name.
4. **Forum topic auto-registration as connector_target** — first message in a forum topic with known title → adapter upserts target `name=<chat-slug>__<topic-slug>`, `display_name="<chat> → <topic>"`, `ref_keys={chat_id, thread_id}`, `scope_key=group:<id>:topic:<tid>`. Agents can now address specific topics by name via `connector_send_to_target`. Idempotent.
5. **Scope key format consistency fix** — `my_chat_member` channel/supergroup auto-register was using `scope_key='chat:<id>'`; `computeScopeKey` and inbound events use `group:<id>`. Mismatch split inbound vs outbound into separate scope conversations. Fixed: always `group:<id>`.

### Diagnosis notes (not shipped as code)

- `409 Conflict` on delete+recreate connector with same bot token was previously fixed (deactivate-before-delete + `deleteWebhook` + `close` pre-flight).
- New symptom diagnosed: if user DMs / chats during activation window, `drop_pending_updates: true` in `deleteWebhook` + `close` + `bot.start` can triple-drop the backlog → message lost, no pairing request. Proposed fix (not yet applied): set `drop_pending_updates: false`. Trade-off: on crash-restart, replays backlog. Defer to user decision.

Relevant files:
- `apps/studio/db/src/migrations/0029_binding_trigger_custom.sql`
- `apps/studio/db/src/schema/connectors.ts` — `trigger_mention_tokens`, `trigger_commands`, `trigger_keywords_regex` columns
- `apps/studio/db/src/queries/connector.ts` — createBinding/updateBinding signatures updated
- `apps/studio/server/src/connectors/event-router.ts` — matchesTrigger rewrite for all 5 modes, topic-aware lazy group-pairing draft
- `plugins/jiku.telegram/src/index.ts` — `getMe()` cache, entity-based mention detection, reply-to-bot check, topic target auto-register, `scope_key='group:<id>'` fix
- `packages/types/src/index.ts` — `ConnectorBinding.trigger_*` fields
- `apps/studio/web/lib/api.ts` — API type updates
- `apps/studio/web/app/(app)/studio/companies/[company]/projects/[project]/channels/[connector]/page.tsx` — GroupPairingRow splits chat/topic with violet badge
- `apps/studio/web/app/(app)/studio/companies/[company]/projects/[project]/channels/[connector]/bindings/[binding]/page.tsx` — conditional fields per trigger_mode

---

## Phase (2026-04-14) — Connector context + tools observability overhaul — SHIPPED

Beef up the context block and agent tools so agents can observe / act on connector traffic safely across multiple platforms. Incremental stack:

1. **Richer `[Connector Context]` block** — now explicitly carries Connector display_name (not just uuid), structured Chat line with chat_type + chat_title + chat_id + optional `→ topic "Name" (thread_id=X)`, Sender with @username + external user_id.
2. **XML-wrapped user input** — context = `<connector_context>…</connector_context>`, user text = `<user_message>…</user_message>`. Leader line in the context block instructs the model to treat user_message as untrusted (prompt-injection defence). Blank-line separator was fragile — a crafted message could spoof a fake `[Connector Context]` header.
3. **Internal DB ids injected** — `Internal event_id: <uuid>` + `Internal message_id: <uuid>` lines point to rows in our `connector_events` / `connector_messages` tables (distinct from platform ids in Chat ref). `logMsg` now runs BEFORE `buildConnectorContextString` so the inbound row id can be embedded. Queued messages also get their row written at enqueue time (previously never hit the messages table).
4. **Forum topic name extraction (Telegram)** — adapter pulls topic name from `forum_topic_created.name` / `forum_topic_edited.name` / synthesised `reply_to_message.forum_topic_created.name` into `event.metadata.thread_title`. Context renders as `→ topic "General" (thread_id=42)` instead of bare id.
5. **Expanded query tools** — `connector_get_events` / `connector_get_thread` take `connector_id`, `chat_id`, `thread_id`, `user_id` (events), `content_search` (ILIKE on `payload.content.text` / `content_snapshot`), `from`/`to` date, `cursor` (keyset pagination). Return `{ items, next_cursor }`.
6. **`connector_list_entities` tool** — AUTHORITATIVE discovery: distinct `chats` / `users` / `threads` with counts + labels (chat_title, username, thread_title) + last_seen. Agent calls this BEFORE paging events/messages when target ids aren't yet verified this turn.
7. **`connector_get_event` + `connector_get_message` by-id tools** — project-scoped lookup using internal UUIDs from the context block. Returns the full row including `raw_payload` so agents can mine Telegram entities / custom_emoji / reply chains.
8. **Enriched `connector_list_targets`** — each row now includes `{ connector: { id, plugin_id, display_name, status } }`; `connector_send_to_target` detects ambiguity and returns `AMBIGUOUS_TARGET` with candidates list rather than silently picking the first match.
9. **Sharpened tool prompts** — descriptions enforce "call `connector_list` fresh every iteration", "use `connector_list_entities` before observe/act (not `connector_list_targets` which is alias-only)", "NEVER fetch events/messages without at least one filter". Agent discipline is baked into the tool surface.
10. **Scope Lock UI — Thread ID picker** — binding detail card now has Chat ID + Thread ID inputs. Combined they write `scope_key_pattern='group:<chat_id>:topic:<thread_id>'` + `source_ref_keys={ chat_id, thread_id }`. Raw Scope Filter hints expanded with topic patterns (`group:<id>:*` for all topics, exact for one, etc.).

### Plus — two critical bug fixes during this push

11. **409 on delete+recreate connector** — `DELETE /connectors/:id` never called `deactivateConnector()` → orphan polling loop. Telegram's server-side long-poll slot lingered → `409 Conflict` on the new connector. Fix: deactivate BEFORE delete in the route; plus Telegram adapter pre-flights `deleteWebhook({drop_pending_updates:true}) + bot.api.close()` on activate to release any lingering slot.
12. **Queue sibling-branch race** (earlier in session, kept for reference) — `drainConnectorQueue` now awaits resolver + observer drain before releasing `runningConversations`.

### Design note — adapter portability (documented, not a code change)

This entire stack is adapter-agnostic. Telegram-specific bits live in `plugins/jiku.telegram/src/index.ts`; everything else consumes the `ConnectorEvent` / `ConnectorTarget` / `ConnectorSendResult` types. New adapters (WhatsApp, Discord, Slack) just implement `ConnectorAdapter` from `@jiku/kit`, normalize ref_keys to the project vocabulary (`chat_id`, `message_id`, `thread_id`, user_id via `sender.external_id`), populate `event.metadata.{chat_title, chat_type, thread_title}`, return `raw_payload` on inbound parse + outbound send. All UI + agent tools then work unchanged. See ADR-077 and `docs/feats/connectors.md`.

Relevant files:
- `apps/studio/server/src/connectors/event-router.ts` — context enrichment, XML wrap, internal id injection, logMsg reorder
- `apps/studio/server/src/connectors/tools.ts` — expanded events/thread tools, `connector_list_entities`, `connector_get_event`, `connector_get_message`, sharpened descriptions, cursor helpers
- `apps/studio/server/src/routes/connectors.ts` — `deactivateConnector` before `deleteConnector`
- `apps/studio/db/src/queries/connector.ts` — expanded `ListConnectorEventsOptions` / `ListConnectorMessagesOptions` filters, `listConnectorDistinctEntities`, `getConnectorMessageById`, project-scoped `getProjectConnectorEventById` / `getProjectConnectorMessageById`
- `plugins/jiku.telegram/src/index.ts` — forum topic name extraction; `deleteWebhook + close` pre-flight
- `apps/studio/web/app/(app)/studio/companies/[company]/projects/[project]/channels/[connector]/bindings/[binding]/page.tsx` — Thread ID input in Scope Lock card; expanded raw Scope Filter hints

---

## Phase (2026-04-14) — Connector binding semantics overhaul — SHIPPED

Fixed a serious multi-tenant leak in binding matching: a binding created for one user's DM could silently capture messages from unrelated users in a shared group. Landed as an incremental stack:

1. **Strict pairing approval** — `POST /connectors/:id/pairing-requests/:iid/approve` now creates a DM binding with `source_type='private'` + `source_ref_keys={ user_id: <identity.external> }`, locking to that one user.
2. **Event-router scope gate** — `matchesTrigger()` treats `source_ref_keys.user_id` against `event.sender.external_id`; implicit scope gate from `source_type` (`private` → require empty scope_key, `group`/`channel` → require non-empty). `any` kept for back-compat, flagged as unsafe in UI.
3. **`member_mode` column** on `connector_bindings` (`require_approval` default, `allow_all`) — new members in a group/channel scope become `pending` identities until admin approves. DM bindings ignore (already single-user). Migration `0028_binding_member_mode.sql`.
4. **UI** — binding detail: amber warning for `source_type='any'`, Source Ref Keys display, Member Mode picker, Scope Lock card (Chat ID input for group/channel, User ID input for private → writes both `scope_key_pattern` and `source_ref_keys` in one save).
5. **Group auto-pairing** — bot added to a Telegram group/supergroup via `my_chat_member` auto-creates a DRAFT binding (`enabled=false`, `scope_key_pattern='group:<id>'`). Admin approves via new "Group Pairing Requests" section → picks agent + member_mode → binding enabled.
6. **Lazy group-pairing** — if a group message arrives and no draft exists for that scope (bot added before hook existed), event-router creates the draft on first message. DM path still per-user pending identity.
7. **Reject fix** — `getPairingRequestsForConnector` now filters `status='pending'` too (was only `binding_id IS NULL`) so rejecting actually removes the row from the UI.
8. **Blocked identities cleanup UI** — new section listing `status='blocked'` rows with Unblock (→ pending) + hard-delete actions. Replaces the old "delete whole connector" workaround.
9. **Always log inbound messages** — even when no binding matches, a `connector_messages` row is written so traffic is observable + `connector_get_thread` agent tool sees it.
10. **Normalize message status vocabulary** — inbound statuses: `handled` / `unhandled` / `pending` / `dropped` / `rate_limited`; outbound: `sent` / `failed`. UI filter surfaces all.

Relevant files:
- `apps/studio/db/src/migrations/0028_binding_member_mode.sql`
- `apps/studio/db/src/schema/connectors.ts` — `member_mode` column
- `apps/studio/db/src/queries/connector.ts` — `getIdentityById`, `getBlockedIdentitiesForConnector`, `deleteIdentity`, `getConnectorTargetsEnriched`, `getConnectorTargetsByName`, `getPendingGroupPairings`, stricter `getPairingRequestsForConnector`
- `apps/studio/server/src/connectors/event-router.ts` — scope gate, member_mode gate, lazy group-pairing, normalized message statuses
- `apps/studio/server/src/routes/connectors.ts` — strict pairing approval, group-pairings CRUD, blocked-identities CRUD
- `plugins/jiku.telegram/src/index.ts` — `my_chat_member` auto-creates group draft; service-message filter in `bot.on('message')`; `raw_payload` on all polling handlers
- `packages/types/src/index.ts` — `ConnectorBinding.member_mode`, `ConnectorEvent.raw_payload`, `ConnectorSendResult.raw_payload`
- `apps/studio/web/app/(app)/studio/companies/[company]/projects/[project]/channels/[connector]/page.tsx` — Group Pairing Requests + Blocked Identities sections; GroupPairingRow component
- `apps/studio/web/app/(app)/studio/companies/[company]/projects/[project]/channels/[connector]/bindings/[binding]/page.tsx` — Scope Lock card, Member Mode picker, `any` warning
- `apps/studio/web/lib/api.ts` — `groupPairings`, `blockedIdentities` clients; `member_mode` on ConnectorBinding

---

## Phase (2026-04-14) — Filesystem: paginated fs_read + fs_append + version-bump fix — SHIPPED

Follow-ups to the read-before-write work:
- **fs_read pagination** (Claude-Code `Read` parity): `offset` + `limit` params, `cat -n` output format, per-line truncation at 2000 chars, response includes `total_lines` / `start_line` / `end_line` / `truncated` / `hint` telling the model how to page.
- **fs_append** — zero-overhead append-only tool. No read-gate. Server-side concat. Clears tracker after so next `fs_edit` forces a re-read.
- **Bug fix**: `upsertFile()` wasn't incrementing `version` on update; optimistic lock was effectively disabled. Now `version += 1` per write, `content_version += 1` only when `content_hash` (SHA-256 of content, computed in service.ts) changes.
- **Tool choice guide** in FS_WRITE_HINT: fs_append for append-only, fs_edit for partial edits, fs_write for new files / full rewrites.

Files: `apps/studio/db/src/queries/filesystem.ts`, `apps/studio/server/src/filesystem/{service.ts,tools.ts}`.

---

## Phase (2026-04-14) — Filesystem: read-before-write + stale detection + fs_edit — SHIPPED

Adopted Claude-Code-style file protection: `fs_write` / `fs_edit` require a prior `fs_read` of the path in the same conversation, and reject on external modification. New `fs_edit` tool does substring replacement — preferred over `fs_write` for partial changes (saves tokens + preserves rest of file verbatim).

Tracker persisted in new table `conversation_fs_reads` keyed by `(conversation_id, path)`; upsert on read, consult on mutate, drop on move/delete. Migration `0027_conversation_fs_reads.sql`.

Relevant files:
- `apps/studio/db/src/migrations/0027_conversation_fs_reads.sql`
- `apps/studio/db/src/schema/conversation-fs-reads.ts`
- `apps/studio/db/src/queries/conversation-fs-reads.ts` — `recordFsRead`, `getFsRead`, `forgetFsRead`, `pruneOldFsReads`
- `apps/studio/server/src/filesystem/tools.ts` — `checkReadGate` helper, new `fs_edit`, updated `fs_read`/`fs_write`/`fs_move`/`fs_delete`
- `docs/feats/filesystem.md`

---

## Phase (2026-04-14) — fix: spurious branch siblings in queued connector messages — SHIPPED

`drainConnectorQueue` released `runningConversations` before the previous run's stream finished draining, so the next queued `runtimeManager.run()` saved its user message against a stale `active_tip_message_id`. Fix: await both the resolver and the observer SSE branch before releasing. File: `apps/studio/server/src/connectors/event-router.ts`.

---

## Phase (2026-04-13) — Channels UI revision + event direction + raw_payload — SHIPPED

Follow-up to the channels tab refactor:
- `connector_events` now has `direction` (`inbound` | `outbound`) and `raw_payload` columns; `connector_messages` also has `raw_payload`. Migration `0026_connector_raw_payload.sql`.
- Outbound bot actions (send, run_action, auto-reply) are logged as outbound events with the platform response captured in `raw_payload`.
- Inbound webhook attaches the original webhook body to `event.raw_payload` before routing so the raw platform JSON (Telegram update etc.) is stored.
- Detail drawer shows a "Raw Payload (platform-side)" block alongside parsed payload/ref_keys/metadata.
- Events tab has a direction filter + per-row direction arrow.

---

## Phase (2026-04-13) — Channels UI revision (3-tab + project-level events/messages) — SHIPPED

Channels page is now tabbed: `Connectors | Messages | Events`. Tab state lives in URL (`?tab=...`). Messages and Events tabs each render a project-wide table (joined across all connectors in the project) with:
- Server-side keyset (cursor) pagination (`Load more`)
- Filters: connector, direction (msgs) / event_type (events), status, date range
- Row click → Sheet drawer with full payload/ref_keys/metadata
- Live SSE toggle (project-scoped stream, filter-aware)

Connector detail page Events/Messages buttons now redirect to the new tabs with `connector_id` pre-filtered. Old per-connector pages (`[connector]/events`, `[connector]/messages`) deleted.

Relevant files:
- `apps/studio/db/src/queries/connector.ts` — `listConnectorEventsForProject`, `listConnectorMessagesForProject` (keyset on `(created_at, id) DESC`)
- `apps/studio/server/src/connectors/sse-hub.ts` — project-level SSE pub/sub with filter matching
- `apps/studio/server/src/connectors/event-router.ts` — `logEv`/`logMsg` wrappers that broadcast after each insert
- `apps/studio/server/src/routes/connectors.ts` — `GET /projects/:pid/connector-events`, `connector-messages`, `+/stream`
- `apps/studio/server/src/middleware/auth.ts` — accepts `?token=` for SSE (EventSource can't set headers)
- `apps/studio/web/lib/api.ts` — `listProjectEvents`, `listProjectMessages`, `projectEventsStreamUrl`, `projectMessagesStreamUrl`
- `apps/studio/web/components/channels/{connectors,messages,events}-tab.tsx`
- `apps/studio/web/app/(app)/studio/companies/[company]/projects/[project]/channels/page.tsx` — tabbed shell
- `apps/studio/web/app/(app)/studio/companies/[company]/projects/[project]/channels/[connector]/page.tsx` — quick-nav buttons rewired

---

## Phase (2026-04-13) — Cron one-shot + archive — SHIPPED

Cron tasks now support `mode: 'once'` (one-shot, fires at `run_at`, auto-archives after success) alongside the existing `mode: 'recurring'`. Archived tasks are hidden from default lists and the scheduler; they remain in the DB for history/audit. No retry on failure (per spec). `cron_list` tool accepts `include_archived`; new `cron_archive`/`cron_restore` tools. REST routes: `POST .../archive`, `POST .../restore`, and `?status=archived` / `?include_archived=1` on list. UI: Active/Archived tabs on list page; mode picker (Recurring cron expression vs Once datetime-local) on create + detail pages.

Migration: `0025_cron_once_and_archive.sql` — adds `mode`, `run_at`, `status` columns; makes `cron_expression` nullable; indexes on `status` and `(project_id, status)`.

Relevant files:
- `apps/studio/db/src/migrations/0025_cron_once_and_archive.sql`
- `apps/studio/db/src/schema/cron_tasks.ts`
- `apps/studio/db/src/queries/cron_tasks.ts` — `archiveCronTask`, `restoreCronTask`, `CronTaskStatus`, `CronTaskMode`
- `apps/studio/server/src/cron/scheduler.ts` — `ScheduledJob` union (recurring Cron vs once setTimeout); auto-archive on once-success; past-due fires immediately
- `apps/studio/server/src/cron/tools.ts` — `cron_create` accepts `mode`/`run_at`; `cron_list` accepts `include_archived`; new `cron_archive`, `cron_restore`
- `apps/studio/server/src/runtime/manager.ts` — registers new tools (3 agent bootstrap sites)
- `apps/studio/server/src/routes/cron-tasks.ts` — `POST /archive`, `POST /restore`; list filter; PATCH accepts `mode`/`run_at`
- `apps/studio/web/lib/api.ts` — `CronTaskMode`, `CronTaskStatus`, `archive`/`restore`, list status filter
- `apps/studio/web/app/(app)/studio/companies/[company]/projects/[project]/cron-tasks/page.tsx` — Active/Archived tabs
- `.../cron-tasks/new/page.tsx` — mode picker
- `.../cron-tasks/[id]/page.tsx` — mode edit + archive/restore buttons + Archived badge

---

## Phase (2026-04-13) — Plan 23 Branch Chat — SHIPPED + post-ship fixes applied

Message-level branching for chat conversations (Claude.ai/ChatGPT-style edit + regenerate). Conversation id and URL stay stable; messages form a tree with `parent_message_id`, and conversation tracks `active_tip_message_id` server-side.

### Shipped this session
- [x] Migration `0024_plan23_branch_chat.sql`: adds `messages.parent_message_id` (self-FK CASCADE) + `messages.branch_index`; `conversations.active_tip_message_id` (FK SET NULL); backfill makes existing rows a single linear branch (`branch_index=0`, parent = previous-by-created_at). Indexes `idx_messages_parent`, `idx_messages_conv_parent`, `idx_conv_active_tip`. Per project convention the journal stays at idx 2 — SQL file is loaded by drizzle-migrator manually.
- [x] Drizzle schema (`apps/studio/db/src/schema/conversations.ts`) updated with `AnyPgColumn` self/cross references.
- [x] Query layer (`apps/studio/db/src/queries/conversation.ts`): `getActivePath`, `getMessagesByPath`, `getLatestLeafInSubtree`, `setActiveTip`, `addBranchedMessage` (single-tx insert + tip bump), `getMessageById`, `conversationHasBranching`. Active-path uses one recursive CTE with sibling sub-selects (ADR-069).
- [x] `StudioStorageAdapter` (`apps/studio/server/src/runtime/storage.ts`) implements optional branching methods. `Message` mapping now carries `parent_message_id` + `branch_index`; `Conversation` carries `active_tip_message_id`.
- [x] Runner (`packages/core/src/runner.ts`):
  - History load uses `getActivePathMessages` whenever conv has a tip set (chat) — falls back to flat `getMessages` (in-memory adapter, empty conv).
  - User msg → `addBranchedMessage(parent = params.parent_message_id ?? conv.active_tip_message_id)`. Assistant msg → `addBranchedMessage(parent = lastUserMessageId)`.
  - New `regenerate: true` mode skips user save and reuses the supplied `parent_message_id` as the existing user turn.
  - Compaction skipped when sibling-count > 1 anywhere (ADR-073).
- [x] HTTP routes:
  - `POST /chat` accepts optional `parent_message_id`.
  - `GET /messages` returns `{ conversation_id, active_tip_message_id, messages[…branch_meta] }` (falls back to flat list when no tip).
  - `GET /sibling-tip?sibling_id=` — latest-leaf descent (ADR-071).
  - `PATCH /active-tip { tip_message_id }` — switch tip (503 if running).
  - `POST /regenerate { user_message_id }` — re-run from a user message; new assistant becomes a sibling (409 if running).
- [x] Frontend `api.conversations`: extended `messages` return type + new `resolveSiblingTip`, `setActiveTip`, `regenerate`.
- [x] `ConversationViewer` carries `activeTip` + `branchMeta` map; `prepareSendMessagesRequest` injects `parent_message_id`; render loop shows inline `BranchNavigator` over any message with `sibling_count>1`; user msgs get a Pencil → `MessageEditInput` (edit creates a sibling branch); assistant msgs get a RefreshCw → calls `/regenerate` then polls `/status` until done.
- [x] Components `branch-navigator.tsx`, `message-edit-input.tsx`.
- [x] Types: `Message.parent_message_id` + `Message.branch_index`, `Conversation.active_tip_message_id`, `MessageWithBranchMeta`. `JikuRunParams.parent_message_id` + `regenerate`. `JikuStorageAdapter` optional branching methods.

### Post-ship fixes (same session)
- [x] First message disappeared after redirect from `/new` — mount-time hydration is meta-only now (no `setMessages` race with optimistic `useChat`).
- [x] Edit silently degraded to linear append — `branchMeta` refresh on stream-end transition + null/undefined preservation in chat route + defensive re-fetch in `submitEdit`.
- [x] Edit visually appended to old turn before branching — optimistic prune of `messages[idx..]` before `sendMessage`.
- [x] `BranchNavigator` moved into action bar inline (was above the message — bad UX).
- [x] Regenerate ran silently in background — wired `useLiveConversation` (start before fetch, drain `res.body` to release SSE backpressure, optimistic prune of old assistant).
- [x] Regenerate indicator vanished after one frame — added 8-second startup grace to `useLiveConversation` (tolerate `running:false` until `running:true` seen).
- [x] Regenerate fetch had no auth — routed through `BASE_URL` + `getAuthHeaders()`.
- [x] **Backend audit:** edit was leaking old M + reply into model context (runner walked `active_tip` even when `params.parent_message_id` overrode it). Fix: walk `getMessagesByPath(params.parent_message_id)` when override is supplied.
- [x] **Backend audit:** regenerate duplicated the user message in model context. Fix: skip `input.push` when `params.regenerate === true`.
- [x] **Compaction redesigned (ADR-073 revised):** branch-aware + append-only via `addBranchedMessage` + `[Context Summary]` checkpoint; reuse existing `applyCompactBoundary`. Skip on explicit fork / regenerate. Threshold + preview accounting now per-active-branch.

### Migration state
- `0023` — DROP COLUMN connector_bindings.simulate_typing (Plan 22 rev 3)
- `0024` — Plan 23 message-level branching

### Relevant Files
- Plan: `docs/plans/23-branch-chat.md`
- Migration: `apps/studio/db/src/migrations/0024_plan23_branch_chat.sql`
- DB schema: `apps/studio/db/src/schema/conversations.ts`
- DB queries: `apps/studio/db/src/queries/conversation.ts`
- Storage adapter: `apps/studio/server/src/runtime/storage.ts`
- Runner: `packages/core/src/runner.ts`
- Server routes: `apps/studio/server/src/routes/{chat,conversations}.ts`
- Types: `packages/types/src/index.ts`
- Web API client: `apps/studio/web/lib/api.ts`
- Web UI: `apps/studio/web/components/chat/{conversation-viewer,branch-navigator,message-edit-input}.tsx`
- Decisions: `docs/builder/decisions.md` (ADR-067 … ADR-073)

### Important Context
- Branching is **implicit** — no dedicated `/branch` endpoint. Sending a message with a `parent_message_id` that already has children automatically creates a sibling (ADR-070).
- `branch_index` is computed inside `addBranchedMessage` (`MAX(siblings)+1`) — never trust client-supplied values.
- `sibling_count` query uses `IS NOT DISTINCT FROM` so `parent_message_id IS NULL` (root messages) compare correctly.
- The runner only switches to active-path loading when `conversation.active_tip_message_id` is set AND the storage exposes `getActivePathMessages`. Empty/legacy conversations (where backfill ran but tip is somehow null) fall back to flat — safe.
- Branch switch / regenerate / edit are all disabled in the UI during `streaming|submitted` and rejected server-side with 503/409 while `streamRegistry.isRunning` (ADR-072). Don't try to make this concurrent without a serious think — assistant rows would race.
- Compaction is **disabled** on any conversation with branching present. Re-enabling requires deciding which branch's summary survives. Tracked in Next Up.
- TS errors visible in pre-existing files (`req.params: string|string[]`, `Record<string, unknown>` → `StreamChunk` casts) are project-wide pre-existing — Plan 23 followed the same patterns and added no new error categories. Web app TS = 0 errors.

### Implementation report
- `docs/plans/impl-reports/23-branch-chat-implementation-report.md`

### Next Up
- E2E coverage for edit / regenerate / multi-branch navigation / root-message edit / non-tip regenerate.
- QA: long compaction-crossing conversation under branching — verify each branch carries its own checkpoint and switching is coherent.
- Sidebar "(branched)" indicator on conversation list (needs cheap `has_branches` check; either denormalized boolean kept in sync via insert trigger or a per-row check on project list).
- Toast UI for branch-switch / regenerate / edit failures (currently `console.error`). Wait for project-wide toast pick.
- Visual hint for messages on a non-default branch (border/badge when current_sibling_index > 0).
- Keyboard arrows on `BranchNavigator`.
- Resolve the long-standing pre-existing TS errors flagged in Plan 22 rev 3's "Next Up".
