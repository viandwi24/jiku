## Backlog

### Plan 28 follow-ups (post-ship)
- [ ] Queue drain path (`queue_mode='ack_queue'` dequeue in `drainConnectorQueue`) still uses legacy fake simulate_typing. Wire it through `handleResolvedEvent` so subsequent queued messages also stream.
- [ ] Verify tool chunk type names match the actual AI SDK emit names. Current switch matches `tool-call`, `tool-input-start`, `tool-input-available`, `tool-output-available`, `tool-result`, `tool-error`, `data-jiku-tool-start`, `data-jiku-tool-end`, `data-jiku-tool-error` — if the runner emits different names, chips silently won't render. Log a sample run's chunk types to confirm.
- [ ] Port `handleResolvedEvent` pattern to Discord / WhatsApp adapters when they land (each with their own rate-limit + edit-semantics profile).
- [ ] Tool name escape for MarkdownV2 currently uses inline regex. Factor to a shared util if another adapter needs the same escape later.
- [ ] Consider per-tool hint (e.g. args preview) next to the tool line — right now only name is shown.

### Plan 24/25/26/27 follow-ups (post-ship)
- [ ] FS permission file-explorer context-menu UI — delegated to subagent 2026-04-14; follow up on completion, verify badge/indicator + bulk-set flow.
- [ ] Commands: connector inbound dispatcher — currently only chat/task/cron/heartbeat surfaces route `/slug`. Gated opt-in per-binding so external members can't invoke `/deploy-prod`.
- [ ] Commands: args schema editor UI — users can currently only write args via YAML frontmatter. Nice-to-have form builder.
- [ ] @file hint: support `@./relative` and `@folder/` (directory summarisation). Currently exact workspace paths only.
- [ ] @file hint: inline `@path:L10-20` for line-range hint.
- [ ] FS permission: deny read (`none` tier) — deferred; only `read` vs `read+write` today per scenario doc MVP.
- [ ] Connector params: type/enum validation against the schema (parse_mode:"foo" should error before hitting Telegram).
- [ ] Connector params: mirror schema in Discord / WhatsApp adapters when they land.
- [ ] Agent-commands page: when `command_access_mode='all'`, UI should surface "all project commands available" instead of the allow-list.
- [ ] Chat UI: surface "Command Invoked: /slug" chip when dispatcher matches so users see which command fired.

### Connector follow-ups
- [ ] Arrival row unification — downstream `event-router.ts` still INSERTs additional rows as status transitions (`pending_approval`, `handled`, `dropped`, `rate_limited`). Short term each inbound event produces `received` row + outcome row. Longer term those should be UPDATEs against the arrival row. Requires threading arrival event id into `routeConnectorEvent()`.
- [ ] Flip `drop_pending_updates: false` in Telegram adapter's `deleteWebhook` + `bot.start` — currently pending messages during the activation window get triple-dropped (diagnosis ran 2026-04-14). Trade-off: crash-restart replays backlog. Decide + ship.
- [ ] Per-binding "Reset all pairings" button — set all identities under a binding to `status='pending'` so admin can re-trigger approval flow after a settings change without deleting the whole connector.
- [ ] Propagate `getHealth()` to other adapters (WhatsApp / Discord / Slack when they land) so HealthBadge renders uniformly across platforms.
- [ ] Force re-pair action on orphaned identities (DM UI) — for cases where the automatic reset on next message isn't acceptable (e.g. bulk migration). Currently orphan reset only triggers on inbound; an explicit "reset now" button would let admin prepare the state without waiting for the user to chat.
- [ ] Auto-release stuck `runningConversations` in `event-router.ts` — module-level Set is not cleared on boot; if a process crashed with entries in the Set, a restart resets it (fresh module), but a handler that errors mid-run may leave stale IDs. Consider periodic sweep or `finally`-guard audit.
- [ ] `POST /connectors/:id/logout` admin action — calls Telegram's `logOut` API (force-release all sessions server-side). Nuclear option for when even deactivate+30s wait can't clear the slot. Expose as "Force logout" button behind a confirm dialog.
- [ ] Stuck-poll-slot detection heuristic: if `getUpdates` returns 409 >3 times in a row despite `close()`, log a strong warning + surface in HealthBadge. Currently this loops silently with exponential backoff.
- [ ] Migration helper for legacy loose bindings (`source_type='any'` with null `source_ref_keys` + null `scope_key_pattern`) — either auto-narrow on first match or surface a banner on the connector detail page.
- [ ] Scope binding-match by connector UUID (defensive): currently filter uses `connector.plugin_id === event.connector_id`; if two connectors share a plugin_id in one project, they can cross-match. Switch to `connector.id === connectorUuid`.

### Plan 23 follow-ups (post-ship)
- [ ] Conversation list sidebar: "(branched)" indicator. Needs either denormalized `has_branches` boolean on `conversations` (kept in sync via insert trigger or runner-side write) or accept a per-row branching check on the project list query.
- [ ] Toast UI for branch-switch / regenerate / edit failures (currently `console.error` only). Wait for a project-wide toast pick before adding a new dependency.
- [ ] Keyboard arrows on `BranchNavigator` (← / → when focused) for power users.
- [ ] E2E tests: edit flow, regenerate flow, multi-branch navigation, root-message edit (parent_message_id=null), regenerate from a non-tip assistant.
- [ ] QA: long conversation that crosses compaction threshold under branching — verify each branch carries its own checkpoint and switching between them keeps context coherent.
- [ ] Visual hint for messages on a non-default branch (e.g. subtle border/badge when current_sibling_index > 0).

### Plan 22 follow-ups (post-revision-part-3)
- [ ] "Smart" `simulate_typing`: if outbound text < 80 chars, skip placeholder + single send (3 round-trips for a one-liner is overkill).
- [ ] QA cron scheduling end-to-end in Telegram with weekday-only + DST-crossing schedules.
- [ ] Plugin-authored prompt segments support `LabeledSegment` (currently studio-only; plugins still pass `string`).
- [ ] Fix pre-existing TS errors surfaced during Plan 22 work: express `req.params: string|string[]`, drizzle `.default(null)`, `UserContentPart[]`/`ToolContent` mismatch in runner.ts:489, memory/tools.ts `AgentMemory` missing required fields, browser-profiles `os` property. Separate cleanup pass.
- [ ] Simulate_typing for Discord / WhatsApp adapters when those land — mirror Telegram pattern via shared helper.
- [ ] Cron UI: show `context.delivery` / `context.origin` so admin can edit without agent round-trip.
- [ ] Cron list in UI: filter by caller / by delivery connector / by "silent" (no delivery) — triage at scale.

### Plan 21 follow-ups (post-ship)
- [ ] Plugin adapter registration: expose `ctx.agent.registerAdapter()` via `StudioContributes` + `context-extender.ts` when the first plugin-authored adapter lands.
- [ ] Optional "retry phase 2 once on dropped tool" mode for HarnessAgentAdapter (residual risk: GPT sometimes drops a tool call with `tool_choice=auto` → loop exits early). Make opt-in because retry wastes a call when model genuinely decided to stop.
- [ ] Harness iteration pill in UI (we emit `jiku-harness-iteration` events from iter ≥ 2; nothing consumes them yet).

### Plan 20 follow-ups (post-ship)
- [ ] Stale CamoFox tab recovery: if CamoFox evicts a cached tabId (idle timeout or `MAX_TABS_PER_SESSION` eviction), adapter should detect 404 on next call + refresh. Currently adapter caches `tabId` forever.
- [ ] Extend action registry to `JikuBrowserVercelAdapter` if any CDP-specific custom actions emerge (none today).
- [ ] Private registry publish for `jiku-camofox` image so deploys don't rebuild from git each time.

### Plan 19 follow-ups
- [ ] Sandboxed `skill_exec_file` runtime (separate plan — needs JS/TS/Python sandbox)
- [ ] Private-repo skill import via GitHub PAT (credentials vault integration)
- [ ] Expose per-phase credential/model override in Dreaming UI (schema already supports)
- [ ] Skill marketplace browse — catalog from skills.sh inside app
- [ ] Per-caller permission grant surface so `requires.permissions` in manifests actually gates at runtime (currently `grantedPermissions` passed as empty Set)
- [ ] `skill.source_changed` audit event emission on plugin activate/deactivate (currently reserved, not emitted)
- [ ] Dreaming effectiveness benchmark at 10k-memory scale
- [ ] Usage page: `agent_id=null` filter (background-only view)
- [ ] Memory browser: add `source_type` column to the table (currently only shown via Type badge tooltip)

### Plan 17 follow-ups
- [ ] Third-party plugin sandboxing (iframe origin isolation, code signing, per-publisher keys, bundle SRI) — deferred from original Plan 18 scope; current Plan 18 implements per-user permission grants but not iframe isolation
- [ ] Wire `ctx.files.*` to filesystem service (currently stubbed — returns empty)
- [ ] Wire `ctx.secrets.*` to credentials vault (currently throws)
- [ ] Implement `ctx.api.stream` (SSE streaming from plugin server to UI)
- [ ] Client-side `ctx.events.on` subscription (EventSource with query-string token similar to signed-URL flow)
- [ ] `ctx.ui.openModal` / `global.modal` slot host
- [ ] Rate-limit per plugin × user (complement to per-IP limiter on asset router)
- [ ] Bundle-size budget enforcement (warn on > 50KB, error on > 200KB gzipped)
- [ ] axe-core a11y CI check for plugin slot variations
- [ ] Add `jiku plugin reload <id> --project <p>` CLI command (needs server-side invalidate endpoint)
- [ ] Migrate `jiku.skills` / `jiku.social` to contribute UI entries (pattern now trivial)

### jiku.sheet follow-ups
- [ ] Verify `sheet_read` path-based read with projectId from `toolCtx.runtime['project_id']` works correctly end-to-end in production (dynamic import path from plugin to server filesystem service)

### Other
- [ ] Cron Task System nice-to-haves (schedule_paused state, timezone support, run history pagination)
- [ ] Verify Telegram bot responds end-to-end after `depends: [StudioPlugin]` switch (test: send message → typing indicator → get_datetime tool call → MarkdownV2 response)
- [ ] DB migration: `cd apps/studio/db && bun run db:push` — applies Plan 17 migration plus any previously pending (filesystem, attachments, persona_prompt)
- [ ] Update `apps/studio/web` to import from `@jiku/ui` instead of local `@/components/ui/` and `@/components/ai-elements/`
- [ ] Add `NEXT_PUBLIC_API_URL` to web `.env.local` (WS_URL no longer needed)
- [ ] Test suite — unit tests for resolveScope, checkAccess, PluginLoader, resolveCaller, `discoverPluginsFromFolder`, `signAsset` / `verifyAsset`
- [ ] Invite member feature (currently only owner can be member)
- [ ] Agent Tools tab — currently placeholder "coming soon", needs real tool assignment UI
- [ ] `extractPersonaPostRun()` — auto-extract persona signals after conversation (implemented but needs keyword tuning)
- [ ] Filesystem: add RustFS service to docker-compose.yml and set up default credentials for dev

## Done

- [x] Connector recovery + queue resilience + polling reconnect — per-chat outbound send queue + `withTelegramRetry` 429 handling (honors `retry_after` capped at 45s), global inbound FIFO batch queue (size 5, `Promise.allSettled`), non-blocking arrival log via `logArrivalImmediate()` (ops can see raw arrivals in `connector_events` independent of router health), `bot.start()` auto-reconnect loop (1s→60s backoff, `bot.api.close()` between 409 retries), 30s post-deactivate guard via module-level `lastDeactivateByConnector` map, `bot.catch()` middleware error handler, orphan identity auto-reset in event-router Path B (DM), admin UI Restart button + HealthBadge polling 15s, new `POST /connectors/:id/restart` + `GET /connectors/:id/health` endpoints, `getHealth()` adapter method on Telegram. ADRs ADR-079…082 — completed 2026-04-14.

- [x] `scripts/reset-password.ts` ops script — email prompt → user lookup → confirm → generate 8-char random password (letters+digits+symbols via `crypto.getRandomValues`) → bcrypt hash (10 rounds, matches register flow) → DB update → plaintext printed to stdout. Runnable via `bun --env-file=.env run scripts/reset-password.ts` from `apps/studio/server`. — completed 2026-04-14.

- [x] Trigger modes + auto-register topics + group pairing UX — proper `mention`/`reply` detection (Telegram entity scan + bot id cache), customizable trigger_mode (`trigger_mention_tokens`, `trigger_commands`, `trigger_keywords_regex`) via migration `0029`, topic-aware group pairing `display_name` ("Chat → Topic") + violet topic badge in UI, forum topic auto-register as `connector_target`, scope_key format consistency fix (`chat:<id>` → `group:<id>` in `my_chat_member` auto-register). ADR-078 — completed 2026-04-14.

- [x] Connector context + tools observability overhaul — `<connector_context>`/`<user_message>` XML wrapping (prompt-injection defence), richer Chat/Sender/Connector lines, internal `event_id` + `message_id` injected into context, Telegram forum topic NAME extraction (from `reply_to_message.forum_topic_created.name`), expanded `connector_get_events` + `connector_get_thread` with `chat_id`/`thread_id`/`user_id`/`content_search`/`from`/`to`/`cursor` filters, new `connector_list_entities` (distinct chats/users/threads discovery), new `connector_get_event` / `connector_get_message` by-id tools (project-scoped), enriched `connector_list_targets` with connector metadata + ambiguity-safe `connector_send_to_target`, Thread ID input in Scope Lock UI. Sharpened tool prompts for freshness + discovery-first discipline. Fix `409 Conflict` on delete+recreate connector (deactivate before delete; Telegram `deleteWebhook + close` pre-flight). ADR-077 — completed 2026-04-14.

- [x] Connector binding semantics overhaul — strict DM pairing approval (scopes to one `user_id`), implicit scope gate in `matchesTrigger`, `member_mode` column (`require_approval` default) on `connector_bindings`, group auto-pairing drafts (via `my_chat_member` + lazy creation from first group message), reject-button fix (`status='pending'` filter), Blocked Identities cleanup UI, always-log inbound messages, normalized inbound message status vocabulary (`handled` / `unhandled` / `pending` / `dropped` / `rate_limited`), Scope Lock UI card (Chat ID / User ID pickers), enriched `connector_list_targets` with connector metadata, ambiguity-safe `connector_send_to_target` with `AMBIGUOUS_TARGET` error. Migration `0028_binding_member_mode.sql`. ADR-074 — completed 2026-04-14.

- [x] Filesystem: Claude-Code-style safety — `conversation_fs_reads` table (session read tracker), read-before-write gate, STALE_FILE_STATE detection via version compare, `fs_edit` substring replacement, `fs_read` pagination (offset/limit, `cat -n`, line truncation, paging hint), `fs_append` zero-read append tool, `upsertFile` version-increment fix with SHA-256 content_hash. Migration `0027_conversation_fs_reads.sql`. ADR-075 — completed 2026-04-14.

- [x] Channels UI revision — 3-tab page (Connectors | Messages | Events), project-level cursor-paginated queries + SSE streams with filters, row-click Sheet drawer, event direction (inbound/outbound) column, raw_payload captured from webhook + polling + adapter send results, Telegram service-message filter (join/leave emit; silent skip for title/pin/migrate). Migrations `0026_connector_raw_payload.sql`. — completed 2026-04-14.

- [x] Fix connector queue sibling-branch race — `drainConnectorQueue` now awaits the resolver + observer drain before releasing `runningConversations`, so the next queued run sees the latest `active_tip_message_id`. — completed 2026-04-14.

- [x] Plan 23 — Branch Chat (message-level branching for chat conversations): migration `0024` (parent_message_id + branch_index + active_tip_message_id with backfill), recursive-CTE active path query, branch-aware runner (history walk by parent_message_id override OR active tip), regenerate route with `regenerate:true` flag, branch switch + sibling-tip endpoints, `BranchNavigator` + `MessageEditInput` UI inline in action bar, regenerate streams via `useLiveConversation` + 8s startup grace, append-only branch-aware compaction (ADR-073 revised — appends `[Context Summary]` checkpoint via `addBranchedMessage`, never destroys siblings), preview/threshold accounting per active branch. ADRs ADR-067…073 — completed 2026-04-13. See `docs/plans/impl-reports/23-branch-chat-implementation-report.md`.

- [x] Plan 22 Revision Part 3 — cron reliability + Telegram UX + prompt structure: removed `builtin_` prefix on built-in tool names (ADR-064), `simulate_typing` per-send defaults (ADR-065), heartbeat cron parser → croner (ADR-066), markdown-structured system prompt with `LabeledSegment[]`, `extra_system_prepend` for hard rules above base prompt, `/reset` command in Telegram, cron context decoupling (ADR-061) via `cron_tasks.context jsonb`, side-effectful tool dedup on replay (ADR-060), `[Cron Trigger]` preamble to prevent loops + silent failures, Telegram connector usage log parity, audit-log non-UUID actor guard, project default timezone (`Asia/Jakarta`), Company & Team + Project Context runtime segments, agent-side target CRUD. Migrations `0019` (admin perms backfill), `0020` (cron context), `0021/0022` (project timezone), `0023` (simulate_typing column rollback) — completed 2026-04-13. See `docs/plans/22-channel-system-v2.md` (Revision appendix).

- [x] Fix `plugin-permissions` loader UUID error — non-UUID caller ids (`'system'`, `'connector:*'`) no longer reach `project_memberships.user_id` — completed 2026-04-13.

- [x] Plan 20 — Multi Browser Profile + Browser Adapter System: `BrowserAdapter` abstraction in `@jiku/kit`, per-project browser profiles (DB `browser_profiles` + migration 0016), plugin `ctx.browser.register()` hook, unified `browser` tool with `profile_id` routing, multi-profile tabbed UI + Add Profile modal, CamoFox plugin (REST REST adapter on port 9377 — NOT CDP), `@jiku/camofox` Docker wrapper package, custom action registry (`browser_list_actions` / `browser_run_action`) with 7 CamoFox custom actions, compose + env wiring for both dokploy and local dev — completed 2026-04-13. See `docs/plans/impl-reports/20-multi-browser-profile-implementation-report.md`.
- [x] Plan 19 — Memory Learning Loop + Skills Loader v2: memory typing (episodic/semantic/procedural/reflective) + health decay, durable `background_jobs` queue + `BackgroundWorker` (SKIP LOCKED, retry), compaction-flush hook, post-run reflection (opt-in per agent), 3-phase dreaming engine (light/deep/REM) with explicit credential+model picker, FS-first skills with YAML frontmatter (skills.sh compatible), plugin `ctx.skills.register()` API, progressive-disclosure XML hint, per-agent access mode (`manual`/`all_on_demand`), eligibility gate, GitHub tarball + ZIP import (accepts `npx skills add` URL form), universal `recordLLMUsage()` usage tracker (all sources), usage page source filter + duration column + color-coded badges, memory browser Type/Health columns + clickable detail/edit dialog, FK names shortened in plugin_granted_permissions, `fs.read` unwrap fix, `refetchOnWindowFocus: false` globally, credential rate limit 30→120/min, deleted orphan `settings/memory` page — completed 2026-04-12. See `docs/plans/impl-reports/19-memory-skills-implementation-report.md`.
- [x] Plan 18 — Production Hardening: rate limiting (5-layer `express-rate-limit`), broad `audit_logs` table + `audit.*` helper + settings/audit UI with CSV export, plugin policy enforcement via `ToolMeta.required_plugin_permission` + `plugin_granted_permissions` + core runner `ToolHooks`, tool hot-unregister on plugin activate/deactivate, plugin-permissions admin UI, and settings navigation refactor (vertical sidebar with Access Control group) — completed 2026-04-12. See `docs/plans/impl-reports/18-production-hardening-report.md`.
- [x] Plan 17 — Plugin UI System (full): isolated runtime (tsup bundles + dynamic URL import + own React), auto-discovery loader, `apps/cli` (commander + Ink), `@jiku-plugin/studio` host anchor via native contributes/depends, signed-URL + rate-limit + prod .map gate on asset router, `jiku.analytics` demo plugin, Active Plugins tab split into System/Project sections, jiku.connector merged into Studio anchor, jiku.telegram switched to `depends: [StudioPlugin]` — completed 2026-04-12. See `docs/plans/impl-reports/17-plugin-ui-implementation-report.md`.
- [x] Plan 16 — Cron Task System: full end-to-end (DB schema, scheduler, tools, REST API, web UI, expression preview) — completed 2026-04-07
- [x] Memory System (Plan 8): core types, relevance scoring, builder, extraction, DB schema, server tools + routes, web browser + config UI — completed 2026-04-05
- [x] Memory previewRun integration — memory section visible in context preview sheet — completed 2026-04-05
- [x] Fix getMemories agent_id bug — agent_id now optional in DB query so runtime_global queries work — completed 2026-04-05
- [x] `memory_user_write` tool — added to tools.ts, policy-gated by write.cross_user — completed 2026-04-05
- [x] Memory expiration cleanup job — deleteExpiredMemories() + daily setInterval in server bootstrap — completed 2026-04-05
- [x] Memory Preview Sheet — MemoryPreviewSheet component, wired via onMemoryClick in ContextBar footer — completed 2026-04-05
- [x] Run Detail page uses ConversationViewer mode=readonly — same context/tools/memory preview as chat — completed 2026-04-06
- [x] Memory browser table layout + agent column + filter by agent — completed 2026-04-06
- [x] Persona refactor — persona_prompt field, direct system prompt injection, simple textarea UI — completed 2026-04-06
- [x] `@jiku/plugin-connector` — new core plugin exposing `ctx.connector.register()` via contributes — completed 2026-04-06
- [x] Telegram plugin: depends on ConnectorPlugin, MarkdownV2 + telegramify-markdown, multi-chunk messages — completed 2026-04-06
- [x] Typing indicator in event-router (sendTyping + 4s interval repeat) — completed 2026-04-06
- [x] Zod v3.25.76 standardization across all workspace packages — completed 2026-04-06
- [x] Binding architecture: output_adapter + output_config jsonb (no agent_id at root) — completed 2026-04-06
- [x] Dashboard metrics live counts — Studio (Projects+Agents), Company (Agents), Project (Chats) via useQueries — completed 2026-04-05
- [x] Bug fixes from automated test — MemoryItem type fields (source, project_id), staleTime:0, touchMemories warning — completed 2026-04-05
- [x] Chat UX polish: conversation list grouping, context bar, SSE observer, sidebar footer — completed 2026-04-05
- [x] Setup automated docs architecture — completed 2026-04-04
- [x] Implement @jiku/types — completed 2026-04-04
- [x] Implement @jiku/kit — completed 2026-04-04
- [x] Implement @jiku/core (runtime, runner, resolver, loader, storage) — completed 2026-04-04
- [x] Create plugins/jiku.social built-in plugin — completed 2026-04-04
- [x] Create apps/playground demo — completed 2026-04-04
- [x] Plugin System V2 (contributes, typed deps, circular detection, override pattern) — completed 2026-04-04
- [x] Studio Base Plan 3: @jiku-studio/db, @jiku-studio/server, @jiku/ui, apps/studio/web — completed 2026-04-04
- [x] Policy System Revision Plan 3.5: policy entity, agent_policies, SubjectMatcher, wakeUp/syncRules — completed 2026-04-04
- [x] Migrate shadcn UI + ai-elements into @jiku/ui (packages/ui/src/components/) — completed 2026-04-04
- [x] Write Plan 3 + 3.5 implementation reports — completed 2026-04-04
- [x] Fix create project 500 error (middleware path mismatch in projects route) — completed 2026-04-04
- [x] Credentials system end-to-end (Plan 4): DB schema, AES-256-GCM encryption, adapters, API routes, UI — completed 2026-04-05
- [x] Connect `@jiku/core` JikuRuntime to `JikuRuntimeManager` — one JikuRuntime per project, dynamic provider pattern — completed 2026-04-05
- [x] Chat migration: WebSocket → HTTP streaming via Vercel AI SDK + JikuRuntime — completed 2026-04-05
- [x] StudioStorageAdapter: implement full JikuStorageAdapter interface (conversations, messages as MessageContent[], plugin KV) — completed 2026-04-05
- [x] Plugin KV store: persist in `plugin_kv` DB table instead of in-memory — completed 2026-04-05
- [x] DB migrations: generated `0001_lumpy_ezekiel.sql`, pushed to DB — completed 2026-04-05
- [x] buildProvider(): support openai, anthropic, openrouter, ollama via @ai-sdk/* — completed 2026-04-05
- [x] UX fix: show error bubble in ChatInterface when server returns error (e.g. no credential assigned) — completed 2026-04-05
- [x] Plan 5 — Studio Web UI/UX Overhaul: sidebar, chat system, agent tabs, settings tabs, error boundaries, empty states, toast — completed 2026-04-05
- [x] Chat history fix: content→parts migration, AI SDK v6 `messages` option, `!historyData` guard — completed 2026-04-05
- [x] Plan 9 — Persona System: agent_self scope, PersonaSeed, ensurePersonaSeeded, formatPersonaSection, persona_read + persona_update tools, persona settings page, API routes — completed 2026-04-05
- [x] Active Tools UI — ToolRow expandable detail (description, ID, params schema), ContextBar tools button + count — completed 2026-04-05
- [x] Tool group metadata — `group` field in ToolMeta, all memory/persona tools tagged, grouping in context preview sheet — completed 2026-04-05
- [x] Context preview sheet layout — system prompt below usage bar, segment grouping by source, tab context/tools — completed 2026-04-05
- [x] Tool parts persistence — runner saves tool-invocation parts (call+result) per step to DB; history loading reconstructs full model messages with tool roles — completed 2026-04-06
- [x] Real-time streaming for connector conversations — streamRegistry teed in event-router, useLiveConversation hook polls /live-parts — completed 2026-04-06
- [x] `get_datetime` system tool — returns iso/timezone/local/unix; injected into all agents — completed 2026-04-06
- [x] Telegram user timezone context — language_code → timezone map injected into connector context string — completed 2026-04-06
- [x] Plan 13 — Browser Automation: OpenClaw engine ported, browser tools injected at wakeUp(), settings UI — completed 2026-04-06 ⚠️ MARKED FAILED — does not meet planning requirements (see ADR-026)
- [x] Plan 33 — Browser rebuild via `@jiku/browser` (CDP bridge to agent-browser CLI), unified attachment persistence, CDP-only config, hardened Docker container (--no-sandbox + readiness probe), settings page rewrite with Live Preview box, OpenAI-safe flat z.object tool schema — completed 2026-04-09. See `docs/plans/impl-reports/13-browser-implement-report.md`.
- [x] Plan 14 — Filesystem: S3/RustFS adapter, virtual path DB, agent tools (fs_list/read/write/move/delete/search), file manager UI (/disk), settings page — completed 2026-04-06
- [x] Chat image attachments: upload + serve endpoint (/api/attachments), project_attachments DB table, image rendering in chat, ImageGallery fullscreen preview component — completed 2026-04-06
