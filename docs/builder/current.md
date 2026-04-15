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
