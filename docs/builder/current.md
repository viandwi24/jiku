## Phase (2026-04-16) — Telegram: inbound album debounce + outbound single/album parity + file_id reuse ✅

Three stacked user asks in one pass:

1. **Inbound album debounce (bot)** — N-per-album `message` updates batched to ONE event after 5s silence. `content.media_items[]` (public) + `metadata.media_items[]` (per-item file_id etc.) + `metadata.media_group_id`. `fetch_media` gained `index` param. See ADR-103.
2. **Outbound single/album parity** — bot gained `send_video`; userbot gained `send_video` + `send_media_group`. Agent can now pick single-photo / single-video / album / mixed across either adapter.
3. **file_id source support** — `send_photo`/`send_video`/`send_file`/`send_document` + `send_media_group` items now accept `file_id` as an alternative source to `url` / `file_path`. Enables re-sending media the adapter saw earlier WITHOUT re-upload. `ConnectorMediaItem` extended with `file_id?`.

file_id capture (user concern, confirmed intact):
- Inbound single: `metadata.media_file_id` + `raw_payload.message.photo[].file_id` (or document/video).
- Inbound album: `metadata.media_items[].media_file_id` + `metadata.media_file_id` (back-compat, item[0]) + `raw_payload.updates[].message.*.file_id`.
- Public `content.media*` deliberately omits file_id per ADR-058.

Verified typecheck: all newly-introduced code typechecks cleanly. Pre-existing errors in `bot-adapter.ts:1952-1956` (`runSnapshot` never-inference) + `user-adapter.ts:181/524/746/947` (mtcute type drift) are unrelated.

### Files touched
- `packages/types/src/index.ts` — `ConnectorEvent.content.media_items?[]`, `ConnectorMediaItem.file_id?`.
- `plugins/jiku.telegram/src/shared/constants.ts` — `MEDIA_GROUP_DEBOUNCE_MS=5000`.
- `plugins/jiku.telegram/src/shared/helpers.ts` — `extractTelegramMedia` returns `mediaGroupId`.
- `plugins/jiku.telegram/src/bot-adapter.ts` — buffer + flush + `autoRegisterForumTopic` helper + `send_video` + url/file_id alt sources + `fetch_media({index})`.
- `plugins/jiku.telegram/src/user-adapter.ts` — `send_video` + `send_media_group` + file_id alt sources, `resolveMediaInput` shared helper.
- `apps/studio/server/src/connectors/event-router.ts` — group vs single media hint.
- Docs: `changelog.md`, `decisions.md` (ADR-103), `tasks.md`, `feats/connectors.md`.

### Follow-ups (on tasks.md)
- Userbot inbound album debounce (mtcute `grouped_id`).
- `fetch_all_media({event_id, save_dir})` convenience tool so agent doesn't loop `fetch_media({index})` itself.

## Phase (2026-04-15) — Disk: ZIP + drag-drop move + full folder ops parity ✅

Multi-pass evolution of the `/disk` feature based on field-test feedback:

1. **ZIP export/import.** New `apps/studio/server/src/filesystem/zip.ts` (deps: `jszip` — run `bun install`). Export: `POST /files/export-zip` body `{ paths: string[] }` — returns ZIP stream with binary files decoded back to raw bytes via `__b64__:` prefix detection, AND empty folder markers via `project_folders` query so empty subdirs survive the round-trip. Import: `POST /files/import-zip?path=&conflict=` with conflict ∈ `{overwrite, skip, rename}` (rename suffixes ` (1)`, ` (2)`, …). Per-entry allow-list + path-traversal guard; caps `MAX_ZIP_BYTES=50MB`, `MAX_ZIP_ENTRIES=5000`.
2. **ZIP import junk filter (field bug).** macOS Finder zips emit `__MACOSX/` resource forks + `._<file>` AppleDouble files containing null bytes that crash Postgres TEXT inserts. New `isPlatformJunk(entryPath)` silently drops `__MACOSX/*`, `.DS_Store`, `Thumbs.db`, `desktop.ini`, `._*`. Counter `skipped_junk` surfaced in UI for transparency. Defense-in-depth: explicit null-byte check before DB write rejects any text-mode entry containing `\u0000`. ADR-102.
3. **Empty folders round-trip.** Import processes dir entries (`.dir === true`) BEFORE files via `fs.mkdir`. Export queries `project_folders` for each requested root and emits trailing-slash `zip.folder()` markers.
4. **Drag-and-drop move (replaces dialog).** Entry rows are `draggable`; folder entries + breadcrumb segments are drop targets. Visual feedback: ring-2 primary highlight on drop target, `opacity-40` on dragged row. `canDropAt` guard rejects self / current-parent / folder-into-descendant. Toast distinguishes "Renamed" vs "Moved" by comparing `dirOf(from)` vs `dirOf(to)`.
5. **Folder move support.** `FilesystemService.move()` now detects file vs folder; folder branch walks every descendant file + nested folder row (`getFilesUnderFolder` + direct `project_folders` query) and rewrites paths/parent_path/depth in single transaction. Storage layer untouched (UUID-based keys are immutable).
6. **Agent FS tools full folder parity.** New `fs_mkdir` agent tool (idempotent empty-folder create). `fs_move` description updated for folder support; tracker cleanup uses new `forgetFsReadsUnderPrefix(conversationId, fromPath)` so descendants don't carry stale `STALE_FILE_STATE`. `fs_delete` extended with file-vs-folder dispatch; folder deletes require explicit `{ recursive: true }` flag (returns `FOLDER_DELETE_REQUIRES_RECURSIVE` otherwise — safety guard against LLM wipes). New DB queries: `getFolderByPath`, `forgetFsReadsUnderPrefix`. ADR-101.

Project invariant established (ADR-101): the virtual disk simulates a real filesystem — every file op has a folder counterpart in BOTH UI + agent tools, with root `/` as the only un-mutable path. Future FS-mutating tools / UI actions MUST audit folder support before shipping.

Deploy: run `bun install` at repo root to pick up `jszip` dep.

Files: `apps/studio/server/package.json` (+jszip), `apps/studio/server/src/filesystem/{zip.ts (new), service.ts, tools.ts}`, `apps/studio/server/src/routes/filesystem.ts` (+2 routes), `apps/studio/db/src/queries/{filesystem.ts (+getFolderByPath), conversation-fs-reads.ts (+forgetFsReadsUnderPrefix)}`, `apps/studio/web/lib/api.ts` (+2 methods), `apps/studio/web/components/filesystem/file-explorer.tsx` (toolbar buttons, dropdown items, drag-drop handlers, ImportZipDialog).

## Phase (2026-04-15) — Chat UI: active_command accordion + collapsible sub-sidebar ✅

Three chat UI tasks in same pass:

1. **`<active_command>` accordion shared + streaming-aware.** Conversation viewer (history view) rendered user messages as raw `<span>{text}</span>` so the dispatcher's `<active_command slug="...">...</active_command>` wrapper leaked as XML. Extracted `MessageTextWithActiveCommands` + `ActiveCommandBlock` + streaming-aware parser to `apps/studio/web/components/chat/active-command-block.tsx`. Used by both `chat-interface.tsx` (replaced local duplicate) and `conversation-viewer.tsx`. Streaming: opening tag without a close yet renders the same accordion chip with a pulsing amber dot + "streaming" label and a trailing `…` inside the body preview.

2. **Parser greedy-close fix (field bug).** Lazy first-match parser was bounded by the literal `</active_command>` substring that the dispatcher embeds INSIDE the body preamble (describing where the trigger text appears). Body got truncated at the fake-close, real SOP spilled outside the accordion. Two-layer fix: (a) parser uses `lastIndexOf(CLOSE_TAG)` capped at the next opening tag; (b) dispatcher rephrases the preamble to avoid the literal close-tag string. Old DB rows render correctly via the parser fix. See ADR-100.

3. **Collapsible chat sub-sidebar with mobile default.** `chats/layout.tsx` was a fixed `w-72` rail. Now togglable via header button (in panel) + floating `PanelLeftOpen` button (over chat area when collapsed). State persisted in `localStorage['chats.sidebar.open']`. Default: open on ≥768px viewport, closed on <768px. `ConversationListPanel` gained optional `onCollapse` prop.

## Phase (2026-04-15) — Connector traffic_mode (inbound_only / outbound_only / both) ✅

Per-connector direction gate. Schema-only (no migration file — user runs `db generate`/`db push`). Polling/lifecycle untouched per requirement; gate enforced at routing + tool layer. Cached in `connectorRegistry`, refreshed on PATCH without restart. Surfaced to adapters via `ConnectorContext.trafficMode`. UI Select on channel detail page next to LogMode + OutboundApproval. Codes returned to agents: `TRAFFIC_INBOUND_ONLY` (for outbound tools) and `drop_reason: 'traffic_outbound_only'` (on dropped inbound rows).

Files: `packages/types/src/index.ts`, `apps/studio/db/src/{schema,queries}/connector*.ts`, `apps/studio/server/src/connectors/{registry,activation,event-router,tools}.ts`, `apps/studio/server/src/routes/connectors.ts`, `apps/studio/web/lib/api.ts`, `apps/studio/web/app/.../channels/[connector]/page.tsx`. See `changelog.md` 2026-04-15 + memory entry "Connector traffic_mode = pure routing/tool gate".

## Phase (2026-04-15) — Connector events: collapse duplicate rows + drop `pending_approval` ✅

User saw two rows per inbound in Channels Events tab (`received` + `pending_approval`). Root cause: adapter's `logArrivalImmediate` INSERTed the arrival row, then `routeConnectorEvent` INSERTed a SECOND row with the routing outcome. Was tracked as a known follow-up (`tasks.md:39`).

Fix: arrival logger now stamps the inserted row id onto `event.metadata.arrival_event_id`. `event-router.ts:finalizeEv` UPDATEs that row via new `updateConnectorEvent` query instead of INSERTing. Pipeline collapses to ONE row per inbound. `pending_approval` status removed entirely — folded into `unhandled` (with `drop_reason='no_binding'` or `'identity_pending'` distinguishing the two cases). New canonical vocabulary: `received | routed | unhandled | dropped | rate_limited | error`. Frontend `events-tab.tsx` updated (filter dropdown, status colours, SSE upsert-by-id).

See `changelog.md` 2026-04-15 entry "Connector events: ONE row per inbound" + memory entry "Connector inbound = ONE event row per update".

## Phase (2026-04-15) — Action Request: detach-only + Telegram userbot error clarity ✅

User-requested two changes + one bug-investigation:
1. Removed `action_request_wait` tool entirely (deleted handler, helper, import, dead pubsub channel). Agent flow for AR is now ALWAYS detached — create-and-move-on. Wait hints stripped from `action_request_create` description, return value, `connector_send` outbound-approval response, and `connector_run_action` outbound-approval response.
2. Telegram userbot `copy_message` failed with `Peer 1309769651 is not found in local cache`. Root cause = agent prompt likely saved sender's `user_id` as `from_chat_id` (instead of the chat where the message LIVED) AND saved a UUID as `message_id`. Code-side: added numeric `message_id` validation in `copy_message` + `forward_message`, added `PEER_NOT_CACHED` translation in `mapQueueError` with actionable hint, sharpened action descriptions to reject UUIDs / sender ids upfront.

See `changelog.md` 2026-04-15 entries + memory entries `Action Request agent flow is ALWAYS detached` and `Telegram userbot: peer access_hash must be cached`.

## Phase (2026-04-15) — Bugfix: project-scope plugin leak ✅

`AgentRunner` panggil `PluginLoader.getResolvedTools()` + `getPromptSegmentsWithMetaAsync()` tanpa projectId di 4 call site (`runner.ts:212/422/886/907`) — filter `project_scope` di loader tidak pernah aktif, jadi tools + prompts dari plugin `project_scope: true` (mis. `jiku.web-reader`, `jiku.analytics`, `jiku.social`) bocor ke setiap project. Fix: pass `this.runtimeId`. Skills/storage/lifecycle hooks sudah aman. Lihat `changelog.md` 2026-04-15 + memory entry `PluginLoader.getResolvedTools()...`.

## Phase (2026-04-15) — Plan 25 Action Request Center ✅

All 6 phases shipped from `docs/plans/25-action-request-center.md` in one session:
data + API, UI, agent tools, outbound interceptor, task checkpoint, polish/docs. See
`docs/feats/action-request.md` for architecture + file map and `changelog.md` for the
detail list. Deploy: apply migrations 0035 + 0036 before server start.

## Phase (2026-04-15) — Permission hardening across features ✅

End-to-end audit + fix pass across all 11 project features (Channels, Cron Tasks, Browser, Disk, Plugins, Console, Skills, Commands, Memory, Chats, Agents). Plus: cancel-run ownership gate + real stream abort.

- Added permission keys: `skills:*`, `commands:*`, `browser:*`, `disk:*`, `usage:read`, `console:read`, `runs:cancel` (PR `packages/types/src/index.ts`).
- Migrations `0033_permissions_expanded.sql` + `0034_runs_cancel_permission.sql` backfill existing roles so upgrade doesn't strip menus.
- Role editor UI (`settings/permissions/page.tsx`) exposes every new group as a toggle.
- Sidebar uses the right permission key per item (was lumped under `agents:read`/`settings:read` before).
- Server routes: every feature's mutate endpoints now gated by `:write` permission; user-facing file ops by `disk:write` (fixed a bulk-replace mistake that set them to `disk:read`); browser/browser-profiles use `browser:*`; usage uses `usage:read`.
- UI write-button gating: Skills / Commands / Cron Tasks hide Create + Delete buttons for `:read`-only users. FileExplorer exposes `canWrite` prop consumed by Disk + Skills + Commands file editors.
- Disk viewer: `GET /filesystem/config` + `/filesystem/test` readable by `disk:read` (via `requireAnyPermission`) so the "Virtual Disk not configured" false-positive for non-admin readers is gone. Built-in **image viewer** adapter added (`.png/.jpg/.jpeg/.gif/.webp/.svg/.bmp/.avif`) — loads via signed inline proxy URL, zoom 25-800%. Storage Config tab hidden for users without `settings:read`.
- Runs cancel: was gated by `runs:read` (anyone viewing could cancel). Now chat runs are **owner-only or superadmin** (no team perm can stop someone else's personal chat). Task/heartbeat runs require owner / superadmin / `runs:cancel`. Cancel endpoint now calls `streamRegistry.abort(conversationId)` which threads through `AbortController` → `reader.cancel()` → chat route finally-block UPDATE `run_status='cancelled'` — so the stream actually stops, not just the DB label.
- Console UI: project-level `/console` page (sidebar "Config → Console") lists all active sessions for the current project's connectors with live indicator + filter. Connector detail page renders the console as an inline terminal-styled block (black bg, green text) — no Sheet/Drawer. `<ConsolePanel>` gained `variant: 'default' | 'terminal'`.
- Sidebar restructured into groups: (no-header) Dashboard, **AI** (Agents, Chats, Memory, Skills, Commands), **Tools** (Channels, Cron Tasks, Browser, Disk), **History** (Runs, Usage), **Config** (Plugins, Console, Settings), **Plugins** (dynamic slots).

See ADR-090 through ADR-095 + `docs/feats/permission-policy.md`, `docs/feats/console.md`.

## Phase (2026-04-15) — Console feature ✅

Shipped plugin-wide ephemeral log streams. Telegram bot + userbot adapters are the first consumer; architecture is generic (`<plugin_id>:<scope>:<id>` console ids, `ctx.console` API, `<ConsolePanel>` UI). Storage: 100–200 memory ring + NDJSON tempfile flush at 200 → keep 100. Session-scoped (tempdir wiped on boot). SSE live tail + reverse-scan pagination for history. See `docs/feats/console.md`, ADR-093.

## Phase (2026-04-15) — Telegram production safety hardening ✅

Final audit before production run. Three fixes shipped:
1. Bot adapter `runAction` — every `bot.api.*` call wrapped with `enqueueForChat + withTelegramRetry` (closed flood + 429-loop risk).
2. `runAction` signature now threads `connectorId` through (kit + tools + both Telegram adapters) — closes multi-tenant cross-bot leak for action calls.
3. Action surface narrowed to message + media only. Removed from bot: send_reaction, delete_message, pin/unpin, get_chat_members, create_invite_link, set_chat_description, ban_member. Removed from userbot: join_chat, leave_chat, delete_message, send_reaction, pin/unpin. See ADR-090/091/092.

No known-remaining blockers for production. `runAction` in connectors/tools forwards `connector_id`. `botFor()`/`clientFor()`/`queueFor()` resolve per-credential state.

## Phase (2026-04-14) — Plan 24 (Telegram Userbot via MTProto) — ALL 5 PHASES SHIPPED

Five-phase plan from `docs/plans/24-telegram-userbot-mtproto.md`. Single-session full implementation.

### Phase 1 — Setup API Foundation ✅
- Types in `@jiku/types`: `ConnectorSetupSpec`, `ConnectorSetupStep`, `ConnectorSetupInput`, `ConnectorSetupSessionState` (+`credential_fields` decrypted by route handler), `ConnectorSetupStepResult`.
- Kit additions on `ConnectorAdapter`: optional `getSetupSpec?()`, `runSetupStep?()`, `readonly requiresInteractiveSetup?: boolean`. Re-exports for plugins.
- Server `ConnectorSetupSessionStore` (in-memory `Map`, 15-min TTL, periodic sweep, retry cap 3 per step, multi-tenant key by `(project_id, credential_id)`).
- Routes `POST/POST/DELETE /api/projects/:pid/credentials/:credId/setup{/start, /:sid/step, /:sid}`. Resolves adapter via `connectorRegistry`, dispatches `runSetupStep`, persists `complete:true` fields by merging into encrypted credential fields, audits each step.
- Audit events: `credential.setup_started`, `credential.setup_step`, `credential.setup_completed`, `credential.setup_failed`, `credential.setup_cancelled`.
- `CredentialAdapter` listing exposes `requires_interactive_setup`.
- UI: `ConnectorSetupWizard` Dialog component (multi-step, retry counter, abort state, server-side cancel-on-close) + credential page integration (banner + Run Setup button).

### Phase 2 — Plugin restructure ✅
- `TelegramAdapter` → `TelegramBotAdapter` (id `jiku.telegram` → `jiku.telegram.bot`, displayName "Telegram" → "Telegram Bot"). Plugin meta id stays `jiku.telegram` (parent).
- Plugin `setup(ctx)` registers BOTH `telegramBotAdapter` + `telegramUserAdapter`.
- `ADAPTER_ID_ALIASES` in `connectorRegistry` resolves `jiku.telegram` → `jiku.telegram.bot` for backward compat. Applies in `get`, `getRequired`, `getAdapterForConnector`, `getActiveContextForPlugin`.
- Migration `0032_plan24_telegram_adapter_rename.sql` updates persisted `connectors.plugin_id` rows.

### Phase 3 — User adapter MVP ✅
- `@mtcute/bun` + `@mtcute/core` deps in plugin.
- `TelegramUserAdapter` real implementation: full credential schema, `runSetupStep` driving mtcute (`sendCode` → `signIn` with `SESSION_PASSWORD_NEEDED` branching → `checkPassword` → `finalizeLogin`), `onActivate` connects with `sessionString`, `client.on('new_message')` normalised to `ConnectorEvent` (skips own outbound by `myUserId`).
- Standard `sendMessage` with telegramifyMarkdown + params pass-through; queue-wrapped (Phase 5).
- Surfaces `FLOOD_WAIT_X` / `PEER_FLOOD` / `AUTH_KEY_*` as structured codes.

### Phase 4 — Action parity ✅
- 8 actions registered: `forward_message` (default `hide_sender:true` USERBOT-ONLY noForwardHeader+forwardSenders:false), `get_chat_history` (past 100-msg cap), `join_chat`, `leave_chat`, `get_dialogs`, `set_typing`, `delete_message`, `edit_message`.
- mtcute method capabilities probed at runtime — graceful "method not exposed in this build" fallback per action.

### Phase 5 — Hardening ✅ (queue management §8b)
- New module `plugins/jiku.telegram/src/userbot-queue.ts` — `UserbotQueue` class.
- Per-chat FIFO chains; min gap 1000ms per chat; sliding-window global quota 20/min; new-chat first-send 5s gap; `forward_message` 2s per source; `join_chat`/`leave_chat` 10/hr cap.
- `FLOOD_WAIT_X` → scope-aware pause (chat OR global by action heuristic). `PEER_FLOOD` → `spamRestricted` latch refuses all subsequent enqueues until cleared. `AUTH_KEY_DUPLICATED/UNREGISTERED` → `sessionExpired` latch.
- Per-credential `queue_policy` field (JSON) overrides defaults; lower values = faster but higher ban risk.
- `connector_get_queue_status` agent tool surfaces snapshot — `pending_per_chat`, `global_calls_last_minute`, `global_quota_remaining`, `global_rate_used_percent`, `flood_wait_active`, `spam_restricted`, `session_expired`, `policy`, `estimated_delay_next_ms`.
- `mapQueueError` helper translates queue-thrown structured errors (`code`, `wait_seconds`, `scope`) into `ConnectorSendResult` envelope.

### Pre-deploy checklist
1. Apply migrations `0030_plan24_commands.sql`, `0031_plan26_fs_tool_permission.sql` (already shipped earlier today), `0032_plan24_telegram_adapter_rename.sql` (this Plan 24).
2. `bun install` in repo root to fetch `@mtcute/bun` + `@mtcute/core`.
3. `bun run typecheck` di `apps/studio/server`, `apps/studio/web`, `plugins/jiku.telegram`.
4. Smoke test bot adapter: existing Telegram bot credentials — verify zero regression (alias resolves `jiku.telegram` → `jiku.telegram.bot`).
5. Smoke test user adapter: create credential with api_id/api_hash/phone_number → "Run Setup" → wizard runs OTP → exports session.
6. Validate queue: send 25 messages in <1 minute, check `connector_get_queue_status` shows `global_calls_last_minute` capped at 20, queue delays kick in.

### Known limitations (post-ship)
- mtcute method names assumed (joinChat / leaveChat / getDialogs / sendTyping / deleteMessages / editMessage) — runtime probe with graceful fallback. Adjust calls if `@mtcute/bun` version exposes different names.
- Queue is per-adapter-instance (singleton) — multi-credential userbot would share quota. Acceptable for MVP (one userbot per process); future: keyed by connectorId.
- Spam-restricted latch is in-memory — clears on process restart. Should be persisted to credential metadata.
- `queue.onEvent` hook currently logs to console — wire to `audit.write({event_type:'userbot.flood_wait', ...})` next iteration.

---

## Phase (2026-04-14) — Streaming adapter handoff: Telegram streaming outbound — SHIPPED (with revisions)

Event-router no longer drains the agent stream before touching Telegram. New optional `ConnectorAdapter.handleResolvedEvent(ctx)` hook — event-router resolves binding/identity/conversation, builds context + @file hint, then hands off a `ResolvedEventContext` with injected service callables. Telegram adapter consumes stream natively: `⌛` placeholder immediately → debounced 700ms edits → tool chunks `[🔧]` → `[☑️]` / `[❌]` → 4000-char overflow split → final MarkdownV2 with plain fallback. Stream teed back to host for SSE observers (chat web unaffected). See ADR-087. Backward compat: adapters without the hook use the legacy path.

### Post-ship revisions (same day)

1. **`message is not modified` no-op guard** — for responses with no MarkdownV2-escapable characters, the final edit rendered identical content to what the interim edit already landed. Telegram compares rendered output and returns 400. Now detected by description substring match and treated as success, not warning.
2. **Interleaved segment render** — replaced fixed-header tool list (all tools at top) with chronological `segments[]` model: consecutive text-delta appends to current text segment; consecutive tool-calls stack under current tool group; transition between types inserts `---` separator. Final MarkdownV2 render wraps tool lines in italic (`_[☑️] tool_name_`) with escaped tool names + escaped `\-\-\-` separators. Plain interim edits keep literal `---`. Matches natural narrative flow: "bot said X → ran tool Y → said Z".
3. **`ConnectorParamSpec`** extended with `'array' | 'object'` types and wider `example` value types (linter-applied user tweak) — supports more nuanced platform params going forward.
4. **MarkdownV2 bracket escape in tool chips** — `[` and `]` are MarkdownV2 link anchors and got silently stripped when wrapping `[☑️]` in italic `_..._`. Fix: run the icon chunk through `escapeMdV2` too (not just the tool name), so `_\[☑️\] fs_list_` renders literally.
5. **Slash command autocomplete in chat input (`/…` popup)** — new `SlashCommandAutocomplete` component consumes `usePromptInputController`. Arrow keys navigate, Tab/Enter insert `/<slug> `, Esc dismisses. Fetches agent via `GET /agents/:aid` (new endpoint), reads `command_access_mode` to decide whether to show allowlist or all project commands. Triggers `POST /projects/:pid/commands/refresh` on mount so newly-dropped FS commands appear without project reload.
6. **Connector inbound dispatcher (reverses ADR-085 partially)** — event-router now runs `dispatchSlashCommand` with `surface='connector'` on inbound text before wrapping. External Telegram members can invoke `/command` iff the agent's config allows (manual mode + allow-list OR mode='all'). Same permission model as chat — no surface-special-case anymore.
7. **Uniform `command_access_mode` across ALL surfaces** — reverted the earlier "chat bypasses allow-list" hack. Config is now single source of truth: `manual` + allow-list gates every surface (chat, connector, cron, task, heartbeat). UX: if user wants free access in chat, they set `command_access_mode='all'` — explicit, consistent.
8. **Drizzle schema drift fix** — migration 0030 added `agents.command_access_mode` column in DB but `apps/studio/db/src/schema/agents.ts` wasn't updated to match. Drizzle's type-safe `.set({...})` silently dropped the unknown field, producing `UPDATE "agents" SET WHERE id=$1` → Postgres 42601 syntax error. Column now declared in schema alongside `skill_access_mode`.
9. **`web-reader` plugin history bug (unrelated to the streaming adapter work but found debugging)** — tool handler read `toolCtx.runtime.caller.user_data.project_id` which is never populated by `resolveCaller`. So agent-invoked calls never wrote to history; only the plugin's own HTTP `/read` endpoint did (because its handler got projectId from the plugin-ctx closure). Fixed to `toolCtx.runtime['project_id']` — the pattern `jiku.sheet` already uses. Runner injects `project_id` into every `RuntimeContext`.

Follow-up: queue drain path (ack_queue mode dequeue) still uses legacy fake typing-sim — wire it through `handleResolvedEvent` when it becomes worth the refactor.

## Phase (2026-04-14) — Scenario 1 production prep: Commands + @file + FS permission + connector params — BACKEND SHIPPED

Driving the `docs/scenarios/1-manage-a-channel-with-agent.md` test tomorrow. All four high-priority gaps identified in §9 of the scenario are now implemented end-to-end on the backend; Commands UI shipped; FS-permission UI delegation in progress.

1. **§9.A Commands system** — user-triggered `/slash` FS-first, mirrors SkillLoader architecture. New tables `project_commands`, `agent_commands`, column `agents.command_access_mode`. Core parser + registry, studio `CommandLoader`, dispatcher wired into chat route, task/cron/heartbeat runner. Routes + audit + UI (project + per-agent allow-list) live.
2. **§9.B @file reference hint** — `src/references/hint.ts` scanner + injector. Inject `<user_references>` with size/mtime/large flag for every `@path` that resolves on disk. Wired in chat / task / connector inbound. Cap 20 per invocation.
3. **§9.C FS tool permission** — `tool_permission` metadata on `project_files` + `project_folders`, resolver with parent-walk inheritance, gate in `fs_write`/`fs_edit`/`fs_append`/`fs_move`/`fs_delete`, routes + audit. UI delegation queued.
4. **§9.D Connector params + hint** — `getParamSchema()` on `ConnectorAdapter`, `params` pass-through on `ConnectorContent`, Telegram declares 7 params (reply_to_message_id, parse_mode, disable_web_page_preview, message_thread_id, protect_content, disable_notification, allow_sending_without_reply). `connector_list` emits per-connector `param_schema` so agents self-discover.

## Deploy checklist for tomorrow
- Apply migrations `0030_plan24_commands.sql` + `0031_plan26_fs_tool_permission.sql` before server start.
- For the marketing scenario: create `/commands/marketing-channel-execute/COMMAND.md` + `/plans/marketing-channel.md` on the disk; PATCH `/reports/` folder permission to `read` so agent cannot overwrite ground-truth data during self-improve loop.
- Telegram agents should rely on `connector_list` output to read `param_schema` — no prompt changes needed, tool description already points at it.

## Relevant files
- Backend wiring: `apps/studio/server/src/commands/{loader,dispatcher}.ts`, `apps/studio/server/src/references/hint.ts`, `apps/studio/server/src/filesystem/tools.ts`, `apps/studio/server/src/connectors/tools.ts`.
- Telegram schema: `plugins/jiku.telegram/src/index.ts` — `getParamSchema()` override near `sendMessage`.
- Migrations: `apps/studio/db/src/migrations/0030_plan24_commands.sql`, `0031_plan26_fs_tool_permission.sql`.
- Scenario source: `docs/scenarios/1-manage-a-channel-with-agent.md`.

## Next up
- FS permission file-explorer context-menu UI (subagent in flight).
- Once subagent reports, run `bun run typecheck` in `apps/studio/server` + `apps/studio/web` to catch any regressions before the production test.
- Seed demo data for scenario test: a sample `/commands/marketing-channel-execute/COMMAND.md` + `/plans/marketing-channel.md` so the cron-driven marketing loop can be exercised end-to-end.
