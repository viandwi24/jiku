# Changelog

## 2026-04-17 — Cron: slash-command pre-dispatch in scheduler — `/slug …` stored prompts now actually invoke the command

Field bug: a cron task whose stored `prompt` is a slash invocation like `/marky-send only_content link` never triggered the command body. Root cause: the cron scheduler composes the prompt with the `[Cron Trigger]` preamble before handing to `runTaskConversation`, which calls `dispatchSlashCommand` with the full composed input. The dispatcher's first check (`commands/dispatcher.ts:24`) is `trimmed.startsWith('/')` — the trimmed composed input starts with `[Cron Trigger]`, not `/`, so `{ matched: false }` is returned and `/marky-send …` lingers as plain text for the LLM to re-interpret (usually inaccurately).

Fix (`apps/studio/server/src/cron/scheduler.ts`): pre-dispatch the slash command at the scheduler level, BEFORE `composeCronRunInput`. Pattern:

```ts
const cmd = await dispatchSlashCommand({
  projectId: task.project_id, agentId: task.agent_id,
  input: task.prompt, surface: 'cron', userId: task.caller_id ?? null,
}).catch(() => ({ matched: false, resolvedInput: undefined } as const))
const effectivePrompt = (cmd.matched && cmd.resolvedInput) ? cmd.resolvedInput : task.prompt
const runInput = composeCronRunInput(effectivePrompt, ...)
```

The dispatcher's `resolvedInput` already wraps the SOP body in `<active_command>` + the literal trigger text, so the preamble-composed input now contains the command body inside the `Instruction:` section — exactly where the agent expects actionable content. Task runner's downstream `dispatchSlashCommand` call remains (it handles chat/task/heartbeat surfaces) — in the cron path it's a harmless no-op because the input starts with `[Cron Trigger]` so `startsWith('/')` is false and dispatch short-circuits.

Non-slash prompts are untouched — dispatcher returns `matched: false`, `effectivePrompt` falls back to `task.prompt`, preamble composition proceeds as before.

Files: `apps/studio/server/src/cron/scheduler.ts`.

## 2026-04-16 — Cron: edit-form delivery editor, server warning, auto-populate from Connector Context

Three follow-ups from the earlier cron-delivery work:

### 1. Edit-form delivery editor (`cron-tasks/[id]/page.tsx`)
Same section as the new-task form: Connector dropdown → Target dropdown → raw Chat ID / Thread ID fallbacks. Hydrates from `task.context.delivery` on load. Save mutation threads a `delivery: CronDeliverySpec | null` field — `null` clears (task → silent), a spec with at least one addressable field (`target_name` or `chat_id`) sets.

Server PATCH (`routes/cron-tasks.ts`) accepts the same `delivery` body field. Merging semantics: when `delivery` is supplied, replace `context.delivery` while preserving other `context` keys (`origin` / `subject` — managed by the agent's `cron_create` tool, not UI). `null` → drop only the delivery key. Missing field → context untouched.

Type shape mirrored client-side: new `CronDeliverySpec` export on `lib/api.ts`; `CronTask.context` now typed. `cronTasks.update` body accepts `delivery?: CronDeliverySpec | null`.

### 2. Non-blocking create warning (`routes/cron-tasks.ts`)
On `POST /projects/:pid/cron-tasks`, if delivery ends up empty AND the prompt matches a loose imperative-verb heuristic (`kirim|kirimkan|ingatkan|ingetin|beritahu|bilang|tanyakan|sampaikan|notify|notif|send|remind|tell|ping|alert|message`), the response includes a `warnings: string[]` field alongside `cron_task`. UI surfaces as `toast.warning(...)` on the new-task page (8s duration, doesn't block navigation).

False-positive-tolerant by design: users who genuinely want a silent task with matching verbs (e.g. "kirim ke file output.json") just dismiss the toast. False-negatives (missing a silent-but-should-have-delivered task) are more expensive.

### 3. Auto-populate delivery from Connector Context (`cron/tools.ts` + `event-router.ts` + core runtime)
When an agent calls `cron_create` from within a connector-initiated run (user chats on Telegram → agent creates cron), the tool now auto-fills `delivery` from the active connector context even if the agent doesn't supply it. Eliminates the "agent forgot to wire `delivery` → user never gets the reminder" silent failure.

Mechanism:
- **New `JikuRunParams.extra_runtime_context`** (`packages/types/src/index.ts`) — generic `Record<string, unknown>` the caller spreads into `RuntimeContext` for one run. Keys must be namespaced to avoid clashing with plugin-provider contributions.
- **Runner** (`packages/core/src/runner.ts`) — spreads `params.extra_runtime_context` into `runtimeCtx` BEFORE `plugins.resolveProviders(caller)` so plugins can intentionally override.
- **Event-router** (`apps/studio/server/src/connectors/event-router.ts`) — new `buildConnectorHint(event, connectorId, displayName)` helper produces `{ connector_id, platform, chat_id?, thread_id?, scope_key? }`. Passed via `extra_runtime_context: { connector_hint: {...} }` at BOTH `runtimeManager.run(...)` call sites inside `executeConversationAdapter` (streaming handoff path + legacy fallback path).
- **`cron_create` tool** (`apps/studio/server/src/cron/tools.ts`) — gained a `toolCtx` parameter on `execute`. After merging agent-provided `delivery`, if the spec still lacks an addressable field AND the prompt matches `promptImpliesUserFacingOutput`, copy `connector_id` / `chat_id` / `thread_id` / `scope_key` / `platform` from `toolCtx.runtime.connector_hint` into `context.delivery`. Agent-supplied fields win; auto-fill only backs off when the slot is empty.

Guardrails:
- Prompt-intent heuristic prevents auto-populating truly-internal cron tasks (file writes, conditional `cron_create` chains).
- Agent can still opt out by clearing delivery explicitly (`delivery: {}`) — auto-fill only runs when no addressable field is present AND no explicit empty spec was passed. (Passing `{ connector_id: "..." }` with no address triggers auto-fill; passing nothing also does. Passing `{ target_name: "xyz" }` opts out of auto-fill entirely.)

Files: `packages/types/src/index.ts`, `packages/core/src/runner.ts`, `apps/studio/server/src/connectors/event-router.ts`, `apps/studio/server/src/cron/tools.ts`, `apps/studio/server/src/routes/cron-tasks.ts`, `apps/studio/web/lib/api.ts`, `apps/studio/web/app/.../cron-tasks/{new,[id]}/page.tsx`.

## 2026-04-16 — Cron UI: delivery channel picker on new-task form

Follow-on from the preamble-conditional fix. The preamble now gracefully falls back to silent mode when no delivery is configured — but the UI still gave users NO way to configure delivery, so every UI-created cron was silent by default. Now user-intended deliveries can be wired up-front from Studio.

- Form (`apps/studio/web/app/(app)/studio/companies/[company]/projects/[project]/cron-tasks/new/page.tsx`) gained an optional "Delivery channel" section between Prompt and Enabled. Fields:
  - **Connector** dropdown — lists the project's active connectors. Default "None — silent task" keeps old behavior.
  - **Target** dropdown (shown when a connector is picked) — lists that connector's named targets (via `api.connectors.targets.list`). Default "None — enter raw chat_id below".
  - **Chat ID** + **Thread ID** raw inputs (shown only when no target is picked) — power-user fallback when no named target exists yet. Thread ID is for forum topics.
- Submit logic only includes `delivery` in the request when at least one addressable field (`target_name` or `chat_id`) is populated — prevents storing meaningless `{ connector_id }`-only specs that'd still trip the silent-mode check.
- `platform` label is auto-derived from `connector.plugin_id` convention (`jiku.telegram.bot` → "Telegram") so the agent sees a human-readable channel name in the preamble.
- Server route `POST /projects/:pid/cron-tasks` (`apps/studio/server/src/routes/cron-tasks.ts`) accepts `body.delivery`, trims empties, writes to `cron_tasks.context.delivery`. API client type (`apps/studio/web/lib/api.ts`) mirrors the shape.

Behavior on create: no delivery picked → task runs silent (matches previous default). Delivery picked with target → agent gets full `connector_send_to_target` prose in preamble. Delivery picked with raw chat_id → agent gets `connector_send` prose with the right `chat_id` (and `thread_id` if the target is a forum topic).

Files: `apps/studio/server/src/routes/cron-tasks.ts`, `apps/studio/web/lib/api.ts`, `apps/studio/web/app/.../cron-tasks/new/page.tsx`.

Follow-ups (in `tasks.md`):
- Edit-task form mirror — currently only the create form collects delivery. Editing a task's delivery after creation still requires a DB patch or agent-driven `cron_update`.
- Server-side warning when prompt mentions user-facing verbs (`kirim`, `ingatkan`, `beritahu`, `notify`) but delivery is empty — non-blocking "yakin mau silent?" hint.
- Auto-populate delivery when the task is created while a Connector Context is present (e.g. an agent-mode chat on a Telegram binding).

## 2026-04-16 — Cron preamble: conditional on delivery presence — silent/internal tasks no longer refuse with "no delivery config"

Field bug: cron tasks created without a `[Cron Delivery]` config (UI `cron-tasks/new` form collects zero delivery fields; agent-invoked `cron_create` has `delivery` optional) fired with a preamble that demanded the agent "MUST call a delivery tool from [Cron Delivery]" even though no such block existed. Agent correctly-but-frustratingly refused with "tidak ada konfigurasi Cron Delivery". Common failure mode: slash-command-only prompts like `/marky-send only_content link` (where the command already owns its own output), internal tasks (file writes, conditional cron_create, heartbeats), etc.

Root cause design gap: the preamble was written for the "reminder-on-a-channel" case (user says "ingatkan saya jam 6" in Telegram → agent writes cron with delivery pointing back to that chat) and assumed `[Cron Delivery]` would always be present. Any task lacking it was silently mis-served with strict delivery prose.

Fix (`apps/studio/server/src/cron/context.ts`):

- New helper `hasUsableDelivery(delivery)` — returns true only when at least one addressable field is present (`target_name`, `scope_key`, or `chat_id`). A bare `{ connector_id }` / `{ platform }` is metadata-only and fails the check.
- `buildCronTriggerPreamble(hasDelivery: boolean)` now accepts a flag:
  - `true` → existing strict "CRITICAL DELIVERY RULE / REQUIRED OUTPUT FORMAT" prose.
  - `false` → new "TASK MODE — SILENT / INTERNAL" variant telling the agent: execute the Instruction with the tools available; don't refuse with "no delivery config"; if the Instruction implies user-facing output but no channel was configured, do your best and end with an internal log line noting the misconfiguration (operators can see the task log even if users can't).
- `composeCronRunInput` passes `hasUsableDelivery(ctx.delivery)` AND skips appending `buildDeliveryBlock` entirely when the spec isn't usable (no more empty/dangling header block).

Behavior after fix:
- Cron with `delivery: { target_name: "...", connector_id: "..." }` → strict mode, unchanged.
- Cron with `delivery: {}` or `context: {}` (the UI default) → silent mode. Agent just executes the Instruction. Slash commands in the prompt work because the command dispatcher handles its own output.

Follow-ups (in `tasks.md`):
- UI `cron-tasks/new/page.tsx` still collects zero delivery fields. Add a Channel Target selector (dropdown from `connector_targets` for the project) + optional raw `chat_id`/`thread_id`/`scope_key` fallback inputs. When user picks a target, populate `context.delivery` on create.
- Server-side warning on create: if prompt contains obvious user-facing verbs (`kirim`, `ingatkan`, `reply`, `notify`, `beritahu`) and delivery is empty, surface a non-blocking warning in the UI.

Files: `apps/studio/server/src/cron/context.ts`.

## 2026-04-16 — Telegram userbot: `replyTo` must be a plain number (not object) in mtcute v0.27 + single-value semantic

Field bug from the prior streaming-reply fix: passing `replyTo: { messageId, threadId }` as a plain object crashed every send with `TypeError: undefined is not an object (evaluating 'params.replyTo?.chat.inputPeer')` at `@mtcute/core/send-common.js:27`. mtcute's high-level API overloads `replyTo`:

- `number` → treated as a message id (TL `replyToMsgId`), `replyToPeerId` left undefined
- `Message` instance → extracts `.id` AND reads `.chat.inputPeer` for `replyToPeerId`
- anything else → crash at `.chat.inputPeer` access

The TL construct (`inputReplyToMessage` at send-common.js:45-54) does NOT expose `top_msg_id` at all in this version — so there's no high-level way to say "reply to message X AND route to topic Y simultaneously". mtcute's own `answerText` (send-answer.js) hacks around this by using `replyTo = threadId` for topic messages (i.e. "reply to the topic's root message") which loses the quote-bubble UX.

Fix — single-value `replyTo` with preference order:
1. **Message id present** (`ctx.event.ref_keys.message_id` for streaming / `target.reply_to_ref_keys.message_id` for sendMessage) → `replyTo: Number(messageId)`. Telegram server auto-inherits the topic from the replied message, AND renders the "replying to…" quote. Best of both.
2. **Only threadId** → `replyTo: Number(threadId)`. Posts into the topic (no quote). Matches mtcute's `answerText` idiom.
3. **Neither** → no `replyTo`.

`sendMessage()` also defends against agent-supplied `content.params.replyTo: { messageId: ... }` objects by normalising to number before the value reaches mtcute — otherwise the same crash surfaces from the tool-call path.

Alternative considered: use mtcute's `client.replyText(message, text, params)` shortcut directly. Rejected because it requires the live `Message` instance from `event.raw_payload` — fragile if any pipeline step JSON-serialises the event.

Files: `plugins/jiku.telegram/src/user-adapter.ts` (handleResolvedEvent `sendOpts` builder, sendMessage `replyTo` normaliser).

## 2026-04-16 — Telegram userbot: streaming handoff threads threadId + literal reply (topic messages now land in the right topic, visible "replying to…" quote)

Follow-on from the topic/thread_id inbound fix: binding routed correctly but the agent's reply still landed in the forum's General topic because `handleResolvedEvent` (`user-adapter.ts:859`) was calling `client.sendText(peer, '⌛')` without opts on four separate paths — initial placeholder, continuation placeholder (overflow split), edit-failure fallback, and no-edit final fallback. mtcute defaults to General when `replyTo` is absent. Separately, the userbot reply had no "replying to…" chat-bubble quote, so from the user's side there was nothing visually tying the bot's response to the message that triggered it (bot adapter has done this since Plan 22 via `reply_parameters`).

Fix — parity with `bot-adapter.ts:1679-1686`:
- Hoist `replyToMsgId = ctx.event.ref_keys['message_id']` + `threadId = ctx.event.ref_keys['thread_id']` at the top of `handleResolvedEvent`.
- Build one `sendOpts: { replyTo: { messageId, threadId } }` (conditional — threadId only when message originated in a topic) and thread it into ALL FOUR `client.sendText` call sites. `editMessage` calls don't need the opts — the targeted message already carries its topic + reply context from the placeholder send.
- Also extended `sendMessage()` (non-streaming outbound, `user-adapter.ts:720`) to consume `target.reply_to_ref_keys.message_id` when building `opts.replyTo`. Base-merge precedence: whatever the caller set via `content.params.replyTo` wins; we layer `messageId` / `threadId` on top only when they aren't already present. Preserves agent override ability for cases like "reply to a different message in the same topic".

UX: placeholder `⌛` now appears as a reply to the user's inbound, landing in the same topic. Edit-in-place progresses the same message. Final text still attached as a reply quote → looks exactly like a normal Telegram bot responding.

Files: `plugins/jiku.telegram/src/user-adapter.ts` (handleResolvedEvent header + 4 sendText calls + sendMessage replyTo builder).

## 2026-04-16 — Telegram userbot: mention + reply-to-self detection (binding `trigger_mode='mention'` now works)

Userbot inbound normalize was silently breaking the mention-gated binding mode. `event-router.ts:243-253` checks `event.metadata.bot_mentioned === true` when `trigger_mode='mention'` and no custom tokens configured — bot adapter populated this since Plan 22 (`bot-adapter.ts:918-935`), userbot never did. Result: every mention-filtered userbot binding silently skipped all events in groups (because `bot_mentioned` was undefined → filter returns false → binding rejected).

Fix (`user-adapter.ts normalizeInbound`) — layered detection for maximum reliability:
1. **Primary: `m.isMention === true`** — mtcute's precomputed "self is mentioned" flag (computed server-side + entity-table aware). Authoritative when present.
2. **Entity scan fallback** — iterate `m.entities[]` for `type === 'mention'` substring-matching `@<myUsername>` (case-insensitive), plus `type === 'text_mention' | 'mentionName'` matching `entity.user?.id ?? entity.userId === myUserId`. Accepts both naming conventions because mtcute build variance surfaces user-id text mentions under either name.
3. **`bot_replied_to`** — true when `m.replyToMessage.sender.id === myUserId` (falls back to `senderId` field). Covers "user replied to a message I sent earlier" semantics. Also correctly fires for forum-topic-root messages the userbot itself originated (semantically a reply-to-self).

Metadata fields are spread conditionally — only present when true (matches bot adapter shape exactly so event-router's equality check passes identically for both adapters).

Verified: binding `trigger_mode='mention'` with empty `trigger_mention_tokens` now gates on the adapter-populated flag identically between bot and userbot. Custom-token mode (tokens non-empty) was already adapter-agnostic — router does substring match on `event.content.text` directly.

Files: `plugins/jiku.telegram/src/user-adapter.ts` (normalizeInbound, ~45 new lines).

## 2026-04-16 — Telegram userbot: forum topic / thread_id parity with bot

Reported bug: userbot inbound in a forum topic never routed to a topic-scoped binding — event-router matched `ref_keys.thread_id` strictly and userbot was never populating it. Bot adapter (grammy) has had topic support since Plan 22 (see `bot-adapter.ts:1001` + `computeScopeKey` + `autoRegisterForumTopic`); userbot was stuck at chat-level scope.

Root cause: `normalizeInbound()` in `user-adapter.ts` built `ref_keys` with `message_id` + `chat_id` only, and set `scope_key = group:${chatId}` unconditionally. mtcute DOES expose topic info on inbound — `msg.isTopicMessage: boolean` + `msg.replyToMessage?.threadId: number` (already captured into `metadata.reply_to.thread_id` by `extractMtcuteReply`, but not surfaced to the router as a ref_key).

- **Inbound extraction** (`user-adapter.ts:585 normalizeInbound`): read `m.isTopicMessage && m.replyToMessage?.threadId`, add `thread_id` to `ref_keys` and `:topic:<id>` to `scope_key`. Matches grammy's `msg.message_thread_id` branch exactly.
- **Scope helpers** (`user-adapter.ts`): added `override computeScopeKey` + `override targetFromScopeKey` mirroring bot-adapter's grammar (`group:{chatId}[:topic:{threadId}]`). This is what lets outbound tools resolve a scope_key string back to `{ chat_id, thread_id }` when the agent supplies `target_scope_key` directly.
- **Outbound routing** (`user-adapter.ts sendMessage`): resolve `threadId` with explicit-`ref_keys > scope_key fallback` precedence (mirrors `bot-adapter.ts:1565-1575`), then forward into mtcute's `opts.replyTo` as `InputReplyTo` shape — merges with whatever reply shape the caller may have passed. `replyTo: { threadId }` is the correct mtcute idiom for "send into this topic without replying to a specific message".
- **Auto-register topic target** (`user-adapter.ts autoRegisterForumTopic`): on first topic message sighting, fire-and-forget create a `connector_target` row keyed `<chat-slug>__topic-<threadId>` so the topic is addressable by name AND remembered in Channels UI. Matches bot adapter pattern at `bot-adapter.ts:696-727`. Caveat: mtcute's inbound Message does NOT carry the forum topic name (grammy has `reply_to_message.forum_topic_created.name`; mtcute exposes only `isForumTopic + threadId`). We use fallback name `topic-<threadId>` and leave `thread_title: null`. Enriching via `client.getForumTopics(peer)` is a follow-up — adds one RPC per first-sighting and needs FLOOD_WAIT handling.

Bot adapter verified unchanged — inbound (`bot-adapter.ts:1001`), scope helpers (`:178-200`), outbound (`:1565-1580`), auto-register (`:696-727`), action `thread_id` params (`:402,506,522,550,590`), `getParamSchema` (`:1631`) all intact.

Files: `plugins/jiku.telegram/src/user-adapter.ts`.

Follow-ups (see `tasks.md`):
- Enrich userbot auto-registered topic targets with real names via `client.getForumTopics(peer)` — single RPC per first-sighting, needs FLOOD_WAIT guard.
- Extract `slugifyChannelTitle` into `shared/helpers.ts` — currently duplicated between bot + userbot adapters.
- Userbot action registry (`forward_message`, `send_photo`, `send_video`, `send_media_group`, `copy_message`, etc.) still ignores `thread_id` param — add topic targeting to each, matching bot's action schemas at `bot-adapter.ts:228+`.
- Userbot `getParamSchema()` override — currently missing entirely; agents can't self-discover topic/reply params.

## 2026-04-16 — Plan 26: `jiku.sandbox` plugin + `run_js` tool + `RuntimeContext.llm` bridge

System-scoped plugin for sandboxed JS/TS execution. Agents get one compute primitive (`run_js`) with three source modes — raw `code`, disk `path`, or `prompt` (LLM generates code from goal inside the tool, so agent context doesn't eat the full source). Sandbox is QuickJS isolate with hard memory/stack/CPU limits; no Node APIs leak in.

- **Core change (prerequisite):** new `LLMBridge` interface on `RuntimeContext.llm?` so tool handlers can call the agent's active LLM directly. Runner constructs the bridge via AI SDK `generateText` bound to the agent's resolved provider/model; plugins may override `provider`/`model`/`system`/`temperature`/`maxTokens` per call. See ADR-104.
- **Plugin entry** (`plugins/jiku.sandbox/src/index.ts`): `project_scope: false`, `configSchema` exposes `max_concurrent` (5), `max_queue_depth` (20), `queue_timeout_ms` (30s), `exec_timeout_ms` (120s), `memory_limit_mb` (50), `stack_limit_kb` (1024), `allowed_path_roots` (empty = allow-all), optional `llm_override`, `prompt_cache_ttl_ms` (1h).
- **Tool `run_js`**: Zod discriminated union input on `source.type` = `code` | `path` | `prompt`. Returns `{ mode, output, logs, error?, errorDetail?, executedCode?, executionMs, queueWaitMs }`. Typed errors: `queue_full`, `queue_timeout`, `exec_timeout`, `eval_error`, `transpile_error`, `read_error`, `llm_error` — agent can differentiate "system overloaded" vs "code broken". `executedCode` always populated for `path` + `prompt` modes so the agent can debug what actually ran.
- **Queue** (`src/queue/semaphore.ts`): module-level `Semaphore` captured in closure. Configure-able at runtime via `configure()`. FIFO waiting list; request rejected when waiting count exceeds cap.
- **Sandbox runner** (`src/sandbox/runner.ts`): ported from `refs-bak/js-sandbox.ts` (senken-specific bridges stripped — `senken.getCandles`, `senken.finance.*`, `senken.vfs.*`, `ANALYSIS_HELPERS`). Kept: QuickJS dispose lifecycle, `console.log/warn/error` capture into `logs[]`, `__jiku_result`/`__jiku_error` capture pattern. Bugs fixed: empty `wrapCode` body reimplemented in `src/sandbox/wrap.ts` (auto-return last expression via STMT_KEYWORDS regex); duplicate legacy `inFlightCount`/`disposing` aliases removed.
- **Transpile** (`src/sandbox/transpile.ts`): `Bun.Transpiler` with `loader: 'ts'` when TS declared or heuristically detected (type annotations, interfaces, `as const`, generic `<T>`). JS passes through.
- **Prompt mode** (`src/source/from-prompt.ts`): constructs a tight system prompt ("output raw JS only, no markdown fences"), calls `ctx.runtime.llm.generate(...)` with `temperature: 0`, strips any stray ```` ``` ```` fences. Cache keyed by `sha256(system_version + model + prompt)` stored in plugin storage with TTL. Cache hits skip the LLM call entirely.
- **Path mode** (`src/source/from-path.ts`): requires absolute path, rejects `..` segments, honors `allowed_path_roots` whitelist when non-empty. Language auto-detected from file extension.

Deploy: `bun install` to pick up `quickjs-emscripten` (^0.31.0). No migrations needed — system-scoped plugin picked up at next server start.

Follow-ups (in `tasks.md`): hot-reload system-plugin config from Studio UI storage; `emitUsage` accounting for bridge LLM calls; Python sandbox leg; wire `skill_exec_file` (JS/TS skills) to `run_js`; extra bridges inside QuickJS (`fetch`, timers, project-disk read-only); agent-facing queue snapshot tool.

Files: `packages/types/src/index.ts`, `packages/core/src/runner.ts`, `plugins/jiku.sandbox/**`, `docs/plans/26-sandbox.md`, `docs/feats/sandbox.md`, `docs/builder/decisions.md` (ADR-104).

## 2026-04-17 — Fix: folder rename at root makes folder vanish from explorer

Reported in prod: rename `/bak` → `/bak1` and the folder disappears from the file explorer disk view. Root cause: the folder-move branch in `FilesystemService.move()` wrote `parent_path = '/'` (the string) for top-level folders, while `listSubfolders('/')` only matches rows where `parent_path IS NULL`. Convention mismatch — `mkdir` and `upsertAncestorFolders` already normalize root parent to `null`; move missed it.

- Fix: in `service.ts` folder-move loop, treat `nodePath.dirname(...) === '/'` the same as root (write `null`), matching `upsertAncestorFolders`.
- Note for ops: rows seeded by migration `0009_filesystem_revision_v2.sql` use `parent_path = '/'` (string) for top-level folders. Those would also be invisible to `listSubfolders('/')`. If any user reports missing root-level folders that pre-date the rename fix, heal with: `UPDATE project_folders SET parent_path = NULL WHERE parent_path = '/';`
- Files: `apps/studio/server/src/filesystem/service.ts`

## 2026-04-16 — Telegram userbot: streaming `handleResolvedEvent` (placeholder + tool chips, slow debounce)

Per user feedback "kok typing simulate ga ada di telegram self bot". Bot adapter has shipped streaming UX since ADR-087 (placeholder `⌛` → debounced edits → tool chips → final markdown render); userbot was stuck on the legacy accumulate-then-send path because mtcute's edit semantics + userbot flood thresholds needed different pacing.

- New `TelegramUserAdapter.handleResolvedEvent(ctx)` mirrors the bot's interleaved segment renderer (chronological text + tool groups separated by `---`), with three userbot-specific tunings:
  - **Plain text only.** mtcute v0.27 high-level `editMessage({chatId, message, text})` doesn't carry parseMode in this build; tool chips render as literal `[🔧] name` / `[☑️] name` / `[❌] name` (no italic) and `---` separators are bare. Matches what userbot's `sendMessage` already does (the existing markdownify path was producing visible backslashes for the same reason).
  - **First edit 1500ms, subsequent 5000ms.** User-tested cadence: fast first feedback (so `⌛` doesn't sit dead for ~5s), then 5s pacing keeps total throughput at ~12 edits/min — well under any realistic FLOOD_WAIT / PEER_FLOOD threshold even with multi-chat concurrency.
  - **Queue-respecting.** Every placeholder / edit / continuation / final-fallback call goes through `UserbotQueue.enqueue(...)` so the global 20/min sliding window + per-chat 1000ms min gap + FLOOD_WAIT pause latch all still gate. Edit failures (FLOOD_WAIT mid-stream, mtcute MESSAGE_NOT_MODIFIED no-op) swallowed silently for intermediate ticks; final edit falls back to `sendText` if it errors so the user always sees SOMETHING.
- **editMessage probe at call-time.** Some mtcute builds don't expose `editMessage`; in that case we skip placeholder + intermediate edits and just send a single `sendText` at stream end. No regression for builds without edit support.
- **Overflow at 4000 chars.** Same as bot — finalize current message, send fresh `⌛` continuation, reset segments, resume.
- Outbound logging (`logOutboundMessage` + `logOutboundEvent`) + `recordUsage` invoked at finalize, mirroring bot adapter so Channels Events / Messages / Usage tabs pick up streamed userbot runs the same way.
- Files: `plugins/jiku.telegram/src/user-adapter.ts` (new method ~270 lines), imports added for `ResolvedEventContext` + `TELEGRAM_MAX_LENGTH`.

ADR-087 (streaming adapter handoff) decisions unchanged — this is a faithful port with platform-specific knobs. Memory note added: "userbot streaming = plain text, 1.5s/5s debounce, queue-wrapped".

## 2026-04-16 — Telegram: inbound media-group (album) debounce + outbound photo/video/group parity

Field feedback: a user who sent an album of N photos triggered N separate bot runs (one per item, each with one photo), yielding N replies. Agent also didn't have parity across bot vs userbot for single photo / single video / multi-photo / multi-video send.

### Inbound media-group debounce (bot adapter)
- Module-level Map `mediaGroupBuffers` keyed by `${connector_id}:${chat_id}:${media_group_id}`. First arrival arms a 5s timer (`MEDIA_GROUP_DEBOUNCE_MS`), subsequent arrivals append without resetting. On flush the adapter emits ONE `ConnectorEvent` with `content.media_items[]` (public metadata, no file_id) + `metadata.media_items[]` (adapter-internal `{ message_id, media_file_id, media_type, media_file_name, media_mime_type, media_file_size }` per item) + `metadata.media_group_id`. `content.media` also populated with item[0] for back-compat. `raw_payload = { media_group: true, media_group_id, updates: [...grammy updates...] }` so every item's original photo/document object (with `file_id`) is preserved for inspection in the Channels Events detail drawer.
- `bot_mentioned` / `bot_replied_to` OR-accumulated across items (a mention in any caption counts).
- `onDeactivate` drops pending buffers for the deactivating connector (clears timers) — avoids firing events into a torn-down ctx.
- Userbot adapter NOT covered yet; backlog entry added.
- `fetch_media` action gained optional `index` param (0-based) — agent calls once per item. Returns `{ path, size, index, total_items }` for groups. Back-compat: omitting `index` on a group returns item[0]; passing `index>0` on a non-group event errors clearly.
- `event-router.ts` context hint distinguishes group vs single: `Media group available: 5 items (4 photos, 1 video) ~2480KB total (event_id: "...") — use connector_run_action("fetch_media", { event_id, index: 0..4, save_path: "..." }) — call once per item to fetch all`.
- Extracted forum-topic auto-register into `autoRegisterForumTopic(msg, forumTopicName, connectorId)` so both inbound paths (single + group-flush) share it.

### Outbound parity (bot + userbot)
- **Bot**: added `send_video` action. `send_photo` / `send_video` / `send_file` accept exactly one of `file_path` / `url` / `file_id` (file_id = re-send media the bot received earlier without re-upload — Bot API accepts file_id strings directly, same-bot constraint). `send_url_media` `type` enum extended with `"video"`. `send_media_group` items extended with `file_id?` so albums can mix uploaded + re-used media. `sendMediaGroup` + `sendSingleMedia` internals now dispatch `url` vs `file_id` vs uploaded-bytes based on item shape.
- **Userbot**: added `send_video` (url / path / file_id; uses mtcute `sendVideo` with `sendMedia`+type:'video' fallback). Added `send_media_group` (uses mtcute `sendMediaGroup` with `{ type, file, caption?, parseMode? }[]` shape; max 10 items). Extended `send_photo` / `send_document` to accept `file_id` (mtcute's `UploadFileLike` takes a bare string as TDLib/Bot-API file_id). Shared `resolveMediaInput({ url, path, file_id })` helper enforces "exactly one source" across all four actions.

### File-id capture (inbound, confirmed intact)
Audit done per field question. file_id ends up in TWO places on every inbound media row — the agent-invisible `metadata` (for `fetch_media` lookup) AND the admin-visible `raw_payload` (for debugging in the Channels Events detail drawer).
- Single media: `metadata.media_file_id` + `raw_payload.message.{photo[]|document|video|voice|sticker}.file_id`.
- Album (after debounce flush): `metadata.media_items[].media_file_id` (per item) + `metadata.media_file_id` (item[0] back-compat) + `raw_payload.updates[].message.*.file_id` (full per-item grammy updates preserved).
- Public `ConnectorEventMedia` / `content.media*` deliberately omits `file_id` per Plan 22 / ADR-058 — agent uses `fetch_media({ event_id, index? })` which reads from `metadata`.

### Type changes
- `packages/types/src/index.ts`: `ConnectorEvent.content.media_items?: ConnectorEventMedia[]` (new — populated by album-capable adapters; singular `media` kept for back-compat).
- `packages/types/src/index.ts`: `ConnectorMediaItem.file_id?: string` (new — outbound re-use without re-upload).

### Files
`packages/types/src/index.ts`, `plugins/jiku.telegram/src/shared/{constants,helpers}.ts`, `plugins/jiku.telegram/src/bot-adapter.ts`, `plugins/jiku.telegram/src/user-adapter.ts`, `apps/studio/server/src/connectors/event-router.ts`. See ADR-103 and `docs/feats/connectors.md` Telegram-specific section.

## 2026-04-15 — Agent FS tools: full folder coverage (mkdir + move + delete)

User-stated invariant: "we're simulating a filesystem; everything that works for files must work for folders too — except moving the root `/` itself". Three agent-tool gaps closed.

- **`fs_mkdir` (NEW)** in `apps/studio/server/src/filesystem/tools.ts`. Wraps `fs.mkdir(path)`. Idempotent (existing folder is OK), creates ancestor chain. Permission gate uses `'write'` on the target path. Description says: "call this only when you need an EMPTY folder" — `fs_write` still creates folders implicitly via `upsertAncestorFolders`, no need to mkdir before writing.
- **`fs_move` description + tracker cleanup** updated: explicitly mentions folder support, calls new `forgetFsReadsUnderPrefix(conversationId, fromPath)` after the move so descendant tracker rows don't carry stale `STALE_FILE_STATE` errors keyed under the old folder path.
- **`fs_delete` extended**: detects file vs folder via `getFileByPath` then `getFolderByPath`. For folders, requires explicit `recursive: true` flag — without it returns `{ code: 'FOLDER_DELETE_REQUIRES_RECURSIVE' }` as a safety guard against an LLM accidentally wiping a tree thinking it's a file. Same descendant tracker cleanup as fs_move.
- **DB queries**: new `getFolderByPath(projectId, path)` in `queries/filesystem.ts`; new `forgetFsReadsUnderPrefix(conversation_id, prefix)` in `queries/conversation-fs-reads.ts`.
- File-only assumptions previously baked into `fs_move` / `fs_delete` descriptions caused agents to refuse folder ops or call them and get cryptic errors. New descriptions are explicit so agents pick the right tool first try.

## 2026-04-15 — Disk move: support folders (was file-only)

Field test: dragging a folder threw "Path not found" — `FilesystemService.move()` only handled files (`getFileByPath` then throw). Folders never worked, even from the old dialog.

- `service.ts move(from, to)`: try file lookup first; if missing, look up `project_folders` row. For folders: validate target doesn't conflict (no existing folder OR file at `to`), reject self-move + folder-into-own-descendant. Walk all descendant files (`getFilesUnderFolder`) and folder rows (prefix match), rewrite each path/folder_path/parent_path/depth in a single DB transaction (atomic). `to`'s ancestors get upserted afterwards so they exist if user dropped into a brand-new branch.
- Storage layer untouched — `storage_key` is UUID-based and immutable since Plan 16, so a folder rename is pure DB row updates. No S3 round-trips.
- Frontend already supported folder drag because the button renders `draggable` for both file and folder entries; client-side `canDropAt` guard already rejected folder-into-descendant — both checks now have server-side counterparts (defense in depth).

## 2026-04-15 — Disk: replace "Move to…" dialog with native drag-and-drop

User-requested UX change. The dialog-based move action (text input for absolute path) was clunky for the common case of "drop file into adjacent folder". Replaced with HTML5 drag-and-drop on the file tree.

- `file-explorer.tsx`: removed `MoveDialog` component + `movingEntry` state + `onMove` prop on `EntryDropdown`. Entry rows are now `draggable={canWrite}` (cursor `grab` / `grabbing`). Folder entries AND breadcrumb segments accept drops via `onDragOver` / `onDragLeave` / `onDrop`. Drop target shows a primary-coloured ring + bg highlight; dragged row drops to `opacity-40`.
- `canDropAt(target)` guard rejects: dragging onto self, into the entry's current parent (no-op), or a folder onto its own descendant (loop). Drop on `/` (root crumb) moves to root.
- `moveMutation.onSuccess` now distinguishes "Renamed" vs "Moved" by comparing `dirOf(from)` with `dirOf(to)` — same folder → rename, different → move. Helpers `dirOf` + `basenameOf` added at module level.
- `dragOverPath` cleared by a `relatedTarget`-aware `handleDragLeave` that ignores leaving into a child element (avoids flicker when the cursor moves inside the same drop target).
- Removed unused `Move` lucide icon import.

## 2026-04-15 — Disk ZIP: round-trip empty folders (both directions)

Field-check follow-up: empty folders weren't surviving the ZIP round-trip — import filtered out dir entries with `!e.dir` and export only queried files (not `project_folders`), so a folder you created via the UI would vanish after export → re-import.

- `filesystem/zip.ts importZip`: split `zip.files` into `dirEntries` (trailing slash / `.dir === true`) + `fileEntries`. Loop dirs FIRST, skip platform-junk (`__MACOSX/*` etc.) + path-traversal segments, call `fs.mkdir(normalized)` for each. `fs.mkdir` already chains ancestor `onConflictDoNothing` inserts so nested-empty-folder hierarchies work.
- `exportZipWith`: track folder roots from the input `paths` and query `project_folders` for each (whole-disk shortcut when root is `/`). Emit `zip.folder(entryPath)` dir markers before file entries — JSZip / unzippers both honour trailing-slash entries as dir-only records. Non-empty folders get redundant markers (no-op) but empty ones now survive.
- `ImportResult` gained `folders_created: number`; dialog renders a "Folders" stat tile when > 0; toast summary includes the count.
- Export return shape gained `folderCount`; exposed via new `X-Folder-Count` response header; web toast reads both counts.

## 2026-04-15 — Disk ZIP import: skip platform junk + null-byte defense

Field-test failure: user imported a Mac-zipped archive and got `__MACOSX/._test.csv` failing with a Postgres insert error. Root cause: macOS Finder emits AppleDouble resource forks (`__MACOSX/` folder + `._*` sibling files) that contain binary data with null bytes, which Postgres `text` columns explicitly reject.

- `filesystem/zip.ts`: new `isPlatformJunk(entryPath)` helper — matches `__MACOSX/*`, `.DS_Store`, `Thumbs.db`, `desktop.ini`, any `._<name>` AppleDouble file. Silently dropped (not counted as imported/skipped/failed) but surfaced as new `skipped_junk` counter so the UI can show "dropped N platform-junk entries" for transparency.
- `ImportResult` gained `skipped_junk: number`.
- Defense-in-depth: after encoding content to text, explicitly reject null bytes for text-mode extensions BEFORE the DB write — produces a clean "File contains null bytes" error instead of letting the cryptic Postgres query failure propagate. Check runs before conflict resolution so counters never need rollback.
- UI (`ImportZipDialog`): renders a muted hint line when `skipped_junk > 0` listing the common platform-junk patterns.

## 2026-04-15 — Disk: ZIP export/import + Move action in entry dropdown

End-to-end ZIP round-tripping for the project virtual disk + a long-missing Move action on file/folder rows.

**Backend**
- New dep `jszip ^3.10.1` in `apps/studio/server/package.json` (run `bun install`).
- New module `apps/studio/server/src/filesystem/zip.ts` — `exportZipWith(fs, projectId, paths)` walks a mixed list of file/folder paths (folders expand to descendants), pulls raw bytes (decoding `__b64__:` prefix for binary files), and packs into a JSZip archive. `importZip(fs, projectId, buffer, { targetFolder, conflict })` extracts each entry, validates against the allow-list / size cap, and writes via `FilesystemService.write()`. Conflict policy: `overwrite | skip | rename` (rename suffixes ` (1)`, ` (2)`, … until free, capped at 999 attempts).
- Caps: `MAX_ZIP_BYTES` 50MB, `MAX_ZIP_ENTRIES` 5000 — defends against zip-bomb / OOM.
- Path-traversal guard: any entry containing `..` segment is rejected with a per-file error rather than crashing the whole import.
- Routes: `POST /projects/:pid/files/export-zip` body `{ paths: string[] }` (gated `disk:read`) responds `application/zip` with `Content-Disposition` filename and `X-File-Count` header. `POST /projects/:pid/files/import-zip?path=&conflict=` (gated `disk:write` + `uploadRateLimit`) accepts multipart `file` field, returns `{ ok, target_folder, conflict, imported, overwritten, skipped, renamed, failed, errors[] }`.
- Reuses `MAX_UPLOAD_BYTES` for the multipart body cap so import body limits stay aligned with single-file upload limits.

**Web**
- `api.filesystem.exportZip(projectId, paths)` returns `{ blob, fileCount }` — caller triggers download via `URL.createObjectURL`.
- `api.filesystem.importZip(projectId, folderPath, conflict, file)` returns the structured result.
- `FileExplorer` toolbar (`components/filesystem/file-explorer.tsx`): two new icon buttons next to Refresh — Export current folder as ZIP (Download icon, also for `disk:read` users) and Import ZIP (FileArchive icon, gated `canWrite`). Spinner when export in flight.
- `EntryDropdown` adds two new actions: **Move to…** (opens `MoveDialog` — Dialog with absolute-path input, Enter submits, validates leading slash + non-empty filename) and **Export as ZIP** / **Export folder as ZIP** (depending on entry type). Move uses the existing `moveMutation` / `api.filesystem.move` — server already supported the operation; was a UI gap.
- New components: `MoveDialog` (in-file) and `ImportZipDialog` (in-file) — the latter has 3-pill conflict selector (Skip default / Overwrite / Rename) and a result panel with per-policy stat tiles + scrollable per-file error list.

## 2026-04-15 — Chat sub-sidebar: collapsible + mobile-friendly default

Chat page's conversation-list panel (`chats/layout.tsx`) was a fixed `w-72` rail with no way to hide — took too much screen on mobile. Now togglable, state persisted in `localStorage['chats.sidebar.open']`.

- `chats/layout.tsx`: state-owned toggle. Default: open on viewport ≥768px, closed on <768px (only when no persisted preference). Sidebar conditionally rendered; when collapsed, a small `PanelLeftOpen` ghost button floats top-left of chat area to re-open.
- `conversation-list-panel.tsx`: new optional `onCollapse?: () => void` prop. When provided, renders a `PanelLeftClose` ghost button next to the New-chat button in the panel header. Parent owns open/closed state.

## 2026-04-15 — Chat UI: `<active_command>` parser fix — false-close in preamble truncated body

Bug found in field test: the dispatcher's preamble inside the block contained the literal string `</active_command>` (in a sentence describing where the user trigger text appears). The lazy-match parser then bounded the accordion body at that fake close, so the actual SOP body + the real closing tag spilled into a raw text segment after the accordion.

- `commands/dispatcher.ts`: rephrased the preamble — replaced `"after </active_command>"` with `"after the active_command closing tag"`. Added a comment warning future editors not to inline the literal closing tag inside the body.
- `web/components/chat/active-command-block.tsx`: defense-in-depth — parser now uses `lastIndexOf(CLOSE_TAG)` capped at the next opening tag (or end-of-text). Greedy match against the LAST close before the next block. Multiple separate blocks still detected; streaming path unchanged. Verified with three test fixtures (fake-close in preamble, streaming-in-progress, two separate blocks).

## 2026-04-15 — Chat UI: `<active_command>` accordion shared + streaming-aware

The conversation viewer (`components/chat/conversation-viewer.tsx`) rendered user messages as raw `<span className="whitespace-pre-wrap">{part.text}</span>` — so `<active_command slug="...">...</active_command>` blocks (injected by the slash-command dispatcher) leaked as ugly XML into the message bubble. The chat-interface already had a proper `ActiveCommandBlock` accordion; extracted it to a shared module and applied to both.

- New `apps/studio/web/components/chat/active-command-block.tsx` — exports `MessageTextWithActiveCommands` + `ActiveCommandBlock` + `parseActiveCommandSegments`. Streaming-aware parser: matches BOTH closed blocks and an opening tag with no close yet (mid-stream). Unclosed segment renders the same accordion with a pulsing amber dot + "streaming" label + ` …` suffix inside the body preview.
- `chat-interface.tsx` — deleted local `MessageText` + `ActiveCommandBlock` duplicate, imports from the shared module. Cleaned up unused `ChevronDown` / `ChevronRight` / `Terminal` imports from lucide-react.
- `conversation-viewer.tsx` — replaced the raw-text `<span>` fallback for user messages with `<MessageTextWithActiveCommands>` so history view + chat-interface render identically.

## 2026-04-15 — Connector traffic mode (inbound_only / outbound_only / both)

Per-connector direction gate so operators can scope a connector to one direction based on strategy (broadcast-only notifier vs listen-only archive vs default both). Polling/lifecycle untouched — pure routing + tool-layer gate.

- New column `connectors.traffic_mode text NOT NULL DEFAULT 'both'` in Drizzle schema (`apps/studio/db/src/schema/connectors.ts`). User runs `db generate` / `db push` for the migration; no migration file shipped.
- Type `ConnectorTrafficMode = 'inbound_only' | 'outbound_only' | 'both'` in `@jiku/types`. Added required field `trafficMode` to `ConnectorContext` so adapters receive the mode at activation (informational — adapters may honour it but the gating is enforced server-side).
- `connectorRegistry`: cached `trafficMode` on activeContexts. New methods `setTrafficMode(connectorId, mode)` (called by PATCH route) + `getTrafficMode(connectorId)` (used by gates). Live update — no connector restart needed when the operator changes the mode.
- `activation.ts`: reads `connector.traffic_mode`, passes into `ctx.trafficMode` and `connectorRegistry.setActive(..., trafficMode)`.
- Inbound gate (`event-router.ts:routeConnectorEvent`): if `outbound_only`, finalize arrival row as `status='dropped'`, `drop_reason='traffic_outbound_only'` and return — no binding match, no agent run.
- `executeConversationAdapter`: if `inbound_only`, early-return — agent doesn't run, no reply sent. Inbound event still recorded as `routed` in connector_events.
- "Access request sent" notification sends in event-router (3 sites: invite-code redemption, DM Path B, pending-identity loop) skip when `inbound_only`.
- Outbound tool gates (`connectors/tools.ts`): `connector_send`, `connector_send_to_target`, `connector_run_action` return `{ code: 'TRAFFIC_INBOUND_ONLY', error }` when the target connector is `inbound_only`. Gate placed before outbound-approval interceptor so AR rows aren't created for traffic that can't be sent.
- PATCH `/connectors/:id` refreshes the registry's trafficMode cache when `traffic_mode` is in the body.
- UI: new `TrafficModeSection` component on the channel detail page (`channels/[connector]/page.tsx`), Select with 3 options + per-mode help text + Save/Reset. Gated by `channels:write`.
- Web `Connector` interface + `api.connectors.update` body updated for `traffic_mode`.
- Files: `packages/types/src/index.ts`, `apps/studio/db/src/{schema,queries}/connector*.ts`, `apps/studio/server/src/connectors/{registry,activation,event-router,tools}.ts`, `apps/studio/server/src/routes/connectors.ts`, `apps/studio/web/lib/api.ts`, `apps/studio/web/app/.../channels/[connector]/page.tsx`.

## 2026-04-15 — Connector events: ONE row per inbound, drop `pending_approval` status

Long-standing duplication where every inbound produced TWO `connector_events` rows (`received` from arrival logger + outcome row from the routing pipeline) — visible in the Channels Events tab as side-by-side duplicates. Folded into one row per event.

- New `updateConnectorEvent(id, patch)` query in `apps/studio/db/src/queries/connector.ts`.
- Telegram adapters (`bot-adapter.ts logArrivalImmediate` + `user-adapter.ts` inline arrival logger) now capture the inserted row and stamp `event.metadata.arrival_event_id` so the downstream router can address it.
- `event-router.ts`: new `finalizeEv(projectId, event, args)` helper UPDATEs the arrival row using `arrival_event_id`; falls back to INSERT when the id is missing (non-Telegram source). Replaced 5 routing-pipeline insert sites (`gatedLogEv` + 3 inline `logEv` for blocked/pending/rate_limited/routed) with `finalizeEv`. The connector_messages logging is unchanged (separate table).
- Vocabulary collapsed: `pending_approval` status removed entirely from connector_events. The two cases that used it (no_binding match, identity pending approval) now use `status='unhandled'` with `drop_reason` describing why (`'no_binding'` vs `'identity_pending'`). connector_messages `'pending'` status also folded into `'unhandled'` for consistency.
- New canonical `connector_events.status` vocabulary: `received | routed | unhandled | dropped | rate_limited | error`.
- `RouteResult` type updated; `routeConnectorEvent` returns `'unhandled'` instead of `'pending_approval'` (no consumer cared about the specific value — both call sites only check for errors).
- Frontend: `events-tab.tsx` removed `pending_approval` from STATUS_COLORS + filter dropdown; added `unhandled`. SSE live items now upsert by id (replace existing entry instead of prepending a duplicate when arrival → routed broadcasts arrive in order).
- Agent tool `connector_get_events` status hint rewritten with the new vocabulary + meaning.
- Known follow-up: when `connectors.log_mode='active_binding_only'` the arrival row stays as `received` (gate skips the finalize). Acceptable — same as before for that mode.

## 2026-04-15 — Action Request: removed `wait` tool, default to detached flow

User-requested behavior change: agent flow for AR is now ALWAYS detached. Agents create-and-move-on; the operator decision flows to its destination handler independently.

- Deleted `action_request_wait` tool from `apps/studio/server/src/action-requests/tools.ts` (removed schema, execute, helper `formatWaitResult`, import of `subscribeActionRequest`).
- Removed wait hint from `action_request_create` tool description + return value.
- Updated destination param description (no longer references wait pairing).
- Removed wait-pair hint from `connector_send` outbound-approval response (`connectors/tools.ts:434`) and from `connector_run_action` outbound-approval response (`connectors/tools.ts:634`) — both now explicitly tell the agent to MOVE ON.
- Pruned dead pubsub: `subscribeActionRequest` + `arChannel` removed from `action-requests/pubsub.ts` (only the wait tool ever subscribed). SSE hub continues to use the project-level channel.
- Cleaned doc-comments in `destination-outbound.ts` (no more "wait() resolves with rejected").
- Docs: rewrote `docs/feats/action-request.md` Architecture diagram, Agent tools, Outbound approval, Task checkpoint, and Realtime sections to reflect detached-only flow. Inline-wait task pattern removed entirely; only detached-resume remains.

## 2026-04-15 — Telegram userbot: clearer errors for `copy_message` / `forward_message` misuse

Diagnosed a real failure: agent passed a UUID as `message_id` AND a sender's `user_id` as `from_chat_id` (instead of the chat id where the message lives). mtcute returned the cryptic "Peer X is not found in local cache" with no recovery hint.

- `plugins/jiku.telegram/src/user-adapter.ts`: `copy_message` + `forward_message` now validate that `message_id` / `message_ids` parse to positive integers BEFORE calling mtcute. Returns `{ code: 'INVALID_MESSAGE_ID', error }` with explicit "not a UUID / connector_events.id" guidance.
- `plugins/jiku.telegram/src/shared/error-mapper.ts`: catches mtcute's "not found in local cache" / `PEER_ID_INVALID` and returns `{ code: 'PEER_NOT_CACHED', error }` explaining the two common causes (sender_id confused with chat_id, or session reset wiped the cache).
- Sharpened `customActions` descriptions on both `forward_message` and `copy_message` to be explicit about: (a) `from_chat_id` = the chat where the message LIVES (group id, NOT sender), (b) `message_id` = numeric Telegram id (NOT a UUID), (c) the userbot must have interacted with the peer for its access_hash to be cached.

## 2026-04-15 — Fix: project-scoped plugins leaked tools + prompts to all projects

`AgentRunner` punya `this.runtimeId` (= projectId) tapi 4 call site ke `PluginLoader` tidak pernah pass argument itu — `getResolvedTools()` dan `getPromptSegmentsWithMetaAsync()` dipanggil tanpa parameter, masuk branch `if (!projectId) return all` di loader, jadi filter `project_scope` tidak pernah aktif. Akibat: tools + system-prompt segment dari plugin `project_scope: true` (mis. `jiku.web-reader`, `jiku.analytics`, `jiku.social`) muncul di setiap project meski belum di-activate via `project_plugins`.

- Fix: pass `this.runtimeId` ke 4 call site (`run()` line 212 + 422, `previewRun()` line 886 + 907).
- Skills tidak terdampak — `propagatePluginSkills` hanya iterate `enabledRows`, jadi sudah benar.
- Storage tidak terdampak — keyed `${projectId}:${pluginId}`.
- Plugin UI route (`/api/.../tools`) tidak terdampak — sudah pass projectId benar.
- Files: `packages/core/src/runner.ts`.

## 2026-04-15 — Plan 25: Action Request Center (all 6 phases)

**Added:**
- New tables `action_requests` + `action_request_events` with strict state-machine
  transitions (migrations `0035_plan25_action_requests.sql`, `0036_plan25_outbound_approval.sql`).
- Service `apps/studio/server/src/action-requests/` with pluggable destination handlers
  (`outbound_approval`, `task`, `task_resume`, plus null/sync-wait).
- Routes `/api/projects/:pid/action-requests[/stream]`, `/api/action-requests/:id[/respond,/drop]`.
- Per-AR + project-scoped in-process pubsub bus driving `action_request_wait` long-poll
  and SSE UI updates.
- Periodic 30s expiry sweep (in-bootstrap setInterval).
- Agent tools `action_request_create`, `action_request_wait`, `action_request_list`
  wired into all three `built_in_tools` assembly sites in `runtime/manager.ts`.
- Outbound interceptor in `connector_send`: connector-level `outbound_approval.mode`
  (`none` | `always` | `tagged`) holds messages as boolean ARs; `params.skip_approval`
  bypass for system messages.
- Task-checkpoint integration: `task_resume` handler injects synthetic `[Operator
  decision]` message and re-invokes `runTaskConversation` against existing convId;
  `task` handler spawns NEW task with response interpolated into `prompt_template`.
- UI: `/studio/.../actions` page with 3 tabs (Active/Recent/Dropped), per-type response
  forms (boolean buttons, choice buttons, input, multi-field form), SSE hookup,
  pending-count sidebar badge, drop confirm.
- UI: outbound-approval mode dropdown on connector detail page.
- Permissions: `action_requests:read|respond|write` added to `PERMISSIONS` enum and
  role presets (Owner/Admin/Manager get all three; Member gets `:read`).
- Audit event types: `action_request.{created,viewed,responded,dropped,expired,executed,execution_failed}`.
- Docs: `docs/feats/action-request.md` with architecture, types, destinations, flow
  details, file map, and known limitations.

**Pre-deploy:**
- Apply migrations `0035_plan25_action_requests.sql`, `0036_plan25_outbound_approval.sql`.
- No new env vars; no new external services.

## 2026-04-15 — Runs cancel: ownership gate + real stream abort

**Changed:**
- `POST /conversations/:id/cancel` previously gated by `runs:read` (any viewer could stop anyone's run). Now chat runs require `conv.caller_id === userId` OR superadmin — personal streams can't be cancelled by teammates. Task/heartbeat runs accept owner, superadmin, or new `runs:cancel` perm.
- New permission `RUNS_CANCEL` (`runs:cancel`) in enum + `ROLE_PRESETS.manager`. Migration `0034_runs_cancel_permission.sql` backfills Owner/Admin/Manager.
- Role editor UI exposes the toggle with explicit note that chat cancels stay owner-only regardless.
- `streamRegistry` now carries an `AbortController` per run. New method `abort(conversationId)` fires the controller + broadcasts SSE `aborted` event. Chat reader loop listens on `abortSignal` → `reader.cancel()` unwinds. Finally-block writes `run_status='cancelled'` to DB (covers race with the endpoint's own flip). So cancel actually stops the LLM stream now, not just the DB label.
- Task/heartbeat runners still not registered in streamRegistry — abort just writes the DB label and the runner picks it up on next poll iteration. Comment notes this.

**Files touched:** `packages/types/src/index.ts`, `apps/studio/db/src/migrations/0034_runs_cancel_permission.sql` (new), `apps/studio/server/src/routes/runs.ts`, `apps/studio/server/src/routes/chat.ts`, `apps/studio/server/src/runtime/stream-registry.ts`, `apps/studio/web/app/(app)/studio/companies/[company]/projects/[project]/settings/permissions/page.tsx`

## 2026-04-15 — Permission audit across all features

**Changed:** End-to-end audit of every sidebar feature's permission enforcement at four layers: server route guards, UI page guards, sidebar keys, and UI write-button gating. Follow-up fixes after the earlier permission-coverage expansion.

- `filesystem.ts`: 6 write routes (POST `/files`, POST `/files/folder`, PATCH `/files/move`, DELETE `/files`, DELETE `/files/folder`, POST `/files/upload`) were set to `disk:read` by a prior bulk replace — restored to `disk:write`.
- Browser page guard: `agents:read` → `browser:read`.
- Cron Tasks / Skills / Commands pages were missing `withPermissionGuard` entirely — added.
- UI write gating: Skills + Commands + Cron Tasks hide Create / Delete / Archive / Restore buttons for `:read`-only users. `FileExplorer` + `FileDetailPanel` gained `canWrite` prop consumed by Disk + Skills + Commands editors (hides New file / New folder / Upload / Rename / Delete / Save; CodeEditor becomes read-only). EntryDropdown hides Rename + Tool permission + Delete when read-only.
- Disk GET `/filesystem/config` + POST `/filesystem/test` now accept `disk:read` OR `settings:read` via `requireAnyPermission` — fixes "Virtual Disk not configured" false-positive for readers. Storage Config tab hidden for users without `settings:read`.
- Built-in **image viewer** adapter for `.png/.jpg/.jpeg/.gif/.webp/.svg/.bmp/.avif`. Uses signed inline proxy URL. Zoom 25-800%.
- Memory routes verified — DELETE/PATCH use manual `loadPerms` + explicit check (equivalent to `requirePermission`).

**Files touched:** `apps/studio/server/src/routes/filesystem.ts`, `apps/studio/web/app/(app)/studio/companies/[company]/projects/[project]/{browser,cron-tasks,skills,commands,disk}/page.tsx`, `apps/studio/web/components/filesystem/{file-explorer,file-detail-panel,adapters/index}.tsx`, `apps/studio/web/components/filesystem/adapters/image-adapter.tsx` (new)

## 2026-04-15 — Sidebar restructured into grouped sections

**Changed:** `NAV_ITEMS` flat array → `NAV_SECTIONS` with `label: string | null` grouping. Sections: (no-header) Dashboard, AI (Agents / Chats / Memory / Skills / Commands), Tools (Channels / Cron Tasks / Browser / Disk), History (Runs / Usage), Config (Plugins / Console / Settings). Renders with `SidebarGroup` + `SidebarGroupLabel`. Plugin sidebar slots render last — `PluginSidebarSlot` already renders its own SidebarGroup so the parent no longer wraps it (fixes double-header).

**Files touched:** `apps/studio/web/components/sidebar/project-sidebar.tsx`

## 2026-04-15 — Permission coverage expansion (Skills, Commands, Browser, Disk, Usage, Console)

**Changed:** Six feature groups that previously piggy-backed on `agents:*` or `settings:*` now have dedicated permission keys. This lets role admins grant/revoke each feature independently instead of lumping them into over-broad grants.

- `PERMISSIONS` enum in `packages/types`: added `SKILLS_READ/WRITE`, `COMMANDS_READ/WRITE`, `BROWSER_READ/WRITE`, `DISK_READ/WRITE`, `USAGE_READ`, `CONSOLE_READ`.
- `ROLE_PRESETS`: Manager gets full r/w on new groups; Member gets read-only (skills/commands/disk/console); Viewer unchanged.
- Migration `0033_permissions_expanded.sql` backfills Owner/Admin/Manager (full list) + Member (read subset) into existing roles so live projects don't lose menus.
- Role editor UI (`settings/permissions/page.tsx`) renders toggle groups for each new category.
- Sidebar `NAV_SECTIONS` now uses the correct permission key per item (Skills→skills:read, Browser→browser:read, Disk→disk:read, Usage→usage:read, Console→console:read, Commands→commands:read).
- Server route guards updated: `skills.ts`, `commands.ts`, `browser.ts`, `browser-profiles.ts` swapped from `agents:*`/`settings:*` → their dedicated keys; `filesystem.ts /files/*` user-facing endpoints → `disk:*` (backend `/filesystem/config` stays on `settings:*` since it configures storage infra); `projects.ts /usage` → `usage:read`.
- Console router documents its defense-in-depth stance: project-level URL gating isn't present (console ids are free-form), so `console:read` is enforced at UI (sidebar + withPermissionGuard). IDs are not secrets.

**Files touched:** `packages/types/src/index.ts`, `apps/studio/db/src/migrations/0033_permissions_expanded.sql` (new), `apps/studio/web/app/(app)/studio/companies/[company]/projects/[project]/settings/permissions/page.tsx`, `apps/studio/web/components/sidebar/project-sidebar.tsx`, `apps/studio/web/app/(app)/studio/companies/[company]/projects/[project]/console/page.tsx`, `apps/studio/server/src/routes/skills.ts`, `apps/studio/server/src/routes/commands.ts`, `apps/studio/server/src/routes/browser.ts`, `apps/studio/server/src/routes/browser-profiles.ts`, `apps/studio/server/src/routes/filesystem.ts`, `apps/studio/server/src/routes/projects.ts`, `apps/studio/server/src/console/router.ts`

## 2026-04-15 — Console UI: project-level viewer + inline terminal on connector detail

**Changed:**
- New project-level page `/console` listing every active console for this project's connectors with session indicator + filter. Picking a session renders the terminal-styled `<ConsolePanel>`. Sidebar entry added.
- Connector detail page now shows the console as an inline terminal-styled block (black bg, green timestamps) — no more Sheet/Drawer.
- `<ConsolePanel>` gained `variant: 'default' | 'terminal'` prop.
- Removed redundant "Console" button + Sheet from the Channels Connectors tab — users navigate into the detail page or use the new unified `/console` route.
- `api.console.list()` client helper added.

**Files touched:** `apps/studio/web/components/console/console-panel.tsx`, `apps/studio/web/components/channels/connectors-tab.tsx`, `apps/studio/web/app/(app)/studio/companies/[company]/projects/[project]/channels/[connector]/page.tsx`, `apps/studio/web/app/(app)/studio/companies/[company]/projects/[project]/console/page.tsx` (new), `apps/studio/web/components/sidebar/project-sidebar.tsx`, `apps/studio/web/lib/api.ts`

## 2026-04-15 — Console feature (live log streams per plugin instance)

**Changed:** New first-class Console feature for plugins/adapters to emit structured log lines that UI can live-stream. Session-scoped storage: 100–200 entries in memory (ring), batched flush of 100 to NDJSON tempfile when ring hits 200, reverse-scan pagination when UI scrolls past memory window. Tempdir wiped on server boot — logs are ephemeral. SSE for live tail. Plugins access via `ctx.console.get(id)` → `.info/.warn/.error/.debug`. Telegram bot + userbot adapters now emit console logs on activate/deactivate/inbound/outbound/errors; each connector instance gets its own console id `<plugin_id>:connector:<uuid>`.

**Files touched:**
- `apps/studio/server/src/console/registry.ts`, `apps/studio/server/src/console/router.ts` — new
- `apps/studio/server/src/index.ts` — wires router + shutdown flush + tmpdir wipe
- `apps/studio/server/src/plugins/ui/context-extender.ts` — `ctx.console` binding
- `plugins/jiku.studio/src/types.ts`, `plugins/jiku.studio/src/index.ts` — `PluginConsoleAPI` types
- `plugins/jiku.telegram/src/index.ts`, `plugins/jiku.telegram/src/bot-adapter.ts`, `plugins/jiku.telegram/src/user-adapter.ts` — console wiring + `attachConsole()` + lifecycle logs
- `apps/studio/web/lib/api.ts` — `api.console.{snapshot,history,streamUrl}`
- `apps/studio/web/components/console/console-panel.tsx` — new
- `apps/studio/web/components/channels/connectors-tab.tsx` — Console button + Sheet

## 2026-04-15 — Telegram production safety hardening

**Changed:**
- Bot adapter `runAction` now wraps every outbound `bot.api.*` call with `enqueueForChat(chatId, () => withTelegramRetry(...))` so each action honours per-chat spacing + 429 `retry_after`. Previously only `sendMessageInner` was guarded; `edit_message`, `send_photo/file`, `forward_message`, `copy_message`, `get_chat_info`, and `fetch_media` could flood or loop on 429.
- `runAction` signature in `@jiku/kit` (and both Telegram adapters) gained optional `connectorId: string` third arg; `connectors/tools.ts` forwards `connector_id` through. Bot adapter resolves via `botFor(connectorId)`, userbot adapter via `clientFor/queueFor(connectorId)` — closes multi-tenant gap where concurrent credentials could mis-route tool calls to the wrong account.
- **Removed dangerous actions** from both adapters. Scope is now strictly message + media management. Removed from bot: `send_reaction`, `delete_message`, `pin_message`, `unpin_message`, `get_chat_members`, `create_invite_link`, `set_chat_description`, `ban_member`. Removed from userbot: `join_chat`, `leave_chat`, `delete_message`, `send_reaction`, `pin_message`, `unpin_message`. Kept: send text/file/photo/media_group/url_media, forward, copy, edit (own msg), get_chat_info, fetch_media, plus userbot read-only (get_chat_history, get_dialogs, search_messages, get_user_info, mark_read, set_typing).

**Files touched:** `plugins/jiku.telegram/src/bot-adapter.ts`, `plugins/jiku.telegram/src/user-adapter.ts`, `packages/kit/src/index.ts`, `apps/studio/server/src/connectors/tools.ts`

## 2026-04-14 — Plan 24 Phases 2-5: Telegram MTProto userbot adapter (full ship)

**Changed:** Single-session implementation of all remaining Plan 24 phases. The userbot ships end-to-end: plugin registers two adapters from the same module, the user adapter walks an interactive OTP+2FA setup wizard via the Phase 1 foundation, runtime connects via `@mtcute/bun`, eight platform actions are exposed through `connector_run_action`, and a mandatory rate-limit + queue layer wraps every outbound API call.

Phase 2 — TelegramAdapter renamed to TelegramBotAdapter (`jiku.telegram` → `jiku.telegram.bot`). Plugin setup registers both bot + user adapters. `ADAPTER_ID_ALIASES` in connectorRegistry preserves backward-compat lookup. Migration `0032_plan24_telegram_adapter_rename.sql` updates persisted rows.

Phase 3 — `@mtcute/bun` + `@mtcute/core` deps. `TelegramUserAdapter` real implementation: full setup flow (sendCode → signIn handles `SESSION_PASSWORD_NEEDED` branching → checkPassword → finalize exports session). `onActivate` connects + registers `client.on('new_message')` → ConnectorEvent normalize. `ConnectorSetupSessionState` extended with `credential_fields` decrypted per step by route handler so adapter doesn't need DB access.

Phase 4 — 8 actions on user adapter: `forward_message` (default `hide_sender:true` USERBOT-ONLY, `noForwardHeader+forwardSenders:false` for drop_author with custom_emoji preservation), `get_chat_history`, `join_chat`, `leave_chat`, `get_dialogs`, `set_typing`, `delete_message`, `edit_message`. Method capabilities probed at runtime with graceful fallback.

Phase 5 — Mandatory `UserbotQueue` (per-chat FIFO + min 1s gap, sliding 20/min global, 5s new-chat first-send, 2s forward per source, 10/hr join/leave). `FLOOD_WAIT_X` → scope-aware pause. `PEER_FLOOD` → `spamRestricted` latch. `AUTH_KEY_*` → `sessionExpired` latch. Per-credential `queue_policy` JSON override. `connector_get_queue_status` agent tool. `mapQueueError` envelope helper.

**Files touched:**
- `packages/types/src/index.ts`, `apps/studio/server/src/routes/connector-setup.ts`, `apps/studio/server/src/connectors/setup-store.ts`
- `apps/studio/server/src/connectors/registry.ts` — alias resolution
- `apps/studio/server/src/connectors/tools.ts` — `connector_get_queue_status`
- `apps/studio/db/src/migrations/0032_plan24_telegram_adapter_rename.sql` — new
- `plugins/jiku.telegram/package.json`, `plugins/jiku.telegram/src/index.ts`
- `plugins/jiku.telegram/src/userbot-queue.ts` — new

## 2026-04-14 — Plan 24 Phase 1: connector setup wizard UI

- Added `api.connectorSetup.{start,step,cancel}` client + re-exported `ConnectorSetupSpec`/`ConnectorSetupStep`/`ConnectorSetupInput`/`ConnectorSetupStepResult`/`ConnectorSetupStartResponse` types (inlined in `lib/api.ts` — api.ts does not import from `@jiku/types`).
- Added `requires_interactive_setup?: boolean` to `CredentialAdapter` shape in `lib/api.ts`.
- New generic wizard `components/connectors/setup-wizard.tsx` — reads spec from server, walks through steps, supports text/number/boolean/secret inputs, retry counter, aborted state, Back/Cancel/Continue buttons, calls DELETE on close.
- Project credential page (`.../settings/credentials/page.tsx`) now: (a) shows a "Setup required" banner with a Run Setup button for each project credential whose adapter requires interactive setup and has no masked fields yet; (b) auto-opens the wizard right after creating a credential that requires setup; (c) refetches credentials on wizard completion.
- Files: `apps/studio/web/lib/api.ts`, `apps/studio/web/components/connectors/setup-wizard.tsx`, `apps/studio/web/app/(app)/studio/companies/[company]/projects/[project]/settings/credentials/page.tsx`.

## 2026-04-14 — Plan 24 Phase 1: connector interactive setup API foundation

**Changed:** Shipped the foundation for adapter-driven multi-step credential setup wizards. Adapters that need interactive flows (OTP entry, 2FA, browser-redirect callbacks) declare them via a `ConnectorSetupSpec` returned from `getSetupSpec()` and an async `runSetupStep(stepId, input, sessionState)` handler. Studio auto-mounts setup endpoints, manages session state in-memory with a 15-min TTL, enforces a 3-retry cap per step (prevents OTP brute-force locking the underlying account), and merges the final `complete:true` field payload into the encrypted credential.

Why now: Plan 24 (Telegram Userbot via MTProto) requires interactive OTP+2FA login that doesn't fit into a single "POST credentials with all fields" flow. The setup API is plugin-agnostic so future adapters (OAuth flows, device-code grants, etc.) reuse the same machinery.

Audit events: `credential.setup_started`, `credential.setup_step`, `credential.setup_completed`, `credential.setup_failed`, `credential.setup_cancelled`.

UI wizard component + credential-form integration: delegated to subagent (in flight). Backend is the deliverable for this checkpoint.

**Files touched:**
- `packages/types/src/index.ts` — 5 new interfaces.
- `packages/kit/src/index.ts` — optional `getSetupSpec()`, `runSetupStep()`, `requiresInteractiveSetup` flag on `ConnectorAdapter`; re-exports.
- `apps/studio/server/src/connectors/setup-store.ts` — new in-memory store.
- `apps/studio/server/src/routes/connector-setup.ts` — new router.
- `apps/studio/server/src/index.ts` — registered router.
- `apps/studio/server/src/audit/logger.ts` — 5 new event types + helpers.
- `apps/studio/server/src/credentials/adapters.ts` — `requires_interactive_setup` flag exposed on adapter listing.

## 2026-04-14 — Naming cleanup: feature additions vs proper plans

**Changed:** Earlier in the session I labeled five feature additions as `Plan 24 / 25 / 26 / 27 / 28` but they were not proper plan docs (no `docs/plans/NN-*.md` file existed). The real Plan 24 is the new MTProto userbot plan dropped today. Subagent-driven sweep of `docs/builder/*`, `docs/feats/*`, and `docs/scenarios/1-*.md` to drop the false plan numbers and use feature names instead (Commands, @file hint, FS tool permission, Connector custom params, Streaming adapter). Migration filenames and source-code comments untouched (archival). ADR numbers 083-089 kept intact — sequential project history.

**Files touched:** `docs/builder/{current,changelog,decisions,memory,tasks}.md`, `docs/feats/{commands,references,connectors,filesystem}.md`, `docs/scenarios/1-manage-a-channel-with-agent.md`.

## 2026-04-14 — web-reader plugin: history not saved for tool-invoked calls

**Changed:** `jiku.web-reader` tool handler read `projectId` from `toolCtx.runtime.caller.user_data.project_id`, which `resolveCaller` never populates — so agent-invoked `web_read` never wrote to history. Only the plugin's own HTTP `/read` endpoint worked (it gets `projectId` from the plugin-ctx closure, not the tool context). Fixed to `toolCtx.runtime['project_id']` — runner injects project_id into every `RuntimeContext` (same pattern `jiku.sheet` already uses).

**Files touched:** `plugins/jiku.web-reader/src/index.ts`.

## 2026-04-14 — Drizzle schema drift on `agents.command_access_mode`

**Changed:** Migration `0030_plan24_commands.sql` added `agents.command_access_mode` via `ALTER TABLE`, but `apps/studio/db/src/schema/agents.ts` wasn't updated to mirror the new column. Drizzle's type-safe `.set({...})` silently stripped the field → `UPDATE "agents" SET WHERE id=$1` (empty SET clause) → Postgres 42601 syntax error. Column now declared in schema next to `skill_access_mode`. PATCH `/agents/:aid/command-access-mode` now persists correctly.

**Files touched:** `apps/studio/db/src/schema/agents.ts`.

## 2026-04-14 — Commands: uniform access-mode gate + connector inbound dispatcher + chat autocomplete

**Changed:** Three coupled tweaks to the Commands dispatcher + UI.

1. **Uniform `command_access_mode` across ALL surfaces** — reverted earlier "chat bypasses allow-list" hack. Config is now single source of truth: `manual` + allow-list gates every surface (chat, connector, cron, task, heartbeat). Rationale: inconsistency between surfaces made the config a lie; if user wants free chat access, they set mode to `all` — explicit, symmetric.

2. **Connector inbound dispatcher** — `event-router.ts` now invokes `dispatchSlashCommand` with `surface='connector'` on inbound text before wrapping. External Telegram/Discord/etc. members can invoke `/command` iff config allows (manual+allowlist OR mode='all'). The Commands feature's original ADR-085 decision to defer this is now partially reversed — security concern resolved by the unified allow-list mechanism.

3. **Chat-input `/` autocomplete popup** — new `SlashCommandAutocomplete` React component mounted above PromptInput. Arrow keys navigate, Tab/Enter insert `/<slug> ` token, Esc dismiss (append space to break prefix match). Fetches agent via new `GET /api/agents/:aid` endpoint (added `api.agents.get`), reads `command_access_mode` + filters list accordingly. Calls `POST /projects/:pid/commands/refresh` on mount so FS-added commands appear without a full project reload. Requires wrapping `PromptInput` in `PromptInputProvider` to lift state.

**Files touched:**
- `apps/studio/server/src/commands/dispatcher.ts` — removed surface-specific bypass.
- `apps/studio/server/src/connectors/event-router.ts` — wired dispatcher into inbound path.
- `apps/studio/server/src/routes/agents.ts` — new `GET /agents/:aid`.
- `apps/studio/web/lib/api.ts` — new `api.agents.get()`.
- `apps/studio/web/components/chat/slash-command-autocomplete.tsx` — new.
- `apps/studio/web/components/chat/conversation-viewer.tsx` — wrap with `PromptInputProvider` + mount autocomplete.

## 2026-04-14 — Streaming adapter revisions: segment render + `message is not modified` guard

**Changed:** Two post-ship refinements to the Telegram streaming adapter.

1. **Render model refactor** — from fixed-header (all tools pinned at top) to interleaved `segments[]` so rendering follows chronological narrative:
   ```
   text part 1
   ---
   [☑️] fs_read
   [☑️] connector_list
   ---
   text part 2
   ---
   [☑️] connector_send
   ---
   closing text
   ```
   Consecutive text-delta chunks append to the current text segment; consecutive tool-call chunks merge into the current tool group; transition between types inserts `---`. Final MarkdownV2 render wraps tool lines in italic (`_[icon] name_`) with MarkdownV2-escaped tool names, and escapes `\-\-\-` for the separator. Interim edits stay plain (no parse_mode, literal `---`) to avoid MarkdownV2 parse errors on incomplete content.

2. **"message is not modified" guard** — Telegram rejects editMessageText with `400: Bad Request: message is not modified` when the rendered output matches the existing message. Happens when the response has no MarkdownV2-escapable chars and the last debounced interim edit already landed the full text. Now treated as a no-op success (content is already on screen) rather than a warning + plain fallback. Plain fallback path also checks the same error to avoid log spam.

3. **`ConnectorParamSpec` widening** — `type` now accepts `'array' | 'object'`; `example` allows arrays and records (linter-applied user change in `packages/kit/src/index.ts`).

**Files touched:** `plugins/jiku.telegram/src/index.ts`, `packages/kit/src/index.ts`, `docs/builder/{current,changelog,decisions,memory}.md`, `docs/feats/connectors.md`.

## 2026-04-14 — Streaming adapter handoff: streaming outbound via `handleResolvedEvent`

**Changed:** Connector event-router no longer drains the agent stream to completion before sending to the platform. Added `handleResolvedEvent?(ctx: ResolvedEventContext)` to `ConnectorAdapter` in `@jiku/kit`. When an adapter implements it, the event-router resolves binding/identity/conversation, builds the context block + @file hint, then hands off a `ResolvedEventContext` with injected service callables (`startRun`, `registerObserverStream`, `logOutboundMessage`, `logOutboundEvent`, `recordUsage`). Adapter owns queueing + stream consumption + outbound send + logging from there.

Telegram adapter implementation:
- Sends `⌛` placeholder immediately as a reply to the user's message.
- Consumes the agent stream natively; debounced 700ms edits from `text-delta` chunks.
- Renders tool-call chunks as `[🔧] tool_name` header block; flips to `[☑️]` on result, `[❌]` on error.
- Splits at 4000-char Telegram cap by finalizing current message + opening fresh `⌛` continuation.
- Final edit applies MarkdownV2 escape with plain-text fallback.
- Tees stream back to host via `registerObserverStream` so chat web SSE observers keep receiving chunks in parallel.

User-visible: streaming now appears concurrent between web UI and Telegram (no more "stream finishes then Telegram starts"); tool invocations visible during processing; queue-position notice ("⏳ posisi #N") added to `queue_mode='ack_queue'` ack message.

Backward compat: adapters without `handleResolvedEvent` fall through to the legacy accumulate-then-sendMessage path.

**Files touched:**
- `packages/types/src/index.ts` — `ResolvedEventContext` interface.
- `packages/kit/src/index.ts` — `handleResolvedEvent?` method + re-export.
- `apps/studio/server/src/connectors/event-router.ts` — build ResolvedEventContext + hand off; queue-position notice tweak.
- `plugins/jiku.telegram/src/index.ts` — `handleResolvedEvent` override with streaming render engine.
- `docs/builder/decisions.md` — ADR-087.

## 2026-04-14 — Scenario 1 foundations: Commands, @file hint, FS tool permission, Connector params

Landed four high-priority features from `docs/scenarios/1-manage-a-channel-with-agent.md` §9 so the scenario runs clean in production.

**Commands system (user-triggered `/slash`, FS + plugin, mirrors Skills).**
- Migration `0030_plan24_commands.sql` — `project_commands`, `agent_commands`, `agents.command_access_mode` (`manual` | `all`).
- Schema + queries in db package; exports added to `@jiku-studio/db`.
- Core: `parseCommandDoc`, `resolveCommandEntrypoint`, `CommandRegistry` (mirror of Skills), types `CommandManifest`, `CommandSource`, `CommandEntry`, `CommandArgSpec`, `PluginCommandSpec`, `CommandDispatchResult`, `CommandAccessMode`.
- Studio: `CommandLoader` (`/commands/<slug>/COMMAND.md` folder OR `/commands/<slug>.md` single file) + `dispatchSlashCommand()` that detects `/slug ...` prefix on FIRST user text, resolves body, parses args, composes `body + <command_args>` and returns a rewritten input. Dispatcher is called in chat route, task/cron/heartbeat runner.
- Runtime manager auto-syncs the `/commands` folder on project init.
- Routes: `/projects/:pid/commands` CRUD, `/refresh`, `/agents/:aid/commands` allow-list, `/command-access-mode`.
- Audit: `command.invoke`, `command.assignment_changed`, `command.source_changed`.
- UI: project Commands page + per-agent allow-list page, sidebar link, API client `api.commands.*`.

**Reference hint provider (`@file`).**
- `src/references/hint.ts` — scans input for `@path/to/file` mentions (workspace-root default, rejects `..`, rejects `./` in MVP, ignores `@alice` non-path-like), stats each match via `getFileByPath`, injects a `<user_references>` block listing ok + not_found entries with size + mtime + `LARGE` tag for files > 1 MB. Cap 20 per invocation.
- Wired into chat route (after command dispatch), task runner (cron/heartbeat/task), and connector inbound (`src/connectors/event-router.ts`).
- Agent still reads content on-demand via `fs_read` — zero eager expansion.
- Audit: `reference.scan` with `{ surface, total, ok, missing }`.

**FS tool permission via metadata.**
- Migration `0031_plan26_fs_tool_permission.sql` — `tool_permission` column on `project_files` + `project_folders` (`'read+write' | 'read' | NULL` for inherit).
- Resolver `resolveFsToolPermission(projectId, path)` — walks parent folder chain; self → ancestors → default `read+write`. Returns `{ effective, source, source_path }`.
- Enforcement gate in `fs_write`, `fs_edit`, `fs_append`, `fs_move` (both from + to), `fs_delete`. Returns `FS_TOOL_READONLY` with a hint pointing to the source of the restriction. Read operations (`fs_read`, `fs_list`, `fs_search`) are never gated — "shared open" semantics.
- Routes: `GET /projects/:pid/files/permission?path=` + `PATCH /projects/:pid/files/permission`.
- Audit: `fs.permission_set`, `fs.permission_denied`.
- UI: file explorer context menu (delegated, in progress).

**Connector custom params + hint injection.**
- Added `ConnectorParamSpec` type + optional `getParamSchema()` on `ConnectorAdapter` in `@jiku/kit`.
- Added `params?: Record<string, unknown>` on `ConnectorContent` in `@jiku/types`.
- `connector_send` + `connector_send_to_target` tools accept `params`, validate against the adapter's declared schema (unknown keys → `INVALID_PARAMS` error with valid_params list).
- `connector_list` tool emits per-connector `param_schema` so agents discover valid keys context-aware.
- Telegram adapter declares 7 params: `reply_to_message_id`, `parse_mode` (HTML override), `disable_web_page_preview`, `message_thread_id`, `protect_content`, `disable_notification`, `allow_sending_without_reply`. `sendMessage` merges these into the Telegram Bot API `commonOpts` (translating `reply_to_message_id` → modern `reply_parameters`).

**Migrations to apply before deploy:**
- `0030_plan24_commands.sql`
- `0031_plan26_fs_tool_permission.sql`

**Files:**
- DB: `apps/studio/db/src/migrations/0030_*.sql`, `0031_*.sql`, `schema/commands.ts`, `schema/filesystem.ts`, `schema/filesystem-folders.ts`, `queries/commands.ts`, `queries/filesystem-permission.ts`, `schema/index.ts`, `index.ts`.
- Core + types: `packages/core/src/commands/{manifest,registry}.ts`, `packages/core/src/index.ts`, `packages/types/src/index.ts`, `packages/kit/src/index.ts`.
- Studio server: `src/commands/{loader,dispatcher}.ts`, `src/references/hint.ts`, `src/filesystem/tools.ts`, `src/routes/{commands,chat,filesystem}.ts`, `src/task/runner.ts`, `src/connectors/{event-router,tools}.ts`, `src/runtime/manager.ts`, `src/audit/logger.ts`, `src/index.ts`.
- Telegram plugin: `plugins/jiku.telegram/src/index.ts`.
- Web UI: `app/(app)/studio/companies/[company]/projects/[project]/commands/page.tsx`, `.../agents/[agent]/commands/page.tsx`, `lib/api.ts`, sidebar + agent layout.

## 2026-04-14 — telegram: fresh-boot poll delay for zero-downtime deploys

- **Changed:** `onActivate` now distinguishes two wait scenarios. (a) Reactivation within the same process keeps the existing 30s `lastDeactivateByConnector` guard. (b) Fresh boot (no entry in the map) waits `TELEGRAM_BOOT_POLL_DELAY_MS` (default 10 s, set 0 to disable) before calling `bot.start()`. Rationale: zero-downtime deploys start the new container + pass health check BEFORE sending SIGTERM to the old container. During that overlap both containers try to poll the same bot token; the new one loses with 409 Conflict until the old one releases its slot. The boot delay gives the old container time to shut down and `bot.stop()` its session.
- **Tombol Restart is not affected** — Restart uses the same-process path (map has an entry), so it only applies the 30s guard, not the extra 10s.
- **Files touched:** `plugins/jiku.telegram/src/index.ts`.

## 2026-04-14 — telegram: silence harmless 400 "already been closed" on activate

- **Changed:** The pre-polling `bot.api.close()` guard in `onActivate` now treats `400 Bad Request: the bot has already been closed` as benign, same as the existing 429 early-call exemption. `bot.stop()` in `onDeactivate` triggers grammy's internal close, so on reactivate our explicit close finds the slot already released — that's the success path, not a failure. Previously it was logged as a warning with a grammy stack trace, misleading operators into thinking activation failed (it didn't; `[connector] activated` still fires after).
- **Files touched:** `plugins/jiku.telegram/src/index.ts`.

## 2026-04-14 — ops: reset-password CLI script

- **Changed:** New ops script `apps/studio/server/scripts/reset-password.ts`. Interactive flow: prompts for email on stdin, looks up the user via `getUserByEmail`, shows name/email/id + asks `y/N` confirmation, generates an 8-character random password (letters + digits + symbols via `crypto.getRandomValues` for cryptographic randomness), hashes with `bcryptjs` at 10 rounds (matches the register flow at `src/routes/auth.ts:19`), updates `users.password`, prints the plaintext to stdout.
- **Run:** `cd apps/studio/server && bun --env-file=.env run scripts/reset-password.ts` (needs `.env` so `DATABASE_URL` is loaded).
- **Files touched:** `apps/studio/server/scripts/reset-password.ts` (new).

## 2026-04-14 — channels: restart button, health indicator, polling resilience, orphaned-identity reset

- **Orphaned identity auto-reset** (`event-router.ts` Path B, DM scope): when the next inbound message arrives after a binding was deleted, the existing identity — now with `binding_id=NULL` and `status='approved'` — used to fall through silently with `drop_reason=no_binding`, producing zero bot reply and zero pairing request in the admin UI. Fix: detect this orphaned shape, UPDATE the identity to `status='pending'`, and send the `👋 access request sent` notification the same as if it were a brand-new DM. Admin now sees the pairing request reappear in the UI.
- **Telegram polling auto-reconnect**: `onActivate` now wraps `bot.start()` in a backoff loop (1s → 60s max). On 409 Conflict (previous instance still holds the long-poll slot) we call `bot.api.close()` between retries to force Telegram to release the slot. On any other error we log + back off. Loop exits cleanly when `onDeactivate` sets `pollingStopRequested`. Old behavior was fire-and-forget `.catch(log)` — a single rejection meant permanent silent failure even though the process stayed "running".
- **30s post-deactivate guard**: module-level `lastDeactivateByConnector` map. `onActivate` awaits the remainder of a 30s window since the last deactivate before calling `bot.start()`. Previously a fast deactivate→activate (e.g. from the new Restart button) would race against Telegram's ~30s server-side slot reservation and produce immediate 409s.
- **`bot.catch(...)`**: installed grammy's middleware-level error handler so exceptions inside async update handlers are logged instead of bubbling as unhandled rejections.
- **Restart endpoint** — `POST /connectors/:id/restart` — deactivate + activate in one call. Scoped to `channels:write`.
- **Health endpoint** — `GET /connectors/:id/health` — returns `{ status, error_message, adapter: { polling, last_event_at, bot_user_id } | null }`. Adapters opt in by implementing `getHealth()`; Telegram adapter populates it from `this.bot`, `this.pollingStopRequested`, and a new `this.lastEventAt` heartbeat set on every inbound update.
- **Channels UI**:
  - New **Restart** button in the connector detail header (visible when `status='active'`), calls the restart endpoint, invalidates connector + health queries.
  - New **HealthBadge** component polling `/health` every 15s while the connector is active. Labels:
    - green — `polling aktif · last event {age} lalu`
    - amber — `polling aktif · last event {age} lalu (stale)` when >5min
    - amber — `polling aktif · belum ada event` when adapter reports polling but no updates yet
    - red — `polling offline` when adapter reports polling=false
  - `RefreshCw` icon for the restart button (spins while pending).
- Files: `apps/studio/server/src/connectors/event-router.ts`, `apps/studio/server/src/routes/connectors.ts`, `plugins/jiku.telegram/src/index.ts`, `apps/studio/web/lib/api.ts`, `apps/studio/web/app/(app)/studio/companies/[company]/projects/[project]/channels/[connector]/page.tsx`.

## 2026-04-14 — telegram: arrival log outside the queue, typing tick tuning

- **Non-blocking arrival log**: new `logArrivalImmediate()` helper inserts a `connector_events` row with `status='received'` the moment an update arrives from grammy, BEFORE entering the inbound FIFO batch queue. Rationale: the processing queue can stall (rate-limit pressure, handler bug, DB deadlock), and when that happens operators lost all visibility — no rows in `connector_events` / `connector_messages` even though Telegram was delivering updates. Arrival is now observable independent of routing health.
- **`ctx.connectorId` cached** on adapter instance so the plugin can call `logConnectorEvent` directly with the correct UUID. Reset in `onDeactivate` alongside the other identity fields.
- **Known follow-up** (not in this change): downstream event-router still INSERTs additional rows as status transitions (`pending_approval`, `handled`, …). Short-term that means each inbound event produces a `received` row + one outcome row. Longer term those should be UPDATEs against the arrival row (requires threading the arrival event id into `routeConnectorEvent`).
- **Typing tick 1s → 2s**: same reasoning as before, fewer edits per message.

## 2026-04-14 — telegram: inbound FIFO batch queue, typing tick 2s, handler error isolation

- **Inbound event queue**: all `ctx.onEvent(event)` call sites (5 of them — message, reaction, unreaction, edit, delete, my_chat_member) now route through `enqueueInboundEvent`. Global FIFO with `INBOUND_BATCH_SIZE = 5`: take 5 events, run via `Promise.allSettled`, wait for the batch to drain, then take the next 5. Prevents a burst of 30 messages from spinning up 30 concurrent agent runs and thrashing the DB / outbound rate limit.
- **Handler error isolation**: wrapped `ctx.onEvent` with `.catch(log)`. Before, an unhandled rejection from the event-router (e.g. a 429 propagating out of `sendMessage`) could crash the grammy polling handler, leave the bot in a bad state, and — combined with stale in-memory `runningConversations` entries in event-router — cause "chat tidak berfungsi lagi meski server di-restart" because the same crash would recur on the next inbound update. `Promise.allSettled` also isolates failures within a batch.
- **Typing tick 1s → 2s**: `TICK_MS` in `sendWithTypingSimulation` doubled. Fewer interim edits per message → less per-chat rate-limit pressure (placeholder + 2 edits + final now spread over ~6s instead of ~3s).

## 2026-04-14 — telegram: per-chat send queue + 429 retry_after handling

- **Per-chat send queue**: `sendMessage` now enqueues per `chat_id` via a promise chain (`chatSendQueues` map), so typing-simulation edits and subsequent sends to the same chat never race. Busy groups with `simulate_typing` (placeholder + 2 interim edits + final edit per message) were hitting Telegram's per-chat rate limit and losing the final edit.
- **429 retry**: new `withTelegramRetry` helper reads `err.parameters.retry_after` on GrammyError 429, waits that many seconds (+250ms buffer), retries once. Cap `MAX_RETRY_WAIT_MS = 45s` — beyond that we give up and let the caller degrade (prevents a pathological retry_after from stalling the whole queue). Applied to: placeholder send, final markdown edit, plain-text fallback edit, and the chunked text-send path. Interim "typing" edits stay best-effort (decorative, and serialization should prevent most 429s there).
- File: `plugins/jiku.telegram/src/index.ts`.

## 2026-04-14 — telegram: auto-register forum topics as connector targets + scope_key consistency

- **Topic target auto-register**: on first message in a forum topic that has a known topic title, Telegram adapter upserts a `connector_target` row with `name=<chat-slug>__<topic-slug>`, `display_name="<chat> → <topic>"`, `ref_keys={chat_id, thread_id}`, `scope_key=group:<chat_id>:topic:<thread_id>`. Agents can now address specific topics by name via `connector_send_to_target`. Idempotent — checks `getConnectorTargetByName` before creating.
- **Scope key format consistency**: `my_chat_member` channel/supergroup auto-register was using `scope_key='chat:<id>'`, but `computeScopeKey` (and therefore inbound events) use `group:<id>`. Mismatch would create separate scope-conversations for outbound vs inbound. Fix: use `group:<id>` everywhere. Existing targets unaffected because scope_key is not the send-routing key (ref_keys is) — just fixes scope-conversation threading.
- File: `plugins/jiku.telegram/src/index.ts`.

## 2026-04-14 — group pairing UI: auto-generated display_name includes topic + violet topic badge

- **Lazy group-pairing** in event-router now composes topic-aware names: `Pending group pairing: Jiku Agent Grup → General Discussion` when the first message came from a forum topic (uses `event.metadata.thread_title` if present, falls back to `topic <thread_id>`). `source_ref_keys.thread_id` is also set so Scope Lock UI pre-fills correctly after approval.
- **`GroupPairingRow`** component splits `"Chat → Topic"` into two visual parts: chat title as primary text, topic as a violet badge `topic: General #42`. Raw `scope_key_pattern` shown small-muted below. Approve flow (route) keeps topic suffix when stripping the `Pending group pairing:` prefix, so resulting active binding reads `Group: Jiku Agent Grup → General Discussion`.
- Files: `apps/studio/server/src/connectors/event-router.ts`, `apps/studio/web/app/(app)/studio/companies/[company]/projects/[project]/channels/[connector]/page.tsx`.

## 2026-04-14 — binding trigger_mode: customizable mention tokens, command whitelist, regex keywords

All 5 trigger modes are now tunable per binding:

- **`always`** — every message (default).
- **`command`** — message must start with `/`. Optional `trigger_commands` whitelist (without slash) narrows to e.g. `['help','ask']`. Respects Telegram's `/help@mybot` suffix (split on `@`). Empty list = any `/...` passes.
- **`keyword`** — text contains any `trigger_keywords`. New `trigger_keywords_regex: boolean` — when true, each entry is a case-insensitive regex instead of a substring.
- **`mention`** — bot is addressed. New `trigger_mention_tokens: string[]` for custom tokens (`['@halo_bot','hai bot','bro']`, substring match). When empty, falls back to adapter-detected `metadata.bot_mentioned` (proper Telegram entity parse). DMs implicitly pass.
- **`reply`** — user used the platform's reply feature to reply directly to one of the bot's own messages. Checked via `metadata.bot_replied_to` flag set by adapter (Telegram: `msg.reply_to_message.from.id === botUserId`, ignoring synthetic forum-topic-created pointer). DMs implicitly pass. Useful in chatty groups — agent only answers when someone specifically replies instead of reacting to every message.

Migration `0029_binding_trigger_custom.sql` adds 3 columns: `trigger_mention_tokens text[]`, `trigger_commands text[]`, `trigger_keywords_regex boolean DEFAULT false`. UI (binding detail → Source card) shows conditional fields per mode with hints + examples.

Files: `apps/studio/db/src/migrations/0029_binding_trigger_custom.sql`, `apps/studio/db/src/schema/connectors.ts`, `apps/studio/db/src/queries/connector.ts`, `apps/studio/server/src/connectors/event-router.ts`, `packages/types/src/index.ts`, `apps/studio/web/lib/api.ts`, `apps/studio/web/app/(app)/studio/companies/[company]/projects/[project]/channels/[connector]/bindings/[binding]/page.tsx`.

## 2026-04-14 — connectors: proper bot-mention + reply-to-bot trigger detection

- **Bug:** `trigger_mode='mention'` used `text.includes('@')` — matches anything with `@` (emails, unrelated user mentions). `trigger_mode='reply'` had no case in `matchesTrigger` switch, fell through to default → always passed.
- **Fix:** Telegram adapter caches `bot.api.getMe()` at activation (`botUsername`, `botUserId`). Message handler scans `msg.entities` + `msg.caption_entities` for type `'mention'` matching `@<botUsername>` AND `'text_mention'` with `user.id === botUserId`. Reply-to-bot check: `msg.reply_to_message.from.id === botUserId && !msg.reply_to_message.forum_topic_created` (ignore synthetic topic-pointer). Flags exposed as `event.metadata.bot_mentioned` / `event.metadata.bot_replied_to`.
- **matchesTrigger** now consults those flags. DMs implicitly count as mention/reply (whole message addressed to bot). `reply` case added to the switch.
- Files: `plugins/jiku.telegram/src/index.ts`, `apps/studio/server/src/connectors/event-router.ts`.

## 2026-04-14 — connectors: inject internal event_id + message_id into context; by-id fetch tools

Agents can now cross-reference the [connector_context] block against our own DB — not just Telegram's ids.

- **Context block** adds two lines immediately after Connector:
  - `Internal event_id: <uuid> (use connector_get_event to load full detail)`
  - `Internal message_id: <uuid> (use connector_get_message to load full detail)`
  These refer to rows in our `connector_events` / `connector_messages` tables (distinct from the platform chat_id / message_id already shown under Chat ref).
- **Event-router** reorders the `handled` path: `logMsg` is called BEFORE `buildConnectorContextString` so the resulting `inboundRow.id` can be embedded. Queue-enqueue path also now writes its inbound `handled` row before context assembly — previously queued messages never hit `connector_messages`, now they do.
- **Two new agent tools**:
  - `connector_get_event({ event_id })` — project-scoped lookup, returns full `connector_events` row (parsed payload + `raw_payload` + metadata + status + connector_name + plugin_id).
  - `connector_get_message({ message_id })` — same shape for `connector_messages` row (conversation_id, ref_keys, content_snapshot, raw_payload, connector_name).
  Both scope check: returns null if the id doesn't belong to the current project.
- DB queries: `getConnectorMessageById` + project-scoped `getProjectConnectorEventById` / `getProjectConnectorMessageById` (join with `connectors` for tenant isolation).
- Files: `apps/studio/db/src/queries/connector.ts`, `apps/studio/server/src/connectors/event-router.ts`, `apps/studio/server/src/connectors/tools.ts`.

## 2026-04-14 — telegram: inject forum topic NAME into context (not just thread_id)

- Telegram adapter now extracts the forum topic name from whichever shape the Bot API chose to put it: `msg.forum_topic_created.name` (creation event), `msg.forum_topic_edited.name` (rename), or the synthesised `msg.reply_to_message.forum_topic_created.name` pointer that Telegram attaches to every message inside a topic. Result stored as `event.metadata.thread_title`; `is_topic_message` flag propagated too.
- `buildConnectorContextString` renders the topic label in the Chat line when present, e.g. `Chat: "Jiku Agent Grup" (supergroup, chat_id=-514..., → topic "General Discussion" (thread_id=42))` instead of only `thread_id=42`.
- `connector_list_entities({ scope: 'threads' })` now returns `thread_label` alongside `chat_label` so the agent can show topic names when listing forum topics without a second query.
- Files: `plugins/jiku.telegram/src/index.ts`, `apps/studio/server/src/connectors/event-router.ts`, `apps/studio/db/src/queries/connector.ts`.

## 2026-04-14 — fix: 409 Conflict when recreating a connector with the same bot token

- **Bug:** `DELETE /connectors/:id` only deleted the DB row — it never called `deactivateConnector()` first. The adapter's in-memory polling loop stayed orphaned (grammy `getUpdates` kept hitting Telegram). When the admin then created a new connector with the SAME bot token and activated it, Telegram saw two concurrent long-poll consumers for the same token → `409 Conflict: terminated by other getUpdates request`.
- **Fix A** — route: `DELETE /connectors/:id` now `await deactivateConnector(id)` before `deleteConnector(id)`. `deactivateConnector` tears down the adapter cleanly (Telegram: `await bot.stop()` resolves only after the current long-poll cycle ends).
- **Fix B** — Telegram adapter `onActivate` pre-flight: `await bot.api.deleteWebhook({ drop_pending_updates: true })` + `await bot.api.close()` before `bot.start()`. `close()` asks Telegram to release the bot token's current long-poll slot server-side — important when a previous connector was just deleted and Telegram still thinks the old poller is active (the slot can linger for ~30s).
- Files: `apps/studio/server/src/routes/connectors.ts`, `plugins/jiku.telegram/src/index.ts`.

## 2026-04-14 — binding: Thread/Topic ID picker for forum-topic scopes

Scope Lock card on binding detail now has a Thread ID input below Chat ID. When both are filled, the binding is locked to one Telegram forum topic via `scope_key_pattern='group:<chat_id>:topic:<thread_id>'` + `source_ref_keys={ chat_id, thread_id }`. Validates that Chat ID exists before allowing Thread ID.

Raw "Scope Filter" hint under Routing also expanded with the full topic-pattern vocabulary:
- `group:<id>` — general chat only (no topics)
- `group:<id>:*` — group + ALL forum topics
- `group:<id>:topic:<thread>` — one specific topic

File: `apps/studio/web/app/(app)/studio/companies/[company]/projects/[project]/channels/[connector]/bindings/[binding]/page.tsx`.

## 2026-04-14 — connectors: sharpen tool prompts for discovery discipline + freshness

Updated tool descriptions so the agent follows a consistent pattern when observing or acting on connector data:

- **`connector_list`** — explicitly told to call FRESH every iteration that uses connector tools; never cache across turns because admins add/remove/reconfigure connectors dynamically.
- **`connector_list_entities`** — now labelled the AUTHORITATIVE discovery tool for chat_ids / user_ids / thread_ids. Agent must call this before any `connector_get_events` / `connector_get_thread` when it doesn't already hold verified ids. Refresh every turn.
- **`connector_list_targets`** — description clarified: these are ADMIN-REGISTERED ALIASES for outbound sends, NOT the authoritative list of chats. Use only when the user asks for a named alias or wants the curated list. Discovery uses list_entities.
- **`connector_list_scopes`** — narrowed: shows only scopes with an active `connector_scope_conversations` row, not every chat.
- **`connector_get_events` / `connector_get_thread`** — descriptions now require a discovery-first step and explicit filters (chat_id / user_id / date / content_search). "NEVER fetch without at least one filter" + "Do not reuse ids from earlier turns without re-listing".
- **`connector_send`** — describes the pair: raw ref_keys for chat_id-addressed sends, plus a note to verify connector active via fresh `connector_list` before sending.

File: `apps/studio/server/src/connectors/tools.ts`.

## 2026-04-14 — connectors: richer context block, XML-wrapped user input, query tools with filters + entity discovery

Ship three related improvements so the agent knows where it is + can introspect traffic safely.

**Context enrichment** — `[Connector Context]` rewritten as `<connector_context>` (XML-tagged for clarity). Now includes:
- Explicit `Connector: <display_name> (id=<uuid>)` — not just the opaque id.
- Structured scope line — e.g. `Chat: "Jiku Agent Grup" (group, chat_id=-514…, thread_id=42)` or `Chat: Direct message (private, chat_id=…)`.
- Sender line shows display_name + `@username` + external user_id.
- Leading instruction frames the block as SYSTEM metadata; states the chat context; warns the model that user content is untrusted.

**Prompt-injection hardening** — user message is now wrapped in `<user_message>…</user_message>`. The connector_context block explicitly tells the model everything inside `user_message` is untrusted. A malicious user can no longer craft text that spoofs a fake `[Connector Context]` header.

**Agent query tools expanded** (connector `tools.ts`):
- `connector_get_events` — new filters: `connector_id`, `chat_id`, `thread_id`, `user_id`, `direction`, `event_type`, `status`, `content_search` (ILIKE on `payload.content.text`), `from`, `to`, `cursor` (keyset pagination). Returns `{ events, next_cursor }`.
- `connector_get_thread` — same filter dimensions for messages (`chat_id`, `thread_id`, `direction`, `status`, `content_search`, date range, cursor). Status vocab includes all new inbound values (`handled`/`unhandled`/`pending`/`dropped`/`rate_limited`).
- **New `connector_list_entities`** — distinct-entity aggregation. `scope='chats'` → unique chat_ids with latest chat title + chat_type; `scope='users'` → unique external user_ids with display_name + username; `scope='threads'` → unique (chat_id, thread_id) pairs. Each row has `event_count` + `last_seen_at`. Agent uses this BEFORE paging events/messages when it doesn't know the target IDs.

**DB queries updated** — `listConnectorEventsForProject` / `listConnectorMessagesForProject` take new filter fields (chat_id / thread_id / user_id / content_search). New `listConnectorDistinctEntities` uses raw SQL with Postgres JSONB extraction for GROUP BY on `ref_keys->>'chat_id'` / `payload->'sender'->>'external_id'`.

Files: `apps/studio/server/src/connectors/{event-router.ts,tools.ts}`, `apps/studio/db/src/queries/connector.ts`.

## 2026-04-14 — connectors: normalize inbound message status vocabulary

Every inbound `connector_messages` row now carries a status that tells you what happened to the message:

- `handled` — binding matched, agent ran (has `conversation_id`).
- `unhandled` — no binding matched this chat; stored for observability / admin review.
- `pending` — binding matched but identity is pending approval; agent didn't run.
- `dropped` — binding matched but identity is blocked.
- `rate_limited` — binding matched but rate limit was hit.
- `sent` / `failed` — outbound (bot → platform).

Previously the routed-inbound row used `status='sent'`, conflicting with outbound `sent`. Filters in the Messages tab were updated to surface all inbound states plus the distinct outbound ones. `connector_get_thread` agent tool consumers can now filter by status.

Files: `apps/studio/server/src/connectors/event-router.ts`, `apps/studio/web/components/channels/messages-tab.tsx`.

## 2026-04-14 — connectors: always log inbound messages even without a matching binding

Previously `connector_messages` only got a row when a binding actually ran (inside `executeConversationAdapter`) and when the bot auto-replied. Message events that arrived in unpaired groups/DMs were captured in `connector_events` but NOT in `connector_messages`, so the Messages tab + `connector_get_thread` agent tool couldn't see them.

Fix: at the top of the no-binding-match branch in `routeConnectorEvent`, always write an inbound `connector_messages` row with `status='received'` for message events. Bound messages still get their second row with `conversation_id` later (from `executeConversationAdapter`) — accept the small duplication in exchange for a complete inbound log. File: `apps/studio/server/src/connectors/event-router.ts`.

## 2026-04-14 — connectors: blocked-identities cleanup UI + REST

Admin can now inspect and clean up stuck/rejected pairing rows without nuking the whole connector.

- New query `getBlockedIdentitiesForConnector()` + `deleteIdentity()`.
- REST: `GET /connectors/:id/blocked-identities`, `POST .../:iid/unblock` (status → 'pending', rejoins the pairing queue), `DELETE /connectors/:id/identities/:iid` (hard delete — user must DM the bot again to re-pair).
- Connector detail page: new "Blocked Identities" section listing status='blocked' rows with `Unblock` and delete buttons. Shows external user_id and block timestamp.
- Files: `apps/studio/db/src/queries/connector.ts`, `apps/studio/server/src/routes/connectors.ts`, `apps/studio/web/lib/api.ts`, `apps/studio/web/app/(app)/studio/companies/[company]/projects/[project]/channels/[connector]/page.tsx`.

## 2026-04-14 — connectors: lazy group-pairing draft from first group message + Scope Lock UI

- **Lazy group-pairing**: event-router's "no binding matches" branch now splits by scope. For group/channel scopes (event.scope_key present), if no draft binding exists for that exact `scope_key_pattern`, one is created lazily on first message (disabled, `source_type=group|channel`, `source_ref_keys.chat_id` set, `member_mode='require_approval'`). Covers cases where `my_chat_member` never fired (bot added before the auto-register hook existed, or Telegram didn't replay the event). DM path unchanged — still creates one pending identity per new user.
- **Binding detail — Scope Lock card**: friendly per-source-type picker. For `source_type=group|channel` an input for "Chat ID" writes `scope_key_pattern='group:<id>'` + `source_ref_keys.chat_id` in one save. For `source_type=private` an input for "Sender User ID" writes `source_ref_keys.user_id`. Clearing the field removes both keys. Raw `scope_key_pattern` text box remains under Routing for advanced patterns (`group:*`, forum topic, etc.).
- Files: `apps/studio/server/src/connectors/event-router.ts`, `apps/studio/web/app/(app)/studio/companies/[company]/projects/[project]/channels/[connector]/bindings/[binding]/page.tsx`.

## 2026-04-14 — connectors: fix reject button + group auto-pairing flow

- **Bug fix — Reject button did nothing**: `getPairingRequestsForConnector()` filtered only on `binding_id IS NULL`. Clicking reject set `status='blocked'` but left `binding_id=null`, so the rejected row stayed in the UI list forever. Query now also requires `status='pending'`. Rejecting now makes the row disappear as expected.
- **Group auto-pairing**: when the bot is added (member or admin) to a Telegram group/supergroup, the adapter auto-creates a **draft binding** — `source_type='group'`, `scope_key_pattern='group:<chat_id>'`, `enabled=false`, `output_config.agent_id` empty, `member_mode='require_approval'`. Admin sees this under a new "Group Pairing Requests" section on the connector detail page, picks an agent + member mode, and hits approve → binding is enabled and starts routing. Reject deletes the draft.
- **Backend**: new query `getPendingGroupPairings()`, routes `GET /connectors/:id/group-pairings`, `POST .../:bid/approve`, `POST .../:bid/reject`. UI mirrors the DM pairing row — just with a memberMode picker instead of an output-adapter picker.
- Channels (not groups) still use the named-target auto-register flow from before.
- Files: `apps/studio/db/src/queries/connector.ts`, `apps/studio/server/src/routes/connectors.ts`, `plugins/jiku.telegram/src/index.ts`, `apps/studio/web/lib/api.ts`, `apps/studio/web/app/(app)/studio/companies/[company]/projects/[project]/channels/[connector]/page.tsx`, `apps/studio/web/app/(app)/studio/companies/[company]/projects/[project]/channels/[connector]/bindings/[binding]/page.tsx` (type fix: `member_mode` cast).

## 2026-04-14 — connectors: binding scope tightening (DM lock + implicit scope gate + member_mode)

User-reported bug: User A's loose binding (`source_type='any'`, no scope pattern, no ref_keys) captured User B's messages inside a shared Telegram group, auto-creating an identity for User B under User A's binding and letting the agent respond. Root cause was a combination of three things: (1) pairing approval created bindings without any sender scope, (2) `matchesTrigger()` had no implicit scope gate based on `source_type`, (3) new identities were auto-approved the moment any binding matched.

Fixes (applied as 4 incremental steps):

1. **Pairing approval creates strict DM bindings**: `POST /connectors/:id/pairing-requests/:iid/approve` now sets `source_type: 'private'` + `source_ref_keys: { user_id: <identity.external> }` on the new binding so it can only ever match that one user's DMs.
2. **Event-router scope gate**: `matchesTrigger()` now (a) treats `source_ref_keys.user_id` specially — compared against `event.sender.external_id` rather than `event.ref_keys` (where user_id doesn't live); (b) enforces an implicit scope gate: `source_type='private'` → require empty scope_key (DM); `source_type='group'|'channel'` → require non-empty scope_key. `any` keeps its legacy behaviour but is now flagged as unsafe in the UI.
3. **`member_mode` column on connector_bindings** (`require_approval` default / `allow_all`): for multi-user scopes (group/channel OR any binding that receives an event with a scope_key), new members' first message creates a `pending` identity that an admin must approve. `allow_all` keeps the old auto-approve behaviour for open public groups. DM bindings ignore this field because they are already locked to one user. Migration: `0028_binding_member_mode.sql`.
4. **UI**: binding detail page now shows an amber warning when `source_type='any'`, displays `source_ref_keys` when present (so admin sees the sender lock), adds a Member Mode picker for group/channel/any bindings, and relabels the source type dropdown to emphasise "Private (DM) — single user" vs "Any (legacy, unsafe)".

Legacy loose bindings still work but are flagged. Admins should either re-approve through the pairing UI (produces a strict DM binding) or manually add `source_ref_keys` / `scope_key_pattern` / change `source_type` away from `any`.

Files: `apps/studio/db/src/migrations/0028_binding_member_mode.sql`, `apps/studio/db/src/schema/connectors.ts`, `apps/studio/db/src/queries/connector.ts`, `apps/studio/server/src/connectors/event-router.ts`, `apps/studio/server/src/routes/connectors.ts`, `packages/types/src/index.ts`, `apps/studio/web/lib/api.ts`, `apps/studio/web/app/(app)/studio/companies/[company]/projects/[project]/channels/[connector]/bindings/[binding]/page.tsx`.

## 2026-04-14 — fix: telegram adapter — service messages no longer trigger agent + raw_payload on all polling handlers

- **Bug**: in groups, joining a member (or any service message — new_chat_title, pinned_message, voice_chat_*, migrate_to_chat_id, etc.) triggered an empty-content `message` event that the agent ran against with "(no text content)". Root cause: the `bot.on('message')` polling handler unconditionally emitted every `msg` as `type: 'message'`, even when `text`/`caption`/media were all absent.
- **Fix**: classify before emit — if `text`/`caption`/media present → `message`; else `new_chat_members` → `join`, `left_chat_member` → `leave`; other service messages dropped silently. Agent now only runs for real user content.
- **Bug 2**: `raw_payload` missing for polling-path events because only the `channel_post` handler set it. Webhook-path events had raw_payload (attached in the HTTP handler), but polling events went directly via `ctx.onEvent` with raw_payload undefined — so the channels UI detail drawer showed no "Raw Payload" block.
- **Fix 2**: attach `raw_payload: gramCtx.update` to every polling handler (`message`, `message_reaction`, `edited_message`, `my_chat_member` already had it, `channel_post` already had it).
- File: `plugins/jiku.telegram/src/index.ts`.

## 2026-04-14 — connectors: enrich list_targets + ambiguity-safe send_to_target

Multi-connector safety for named channel targets:
- **`connector_list_targets`** now returns each target together with its owning connector (id, plugin_id, display_name, status) in a `connector` block, so the agent can pick the right bot without a follow-up `connector_list` call and can tell platforms apart when multiple are configured.
- **`connector_send_to_target`** now detects ambiguity. When `connector_id` is omitted and the target name resolves to more than one connector, the tool returns `code: 'AMBIGUOUS_TARGET'` with a `candidates: [...]` list (connector_id, display_name, plugin_id, status). Previously it silently picked the first match — a latent "wrong bot delivers the message" bug. Distinct error codes also added: `TARGET_NOT_FOUND`, `CONNECTOR_INACTIVE`.
- New query `getConnectorTargetsByName()` (plural) for the ambiguity check, and `getConnectorTargetsEnriched()` for the list endpoint.
- Files: `apps/studio/db/src/queries/connector.ts`, `apps/studio/server/src/connectors/tools.ts`.

## 2026-04-14 — filesystem: paginated fs_read (cat-n format) + fs_append + version-bump bug fix

Follow-up to the read-before-write work:
- **Bug fix**: `upsertFile()` was not incrementing `version` on update, so optimistic locking was broken in practice (tracker always matched DB because both stayed at 1). Now `version` bumps on every write, `content_version` bumps only when `content_hash` changes. Service layer (`filesystem/service.ts`) now computes `sha256(content)` and passes it as `content_hash` to the query.
- **fs_read pagination (Claude-Code `Read` parity)**: `offset` (1-based) + `limit` (default 2000, max 5000) params. Content is returned in `cat -n` format (line-number prefix + tab). Per-line truncation at 2000 chars. Response fields: `start_line`, `end_line`, `total_lines`, `truncated`, `hint` — hint tells the model exactly how to page through: `fs_read({ path, offset: end+1, limit })`. Tool description warns the model NOT to include line-number prefixes in `fs_edit` old_string.
- **fs_append tool**: zero-overhead append. No read-gate (append = purely additive, no clobber). Server-side concatenation (no model tokens). After append, tracker row for that path is cleared — forces re-read if the agent later wants to `fs_edit`. Preferred over `fs_edit` for growing logs / message journals / event streams.
- **FS_WRITE_HINT** rewritten as a tool-choice guide: `fs_append` → append-only, `fs_edit` → partial change, `fs_write` → new file or full rewrite.
- Files: `apps/studio/db/src/queries/filesystem.ts`, `apps/studio/server/src/filesystem/{service.ts,tools.ts}`.

## 2026-04-14 — filesystem: Claude-Code-style read-before-write + stale detection + fs_edit

- New table `conversation_fs_reads (conversation_id, path, version, content_hash, read_at)` — session tracker of files the agent has observed. Cascades on conversation delete. Migration `0027_conversation_fs_reads.sql`.
- `fs_read` upserts the tracker with the file's current `version` + `content_hash`.
- `fs_write` / `fs_edit` now enforce: (a) file must have been `fs_read` earlier in this conversation (exception: `fs_write` for brand-new files), (b) tracker version must equal current DB version (otherwise → `STALE_FILE_STATE`).
- New `fs_edit` tool — substring replacement (`old_string → new_string`, optional `replace_all`). Token-efficient for partial file changes — no more read+write cycle for small patches. Rejects binary files; `old_string` must be unique unless `replace_all: true`.
- Tool descriptions + FS_WRITE_HINT updated to document the read-before-write contract and when to use `fs_edit` vs `fs_write`.
- `fs_move` / `fs_delete` drop the tracker row for the old path so stale entries don't block future writes at the same path.
- Files: `apps/studio/db/src/migrations/0027_conversation_fs_reads.sql`, `apps/studio/db/src/schema/conversation-fs-reads.ts`, `apps/studio/db/src/queries/conversation-fs-reads.ts`, `apps/studio/db/src/{schema,queries,index}.ts`, `apps/studio/server/src/filesystem/tools.ts`, `docs/feats/filesystem.md`.

## 2026-04-14 — fix: spurious sibling branches when queueing connector messages

- **Root cause:** `drainConnectorQueue` in `event-router.ts` called `next.resolve(runResult)` **without awaiting** it. The resolver is the only code that reads the streamed run output end-to-end, and the assistant message is only persisted when the stream finalizes. The `finally` block therefore released `runningConversations` and recursively drained the next queued message while the previous run's assistant row was still being written. The next `runtimeManager.run()` then saved its user message against a **stale `active_tip_message_id`** (the previous user message, not the yet-unsaved assistant reply), producing siblings under the same parent — i.e. spurious branches.
- **Fix:** await the resolver's drain (wrapped in `Promise.resolve` since the queue types resolve as `void`) together with the observer SSE branch before releasing `runningConversations`. The next queued dequeue now always starts after the previous run's assistant message has landed.
- Reproducible when a single Telegram chat sends ≥2 messages back-to-back faster than the agent replies. Non-queued path (first message) was already correct — it awaited `drainStream` fully before `finally`.
- Files: `apps/studio/server/src/connectors/event-router.ts`.

## 2026-04-14 — harness: replace 2-phase narration with clawcode-parity single-phase loop

- **Problem:** Previous harness adapter was 2-phase (forced narration via `tool_choice=none` → action via `tool_choice=auto`). The skip-phase-2 shortcut relied on a regex (`ACTION_INTENT_RE`) to classify narration as action-intent vs final-answer. Regex false-negatived on Indonesian meN- verb forms ("Mengirim…") causing cron-triggered runs to complete phase 1 but never reach phase 2 — the delivery tool call silently dropped. Regex-based natural-language classification was inherently fragile.
- **Fix:** Rewrote `HarnessAgentAdapter` to match the claude-code / clawcode loop pattern (`refs-clawcode/rust/crates/runtime/src/conversation.rs:342-500`). One explicit outer `while` loop; each iteration runs a single model step with `tool_choice: 'auto'` (`stopWhen: stepCountIs(1)`). Model natively interleaves text + tool_use. Exit condition is purely structural — `step.toolCalls.length === 0` → done. No regex, no narration forcing.
- **Architectural value vs. default adapter:** explicit per-iteration control. Enables `jiku-harness-iteration` progress events, per-iteration stall timeout (new `stall_timeout_ms` config, default 120s), emits `jiku-harness-stall` event on timeout, and creates room for future hooks (approval prompts, model switching, interrupt checks) without fighting AI SDK's internal loop.
- Config changes: `force_narration` and `max_tool_calls_per_iteration` removed (obsolete); `stall_timeout_ms` added.
- Files: `packages/core/src/adapters/harness.ts` (full rewrite).

## 2026-04-13 — Connector events: direction (in/out) + raw_payload preserved

- Added `connector_events.direction` (`'inbound' | 'outbound'`, default `'inbound'`) and `raw_payload jsonb` columns; same `raw_payload` added to `connector_messages`. Migration: `0026_connector_raw_payload.sql`.
- Bot-initiated actions (`connector_send`, `connector_run_action`, auto-reply) now log an outbound event with the platform response captured in `raw_payload` so reactions/edits/deletes/sends are visible alongside inbound events in the channels Events tab.
- Inbound webhook entry attaches `req.body` to `event.raw_payload` so the original platform JSON (e.g. Telegram update) is stored and shown in the detail drawer.
- Telegram adapter `sendMessage` now returns `raw_payload` (the Telegram API response).
- Events tab gets a direction filter + per-row direction arrow; both Events and Messages drawers render `Raw Payload (platform-side)` block.
- Files: `apps/studio/db/src/migrations/0026_connector_raw_payload.sql`, `apps/studio/db/src/schema/connectors.ts`, `apps/studio/db/src/queries/connector.ts`, `packages/types/src/index.ts` (`ConnectorEvent.raw_payload`, `ConnectorSendResult.raw_payload`), `apps/studio/server/src/connectors/{event-router.ts,tools.ts,sse-hub.ts}`, `apps/studio/server/src/routes/connectors.ts`, `plugins/jiku.telegram/src/index.ts`, `apps/studio/web/{lib/api.ts,components/channels/{events,messages}-tab.tsx}`.

## 2026-04-13 — Channels page tabbed (Connectors / Messages / Events)

- Project channels page is now a 3-tab UI; tab + `connector_id` filter live in URL.
- New project-level endpoints with cursor pagination + filters (connector / direction|event_type / status / date range): `GET /projects/:pid/connector-events`, `/connector-messages` and matching `/stream` SSE endpoints.
- Project-level SSE hub (`sse-hub.ts`) broadcasts events/messages after each DB log; subscribers filter server-side.
- `authMiddleware` now also accepts `?token=` so EventSource (which cannot set custom headers) can authenticate.
- Connector detail Events/Messages buttons jump to `channels?tab=…&connector_id=…` (auto-applied filter). Old per-connector pages deleted.
- Row click opens a Sheet drawer with full payload, ref_keys, metadata, status/drop_reason.
- Files: `apps/studio/db/src/queries/connector.ts`, `apps/studio/server/src/connectors/{sse-hub.ts,event-router.ts}`, `apps/studio/server/src/routes/connectors.ts`, `apps/studio/server/src/middleware/auth.ts`, `apps/studio/web/lib/api.ts`, `apps/studio/web/components/channels/{connectors,messages,events}-tab.tsx`, `apps/studio/web/app/(app)/studio/companies/[company]/projects/[project]/channels/page.tsx`, `apps/studio/web/app/(app)/studio/companies/[company]/projects/[project]/channels/[connector]/page.tsx`.

## 2026-04-13 — fix: connector tools missing in cron task runs

- **Root cause:** `runtimeManager.resolveSharedTools()` gates `connectorTools` behind `connectorRows.length > 0`, and the result is cached per project. No connector CRUD route was invalidating this cache — so the first connector added to a project registered in the DB but was NEVER reflected in the agent toolset until server restart. Cron-triggered task runs then received a [Cron Delivery] prompt claiming `connector_send` exists, while the tool was actually missing from `aiTools`; the model complied by emitting the args as plain JSON text instead of a tool call.
- **Fix:** `POST /projects/:pid/connectors` (with and without credential) and `DELETE /connectors/:id` now call `runtimeManager.syncProjectTools(projectId)` after the DB write. First-connector-of-a-project now immediately registers connector tools for every agent; last-connector deletion immediately removes them.
- Files: `apps/studio/server/src/routes/connectors.ts`.

## 2026-04-13 — Cron one-shot mode + archive lifecycle

- Added `mode: 'once' | 'recurring'` and `status: 'active' | 'archived'` to `cron_tasks`. One-shot fires at `run_at` then auto-archives on success (no retry). Archived tasks excluded from default lists and scheduler but preserved in DB.
- `cron_list` tool takes `include_archived`. New `cron_archive` / `cron_restore` agent tools.
- REST: `POST /cron-tasks/:id/archive`, `POST /cron-tasks/:id/restore`; list `?status=archived` & `?include_archived=1`; PATCH accepts `mode`/`run_at`.
- Scheduler: recurring via `croner`; once via `setTimeout(run_at - now)`. Past-due once fires immediately on startup.
- UI: Active/Archived tabs on list; mode picker (cron vs datetime-local) on create and detail pages; archived tasks read-only with Restore.
- Migration `0025_cron_once_and_archive.sql` — adds `mode`/`run_at`/`status`, makes `cron_expression` nullable, indexes `(project_id, status)`.
- Files: `apps/studio/db/src/migrations/0025_cron_once_and_archive.sql`, `apps/studio/db/src/schema/cron_tasks.ts`, `apps/studio/db/src/queries/cron_tasks.ts`, `apps/studio/server/src/cron/{scheduler.ts,tools.ts}`, `apps/studio/server/src/runtime/manager.ts`, `apps/studio/server/src/routes/cron-tasks.ts`, `apps/studio/web/lib/api.ts`, `apps/studio/web/app/(app)/studio/companies/[company]/projects/[project]/cron-tasks/{page.tsx,new/page.tsx,[id]/page.tsx}`.

## 2026-04-13 — Plan 23 post-ship: branch-aware compaction + UX fixes

**Fixed (UX bugs found in QA):**
- **Edit didn't actually branch.** `branchMeta` was stale right after a turn ended, so `submitEdit` couldn't find the parent of the edited message → `parent_message_id` fell to `null` → chat route's `?? undefined` downgraded that to "use active_tip" → linear append. Two-part fix: (a) `refreshMessages()` now runs whenever streaming transitions true→false (kept off the initial mount to avoid racing `pending_message`), (b) chat route preserves the null-vs-undefined distinction, (c) `submitEdit` re-fetches meta if missing for the edited message.
- **First message disappeared after redirect from `/new`.** My initial `refreshMessages()` on mount raced with `useChat`'s optimistic send from the `pending_message` handler — the empty DB fetch wiped the just-typed message until the response completed. Replaced mount-time `refreshMessages` with a meta-only `hydrateBranchMetaOnly` that doesn't touch the messages array.
- **Edit visually appended to old turn before snapping into a branch.** Optimistically `setMessages(prev.slice(0, idx))` before `sendMessage` so the edited message and everything after it disappear immediately and the new turn renders in the branched position.
- **Branch navigator was above the message.** Moved inline into the action bar (next to Copy/Edit/Regenerate). Dropped the "Edit"/"Response" labels — context is clear.
- **Regenerate ran silently in the background.** Now starts `useLiveConversation` polling immediately, optimistically removes the old assistant message, drains the response body so server-side SSE actually flows (raw fetch left it unread → backpressure stalled writes), and the live-parts buffer streams the new assistant in real time.
- **Regenerate indicator vanished after one frame.** First `/live-parts` poll was racing the server's `streamRegistry.startRun(convId)` — sometimes returned `running:false` → `stop()` + `onDone` immediately. Added an 8-second startup grace to `useLiveConversation`: `running:false` is tolerated until we've seen `running:true` once OR the grace window expires.
- **Regenerate fetch had no auth.** `api.conversations.regenerate` was using raw `fetch()` without `BASE_URL` or `getAuthHeaders()` (probably 401-ing). Routed through the standard headers/baseURL pattern.

**Backend correctness (objective audit found these — UI testing wouldn't have caught them):**
- **Edit leaked old turn into model context.** Runner was loading history from `conversation.active_tip_message_id` regardless of `params.parent_message_id`. For an edit on message M, the old M and its assistant reply were still in the path → model treated the edit as a follow-up. Fix: when `params.parent_message_id` is supplied, walk history via `getMessagesByPath(params.parent_message_id)`. Null means explicit "branch at root" → empty history.
- **Regenerate duplicated the user message in model context.** With the above fix, history now includes the user message we're regenerating from. Runner was still pushing `params.input` again → model saw the same user message twice. Skip the input push when `params.regenerate === true`.

**Compaction redesigned (ADR-073 revised — supersedes the original "skip on branched conv"):**
- Reread `applyCompactBoundary()` and confirmed the existing system already uses an `[Context Summary]\n…` text-marker pattern; only `replaceMessages` (DELETE + reinsert) was destructive.
- `checkCompactionThreshold` now measures **active branch path tokens** (with `applyCompactBoundary` applied), not flat conversation tokens.
- When triggered, append the checkpoint as a new assistant message via `addBranchedMessage(parent = current_tip)` instead of `replaceMessages`. Old rows stay in DB → other branches keep walking through them.
- Skipped on **explicit branch fork** (edit-message where `parent_message_id !== current_tip`) and on **regenerate** so checkpoints aren't dumped into branches the user is leaving.
- For "linear extend" sends after compaction, `desiredParent` falls through to the latest tip (not the pre-compaction one), so the new user message chains off the checkpoint instead of becoming its sibling.
- `replaceMessages` retained as a fallback for adapters without `addBranchedMessage` (in-memory dev adapter).
- Preview snapshot (`runner.ts:~1040`) likewise switched to active-path token accounting + per-branch compaction count.

**Files touched (post-ship):**
- `packages/core/src/runner.ts` — history-load logic refactored around `historyRef` (linear-extend vs explicit-fork), compaction block rewritten to append-only, threshold + preview branch-aware.
- `apps/studio/server/src/routes/chat.ts` — null/undefined preservation in `parent_message_id`.
- `apps/studio/web/components/chat/conversation-viewer.tsx` — `hydrateBranchMetaOnly` mount, transition-only `refreshMessages`, optimistic prune in submitEdit/regenerate, navigator moved into action bar, regenerate streams via `useLiveConversation`.
- `apps/studio/web/hooks/use-live-conversation.ts` — startup grace for `running:false`.
- `apps/studio/web/lib/api.ts` — regenerate uses `BASE_URL` + `getAuthHeaders()`.
- `docs/builder/{decisions,memory}.md`, `docs/feats/branch-chat.md` — documented the compaction revision and active-branch-as-context-budget invariant.

**Type check:** web 0 errors; core has only the same pre-existing errors documented in Plan 22 rev 3 next-up (`UserContentPart[]`, NodeJS namespaces, etc.).

---

## 2026-04-13 — Plan 23: message-level branching (chat)

**Added:**
- **Schema (migration `0024_plan23_branch_chat.sql`):** `messages.parent_message_id` (self-FK, ON DELETE CASCADE) + `messages.branch_index` (int, default 0); `conversations.active_tip_message_id` (FK → messages, ON DELETE SET NULL). Backfill: existing messages get linear parent chain by `created_at`; each conversation's tip = its last message. Indexes: `idx_messages_parent`, `idx_messages_conv_parent`, `idx_conv_active_tip`.
- **Drizzle schema:** `apps/studio/db/src/schema/conversations.ts` — added the three columns + indexes via `AnyPgColumn` for the self/cross references.
- **Query layer (`apps/studio/db/src/queries/conversation.ts`):**
  - `getActivePath(convId)` — recursive CTE that walks tip → root via `parent_message_id` and attaches `sibling_count` + `sibling_ids` per row (ADR-062).
  - `getMessagesByPath(tipId)` — same walk, returns raw rows for the runner.
  - `getLatestLeafInSubtree(rootId)` — ADR-064 "latest leaf" descent (always `MAX(branch_index)`).
  - `setActiveTip(convId, tipId)` — persist a new active tip.
  - `addBranchedMessage({conv, parent, role, parts})` — single-tx insert with auto-computed `branch_index = max(siblings)+1` then bump `active_tip_message_id`.
  - `getMessageById`, `conversationHasBranching`.
- **Storage adapter:** `StudioStorageAdapter` implements new optional `JikuStorageAdapter` methods `getActivePathMessages`, `getMessagesByPath`, `addBranchedMessage`, `setActiveTip`. `Message` mapping now carries `parent_message_id` + `branch_index`. `Conversation` mapping carries `active_tip_message_id`.
- **Runner (`packages/core/src/runner.ts`):**
  - History load now uses `getActivePathMessages` whenever the storage supports it AND the conversation has a tip set; falls back to linear `getMessages` (in-memory adapter / new convs).
  - User message persistence routed through `addBranchedMessage` with `parent_message_id` chosen as `params.parent_message_id ?? conversation.active_tip_message_id`. Assistant message hangs off the just-saved user msg id.
  - New `JikuRunParams.regenerate` flag: skips the user-save and treats `parent_message_id` (which must be a user msg) as the existing user turn — the new assistant message becomes a sibling of any prior reply.
  - Compaction is skipped when the conversation has any branching (sibling_count > 1 anywhere) — branched-conv compaction is out of scope for the initial release (edge case #5).
- **HTTP routes (`apps/studio/server/src/routes/`):**
  - `POST /conversations/:id/chat` accepts optional `parent_message_id` in body and forwards to runner (ADR-063: branching is implicit — new sibling auto-detected when parent already has children).
  - `GET /conversations/:id/messages` returns `{ conversation_id, active_tip_message_id, messages }` where each message carries branch metadata (sibling_count/ids/current_index) when the conv has a tip; falls back to flat list otherwise.
  - `GET /conversations/:id/sibling-tip?sibling_id=` resolves the latest-leaf tip inside a sibling subtree (used by the navigator before switching).
  - `PATCH /conversations/:id/active-tip` switches the active tip and returns the new active path; rejected with 503 while a run is in progress (ADR-066).
  - `POST /conversations/:id/regenerate { user_message_id }` sets the active tip to that user message and triggers the runner with `regenerate: true`. Rejected with 409 if a run is in progress.
- **Frontend API client (`apps/studio/web/lib/api.ts`):** `conversations.messages` return type extended with branch metadata; new `resolveSiblingTip`, `setActiveTip`, `regenerate` helpers.
- **`ConversationViewer`:**
  - Tracks `activeTip` + `branchMeta` map (id → `{parent_message_id, branch_index, sibling_count, sibling_ids, current_sibling_index}`); hydrated on mount and after each refresh via `refreshMessages()`.
  - `prepareSendMessagesRequest` includes `parent_message_id: activeTipRef.current` (ref mirror so the captured closure always sees the latest tip).
  - Message render loop renders an inline `BranchNavigator` above any message with `sibling_count > 1` (label: "Edit" for user, "Response" for assistant). Edit button on user messages opens `MessageEditInput`; Regenerate button on assistant messages calls the regenerate endpoint then polls `/status` until done.
  - Edit submit: stamps `activeTip` to the edited message's parent so the next `sendMessage` lands as a sibling, then sends.
- **Components:**
  - `apps/studio/web/components/chat/branch-navigator.tsx` — `← N/total →` with optional contextual label, hidden when only one sibling exists.
  - `apps/studio/web/components/chat/message-edit-input.tsx` — inline `Textarea` + Send/Cancel; ⌘/Ctrl+Enter to submit, Esc to cancel.
- **Types (`@jiku/types`):** `Message.parent_message_id` + `Message.branch_index` (optional), `Conversation.active_tip_message_id` (optional), `MessageWithBranchMeta`. `JikuStorageAdapter` gains optional `getActivePathMessages` / `getMessagesByPath` / `addBranchedMessage` / `setActiveTip`. `JikuRunParams` gains `parent_message_id?` + `regenerate?`.

**Files:** `apps/studio/db/src/migrations/0024_plan23_branch_chat.sql`, `apps/studio/db/src/schema/conversations.ts`, `apps/studio/db/src/queries/conversation.ts`, `apps/studio/server/src/runtime/storage.ts`, `apps/studio/server/src/routes/{chat,conversations}.ts`, `packages/core/src/runner.ts`, `packages/types/src/index.ts`, `apps/studio/web/lib/api.ts`, `apps/studio/web/components/chat/{conversation-viewer,branch-navigator,message-edit-input}.tsx`.

**Deferred:** sidebar "(branched)" hint, error-toast UI integration, keyboard-arrow navigation, branched-conversation compaction. Manual UX QA + E2E tests pending.

---

## 2026-04-13 — Plan 22 revision part 3: simulate_typing per send, structured prompt, /reset, fixes

**Added:**
- **Structured markdown system prompt** (`buildSystemPrompt` rewrite). Sections now: `## Runtime Context (Priority Rules)` (prepend), `## Base Prompt`, `## Persona`, `## Skills`, `## Memory`, `## Mode Instruction`, `## User Context`, `## Tool Hints`, `## Plugins` (with `### <plugin name> (<plugin.id>)` sub-headers), `## Runtime Context` (Company & Team / Project Context). Auto-strip leading `[Foo]` brackets from segment content because the markdown header replaces them. Plugin segments now resolved via `getPromptSegmentsWithMetaAsync()` so each plugin's name + id is a sub-header. Preview Context Sheet picks up the new `runtime` source group automatically.
- **`extra_system_prepend`** in `JikuRunParams` for hard rules above base_prompt. Used by Studio to put the Scheduling Capability segment at the very top so weak-base-prompt agents don't reject reminders. Preview shows them under `## Runtime Context (Priority Rules)` with `(prepend)` suffix.
- **`/reset` command in Telegram event-router.** DM = clear `identity.conversation_id`; group/topic = clear `connector_scope_conversations.conversation_id` for that scope. History rows preserved; next message creates a fresh conversation.
- **Telegram typing simulation per send-action.** New `ConnectorContent.simulate_typing` flag. TelegramAdapter `sendMessage` (text-only ≤ 4000 chars) sends `⌛` placeholder, then 3-stage progressive reveal (33% → 66% → full) with `\n\n⚪` indicator and 2s ticks; final edit applies markdown cleanly. Auto-reply path passes `simulate_typing: true` by default (user is waiting); agent tools (`connector_send`, `connector_send_to_target`) accept it as opt-in param defaulting false (notifications/broadcasts stay clean).
- **Telegram connector usage logging in chat path.** `executeConversationAdapter` now drains `data-jiku-usage` / `data-jiku-meta` / `data-jiku-run-snapshot` chunks from the runtime stream and calls `recordLLMUsage({ source: 'chat', ... })`. Previously usage was only recorded in HTTP `/chat` route — Telegram replies invisible in Usage Log.
- **Project timezone settings** finalized: full IANA dropdown grouped by region (Asia first), label "Timezone", default `Asia/Jakarta` for new projects (migrations `0021`, `0022`).
- **Capability-hint Scheduling Capability segment** strengthened to forbid common refusal phrases ("aku tidak bisa pasang pengingat", "set di alarm HP", "pakai Google Assistant") + concrete cron_create example with delivery wiring + explicit update/delete workflow (cron_list → cron_update / cron_delete).

**Fixed:**
- **Cron infinite loop.** Cron-fired agent re-interpreted stored prompt as a new reminder request → re-called cron_create. Root cause: stored prompt was the user's verbatim message. Fixed by: `[Cron Trigger]` preamble at fire time + cron_create tool description forbids echoing user + soft rails reject prompts < 30 chars or starting with first-person ("Ingatkan saya..."). `[Cron Trigger]` also explicitly states cron mutation tools ARE allowed in cron-fired runs (dynamic scheduling supported).
- **Cron delivery silently failed.** Agent in task mode wrote reminder text but didn't call `connector_send`. Two root causes: (1) prompt referenced `connector_send(...)` while AI SDK exposed the tool as `builtin_connector_send` → name mismatch → model "I cannot access". Removed the `builtin_` prefix entirely in `runner.ts` (built-in tools now use bare `meta.id` as `tool_name`), saves tokens. (2) Task mode agents treat text output as the deliverable. `[Cron Trigger]` preamble now explicitly says: "Any text you write is logged internally only — user receives NOTHING; only tool calls reach them" + REQUIRED OUTPUT FORMAT: short narration sentence + tool call in the SAME response.
- **Edit re-runs side-effectful tools (ADR-060).** Editing a chat message replayed AI SDK execute() for previously-fired tools → duplicate cron rows / sends. Fix: `ToolMeta.side_effectful` + runner-level dedup map keyed by `${tool_name}:${stableHash(args)} → cached_result`. Marked: cron_create/update/delete, connector_send, connector_send_to_target, connector_run_action, connector_create_target/update_target/delete_target/save_current_scope, identity_set.
- **Cron context wiped by prompt edit (ADR-061).** `[Cron Trigger]` / `[Cron Delivery]` blocks were baked into `cron_tasks.prompt`; UI prompt edits deleted them. Migration `0020` adds `cron_tasks.context jsonb`. New `cron/context.ts` composes `[Cron Trigger]` + `[Cron Origin]` + `[Cron Subject]` + Instruction + `[Cron Delivery]` at fire time. `cron_create` tool now takes `origin` / `delivery` / `subject` as separate input fields. `cron_update` shallow-merges context.
- **Heartbeat cron parser broken.** `*/30 * * * *` → hand-rolled parser computed NaN → fell through to "every minute" default. Replaced with `croner` `nextRun()` (same library as cron/scheduler.ts). Reject 6-field expressions to prevent runaway "every-30-second" misparses.
- **Audit log UUID crash.** Connector-triggered tool invocations had `actor_id = "connector:<uuid>"` which Postgres rejected on the `uuid` column. Audit logger now nulls non-UUID actor_ids, sets `actor_type` to `'connector'` / `'system'` accordingly, and stores the original label in `metadata.actor_label`. ActorType union extended with `'connector'`.
- **System-user UUID crash in plugin-permissions loader.** Cron/reflection invocations with `caller.user_id = 'system'` hit the `project_memberships.user_id` UUID column. Runtime guard skips lookup for non-UUID caller ids. Closes the corresponding entry in Plan 21 follow-ups.
- **Telegram `editMessage` ignores markdown.** Was always sending plain text. Now respects `content.markdown` (escape via `telegramify-markdown`, set `parse_mode: MarkdownV2`).
- **Cron-tasks list filtered by callerIdFilter for everyone non-superadmin** → admins saw empty list. Loosened: anyone with `cron_tasks:write` sees full project list.
- **Cron Tasks permission group missing in Settings UI.** Added under `settings/permissions/page.tsx` so admin/manager roles can toggle `cron_tasks:read/write`.
- **Edit-bleed regression in cron-fired runs.** ADR-063 reverts an earlier idea to suppress cron mutation tools in cron-fired runs (would have broken conditional/dynamic cron chains). Loop prevention now relies on prompt discipline + side-effect dedup instead.

**DB migrations:**
- `0019_plan22_backfill_admin_cron_perms.sql` — backfill `Admin` project_roles with `cron_tasks:read/write`.
- `0020_plan22_cron_context.sql` — `cron_tasks.context jsonb`.
- `0021_plan22_project_timezone.sql` — `projects.default_timezone text` (default 'UTC').
- `0022_plan22_timezone_default_jakarta.sql` — change default to `Asia/Jakarta`.
- `0023_plan22_binding_simulate_typing.sql` — DROP COLUMN (was tried at binding level then reverted to per-send-action param).

**Files touched:**
- Types: `packages/types/src/index.ts` — `ToolMeta.side_effectful`, `JikuRunParams.suppress_tool_ids`, `JikuRunParams.extra_system_segments`, `JikuRunParams.extra_system_prepend`, `ConnectorContent.simulate_typing`, `ContextSegment.source += 'runtime'`, `ConnectorBinding.scope_key_pattern` (kept; `simulate_typing` reverted).
- Core: `packages/core/src/runner.ts` (dedup map, prepend support, labeled plugin segments, no `builtin_` prefix), `packages/core/src/runtime.ts` (preview wiring), `packages/core/src/resolver/prompt.ts` (markdown structured `buildSystemPrompt` with `LabeledSegment[]`, `prepend_segments`, `runtime_segments`).
- DB: `apps/studio/db/src/schema/{cron_tasks,projects,connectors}.ts`, `apps/studio/db/src/queries/connector.ts`, four migrations above.
- Server runtime: `apps/studio/server/src/runtime/manager.ts` (UUID guard, prepend Scheduling Capability, Company & Team + Project Context segment injection in run + previewRun), `apps/studio/server/src/runtime/team-structure.ts` (new), `apps/studio/server/src/runtime/project-context.ts` (new).
- Cron: `apps/studio/server/src/cron/context.ts` (new — prelude composer), `apps/studio/server/src/cron/tools.ts` (cron_create/update with origin/delivery/subject + safety rails + side_effectful flag), `apps/studio/server/src/cron/scheduler.ts` (composed prelude on fire).
- Heartbeat: `apps/studio/server/src/task/heartbeat.ts` (croner-based parser).
- Connectors: `apps/studio/server/src/connectors/event-router.ts` (`/reset` command, scope-aware conversation resolution, side_effectful awareness, simulate_typing default true on auto-reply, usage log capture, media context hint with event_id), `apps/studio/server/src/connectors/tools.ts` (mark side_effectful, simulate_typing param on send tools, agent-side target CRUD).
- Telegram: `plugins/jiku.telegram/src/index.ts` (scope helpers, `extractTelegramMedia` → DB metadata pipeline, `sendMessage` media/media_group/scope, 9 new actions, `editMessage` markdown support, `sendWithTypingSimulation` 3-stage reveal).
- Audit: `apps/studio/server/src/audit/logger.ts` (non-UUID actor guard).
- Routes: `apps/studio/server/src/routes/projects.ts` (PATCH accepts `default_timezone` with IANA validation), `apps/studio/server/src/routes/cron-tasks.ts` (admin sees all on `cron_tasks:write`), `apps/studio/server/src/routes/connectors.ts` (targets + scopes routes).
- Web: `apps/studio/web/lib/api.ts` (Project type + targets/scopes clients), settings General (timezone Select dropdown grouped by region), settings Permissions (Cron Tasks group), connector detail page (Targets card), binding editor (Scope Filter field; simulate_typing toggle removed), context-preview-sheet (`runtime` source label).
- Plan doc: `docs/plans/22-channel-system-v2.md` — Revision appendix with full file list + ADR refs + migration order.

## 2026-04-13 — Plan 22 revision: project default_timezone + Project Context segment + preview parity

**Added:**
- **Project default timezone.** New `projects.default_timezone text NOT NULL DEFAULT 'UTC'` (migration `0021`). Settings → General has a datalist input populated from `Intl.supportedValuesOf('timeZone')`. Validated server-side via `Intl.DateTimeFormat` probe before save.
- **`[Project Context]` system segment.** `runtime/project-context.ts` builds: project name, default timezone (with shortOffset hint), current UTC time, current local time, and explicit interpretation rules (local-time-without-zone defaults to project tz; cron expressions stay UTC; conversion example using project tz). Injected via `extra_system_segments` in both `runtimeManager.run` and `runtimeManager.previewRun`.
- **Preview parity.** Both `[Company & Team]` and `[Project Context]` now appear in `previewRun` segments list (labelled "Runtime Segment 1/2"), so the Context Preview Sheet matches what the model actually receives. Previously the team segment was added at run time only — invisible in preview.
- **`cron_create.cron_expression` description** references `[Project Context]` as the timezone fallback so the agent knows to consult it.

**DB migration:** `0021_plan22_project_timezone.sql`.

**Files touched:**
- `apps/studio/db/src/schema/projects.ts` + `migrations/0021_plan22_project_timezone.sql`
- `apps/studio/server/src/routes/projects.ts` (PATCH accepts `default_timezone` with IANA validation)
- `apps/studio/server/src/runtime/project-context.ts` (new)
- `apps/studio/server/src/runtime/manager.ts` (`previewRun` injects extra segments; `run` already does)
- `packages/core/src/runner.ts` (`previewRun` accepts + appends `extra_system_segments`)
- `packages/core/src/runtime.ts` (`previewRun` threads `extra_system_segments`)
- `apps/studio/server/src/cron/tools.ts` (cron_expression description)
- `apps/studio/web/lib/api.ts` (Project type + `update` body type)
- `apps/studio/web/app/(app)/.../settings/general/page.tsx` (timezone datalist input)

## 2026-04-13 — Plan 22 revision: cron architecture + side-effect dedup + team structure

**Fixed:**
- **Cron infinite loop.** Cron-fired agent re-interpreted stored prompt as a new reminder request → called `cron_create` recursively. Root cause: prompt stored the user\'s verbatim request. Fix: `[Cron Trigger]` preamble composed at fire time + `prompt` description forbids echoing user + two soft rails reject short / first-person prompts.
- **Edit bleed bug (ADR-060).** Editing a chat message caused side-effectful tools (`cron_create`, `connector_send`, etc.) to re-execute during AI SDK replay, overwriting the original DB row and wiping delivery context. New `ToolMeta.side_effectful` flag + runner-level dedup map (`tool_name:hash(args) → cached_result`) short-circuits replay execution.
- **Cron context wiped by prompt edit (ADR-061).** Delivery/Origin/Subject blocks used to be concatenated into `prompt`, so editing `prompt` in UI deleted them. New `cron_tasks.context` jsonb column stores structured origin/delivery/subject; scheduler composes the prelude at fire time via `apps/studio/server/src/cron/context.ts`.
- **Admin invisible cron list.** Admin role members saw empty cron list because route filtered by `callerIdFilter: userId` for everyone except superadmin. Now anyone with `cron_tasks:write` sees the full project list.
- **Admin cron menu missing.** Existing Admin roles had stale permission arrays missing `cron_tasks:*`. Migration `0019_plan22_backfill_admin_cron_perms.sql` patches them. Permission settings UI now exposes the "Cron Tasks" group so it can be toggled per role.
- **System-user UUID crash.** Cron/reflection jobs invoking the runtime with caller `user_id = \'system\'` (or `connector:<uuid>`) crashed the plugin-permission loader on Postgres UUID cast. Runtime guard skips the lookup for non-UUID caller ids.

**Added:**
- **Company & Team prompt segment (ADR-062).** New `JikuRunParams.extra_system_segments` + `runtime/team-structure.ts` build a per-run `[Company & Team]` block listing project members, roles, and known identities (`user_identities` + approved `connector_identities.external_ref_keys`). Agents gain cross-user awareness so "ingatkan user B" resolves without guessing.
- **Cron dynamic mutation allowed (ADR-063).** Cron-triggered runs KEEP access to `cron_create/update/delete` — supports conditional scheduling ("kalau stok < 10, bikin reminder besok"). Loop prevention relies on prompt preamble + side-effect dedup instead of tool suppression.
- **Explicit cron inputs.** `cron_create` now takes `origin` + `delivery` + `subject` as structured fields. `cron_update` shallow-merges `context` so editing one field doesn\'t nuke the others.
- **Soft rails on cron prompt.** Reject when prompt `< 30 chars` or starts with first-person patterns ("Ingatkan saya...", "Remind me..."); agent retries with reworded prompt.

**Files touched:**
- `packages/types/src/index.ts` — `ToolMeta.side_effectful`, `JikuRunParams.suppress_tool_ids`, `JikuRunParams.extra_system_segments`
- `packages/core/src/runner.ts` — `priorSideEffectResults` map + dedup in execute wrapper; combine plugin + extra segments
- `apps/studio/db/src/schema/cron_tasks.ts` + `migrations/0019_…sql` + `migrations/0020_plan22_cron_context.sql`
- `apps/studio/server/src/cron/context.ts` (new), `cron/tools.ts`, `cron/scheduler.ts`
- `apps/studio/server/src/runtime/team-structure.ts` (new), `runtime/manager.ts` (UUID guard, team segment injection)
- `apps/studio/server/src/routes/cron-tasks.ts` (admin list fix)
- `apps/studio/server/src/connectors/tools.ts` (side_effectful flags)
- `apps/studio/web/app/(app)/.../settings/permissions/page.tsx` (Cron Tasks group)

## 2026-04-13 — Plan 22 follow-up: agent-side target mgmt + enriched context

**Added:**
- **Agent-side Channel Target CRUD.** Four new agent tools: `connector_create_target`, `connector_update_target`, `connector_delete_target`, `connector_save_current_scope`. Agents can now register their own named destinations without admin intervention — covers cases like "user asks the bot to remember this group/topic as X". `connector_save_current_scope` is a convenience shortcut that uses `adapter.targetFromScopeKey()` to derive ref_keys from the scope_key the agent already has in context.
- **Richer Connector Context string.** Now emits `Connector ID:` (UUID needed for target-creation tools), `Chat ref: chat_id=... thread_id=...` so the agent can pipe raw ids directly into `connector_create_target`.
- **Auto-derived scope_key in create_target.** When caller passes `thread_id` + a negative numeric `chat_id` (Telegram group pattern), the tool fills in `group:<chat_id>:topic:<thread_id>` automatically. Explicit scope_key still wins.

**Fixed:**
- **FK name truncation warning on `bun db:push`.** Postgres' 63-char identifier limit clipped auto-generated FK names on `connector_scope_conversations`. Switched to explicit `foreignKey({ name: 'fk_scope_conv_*', ... })` declarations in the schema + the migration SQL.

**Files touched:**
- `apps/studio/db/src/schema/connectors.ts` — explicit FK names on `connector_scope_conversations`
- `apps/studio/db/src/migrations/0018_plan22_channel_system_v2.sql` — explicit `CONSTRAINT fk_scope_conv_*`
- `apps/studio/server/src/connectors/tools.ts` — 4 new tools
- `apps/studio/server/src/connectors/event-router.ts` — `buildConnectorContextString` now accepts `connectorId`; emits Connector ID + chat ref line

## 2026-04-13 — Plan 22: Channel System v2 — scope_key isolation, channel targets, media pipeline, Telegram group mgmt

**Added:**
- **`scope_key` conversation isolation (ADR-056).** `ConnectorEvent.scope_key` carries the platform-specific conversation space (DM = undefined, `group:<chat_id>`, `group:<chat_id>:topic:<thread_id>`). New table `connector_scope_conversations` maps `(connector_id, scope_key, agent_id) → conversation_id`; DMs continue using `identity.conversation_id` (backward compat preserved).
- **Named Channel Targets (ADR-057).** New table `connector_targets` + CRUD API routes (`GET/POST/PATCH/DELETE /connectors/:id/targets`, `GET /connectors/:id/scopes`). Three new agent tools: `connector_list_targets`, `connector_send_to_target`, `connector_list_scopes`. Agents can now publish via names like `"morning-briefing"` without hardcoding chat IDs — unlocks cron-driven proactive messaging.
- **Media pipeline via event log (ADR-058).** `extractTelegramMedia()` stores `file_id` + metadata in `connector_events.metadata` at log time (no in-memory cache). AI receives only metadata (type, size, name) + an event_id hint. New `fetch_media` action performs lazy `bot.api.getFile()` → download → filesystem write via `__b64__:` binary convention. Persistent, auditable, restart-safe.
- **Scope filter on bindings (ADR-059).** `ConnectorBinding.scope_key_pattern` — null = all, `group:*`, `dm:*`, exact, or `group:-100...:topic:N`. Matched in `matchesTrigger()` via prefix wildcard.
- **TelegramAdapter overhauled.** `computeScopeKey()` + `targetFromScopeKey()` implemented. Inbound events populate `thread_id` + `metadata.chat_type/chat_title`. `sendMessage()` handles single media, `media_group` albums (max 10; auto-split photo/video vs document batches), and `target.scope_key`/`content.target_scope_key` routing. New actions: `fetch_media`, `send_media_group`, `send_url_media`, `send_to_scope`, `get_chat_members`, `create_invite_link`, `forward_message`, `set_chat_description`, `ban_member`. `caption_markdown` supported on `send_file`/`send_photo`.
- **Context injection enriched.** `buildConnectorContextString()` now emits `Chat scope:`, `Chat: <title> (<type>)`, and a `Media available: ... event_id: "..."` line that instructs the AI to use `fetch_media`.
- **Web UI — Channel Targets card + Scope Filter field.** Connector detail page has a new Targets section (add/list/delete). Binding editor gained a `scope_key_pattern` field with inline examples.

**DB migration:** `0018_plan22_channel_system_v2.sql` — `connector_scope_conversations`, `connector_targets`, `ALTER connector_bindings ADD COLUMN scope_key_pattern text`.

**Files touched:**
- DB: `apps/studio/db/src/schema/connectors.ts`, `apps/studio/db/src/queries/connector.ts`, `apps/studio/db/src/migrations/0018_plan22_channel_system_v2.sql`
- Types: `packages/types/src/index.ts` — `ConnectorEvent.scope_key`, `ConnectorEventMedia`, `ConnectorMediaItem`, `ConnectorContent.media_group/target_scope_key`, `ConnectorTarget.scope_key`, `ConnectorBinding.scope_key_pattern`, `ConnectorTargetRecord`, `ConnectorScopeConversationRecord`
- Kit: `packages/kit/src/index.ts` — `ConnectorAdapter.computeScopeKey` + `targetFromScopeKey`
- Server: `apps/studio/server/src/connectors/event-router.ts` (scope injection, scope-aware conversation resolution, scope filter, media context), `apps/studio/server/src/connectors/tools.ts` (3 new tools), `apps/studio/server/src/routes/connectors.ts` (targets + scopes routes)
- Telegram plugin: `plugins/jiku.telegram/src/index.ts` — full rewrite of adapter (scope helpers, media extraction, media_group/URL/scope sends, 9 new actions)
- Web: `apps/studio/web/lib/api.ts` (`targets` + `scopes` clients, `ConnectorTargetItem`, `ConnectorScopeItem`, `ConnectorBinding.scope_key_pattern`), connector detail page (Targets card), binding editor (Scope Filter field)

## 2026-04-13 — Plan 21 follow-up: Harness adapter polish + UI indicators + per-mode adapter UX

**Changed:**
- **HarnessAdapter rewritten as a two-phase iteration.** OpenAI Chat Completions API fundamentally cannot emit text + tool_call in one response; without this, GPT batches tool calls without narration. The adapter now runs, per iteration: (1) `tool_choice: 'none'` + `stepCountIs(1)` → forced narration, (2) `tool_choice: 'auto'` + `stepCountIs(N)` → tool or final text. Phase 1 also acts as a "direct answer" path for simple questions (skips phase 2 when the narration contains no action-intent phrasing).
- **Real-time streaming fix.** Both phases now call `sdkWriter.merge(result.toUIMessageStream({ sendFinish: false }))` IMMEDIATELY (before awaiting `result.steps`). Previously phase 2 merged after await, so AI SDK buffered all chunks and flushed them as one "flash" — user saw 3 tool invocations appear simultaneously. Finish chunk is now emitted manually via `ctx.sdkWriter.write({ type: 'finish' })` after the outer loop.
- **Multi-step-per-iteration append bug fixed.** When `max_tool_calls_per_iteration > 1`, phase 2 internally chains steps via AI SDK. Previous code appended only the LAST step to `messages`, losing intermediate tool context for the next iteration. Now iterates all action steps and appends each `(assistant + tool-result)` pair.
- **"Say and do" problem resolved.** `tool_choice='required'` on phase 2 was briefly tried — caused infinite random tool calls (`jiku_social_list_posts` x∞) because GPT is forced to pick ANY tool when the task is actually done. Reverted to `'auto'`; rely on regex + narration prompt for control flow instead. Deliberately do NOT append phase 1 narration to `messages` (phase 2 must see clean context, otherwise GPT frequently decides "I already answered" and emits empty → loop stalls).
- **`ACTION_INTENT_RE` heuristic.** After phase 1, English + Indonesian action-phrase regex decides: match → run phase 2, no match → narration IS the final answer, break loop. Prompt-only stay-silent rules were unreliable on GPT.
- **Phase 1 system prompt (`NARRATION_PHASE_INSTRUCTION`).** Tells the model the `tool_choice=none` constraint is mechanical, tools WILL be available in the next response, and to avoid re-announcing already-completed actions. Prevents "I can't access files" hallucination that contradicts the next turn's tool call.
- **Non-JSON tool output normalization.** `toJsonValue()` round-trips tool outputs through `JSON.stringify`/`parse` before appending to messages — needed because DB queries return `Date` objects which fail AI SDK v6's strict JSONValue schema on re-validation.
- **Config shape.** `max_iterations` (default 40), `max_tool_calls_per_iteration` (default 1 → narasi-per-tool UX; raise for batched chaining with fewer narrations), `force_narration` (default true; set false for Claude).
- **UI — chat / preview / bar surface mode + adapter.**
  - Chat message list: pulsing `w-2 h-2 bg-primary animate-pulse` dot on the last streaming assistant message, plus a standalone "thinking…" bubble when the stream starts with no assistant content yet. Copy button hides while that message is still streaming.
  - ContextBar (below prompt): shows `<model> · <provider> · [MODE] <adapter name>` on the left. Hover popover (with "Details" button) now also lists Mode, Adapter, and the resolved adapter config key/values.
  - ContextPreviewSheet: extended model info block with Mode, Adapter (display name + description), and expanded per-key adapter config list.
  - Preview API (`PreviewRunResult`): added `mode` and `adapter_info: { id, display_name, description?, config? }` resolved server-side from `agent.mode_configs[mode]` via `agentAdapterRegistry`.
- **Plugin prompt labels.** `previewRun` now uses `PluginLoader.getPromptSegmentsWithMetaAsync()` (new) so each plugin prompt appears in the preview as `<Plugin Name> (<plugin.id>)` instead of the generic `Plugin Segment 1/2/3`.
- **NarrationPlugin strengthened.** Added hard rules #9 "Say AND do — in the SAME response" and #10 "only end without tool when delivering final answer", plus explicit CORRECT vs INCORRECT pattern examples. Applies globally (every project, every adapter).
- **Agent settings UI.** `AgentConfigForm` (component, dead code, nobody imported it) deleted. Per-mode Adapter dropdown + dynamic config form rendered from `configSchema` now lives directly on the agent overview page (`.../agents/[agent]/page.tsx`). Max-tool-calls top-level field removed (that's adapter config now). Auto-focus on chat input restored (`autoFocus` + a `useEffect([convId, mode])` that focuses the textarea after route change to loaded-conversation mode).
- **Chats page.** Removed avatar fallback from the agent selector dropdown in new-chat mode — names only, per request.
- **DB default change.** `HarnessAgentAdapter.configSchema.max_iterations` default 40 (was 20).

**Files touched:**
- `packages/core/src/adapters/harness.ts`, `packages/core/src/adapters/default.ts`, `packages/core/src/adapter.ts`
- `packages/core/src/runner.ts`, `packages/core/src/runtime.ts`, `packages/core/src/index.ts`
- `packages/core/src/plugins/loader.ts` — added `getPromptSegmentsWithMetaAsync()`
- `packages/types/src/index.ts` — `PreviewRunResult.mode`, `PreviewRunResult.adapter_info`, `AgentModeConfig.config`, `jiku-harness-iteration` data event
- `apps/studio/server/src/plugins/narration.ts` — hard rules, correct/incorrect examples
- `apps/studio/server/src/routes/preview.ts` — populate `mode` + `adapter_info` via `agentAdapterRegistry`
- `apps/studio/web/lib/api.ts` — `AgentAdapterInfo`, preview result shape, `api.agents.listAdapters`
- `apps/studio/web/components/chat/context-bar.tsx` — adapter badge on left, popover mode/adapter/config rows
- `apps/studio/web/components/chat/context-preview-sheet.tsx` — mode + adapter + config list
- `apps/studio/web/components/chat/conversation-viewer.tsx` — pulsing indicator, copy-hide while streaming, thinking bubble, autofocus textarea on convId change
- `apps/studio/web/components/agent/chat/chat-interface.tsx` — mode badge on usage tooltip
- `apps/studio/web/app/(app)/studio/companies/[company]/projects/[project]/agents/[agent]/page.tsx` — per-mode adapter dropdown + dynamic config form; removed top-level max-tool-calls field
- `apps/studio/web/app/(app)/studio/companies/[company]/projects/[project]/chats/page.tsx` — removed Avatar fallback
- `apps/studio/web/components/agent/agent-config-form.tsx` — DELETED (dead code)

## 2026-04-13 — Plan 21: Agent Adapter System

- **Agent execution is now pluggable per-mode.** New `AgentAdapter` abstraction in `@jiku/core` (`packages/core/src/adapter.ts`) — `DefaultAgentAdapter` preserves the legacy `streamText` path, `HarnessAgentAdapter` runs an explicit iterative LLM → tools loop (one `streamText` per iteration, merged into the same UI stream).
- **Runner refactor.** `AgentRunner.run()` builds the adapter context once (`systemPrompt`, `messages`, `aiTools`, `modeTools`, shared `persistAssistantMessage`, `emitUsage`, writer handles) and calls `adapter.execute(ctx, params)`. The run-end finalize hook is fired inside `persistAssistantMessage` so both adapters get it.
- **Registry.** `apps/studio/server/src/agent/adapter-registry.ts` mirrors the browser adapter registry pattern. Built-ins registered at server start via `apps/studio/server/src/agent/index.ts` (side-effect imported from `server/src/index.ts`). `JikuRuntime` now accepts an `adapter_registry` option; `runtime/manager.ts` injects the Studio registry so every `AgentRunner` resolves adapters through it.
- **DB.** Migration `0017_agent_mode_configs.sql` (`ALTER TABLE agents ADD COLUMN mode_configs jsonb NOT NULL DEFAULT '{}'`). Drizzle schema updated. `wakeUp`, `syncProjectTools`, `syncAgent` forward `a.mode_configs` into `defineAgent()`.
- **API.** New `GET /api/agents/adapters` returns `{ adapters: [{ id, displayName, description, configSchema }] }`. `PATCH /api/agents/:aid` now accepts `mode_configs`.
- **Web.** `AgentConfigForm` renders a per-mode adapter `<select>` + a dynamic config form driven by each adapter's JSON Schema (number / boolean / string). Saved payload shape: `mode_configs: { chat: { adapter, config }, task: { adapter, config } }`. Only enabled modes are persisted.
- Files: `packages/types/src/index.ts`, `packages/core/src/adapter.ts`, `packages/core/src/adapters/default.ts`, `packages/core/src/adapters/harness.ts`, `packages/core/src/runner.ts`, `packages/core/src/runtime.ts`, `packages/core/src/index.ts`, `apps/studio/server/src/agent/adapter-registry.ts`, `apps/studio/server/src/agent/index.ts`, `apps/studio/server/src/index.ts`, `apps/studio/server/src/runtime/manager.ts`, `apps/studio/server/src/routes/agents.ts`, `apps/studio/db/src/migrations/0017_agent_mode_configs.sql`, `apps/studio/db/src/schema/agents.ts`, `apps/studio/web/lib/api.ts`, `apps/studio/web/components/agent/agent-config-form.tsx`.

## 2026-04-13 — Plan 20 hardening: Add Profile UX + CamoFox REST adapter + custom action registry

- **Add Profile modal UX fixed.** Root bug: `serializeAdapter` reported `ZodOptional.toLowerCase()` → `"optional"`, so every config field fell into a plain text Input regardless of underlying type. New `unwrapZod()` walks `Optional`/`Default`/`Nullable`/`Effects` wrappers to the leaf and extracts default, min/max, description, enum options. Frontend gains a shared `ConfigField` component — boolean → Switch, number → numeric Input with bounds, enum → Select, defaults → placeholders. Humanized labels, prefill defaults on adapter select.
- **Modal layout fix.** `DialogContent` widened to `sm:max-w-2xl` + scrollable body (`flex flex-col max-h-[90vh]`, body `overflow-y-auto flex-1`). `DialogFooter`'s baked-in `-mx-4 -mb-4` (assumed `p-4` on DialogContent) neutralized with `mx-0 mb-0 rounded-b-xl` — fixes footer sticking past the container edge.
- **CamoFox adapter rewritten as REST client.** Previous implementation (CDP via `@jiku/browser`) was wrong — upstream exposes a REST API on port 9377, not CDP. New adapter maps `BrowserAction`s to documented endpoints (`POST /tabs/:id/{navigate,click,type,press,scroll,wait}`, `GET /tabs/:id/{snapshot,screenshot}`, etc.). Session model: `userId` per profile, `sessionKey` per agent, tab IDs cached in-memory. Unsupported actions (`pdf`, `eval`, `cookies_*`, `storage`, `batch`, `drag`, `upload`, `dblclick`, `hover`, `focus`, `check`, `uncheck`, `select`, `scrollintoview`) throw clear errors.
- **`@jiku/camofox` wrapper package.** New `packages/camofox/` with self-contained Dockerfile — clones upstream at `CAMOFOX_REF` (default `master`), installs deps, runs `camoufox fetch` as `node` user to bake the Firefox binary into the image (without this, first request crashed with `Version information not found at /home/node/.cache/camoufox/version.json`). Non-root, pre-creates `/home/node/.camofox/cookies` + `/data/camofox`.
- **Docker compose + env.** Added Camofox services (Traefik-routed in `infra/dokploy/docker-compose.browser.yml`, host-ports in `apps/studio/server/docker-compose.browser.yml`). Both compose files build from `packages/camofox/docker`. Volumes: `camofox-cookies:/home/node/.camofox/cookies` (writable — upstream example uses `:ro` for import-only, we keep it writable for persistence) + `camofox-data:/data/camofox`. Browser section added to both `.env.example` files (`CAMOFOX_REF`, `CAMOFOX_API_KEY`, `CAMOFOX_ADMIN_KEY`, `CAMOFOX_PORT`, `CAMOFOX_DOMAIN`, `MAX_SESSIONS`, `MAX_TABS_PER_SESSION`, `SESSION_TIMEOUT_MS`, `IDLE_TIMEOUT_MS`, `PROXY_*`).
- **Chrome container stale-lock fix.** `entrypoint.sh` now wipes `/data/chrome-data/Singleton{Lock,Cookie,Socket}` before launching chromium. These survive SIGKILL/OOM and cause "profile appears to be in use by another Chromium process" on restart because the profile volume is persistent across container ids.
- **CamoFox wire-protocol fixes.**
  - `GET /tabs/:id/screenshot` returns **raw `image/png` binary**, not JSON. Adapter now uses dedicated `requestImage()` with `res.arrayBuffer()` + base64 encoding.
  - `POST /tabs` blocks non-http(s) URL schemes (`about:blank` rejected). Added `preview_url` config field (default `https://www.example.com`, user-overridable) so preview tab loads a valid page.
- **Custom action registry** for platform-specific features. `@jiku/kit` extended with `BrowserCustomAction` type + optional `customActions` and `runCustomAction()` on `BrowserAdapter`. Two new tools in `buildBrowserTools()`: `browser_list_actions(profile_id?)` returns a per-adapter action catalog with `input_schema` + example; `browser_run_action(profile_id?, action_id, params)` validates params via Zod `safeParse` and dispatches to `adapter.runCustomAction()`. Mirrors the existing `ConnectorAdapter.actions` / `connector_run_action` pattern.
- **CamoFox custom actions registered:** `youtube_transcript`, `links`, `images`, `downloads`, `macro`, `stats`, `import_cookies`. Each has a Zod schema + description + example.
- **Files:**
  - `packages/kit/src/browser-adapter.ts`, `packages/kit/src/index.ts`
  - `packages/camofox/{package.json,README.md,docker/Dockerfile}` (new)
  - `packages/browser/docker/entrypoint.sh`
  - `apps/studio/server/src/browser/tool.ts`
  - `apps/studio/server/src/routes/browser-profiles.ts`
  - `apps/studio/server/src/browser/adapters/jiku-browser-vercel.ts`
  - `apps/studio/web/lib/api.ts`
  - `apps/studio/web/app/(app)/studio/companies/[company]/projects/[project]/browser/{add-profile-modal,profile-tab,config-field}.tsx`
  - `apps/studio/server/docker-compose.browser.yml` (new)
  - `apps/studio/server/.env.example`
  - `infra/dokploy/docker-compose.browser.yml`
  - `infra/dokploy/.env.example`
  - `plugins/jiku.camofox/src/{adapter,types}.ts`

## 2026-04-13 — Plan 20: Multi browser profile + browser adapter system

- **Browser feature rearchitected.** One project → N browser profiles; each profile pins a `BrowserAdapter` (stable id like `jiku.browser.vercel` or `jiku.camofox`) with its own config. Unified `browser` tool now takes `profile_id?` and routes via the adapter registry.
- **New abstraction layer in `@jiku/kit`.** `BrowserAdapter` abstract class + `BrowserAdapterContext` / `BrowserAdapterResult` / `BrowserPingResult` / `BrowserPreviewResult` types + `defineBrowserAdapter()` helper.
- **Registry + plugin context.** `browserAdapterRegistry` in Studio server; plugins get `ctx.browser.register(adapter)` via `PluginBrowserAdapterAPI`. Built-in `JikuBrowserVercelAdapter` is registered at Studio boot.
- **DB migration `0016_browser_profiles.sql`** creates `browser_profiles` and seeds a `Default` profile per legacy enabled project.
- **Mutex + tab manager rekeyed** from `projectId` to `profileId`. Idle tab cleanup walks enabled profiles.
- **Routes.** New `/api/projects/:pid/browser/adapters`, `/profiles` CRUD, `/profiles/:id/{ping,preview,status,default}`. Legacy endpoints kept as backward-compat.
- **Frontend.** Multi-profile tab UI with per-profile status, live preview, debug panel, config, delete; `AddProfileModal` uses a radio-group adapter selector + dynamic config form.
- **New plugin `jiku.camofox`.** Auto-discovered.
- **Files:** `packages/kit/src/browser-adapter.ts`, `apps/studio/server/src/browser/*`, `apps/studio/server/src/routes/browser-profiles.ts`, `apps/studio/db/src/migrations/0016_browser_profiles.sql`, `apps/studio/db/src/schema/browser-profiles.ts`, `apps/studio/db/src/queries/browser-profiles.ts`, `apps/studio/web/app/(app)/studio/companies/[company]/projects/[project]/browser/*.tsx`, `apps/studio/web/lib/api.ts`, `plugins/jiku.studio/src/*.ts`, `plugins/jiku.camofox/**`.

## 2026-04-13 — Usage log: capture response + cover every LLM call site

- **`usage_logs.raw_response` column added.** Until now prompts + messages were stored but the LLM reply was dropped on the floor. New migration `0015_usage_logs_raw_response.sql` adds a nullable `varchar` column; schema + `recordLLMUsage()` + web types extended.
- **Every LLM call site now flows through `recordLLMUsage()` with response captured:**
  - `chat` (routes/chat.ts) — switched from direct `createUsageLog()` to `recordLLMUsage()`, includes duration + response aggregated from all steps.
  - `task` / heartbeat (task/runner.ts) — uses `runSnapshot.response` (fallback: drained `outputText`).
  - `title` (title/generate.ts), `reflection` (jobs/handlers/reflection.ts), `dreaming.light/deep/rem` (jobs/handlers/dreaming.ts) — all pass `raw_response: text`.
  - `compaction` (new source) — core `compactMessages()` returns usage + system + duration; `CompactionHook` plumbs them through; `buildCompactionHook()` logs with source `compaction` and resolves provider/model via agent.
  - `embedding` (new source) — `createOpenAICompatibleEmbedding()` logs each `embed()` call with `prompt_tokens`, texts as `raw_messages`, `vectors=N, dimensions=D` as `raw_response`.
- **Core runner emits `response` in `jiku-run-snapshot`.** Aggregates `steps.map(s => s.text).join('\n')` so chat + task consumers both see the final assistant text.
- **Raw Data dialog (both project + agent usage pages): accordion + scrollable.** Each section (System Prompt / Messages / Response) is now a collapsible `AccordionItem`; content uses `max-h-[50vh] overflow-auto` so long payloads scroll inside the dialog instead of stretching it.
- **Files:**
  - `apps/studio/db/src/schema/usage_logs.ts`, `apps/studio/db/src/migrations/0015_usage_logs_raw_response.sql`
  - `apps/studio/server/src/usage/tracker.ts` (UsageSource adds `compaction`, `embedding`)
  - `apps/studio/server/src/routes/chat.ts`, `task/runner.ts`, `title/generate.ts`
  - `apps/studio/server/src/jobs/handlers/reflection.ts`, `jobs/handlers/dreaming.ts`
  - `apps/studio/server/src/memory/hooks.ts` (compaction usage log), `memory/embedding.ts` (embedding usage log)
  - `packages/types/src/index.ts` (JikuDataTypes `jiku-run-snapshot.response`)
  - `packages/core/src/compaction.ts` (return usage/system/duration), `packages/core/src/runner.ts` (emit response, extended CompactionHook)
  - `apps/studio/web/lib/api.ts` (UsageLog.raw_response)
  - `apps/studio/web/app/(app)/studio/companies/[company]/projects/[project]/usage/page.tsx`
  - `apps/studio/web/app/(app)/studio/companies/[company]/projects/[project]/agents/[agent]/usage/page.tsx`

## 2026-04-13 — jiku.sheet plugin fixes + chat payload + task usage raw data

- **jiku.sheet: binary file hints wired end-to-end.** `buildBinaryFileHints()` now imported in `runtime/manager.ts` and passed to `buildFilesystemTools(projectId, hints)`. When `fs_read` encounters a binary file (.xlsx, .csv, etc.) and a plugin adapter is registered for that extension, the agent receives a redirect hint instead of raw base64 — preventing context overflow.
- **Plugin tool permission fix (`csv_read`, `sheet_read`).** Tools registered via `ctx.project.tools.register()` go through `resolveScope` which checks `caller.permissions.includes(resolved_permission)`. Permission `filesystem:read` was being prefixed to `jiku.sheet:filesystem:read` — a permission no caller ever has. Changed both tools to `permission: '*'` so they appear in agent tool list like built-in tools.
- **`sheet_read` empty-string sheet bug.** Agent passes `"sheet": ""` when it doesn't know which sheet to use. `??` operator doesn't replace empty string, so `"" ?? wb.sheetNames[0]` = `""`, triggering false "workbook is empty" error. Fixed with `||` operator. Also fixed error return to include actual `wb.sheetNames` instead of hardcoded `[]`.
- **`sheet_read` system prompt updated.** Agent now told: `sheet_read({ path: "..." })` is sufficient — don't fill optional fields unless needed; omit `sheet` to default to first sheet.
- **Removed `/* @vite-ignore */` from dynamic import in sheet plugin.** Comment was Vite-specific and wrong for Bun/tsup builds.
- **Express body limit raised 100KB → 10MB.** `express.json()` default 100KB was too small for long conversations with large tool results (sheet data). Fixed in `apps/studio/server/src/index.ts`.
- **Frontend chat: only send last user message.** `prepareSendMessagesRequest` in both `chat-interface.tsx` and `conversation-viewer.tsx` now sends only `[lastUserMessage]` instead of full `messages` array. Server loads history from DB itself — sending all messages was O(n) waste that caused 413 errors on long conversations.
- **Task runner captures `raw_system_prompt` + `raw_messages`.** Task/heartbeat runs were recording usage tokens but leaving system prompt and messages as `(not captured)` in the usage Raw Data view. Fixed by capturing `data-jiku-run-snapshot` chunk during stream drain — same pattern already used in `routes/chat.ts`.
- **Files:**
  - `apps/studio/server/src/runtime/manager.ts` — import + wire `buildBinaryFileHints()`
  - `apps/studio/server/src/plugins/ui/fileViewAdapterRegistry.ts` — `buildBinaryFileHints()` + `ADAPTER_ID_TO_TOOL` map
  - `apps/studio/server/src/filesystem/tools.ts` — `BinaryFileHints` type + `binaryHints` param + `fs_read` binary intercept + split `FS_READ_HINT`/`FS_WRITE_HINT`
  - `apps/studio/server/src/index.ts` — `express.json({ limit: '10mb' })`
  - `apps/studio/server/src/task/runner.ts` — capture `data-jiku-run-snapshot` → pass to `recordLLMUsage`
  - `plugins/jiku.sheet/src/index.ts` — permission `*`, `||` fix, all_sheets fix, prompt update, remove vite-ignore
  - `apps/studio/web/components/agent/chat/chat-interface.tsx` — last-message-only send
  - `apps/studio/web/components/chat/conversation-viewer.tsx` — last-message-only send

## 2026-04-12 — Plan 19 post-ship polish & bug fixes

- **Memory browser clickable rows → detail/edit dialog.** Content / importance /
  visibility editable via `PATCH /memories/:id`; immutable fields (scope, tier,
  agent, type, source_type, health, timestamps) displayed read-only.
- **Memory table columns for Type + Health.** Type badge color-coded per
  `memory_type`; Health rendered as 0..1 progress bar with threshold colors
  (green ≥0.8, amber ≥0.5, orange ≥0.2, red <0.2).
- **Raw data capture in background LLM calls.** Reflection, title, and dreaming
  (light/deep/rem) now include `raw_system_prompt` + `raw_messages` so the Raw
  Data dialog on `/usage` shows the actual exchange, not `(not captured)`.
- **Reflection handler fix.** Previously filtered on LLM internal `steps.length`
  instead of conversation user-turn count → never triggered. Handler now
  re-fetches messages and counts `role='user'` rows against
  `min_conversation_turns`.
- **SkillLoader fs.read unwrap fix.** `fs.read()` returns `{ content, version,
  cached }` since Plan 16 v2, but loader passed the object to `parseSkillDoc()`
  causing `content.match is not a function` for every FS skill sync. Applied
  at all call sites in `loader.ts`.
- **`/files/content` route fix.** Same class of bug — route was sending the
  full wrapper object as `content` field to the frontend editor, breaking
  both skills page and disk page editors (`value must be typeof string`).
- **Usage page: Source column + filter + duration + color badges.** Source
  filter dropdown surfaces chat / task / reflection / dreaming.* / flush /
  title / plugin:*. Agent column shows `—` for background-job rows.
- **Dreaming model picker replaced.** `model_tier: cheap|balanced|expensive`
  dropped in favor of explicit `credential_id` + `model_id` (CredentialSelector
  + ModelSelector — same pattern as agent LLM page). Legacy fallback to first
  agent's credential preserved so old configs don't break silently.
- **Cron input convention.** Dreaming phases + agent heartbeat now use
  `CronExpressionInput` (cronstrue live preview + presets). Codified in
  `docs/builder/memory.md`.
- **Import parser accepts `npx skills add` command form.** Paste the full
  `npx skills add https://github.com/owner/repo --skill name` (or `pnpx`/`bunx`,
  with `-s`/`--skill=`/`--ref`/`--branch`/`--tag` flags) — parser extracts
  URL + skill name and rebuilds canonical spec.
- **skills.sh discovery convention.** Importer now follows vercel-labs resolver
  order: literal path → `skills/<name>` → `skills/.curated/<name>` →
  `.claude/skills/<name>` → etc. → recursive fallback. Error lists available
  skill names in the repo when no match found.
- **Preview context includes on-demand skill hint.** Previously skills XML hint
  only appeared in the actual system prompt; preview missed it. Also reordered
  preview segments to match `buildSystemPrompt` output exactly.
- **Orphan `settings/memory/page.tsx` deleted.** Left over from first Dreaming
  UI attempt, never wired to nav, had stale `model_tier` types that broke the
  build.
- **FK name length.** `plugin_granted_permissions` foreign keys renamed to
  explicit short names to stay under Postgres 63-char identifier limit
  (previously hit truncation NOTICE on `db:push`).
- **Files:**
  - `apps/studio/server/src/jobs/handlers/{reflection,dreaming}.ts`,
    `title/generate.ts` — raw data + userTurns fix + tracker wiring
  - `apps/studio/server/src/skills/{loader,importer}.ts` — fs.read unwrap,
    skills.sh resolver, npx command parser
  - `apps/studio/server/src/routes/{filesystem,memory}.ts` — content unwrap,
    `PATCH /memories/:id`
  - `apps/studio/web/components/memory/{memory-browser,memory-config}.tsx` —
    detail dialog, Type/Health columns, CredentialSelector dreaming picker
  - `apps/studio/web/app/(app)/**/usage/page.tsx` — source filter + badge + duration
  - `apps/studio/web/components/providers.tsx` — `refetchOnWindowFocus: false`
  - `apps/studio/server/src/middleware/rate-limit.ts` — 120/min
  - `apps/studio/db/src/schema/plugin_granted_permissions.ts` — explicit FK names
  - Deleted: `apps/studio/web/app/(app)/**/settings/memory/page.tsx`

## 2026-04-12 — Usage tracking: every LLM call logs via `recordLLMUsage`

- `usage_logs` now accepts `agent_id` / `conversation_id` as nullable, adds
  `project_id`, `source` (varchar), and `duration_ms`. Migration
  `0014_plan19_usage_logs_expand.sql` backfills `project_id` from `agents` for
  legacy rows. Project-scope queries (`getUsageLogsByProject`,
  `getUsageSummaryByProject`, `getUsageCountByProject`) union rows matched by
  `project_id` OR by agent FK.
- New helper `apps/studio/server/src/usage/tracker.ts#recordLLMUsage()`
  (fire-and-forget). Sources: `chat`, `task`, `title`, `reflection`,
  `dreaming.{light,deep,rem}`, `flush`, `plugin:<id>`, `custom`.
- Wired: chat (existing path, added `source`+`project_id`), task runner
  (previously not logging at all!), title generator, reflection handler,
  all three dreaming phases.
- Rate-limit: raised `credentialRateLimit` 30 → 120/min. With multiple
  credential-dependent pages (agent LLM, memory config, disk, filesystem,
  channels), 30/min tripped too easily during normal navigation.
- React Query client: disabled `refetchOnWindowFocus` globally. Explicit
  invalidate after mutate is the one way to force fresh data; no more
  silent refires on tab flip.

## 2026-04-12 — Plan 19 Workstream B: Skills Loader v2

- FS-first skill packages: `/skills/<slug>/SKILL.md` with YAML frontmatter.
  `project_skills` becomes a cache; unique key now `(project_id, slug, source)`.
- `SkillLoader` (project-scoped) unifies FS + plugin sources; triggers on wakeUp
  and on plugin activation/deactivation.
- Plugin API: `ctx.skills.register({ slug, source: 'folder' | 'inline', ... })` in
  `setup()`. Studio tracks plugin roots (via `discoverPluginsFromFolder` dir) and
  propagates specs per project. Deactivate marks rows inactive (preserves
  `agent_skills` assignments).
- Runtime tools updated: `skill_list` / `skill_activate` / `skill_read_file` /
  `skill_list_files` — eligibility filter, categorized file trees, source labels.
- Progressive disclosure: `buildOnDemandSkillHint` emits structured XML with
  budget limits (50 skills, 20KB).
- Per-agent `skill_access_mode`: `manual` (current) or `all_on_demand`.
- Eligibility: `requires.{os, bins, env, permissions, config}` evaluated pre-run
  via `buildEligibilityContext`; `which`/`where` probed with 5-min cache.
- Import: `/skills/import` (GitHub tarball via public API) and `/skills/import-zip`
  (raw body ≤20MB). Caps enforced (1000 files, 2MB/file, 20MB total).
- UI: Import dialog + Refresh + source badge on project skills page.
  Access-mode toggle on agent skills page.
- Audit: `skill.import`, `skill.source_changed`, `skill.assignment_changed`.
- Migration `0013_plan19_skills_v2.sql`. New deps: `yaml` (core), `tar`, `unzipper`
  (studio/server).
- Docs: new `docs/feats/skills.md` with full architecture.

## 2026-04-12 — Plan 19 Workstream A: Memory Learning Loop

- Memory rows now typed (`episodic`/`semantic`/`procedural`/`reflective`), carry `score_health`
  and `source_type`. Retrieval boosts health; deep dreaming decays & purges dream-origin rows.
- New `background_jobs` table + `BackgroundWorker` (SKIP LOCKED pickup, retry/backoff).
  `enqueueAsync()` enforces fire-and-forget — stream must close before job insert.
- `CompactionHook` on core runner → studio enqueues `memory.flush` on every compaction summary.
- `FinalizeHook` on core runner → `memory.reflection` (opt-in per agent via
  `AgentMemoryConfig.reflection`). Handler extracts at most one insight, dedups (cosine ≥ 0.9).
- Dreaming engine: 3 phases (light/deep/REM) via per-project croner. `POST /api/projects/:pid/memory/dream`
  for manual trigger. `dreamScheduler` re-syncs on config PATCH.
- Audit events: `memory.write`, `memory.flush`, `memory.reflection_run`, `memory.dream_run`.
- UI: Dreaming section on project memory settings; Reflection section on agent memory page.
- Migration: `0012_plan19_memory_jobs.sql`.
- Files: `apps/studio/db/src/schema/{memories,background_jobs}.ts`,
  `apps/studio/db/src/queries/{memory,background_jobs}.ts`,
  `apps/studio/server/src/jobs/**`,
  `apps/studio/server/src/memory/hooks.ts`,
  `packages/core/src/{runner,runtime}.ts`,
  `packages/types/src/index.ts`.
  See `docs/feats/memory.md` → "Plan 19" section for full file list + contract.

## 2026-04-12 — Settings nav refactor: vertical sidebar + Access Control grouping

**Changed:** Replaced the horizontal Tabs bar on project Settings with a GitHub-style vertical sidebar. Three groups: **Project** (General, Credentials, MCP Servers), **Access Control** (Members, Roles, Agent Access, Policies, Plugin Permissions), **Observability** (Audit Log). Members / Roles / Agent Access still live on one URL but the internal Tabs is now URL-controlled via `?tab=`, so the sidebar can deep-link to each sub-tab and highlight correctly. Memory and Filesystem intentionally excluded — they remain on `/memory` and `/disk`. Motivation: admins struggled to reason about the relationship between Policies (rule engine) and Plugin Permissions (capability grants) when they sat as peer top-level tabs. Grouping them under "Access Control" with an obvious semantic gradient (members → role → agent scope → rules → plugin capability) makes the model legible.

**Files touched:** `apps/studio/web/app/(app)/studio/companies/[company]/projects/[project]/settings/layout.tsx`, `apps/studio/web/app/(app)/studio/companies/[company]/projects/[project]/settings/permissions/page.tsx`.

See ADR-043.

## 2026-04-12 — Plan 18: Production Hardening

Shipped all 5 sections from `docs/plans/18-fixing-prevs-plans.md`:
rate limiting (express-rate-limit, 5 layers), broad audit log system
(`audit_logs` table + `audit.*` helper + settings/audit UI with CSV export),
plugin policy enforcement (`required_plugin_permission` on `ToolMeta`,
per-member `plugin_granted_permissions` table, runner enforcement via
ToolHooks), tool hot-unregister (activate/deactivate triggers
syncProjectTools), and plugin permissions UI at settings/plugin-permissions.

Files added:
- `apps/studio/server/src/middleware/rate-limit.ts`
- `apps/studio/server/src/audit/logger.ts`
- `apps/studio/server/src/routes/audit.ts`
- `apps/studio/server/src/routes/plugin-permissions.ts`
- `apps/studio/db/src/schema/audit_logs.ts`
- `apps/studio/db/src/schema/plugin_granted_permissions.ts`
- `apps/studio/db/src/queries/audit.ts`
- `apps/studio/db/src/queries/plugin_permissions.ts`
- `apps/studio/db/src/migrations/0011_plan18_audit_and_permissions.sql`
- `apps/studio/web/app/(app)/studio/companies/[company]/projects/[project]/settings/audit/page.tsx`
- `apps/studio/web/app/(app)/studio/companies/[company]/projects/[project]/settings/plugin-permissions/page.tsx`
- `docs/plans/impl-reports/18-production-hardening-report.md`

Files modified: `packages/types/src/index.ts`, `packages/core/src/runtime.ts`,
`packages/core/src/runner.ts`, `apps/studio/server/src/index.ts`,
`apps/studio/server/src/routes/auth.ts`,
`apps/studio/server/src/routes/chat.ts`,
`apps/studio/server/src/routes/credentials.ts`,
`apps/studio/server/src/routes/filesystem.ts`,
`apps/studio/server/src/routes/attachments.ts`,
`apps/studio/server/src/routes/acl-members.ts`,
`apps/studio/server/src/routes/acl-invitations.ts`,
`apps/studio/server/src/filesystem/service.ts`,
`apps/studio/server/src/runtime/manager.ts`,
`apps/studio/server/package.json` (+express-rate-limit),
`apps/studio/db/src/schema/index.ts`, `apps/studio/db/src/index.ts`,
`apps/studio/web/lib/api.ts`,
`apps/studio/web/app/(app)/studio/companies/[company]/projects/[project]/settings/layout.tsx`.

## 2026-04-12 — Plan 17: Plugin UI System (final — isolated runtime, CLI, hardened)

**Shipped:** Plugins now contribute React UI as **fully isolated islands** —
each plugin is a self-contained ESM bundle (built by tsup), carries its own
React instance, is loaded by the browser via opaque dynamic URL import, and
mounted into a host-provided `<div>`. Build/runtime isolation guarantees that
a misbehaving plugin cannot break Studio's Next.js build or React tree.

The first-pass "workspace component registry" ADR (ADR-PLUG-17-A) was
**replaced** mid-session by the isolated-bundle design after user feedback
pointed out that workspace-source imports coupled plugin TS errors to
Studio's build. The revised impl report supersedes the original.

Key deliverables:

- **Isolation primitives** in `@jiku/kit/ui`: `defineMountable<C>(Component)`,
  `usePluginQuery` / `usePluginMutation` (plain useState/useEffect hooks —
  plugin-React-instance agnostic), layout wrappers.
- **Auto-discovery gateway** in `@jiku/core`: `discoverPluginsFromFolder(root)`
  replaces hardcoded `sharedLoader.register(X)` calls. Server scans `plugins/`
  at boot.
- **Studio host anchor** (`@jiku-plugin/studio`) — pure-types no-op plugin
  using the plugin system's native `contributes` / `depends`. Exports
  `StudioComponentProps` for typed `ctx.studio.api` in UI components.
  **No TypeScript module augmentation.**
- **Connector built-in** — `plugins/jiku.connector/` deleted; connector API
  is now part of `@jiku-plugin/studio.contributes`. Runtime wired by server
  context-extender via the existing `connector:register` hook.
- **CLI** (`apps/cli/`, binary `jiku`): commander + Ink. Commands: `list`,
  `info`, `build` (cwd-aware), `watch` (cwd-aware), `create` (scaffold).
  Placeholder namespaces `agent`, `db`, `dev`.
- **Hardened asset serving**: HMAC signed URLs (10 min TTL, `JWT_SECRET`),
  in-memory IP rate limiter (120 req/min), prod `.map` gate, path-traversal
  guard, CORS/nosniff/CORP headers.
- **Plugin UI provider moved to `studio/layout.tsx`** so both sidebar and
  project tree see the registry (previously inside project layout only, which
  left sidebar outside the context).
- **Active Plugins tab split** into System / Project sections with sticky
  headers.
- **Demo plugin** `@jiku/plugin-analytics` with `depends: [StudioPlugin]`,
  HTTP handlers, tool, and UI that exercises `usePluginQuery`,
  `ctx.tools.invoke`, `ctx.ui.toast`, `ctx.studio.api.get(...)`.
- **Reverted** the previous `jiku.cron` UI experiment — it now matches its
  pre-Plan-17 state.
- **DB**: `plugin_audit_log` table, `project_plugins.granted_permissions` +
  `ui_api_version` columns (migration `0010_plugin_ui.sql`).
- **Relaxed `ContributesValue = object`** in `@jiku/types` so specific
  interfaces (like `StudioContributes`) satisfy the constraint without
  requiring an index signature.

**Files touched** (notable):
- `packages/kit/src/ui/**`, `packages/types/src/plugin-ui.ts`,
  `packages/core/src/plugins/{discover.ts,loader.ts}`.
- `plugins/jiku.studio/**` (new), `plugins/jiku.analytics/**` (new),
  `plugins/jiku.connector/` (deleted), `plugins/jiku.telegram/**` (depends
  + dep swap).
- `apps/studio/server/src/routes/{plugin-assets,plugin-ui}.ts`,
  `apps/studio/server/src/plugins/ui/**`,
  `apps/studio/server/src/plugins/narration.ts` (new),
  `apps/studio/server/src/index.ts` (asset router ordering, discovery).
- `apps/studio/web/lib/plugins/**`,
  `apps/studio/web/components/plugin/**`,
  `apps/studio/web/app/(app)/studio/layout.tsx`,
  `apps/studio/web/app/(app)/studio/companies/[company]/projects/[project]/{plugin-pages,plugins/inspector}/**`.
- `apps/cli/**` (new workspace app).
- `apps/studio/db/src/schema/{plugin_audit_log.ts,plugins.ts}`,
  `apps/studio/db/src/queries/plugin_audit.ts`,
  `apps/studio/db/src/migrations/0010_plugin_ui.sql`.
- Docs: `docs/dev/plugin/{overview,cli,context-api,slots,security}.md`,
  `docs/feats/plugin-ui.md`, impl report at
  `docs/plans/impl-reports/17-plugin-ui-implementation-report.md`.

See that impl report for the final architecture, security model, and
deferred follow-ups (third-party sandboxing, `ctx.files`/`ctx.secrets`/
`ctx.api.stream` wiring).

**Dokploy image** (`infra/dokploy/Dockerfile`): added a `plugin-builder`
stage between `deps` and `web-builder` that runs `bun run jiku plugin
build`, so `plugins/*/dist/ui/*.js` ships inside the final image. Server
auto-discovery + asset router work out-of-the-box on deploy. The `deps`
stage lists every workspace `package.json` — including the new
`@jiku-plugin/studio`, `@jiku/plugin-analytics`, `@jiku/cli` — and removes
`jiku.connector` (deleted). Root `.dockerignore` added to skip host
`node_modules` / `dist` / `.next` during `COPY . .`.

## 2026-04-10 — Plan 16-FS-Revision-V2: Filesystem production-scale revision

**Shipped:** All 8 phases of the filesystem revision. Plan 14's virtual filesystem
was functional but had scaling bottlenecks. This revision addresses them with
zero downtime — all changes are additive and backward compatible.

**Key changes (from Plan 16-FS-Revision-V2 architecture document):**

1. **UUID-based S3 keys** — `objects/{2-char-prefix}/{fileId}` instead of
   `projects/{projectId}{path}`. Move/rename now does 0 S3 ops (DB-only
   metadata update). Legacy files migrate lazily on first read.
2. **LRU-cached FilesystemService** — new `factory.ts` caches constructed
   services per project (max 500, TTL 5min). Eliminates repeated AES decrypt
   + S3Client construction on every tool call.
3. **`project_folders` table** — explicit folder tracking replaces the
   O(total_files) `extractImmediateSubfolders()` derivation. `list()` now
   does two parallel index lookups instead of a full scan.
4. **Content cache with version + TTL** — `content_version` bumped on
   write, `cache_valid_until` set to 24h. `read()` checks validity before
   using cached content.
5. **tsvector search** — `search_vector` generated column + GIN index
   (zero-extension, built-in Postgres). Falls back to ILIKE if migration
   hasn't run yet.
6. **Optimistic locking** — `version` column + `expected_version` parameter
   on `fs_write`. Concurrent writes are detected and rejected with
   ConflictError.
7. **Storage cleanup queue** — `storage_cleanup_queue` table + 30s
   background worker. File deletion is instant (DB row removed), S3 cleanup
   is deferred and retried up to 3x.
8. **Async migration** — `filesystem_migrations` table +
   `runFilesystemMigration()` background job. POST /migrate returns
   `{ job_id }` immediately; GET /migrate/:id polls progress.

**New files:**
- `apps/studio/server/src/filesystem/factory.ts` — LRU cache factory
- `apps/studio/server/src/filesystem/worker.ts` — StorageCleanupWorker
- `apps/studio/server/src/filesystem/migration-job.ts` — async migration job
- `apps/studio/db/src/schema/filesystem-folders.ts`
- `apps/studio/db/src/schema/filesystem-cleanup.ts`
- `apps/studio/db/src/schema/filesystem-migrations.ts`
- `apps/studio/db/src/migrations/0009_filesystem_revision_v2.sql`

**Modified files:**
- `apps/studio/db/src/schema/filesystem.ts` — new columns on project_files
- `apps/studio/db/src/schema/relations.ts` — new table relations
- `apps/studio/db/src/schema/index.ts` — export new tables
- `apps/studio/server/src/filesystem/adapter.ts` — `buildKeyFromId()`, `isLegacyKey()`
- `apps/studio/server/src/filesystem/service.ts` — full rewrite of write/move/delete/list/read/search
- `apps/studio/server/src/filesystem/tools.ts` — expected_version, version+cached response
- `apps/studio/server/src/filesystem/utils.ts` — `getAncestorPaths()`
- `apps/studio/server/src/routes/filesystem.ts` — invalidation hooks, async migration + polling
- `apps/studio/server/src/runtime/manager.ts` — filesystem cache invalidation in sleep()
- `apps/studio/server/src/index.ts` — start StorageCleanupWorker

**Pending:** `bun run db:push` + manual migration SQL for tsvector + backfill.

---

## 2026-04-09 — Browser: max_tabs is per-project configurable

**Added:** `BrowserProjectConfig.max_tabs` (range 2..50, default 10) lets each
project pick its own chromium tab cap instead of sharing a global constant.
The Debug panel / Browser settings page show the active value from the running
state, not just the saved config.

**Changed:**
- `apps/studio/server/src/browser/tab-manager.ts` — renamed
  `MAX_TABS_PER_PROJECT` → `DEFAULT_MAX_TABS_PER_PROJECT`. Added
  `MIN_MAX_TABS = 2` and `MAX_MAX_TABS = 50` bounds. `ProjectTabState` now
  carries its own `maxTabs`. `ensureInitialized(projectId, maxTabs)` reads
  the value, idempotently updates the existing state if it changed (lazy:
  the next `isAtCapacity()` honors the new value). New `getMaxTabs()` helper
  for the status endpoint.
- `apps/studio/server/src/browser/execute.ts` — `ExecuteBrowserOptions` gains
  `maxTabs?: number`. Passed through to `ensureAgentTabActive` →
  `ensureInitialized`.
- `apps/studio/server/src/browser/tool.ts` — reads `config?.max_tabs` and
  forwards via `executeBrowserAction` options.
- `apps/studio/server/src/routes/browser.ts` — `BrowserConfigSchema` adds
  `max_tabs: z.number().int().min(2).max(50).optional()`. Status endpoint
  resolves the displayed cap as `manager.getMaxTabs() ?? cfg.max_tabs ??
  DEFAULT_MAX_TABS_PER_PROJECT` so the UI shows what the runtime is
  *currently using*, not just the saved config.
- `apps/studio/db/src/queries/browser.ts` and `apps/studio/web/lib/api.ts` —
  `BrowserProjectConfig.max_tabs` documented.
- `apps/studio/web/app/(app)/studio/companies/[company]/projects/[project]/browser/page.tsx`
  — new "Max tabs" number input in the Advanced section, bounds 2..50.
  System tab row in the Debug panel now displays `— always on` instead of
  an ever-growing idle counter, with a tooltip explaining it.

**Files:**
- `apps/studio/server/src/browser/{tab-manager,execute,tool}.ts`
- `apps/studio/server/src/routes/browser.ts`
- `apps/studio/db/src/queries/browser.ts`
- `apps/studio/web/lib/api.ts`
- `apps/studio/web/app/(app)/studio/companies/[company]/projects/[project]/browser/page.tsx`
- `docs/feats/browser.md`, `docs/builder/memory.md`,
  `docs/plans/impl-reports/13-browser-implement-report.md`

---

## 2026-04-09 — Fix: cross-container CDP fails with "Host header is not an IP address or localhost"

**Symptom:** the @jiku/browser docker container worked perfectly when accessed
from `localhost` (`curl http://localhost:9222/json/version` from inside the
container or from the host machine), but failed in production deployments
where the chrome service is reached from another docker service by its
compose alias (e.g. `bitorex-...-chrome-1`):

```
$ curl http://bitorex-...-chrome-1:9222/json/version
Host header is specified and is not an IP address or localhost.
```

**Root cause:** chromium's DevTools HTTP handler enforces a DNS rebinding
protection — `/json/*` requests are rejected when the inbound `Host` header
is not `localhost`, `127.0.0.1`, or an IP. The previous entrypoint forwarded
public port 9222 to internal port 19222 with `socat TCP-LISTEN ... TCP:`,
which is purely TCP-level and passed the Host header through unchanged.
Local calls happened to use `localhost` and worked; production calls used
the docker service hostname and failed.

**Fix:** replaced `socat` with **nginx-light** as the public CDP proxy.
nginx forwards to `127.0.0.1:19222` and unconditionally rewrites the Host
header to `"localhost"` via `proxy_set_header Host "localhost"`. WebSocket
upgrades for the CDP socket are passed through with `proxy_set_header
Upgrade $http_upgrade`.

**Files:**
- `packages/browser/docker/Dockerfile` — added `nginx-light`, removed
  `socat` from the apt list.
- `packages/browser/docker/nginx.conf` — new minimal config (events + http
  with the rewriting server block, ~50 LoC).
- `packages/browser/docker/entrypoint.sh` — replaced the socat invocation
  with `nginx -c /etc/jiku/nginx.conf` plus a follow-up curl readiness check
  that fails fast with the nginx error log if the proxy doesn't come up.
- `docs/builder/memory.md`, `docs/feats/browser.md`,
  `docs/plans/impl-reports/13-browser-implement-report.md` — gotcha
  documented across all the browser docs.

**Pickup:** redeploy the chrome service in Dokploy (or wherever the
production container lives) so the new image is built. After the new image
is up, `curl http://<chrome-service-hostname>:9222/json/version` from
another container should return the chromium JSON instead of the host
header error.

---

## 2026-04-09 — Browser concurrency model: per-project mutex + per-agent tab affinity

**Added:** Studio now safely supports multiple agents per project sharing one
chromium instance. Previously two agents using the browser tool concurrently
would race on the single "active tab" exposed by agent-browser, with no
warning — element refs went stale, fills overwrote each other, navigations
interleaved.

**New files:**
- `apps/studio/server/src/browser/concurrency.ts` — `KeyedAsyncMutex`
  (~50 LoC, no deps), `browserMutex` singleton. Promise-chain mutex keyed by
  `projectId`; calls for different projects do not block each other.
- `apps/studio/server/src/browser/tab-manager.ts` — `BrowserTabManager`
  tracks one chromium tab per agent (index 0 = system tab, index 1..N =
  agent tabs). Methods: `ensureInitialized`, `getAgentTabIndex`, `appendTab`,
  `touch`, `pickEvictionCandidate`, `removeTab`, `pickIdleTabs`, `dropProject`,
  `snapshot`. Plus `startBrowserTabCleanup()` — a 60s idle eviction loop
  that closes tabs idle longer than 10 minutes inside the per-project mutex.

**Changed:**
- `apps/studio/server/src/browser/execute.ts` — `executeBrowserAction` now
  acquires the per-project mutex, runs `ensureAgentTabActive()` (which
  creates/switches tabs as needed, evicting LRU on capacity), then runs the
  command and `touch()`es the agent's tab. Reserved actions (`tab_new`,
  `tab_close`, `tab_switch`, `tab_list`, `close`) throw a clear error so the
  LLM can't desync the tab manager. New required option: `agentId` (sourced
  from `ctx.runtime.agent.id`).
- `apps/studio/server/src/browser/tool.ts` — pulls `agentId` from the
  `ToolContext` and forwards to `executeBrowserAction`. Tool description
  rewritten to emphasize "Studio manages tabs automatically — just use
  open/snapshot/click/etc.".
- `apps/studio/server/src/routes/browser.ts` — `/preview` now wraps the
  screenshot+title+url calls in `browserMutex.acquire()` so it cannot race
  with an in-flight agent command. PATCH `/enabled` and `/config` call
  `browserTabManager.dropProject()` to invalidate stale tab indexes.
  **New endpoint** `GET /browser/status` returns `{ enabled, mutex: {busy},
  tabs[], capacity, idle_timeout_ms }` for the Debug panel.
- `apps/studio/server/src/runtime/manager.ts` — `sleep(projectId)` calls
  `browserTabManager.dropProject()` so the next `wakeUp` starts from clean
  state.
- `apps/studio/server/src/index.ts` — calls `startBrowserTabCleanup()` after
  the runtime boots.
- `apps/studio/web/lib/api.ts` — added `api.browser.status()` +
  `BrowserStatus` / `BrowserStatusTab` types.
- `apps/studio/web/app/(app)/studio/companies/[company]/projects/[project]/browser/page.tsx`
  — new **Debug** section under Live Preview showing the mutex badge,
  capacity bar, and a tab table (index, owner, kind, idle duration). Polls
  `GET /browser/status` every 2 seconds. Stale tabs (idle past timeout)
  highlighted amber.

**Capacity defaults:** 10 tabs per project (including system tab), 10 minute
idle timeout. Both are constants in `tab-manager.ts`; can be lifted to
`BrowserProjectConfig` later if requested.

**What this gives you:** Agent A and Agent B can run browser sequences in
the same project without colliding — each gets its own tab, commands are
serialized, refs stay valid for the next command in the same agent's
sequence. Throughput is one command at a time per project (chromium-bound).
For genuine parallelism, point each project at its own CDP endpoint /
container; the mutex is per-project and won't block across projects.

**Files:**
- `apps/studio/server/src/browser/{concurrency,tab-manager,execute,tool}.ts`
- `apps/studio/server/src/routes/browser.ts`
- `apps/studio/server/src/runtime/manager.ts`
- `apps/studio/server/src/index.ts`
- `apps/studio/web/lib/api.ts`
- `apps/studio/web/app/(app)/studio/companies/[company]/projects/[project]/browser/page.tsx`
- `docs/feats/browser.md`, `docs/builder/memory.md`, `docs/builder/decisions.md`,
  `docs/plans/impl-reports/13-browser-implement-report.md`

---

## 2026-04-09 — Browser migration cleanup (Plan 33 follow-up)

**Fixed:** Plan 33 left several integration leaks between the new
`@jiku/browser` backend and the Plan-13-era Studio surfaces. This pass closes
them so the feature is genuinely production-grade end-to-end.

**Symptoms before this pass:**
- `tool-schema.ts` still listed legacy OpenClaw actions (`status`, `start`,
  `stop`, `profiles`, `act`, `dialog`, `console`, ...). Most LLM-callable
  actions like `click`, `fill`, `type`, `wait`, `eval`, `get` were not even
  in the enum and would have been rejected by Zod at the boundary.
- `execute.ts`'s `mapToBrowserCommand` referenced fields that did not exist on
  the schema and used a dynamic `import()` for the persister (CLAUDE.md
  violation). It also imported `resolveCdpEndpoint` without using it.
- `tool.ts` used inline `import('./tool-schema.js').BrowserToolInput` type
  expressions (CLAUDE.md violation) and still tried to strip a Plan-13
  `profile` field from the args.
- The DB and Web `BrowserProjectConfig` types still exposed `mode`,
  `headless`, `executable_path`, `control_port`, `no_sandbox` — none of which
  are honored by the new backend (the route Zod schema strips them on save).
- The Browser settings page still showed Managed/Remote tabs, headless and
  no_sandbox toggles, and gated the "Test connection" button on a
  `status.running` field that the backend never returned. Result: the button
  was permanently invisible and the status bar always showed "Stopped".

**Changed:**
- `apps/studio/server/src/browser/tool-schema.ts` — rewritten as a Zod
  `discriminatedUnion` mirroring `BrowserCommand` from `@jiku/browser` 1:1.
  Tab and cookies operations are flattened into top-level actions
  (`tab_list`, `tab_new`, `tab_close`, `tab_switch`, `cookies_get`,
  `cookies_set`, `cookies_clear`).
- `apps/studio/server/src/browser/execute.ts` — exhaustive
  `mapToBrowserCommand()` covering every action, with a `never`-typed default
  branch so future drift is a compile error. Static `persistContentToAttachment`
  import. Honors `timeout_ms` and `screenshot_as_attachment` from project
  config. When `screenshot_as_attachment` is false, returns base64 inline
  instead of persisting.
- `apps/studio/server/src/browser/tool.ts` — static type imports, dropped
  Plan-13 `profile` strip, gates `eval` behind `evaluate_enabled`, expanded
  the tool description to list the real supported action set, propagates
  `timeoutMs` + `screenshotAsAttachment` to `executeBrowserAction`.
- `apps/studio/db/src/queries/browser.ts` — `BrowserProjectConfig` trimmed to
  `cdp_url`, `timeout_ms`, `evaluate_enabled`, `screenshot_as_attachment`.
  `BrowserMode` export removed.
- `apps/studio/web/lib/api.ts` — `BrowserProjectConfig` mirrored from DB type,
  fake `status: { running, port }` removed from `api.browser.*` response
  types, new `BrowserPingResult` interface aligned with the backend ping
  payload (latency_ms / cdp_url / browser).
- `apps/studio/web/app/(app)/studio/companies/[company]/projects/[project]/browser/page.tsx` —
  rewritten as a CDP-only page. Status bar derives tone from the most recent
  ping result. Test connection button is always visible while enabled.
  Defaults align with the backend (`ws://localhost:9222`). New "Persist
  screenshots as attachments" toggle.
- `apps/studio/server/src/runtime/manager.ts` — stale comments updated; tool
  import switched to `.ts` extension to match the rest of the server.
- `docs/builder/memory.md` — added two memories: "Browser tool input schema
  must mirror `BrowserCommand`" and "Browser config is CDP-only".

**Files touched:**
- `apps/studio/server/src/browser/tool-schema.ts`
- `apps/studio/server/src/browser/execute.ts`
- `apps/studio/server/src/browser/tool.ts`
- `apps/studio/server/src/runtime/manager.ts`
- `apps/studio/db/src/queries/browser.ts`
- `apps/studio/web/lib/api.ts`
- `apps/studio/web/app/(app)/studio/companies/[company]/projects/[project]/browser/page.tsx`
- `docs/builder/memory.md`, `docs/builder/current.md`, `docs/feats/browser.md`

**Deleted (Plan 13 docker artifacts):**
- `apps/studio/server/docker-compose.browser.yml` — old `linuxserver/chromium` compose, replaced by `packages/browser/docker-compose.yml`
- `apps/studio/server/browser-init/chromium-cdp.sh` — Plan 13 CDP init script that never actually ran
- `apps/studio/server/browser-init/` — directory removed
- `infra/dokploy/Dockerfile.browser` — orphaned, never referenced from `infra/dokploy/docker-compose.yml`

**Fixed — `Invalid schema for function 'builtin_browser'` from OpenAI:**
- Symptom: starting any chat in a project with the browser tool enabled
  failed with `Invalid schema for function 'builtin_browser': schema must be a
  JSON Schema of 'type: "object"', got 'type: "None"'.`
- Root cause: the cleanup pass earlier today rewrote `tool-schema.ts` as a
  `z.discriminatedUnion` over `action`. `zod-to-json-schema` (used by AI SDK's
  `zodSchema()`) converts a discriminated union to `{ "anyOf": [...] }` at the
  root, with no top-level `type`. OpenAI's function calling API rejects that.
- Fix: rewrote `tool-schema.ts` as a flat `z.object` with `action` as a
  required enum and every other field optional. Per-action requirements moved
  to a `need()` helper in `execute.ts`'s `mapToBrowserCommand` (still
  exhaustive over `BrowserAction` via the `never` default branch). New
  `BROWSER_ACTIONS` const is the single source of truth for the enum.
- Files: `apps/studio/server/src/browser/tool-schema.ts`,
  `apps/studio/server/src/browser/execute.ts`, `docs/builder/memory.md`.

---

**Fixed — Chromium fails to start in @jiku/browser docker container:**
- Symptom: noVNC shows only the Fluxbox wallpaper + taskbar, no chromium
  window. socat spams `Connection refused` to `127.0.0.1:19222` forever.
- Root cause #1: chromium zygote aborts with `No usable sandbox!` because
  Docker Desktop on macOS/Windows does not expose unprivileged user
  namespaces to containers, and the previous entrypoint relied on running
  chromium as a non-root `browser` user without `--no-sandbox`.
- Root cause #2: `su browser -c "..."` was unreliable because the system user
  created via `useradd -r` may end up with a `nologin` shell, in which case
  `su -c` exits silently without launching chromium.
- Root cause #3: `socat` was started 2 seconds after chromium with no
  readiness check, so even if chromium *had* started slowly the proxy would
  still have raced.
- Fix: rewrote `packages/browser/docker/{Dockerfile,entrypoint.sh}`:
  - drop the non-root user, run as root inside the container
  - add `--no-sandbox` to chromium (standard for headful chromium in Docker)
  - add a CDP readiness probe via `curl http://127.0.0.1:19222/json/version`
    that waits up to 30s and exits with a tail of the chromium log on failure
  - start `dbus` before chromium to silence noisy warnings
  - log every sub-process to `/var/log/jiku-browser/*.log` inside the container
  - `exec websockify` as the foreground process so SIGTERM propagates and
    `docker compose down` shuts the container down cleanly
- Pickup: `cd packages/browser && docker compose down && docker compose up -d --build`

**Added — live browser preview in settings page:**
- New endpoint `POST /api/projects/:pid/browser/preview` — captures one-shot
  screenshot via `execBrowserCommand` and returns it inline as base64. Best
  effort `title` and `url` via parallel `get` calls. Never persisted.
- New API method `api.browser.preview()` + `BrowserPreviewResult` type.
- Browser settings page now shows a 16:9 "Live Preview" box (only when
  enabled) with manual Refresh button + 3s auto-refresh toggle. Title/URL
  overlay on the screenshot. Empty/loading/error states handled. Concurrent
  request guard via `previewInFlight` ref so a slow screenshot doesn't pile up
  requests when auto-refresh is on.

---

## 2026-04-09 — Plan 33: Browser rebuild + unified attachment system

**Shipped:** Plan 33 replaces the failed Plan 13 (OpenClaw port). Browser automation now works via `@jiku/browser` (CLI bridge to Vercel `agent-browser` over CDP), and all tool outputs (starting with screenshots) persist to S3 via a single reusable `persistContentToAttachment()` service.

**Key change:** Attachment references are `{ attachment_id, storage_key, mime_type }` — URLs are never stored in the DB. URLs are generated on-demand at the UI boundary (`useAttachmentUrl()`) or at LLM call time (chat route).

**Added:**
- `apps/studio/server/src/content/persister.ts` — unified content persistence service
- `apps/studio/web/hooks/use-attachment-url.ts` — authenticated URL hook for UI
- `apps/studio/db/src/migrations/0008_add_attachment_source_tracking.sql` — `source_type` + `metadata` columns
- `docs/plans/impl-reports/13-browser-implement-report.md` — full implementation report

**Changed:**
- `packages/types/src/index.ts` — `ToolContentPart`, `ContentPersistResult`, `ContentPersistOptions`
- `packages/ui/src/components/ai-elements/tool.tsx` — `ToolOutput` renders attachment refs; `token` prop added
- `apps/studio/server/src/browser/` — `execute.ts`, `tool.ts`, `config.ts`, `index.ts` rewritten to use `@jiku/browser`
- `apps/studio/server/src/runtime/manager.ts` — removed `startBrowserServer`/`stopBrowserServer` lifecycle
- `apps/studio/server/src/routes/browser.ts` — simplified schema; ping tests CDP directly
- `apps/studio/web/components/chat/conversation-viewer.tsx` — passes JWT token to `ToolOutput`
- `docs/feats/browser.md` — marked rebuilt, new architecture
- `docs/builder/current.md`, `docs/builder/memory.md`, `docs/builder/decisions.md` — updated

**Deleted:**
- `apps/studio/server/src/browser/browser/*` — ~80 files of OpenClaw port

**Verification:** `bun run dev` boots cleanly; `bun run db:push` applied migration. End-to-end screenshot pipeline pending manual test with live browser container.

---

## 2026-04-09 — Fix: Cron task conversation type should be 'task' not 'cron'

**Fixed:** `CronTaskScheduler.triggerTask()` was creating conversations with `type: 'cron'`, which is not a valid conversation type. Valid types are: `chat`, `task`, `heartbeat`.

**Changed:**
- `type: 'cron'` → `type: 'task'` in `scheduler.ts` line 66
- Trigger source still tracked via `metadata.trigger: 'cron'` and `metadata.cron_task_id` for audit trails

**Files touched:**
- `apps/studio/server/src/cron/scheduler.ts` — fixed conversation type in `triggerTask()`
- `docs/builder/memory.md` — documented conversation type convention

---

## 2026-04-08 — Add: connector_list tool for agent discovery

**Added:** Agent tool `connector_list` to discover connector IDs before calling connector tools.

**Context:** Connector tools (`connector_send`, `connector_run_action`, etc.) require a valid `connector_id` (UUID), not display_name. Agents could not easily map display_name → UUID.

**Solution:** New tool `builtin_connector_list` (no parameters) returns array of connectors with `{ id, plugin_id, display_name, status }`. Agent workflow:
1. Call `connector_list()` 
2. Find connector by matching `display_name` or `plugin_id`
3. Use returned `id` in subsequent connector tool calls

**Files touched:**
- `apps/studio/server/src/connectors/tools.ts` — added `connector_list` tool definition
- `docs/builder/memory.md` — added gotcha documentation

---

## 2026-04-08 — Fix: Credential inheritance for semantic memory embedding

**Changed:** Company-level credentials were invisible to the semantic memory embedding picker and runtime resolver. Two fixes applied:
1. `EmbeddingCredentialPicker` (frontend) now calls `api.credentials.available(projectId)` which hits `/api/projects/:pid/credentials/available` — returns both company-level and project-level credentials, instead of the old `api.credentials.listProject` which was project-only.
2. `resolveApiKey()` (backend, `embedding.ts`) fallback now uses `getAvailableCredentials(company_id, projectId)` instead of `getProjectCredentials(projectId)` — looks up `company_id` from project first, then calls the union query.

**Files touched:**
- `apps/studio/web/components/memory/memory-config.tsx` — `EmbeddingCredentialPicker` query key + fn changed
- `apps/studio/server/src/memory/embedding.ts` — `resolveApiKey()` fallback uses `getAvailableCredentials`

---

## 2026-04-08 — @jiku/browser: Browser Automation Package (replaces Plan 13)

**Changed:** Built `@jiku/browser` package from scratch — HTTP bridge to Vercel agent-browser CLI via CDP. Replaces failed Plan 13 OpenClaw port (~9000 lines) with clean ~600 line implementation.

- `packages/browser/` — new package with Express server, CLI spawner, parsed responses, AI error hints
- 30+ browser commands: navigation, interaction (click/fill/type/drag/upload), observation (snapshot/screenshot/pdf), tabs, cookies, storage, eval, batch
- Docker container: Chromium + Xvfb + noVNC + socat CDP proxy (non-root user, no `--no-sandbox`)
- Screenshot returns base64 (not file path) — client handles persistence
- `BrowserResult<T>` response with `hint` field for AI recovery suggestions (10 error patterns)
- `ensureConnected()` — auto-runs `agent-browser connect` once per CDP endpoint
- `resolveCdpEndpoint()` — converts `ws://` to `http://` format for agent-browser
- 52 unit tests (profile manager, spawner/buildArgs, parser/hints, server API)

**Files touched:**
- `packages/browser/src/types.ts`, `server.ts`, `spawner.ts`, `parser.ts`, `profile-manager.ts`, `main.ts`, `index.ts`
- `packages/browser/src/examples/cdp.ts`
- `packages/browser/src/tests/*.test.ts` (4 files)
- `packages/browser/docker/Dockerfile`, `docker/entrypoint.sh`, `docker-compose.yml`
- `packages/browser/README.md`, `SKILL.md`
- `docs/feats/browser.md` — rewritten for new architecture

## 2026-04-08 — Plan 15 Sprint 4: Inter-Agent + Tool Streaming + Progress

- **15.4 Enhanced Inter-Agent Calling:**
  - **Task Runner** (`apps/studio/server/src/task/runner.ts`): `RunTaskResult` now includes `tool_results` (structured tool call results) and `message_count`. `runTaskConversation()` extracts tool results from conversation messages after drain.
  - **run_task tool** (`apps/studio/server/src/task/tools.ts`): Response now includes `tool_results` + `message_count` for attach mode.
  - **agent_read_history tool** (new): Read recent conversation history of another agent. Returns text-only parts (strips tool internals). Supports specific conversation or latest.
  - **list_agents enhanced**: Now accepts `mode` (filter by chat/task) and `search` (filter by name/description). Returns `modes` field.
  - **Runtime Manager** (`apps/studio/server/src/runtime/manager.ts`): `agentReadHistoryTool` registered in all 3 agent registration paths.

- **15.1 Tool Streaming (Progressive Results):**
  - **Types** (`packages/types/src/index.ts`): Added `ToolStreamChunk` interface (`type: 'progress' | 'partial'`). Added `executeStream?` to `ToolDefinition` — optional async generator.
  - **Runner** (`packages/core/src/runner.ts`): When `executeStream` is defined on a tool, runner uses it and emits progress chunks via `jiku-tool-data` stream event. Non-streaming tools unchanged.

- **15.8 Progress Reporting Tool:**
  - **Progress Tool** (`apps/studio/server/src/task/progress-tool.ts`): New `report_progress` built-in tool. Agent calls it to report step/percentage/details. Appends to `conversation.metadata.progress_log` and emits via stream.
  - **Types** (`packages/types/src/index.ts`): Added `extra_built_in_tools` to `JikuRunParams` — enables per-run tool injection.
  - **Runner** (`packages/core/src/runner.ts`): Merges `extra_built_in_tools` with `agent.built_in_tools`.
  - **Task Runner** (`apps/studio/server/src/task/runner.ts`): Injects `buildProgressTool(conversationId)` via `extra_built_in_tools` for task mode runs.

- Files: `apps/studio/server/src/task/runner.ts`, `apps/studio/server/src/task/tools.ts`, `apps/studio/server/src/task/progress-tool.ts`, `apps/studio/server/src/runtime/manager.ts`, `packages/types/src/index.ts`, `packages/core/src/runner.ts`

## 2026-04-08 — Plan 15 Sprint 3: MCP Support + Tool On/Off + Semantic Memory

- **15.6 MCP Support + Tool On/Off Registry:**
  - **DB Schema** (`apps/studio/db/src/schema/mcp_servers.ts`): New `mcp_servers`, `project_tool_states`, `agent_tool_states` tables.
  - **Migration** (`apps/studio/db/src/migrations/0007_add_mcp_and_tool_states.sql`): 3 tables + indexes.
  - **DB Queries** (`apps/studio/db/src/queries/mcp_servers.ts`): Full CRUD for MCP servers + tool state get/set/delete.
  - **MCP Client** (`apps/studio/server/src/mcp/client.ts`): `MCPClientManager` class — connect/disconnect/getTools for stdio/sse/streamable-http transports. 5s connect timeout.
  - **MCP Wrapper** (`apps/studio/server/src/mcp/wrapper.ts`): `wrapMCPTool()` — converts MCP tool schema to Jiku `ToolDefinition`.
  - **Runner** (`packages/core/src/runner.ts`): Tool filtering by on/off state (agent override > project override > default enabled). Uses `tool_states` from `JikuRunParams`.
  - **Runtime Manager** (`apps/studio/server/src/runtime/manager.ts`): Loads tool states from DB before each run, passes to runner.
  - **API Routes** (`apps/studio/server/src/routes/mcp-servers.ts`, `tool-states.ts`): MCP server CRUD + test endpoint. Tool state get/set/reset per agent.
  - **Types** (`packages/types/src/index.ts`): Added `ToolStatesMap` type. Extended `JikuRunParams` with `tool_states`.
  - **Web API** (`apps/studio/web/lib/api.ts`): Added `McpServerItem` type. Added `api.mcpServers.*` and `api.toolStates.*` methods.
  - **UI** (`apps/studio/web/.../agents/[agent]/tools/page.tsx`): Tool list now shows toggle switches per tool (enabled/disabled). Loads + saves agent tool states.

- **15.2 Semantic Memory (Qdrant + Hybrid Scoring):**
  - **Docker Compose**: Added Qdrant v1.13.2 to both dev (`apps/studio/server/docker-compose.yml`) and prod (`infra/dokploy/docker-compose.yml`).
  - **Embedding Service** (`apps/studio/server/src/memory/embedding.ts`): `EmbeddingService` abstraction. Uses OpenAI `text-embedding-3-small` (1536 dim). Resolves API key from project credentials or env.
  - **Qdrant Client** (`apps/studio/server/src/memory/qdrant.ts`): `MemoryVectorStore` — upsert/delete/search/ensureCollection. Graceful fallback on connection errors.
  - **Relevance Scoring** (`packages/core/src/memory/relevance.ts`): `scoreMemory()` now supports 4-factor hybrid scoring (keyword + semantic + recency + access). `findRelevantMemories()` accepts optional `semanticScores` map.
  - **Types** (`packages/types/src/index.ts`): Added `semantic?` to `ResolvedMemoryConfig.relevance.weights`.

- Files: `apps/studio/db/src/schema/mcp_servers.ts`, `apps/studio/db/src/queries/mcp_servers.ts`, `apps/studio/db/src/migrations/0007_add_mcp_and_tool_states.sql`, `apps/studio/server/src/mcp/client.ts`, `apps/studio/server/src/mcp/wrapper.ts`, `packages/core/src/runner.ts`, `apps/studio/server/src/runtime/manager.ts`, `apps/studio/server/src/routes/mcp-servers.ts`, `apps/studio/server/src/routes/tool-states.ts`, `apps/studio/server/src/index.ts`, `packages/types/src/index.ts`, `apps/studio/web/lib/api.ts`, `apps/studio/web/.../tools/page.tsx`, `apps/studio/server/docker-compose.yml`, `infra/dokploy/docker-compose.yml`, `apps/studio/server/src/memory/embedding.ts`, `apps/studio/server/src/memory/qdrant.ts`, `packages/core/src/memory/relevance.ts`

## 2026-04-08 — Plan 15 Sprint 2: Channel Routing + Structured Persona

- **15.5 Channel Routing Rules:**
  - **DB Schema** (`apps/studio/db/src/schema/connectors.ts`): Added `priority`, `trigger_regex`, `schedule_filter` to `connector_bindings`. Added `match_mode`, `default_agent_id` to `connectors`.
  - **Migration** (`apps/studio/db/src/migrations/0006_add_channel_routing.sql`): 5 column additions.
  - **DB Queries** (`apps/studio/db/src/queries/connector.ts`): Updated `createBinding`, `updateBinding`, `updateConnector` to accept new fields.
  - **Event Router** (`apps/studio/server/src/connectors/event-router.ts`): `matchesTrigger()` now supports regex + schedule filter. `routeConnectorEvent()` sorts by priority (descending), supports `first` match mode, implements fallback default agent.
  - **Types** (`packages/types/src/index.ts`): Extended `ConnectorBinding` with `priority`, `trigger_regex`, `schedule_filter`. Extended `ConnectorRecord` with `match_mode`, `default_agent_id`.
  - **Web Types** (`apps/studio/web/lib/api.ts`): Updated `ConnectorBinding` and `ConnectorItem` interfaces.
  - **UI** (`apps/studio/web/.../bindings/[binding]/page.tsx`): Added "Routing" card with priority input and trigger regex field.

- **15.9 Structured Persona:**
  - **Types** (`packages/types/src/index.ts`): Added `PersonaTraits` interface (formality, verbosity, humor, empathy, expertise_display) with `DEFAULT_PERSONA_TRAITS`. Extended `PersonaSeed` with `traits` and `boundaries`.
  - **Builder** (`packages/core/src/memory/builder.ts`): `formatPersonaSection()` now injects "Communication Style" and "Boundaries" sections into system prompt when traits/boundaries are set.
  - **Web Types** (`apps/studio/web/lib/api.ts`): Added `PersonaTraits` interface, extended `PersonaSeed`.
  - **UI** (`apps/studio/web/.../agents/[agent]/persona/page.tsx`): Added "Communication Traits" section with toggle buttons for each trait dimension. Added "Boundaries" section with add/remove list. Saves to persona_seed via existing API.

- Files: `apps/studio/db/src/schema/connectors.ts`, `apps/studio/db/src/queries/connector.ts`, `apps/studio/db/src/migrations/0006_add_channel_routing.sql`, `apps/studio/server/src/connectors/event-router.ts`, `packages/types/src/index.ts`, `packages/core/src/memory/builder.ts`, `apps/studio/web/lib/api.ts`, `apps/studio/web/.../bindings/[binding]/page.tsx`, `apps/studio/web/.../persona/page.tsx`

## 2026-04-08 — Plan 15 Sprint 1: Conversation Queue + Auto-Reply (Backend)

- **Conversation Queue** (`apps/studio/server/src/runtime/conversation-queue.ts`): New `ConversationQueue` class with in-memory FIFO queue per conversation. Enqueues messages when agent is busy, processes them after current run completes. Max 10 per conversation, 5-minute timeout. Exported singleton `conversationQueue`.
- **Auto-Reply Evaluator** (`apps/studio/server/src/auto-reply/evaluator.ts`): Rule-based auto-reply before LLM invocation. Supports 4 trigger types: `exact`, `contains`, `regex`, `command`. Checks availability schedule first (offline message), then rules in order.
- **Schedule Utility** (`apps/studio/server/src/utils/schedule.ts`): `isWithinSchedule()` — timezone-aware availability checking using `Intl.DateTimeFormat`. Graceful fallback if timezone invalid.
- **Types** (`packages/types/src/index.ts`): Added `AgentQueueMode`, `AutoReplyRule`, `ScheduleHours`, `AvailabilitySchedule` types.
- **DB Schema** (`apps/studio/db/src/schema/agents.ts`): Added `queue_mode varchar(20) DEFAULT 'off'`, `auto_replies jsonb DEFAULT '[]'`, `availability_schedule jsonb DEFAULT NULL` columns.
- **Migration** (`apps/studio/db/src/migrations/0005_add_queue_and_auto_reply.sql`): Adds 3 columns to agents table.
- **Chat Route** (`apps/studio/server/src/routes/chat.ts`): Auto-reply intercept before LLM (returns SSE stream with auto-reply text). Queue mode intercept: returns 202 with queue position if running + queue enabled. Queue drain on run completion (recursive FIFO processing).
- **Event Router** (`apps/studio/server/src/connectors/event-router.ts`): Auto-reply intercept for connector messages (direct response, skip LLM). Queue mode: `ack_queue` sends acknowledgment, enqueues message. Queue drain via `drainConnectorQueue()` after run completion.
- **Agent API** (`apps/studio/server/src/routes/agents.ts`): PATCH endpoint accepts `queue_mode`, `auto_replies`, `availability_schedule`.
- **Web API** (`apps/studio/web/lib/api.ts`): Added `queue_mode`, `auto_replies`, `availability_schedule` to Agent interface. Added `AutoReplyRule`, `ScheduleHours`, `AvailabilitySchedule` types.
- **Agent Layout** (`apps/studio/web/.../agents/[agent]/layout.tsx`): Added "auto-reply" nav item with `MessageCircleReply` icon.
- **Auto-Reply Page** (`apps/studio/web/.../agents/[agent]/auto-reply/page.tsx`): Full settings page with 3 sections: Queue Mode selector (off/queue/ack_queue), Auto-Reply Rules editor (add/remove/toggle rules with trigger type, pattern, response), Availability Schedule editor (enable/disable, timezone, day/hour windows, offline message).
- Files: `apps/studio/server/src/runtime/conversation-queue.ts`, `apps/studio/server/src/auto-reply/evaluator.ts`, `apps/studio/server/src/utils/schedule.ts`, `packages/types/src/index.ts`, `apps/studio/db/src/schema/agents.ts`, `apps/studio/db/src/migrations/0005_add_queue_and_auto_reply.sql`, `apps/studio/server/src/routes/chat.ts`, `apps/studio/server/src/connectors/event-router.ts`, `apps/studio/server/src/routes/agents.ts`, `apps/studio/web/lib/api.ts`, `apps/studio/web/.../agents/[agent]/layout.tsx`, `apps/studio/web/.../agents/[agent]/auto-reply/page.tsx`

## 2026-04-07 — Cron Task System: Full End-to-End Implementation

- **DB schema** (`apps/studio/db/src/schema/cron_tasks.ts`): New `cron_tasks` table with `id, project_id, name, description, cron_expression, agent_id, prompt, caller_id, caller_role, caller_is_superadmin, run_count, last_run_at, created_at, updated_at` columns. Caller context snapshotted at creation time for permission checks.
- **Agent config** (`apps/studio/db/src/schema/agents.ts`): Added `cron_task_enabled: boolean DEFAULT true` column — when false, cron tools not injected into that agent.
- **Migration** (`apps/studio/db/src/migrations/0004_add_cron_tasks.sql`): Creates `cron_tasks` table + adds `cron_task_enabled` to `agents`.
- **CRUD queries** (`apps/studio/db/src/queries/cron_tasks.ts`): `createCronTask`, `getCronTaskById`, `getCronTasksByProject`, `getCronTasksByAgent`, `updateCronTask`, `deleteCronTask`, `incrementRunCount`, `getEnabledCronTasks` (for scheduler).
- **Cron scheduler** (`apps/studio/server/src/cron/scheduler.ts`): `CronTaskScheduler` class using `croner@10.0.1`. Methods: `scheduleTask` (parse cron expression + register), `triggerTask` (run conversation), `rescheduleTask`, `stopTask`, `stopAll`, `loadAndScheduleProject` (boot all active tasks). Integrated into `RuntimeManager.wakeUp()`/`syncAgent()`/`stopAll()`.
- **Cron tools** (`apps/studio/server/src/cron/tools.ts`): Four agent tools `buildCronCreateTool`, `buildCronListTool`, `buildCronUpdateTool`, `buildCronDeleteTool` — CRUD for cron tasks, security model enforces: superadmin can modify all, non-superadmin can only modify tasks they created + only if caller role unchanged.
- **REST API** (`apps/studio/server/src/routes/cron-tasks.ts`): 6 endpoints — `GET /api/projects/:pid/cron-tasks` (list), `POST /api/projects/:pid/cron-tasks` (create), `GET /api/cron-tasks/:id` (get), `PATCH /api/cron-tasks/:id` (update), `DELETE /api/cron-tasks/:id` (delete), `POST /api/cron-tasks/:id/trigger` (manual trigger). All guarded with permission checks.
- **Web API client** (`apps/studio/web/lib/api.ts`): Added `CronTask` type + `api.cronTasks.list/create/get/update/delete/trigger` methods. Added `cron_task_enabled` to `Agent` type.
- **CronExpressionInput component** (`apps/studio/web/components/cron/cron-expression-input.tsx`): New shared component with realtime validation using `cronstrue@3.14.0`. Shows green checkmark for valid expressions, red error text for invalid. Supports keyboard shortcuts (Ctrl+Space to explain).
- **Frontend pages**: List page (table with enable/edit/delete), Create page (form with CronExpressionInput), Edit/view page (form with task history preview).
- **Agent integration** (`agents/[agent]/task/page.tsx`): Added `cron_task_enabled` toggle to agent task settings page — allows selectively disabling cron execution per agent without deleting the tasks.
- **Sidebar nav** (`components/sidebar/project-sidebar.tsx`): Added "Cron Tasks" nav item with Clock icon above Browser, guarded by `cron_tasks:read` permission.
- **Conversation traceability**: Cron-triggered conversations get `metadata.cron_task_id` and `metadata.trigger: 'cron_task'`. Conversation type supports `'cron'` as valid type.
- **Permissions** (`packages/types/src/index.ts`): Added `CRON_TASKS_READ` and `CRON_TASKS_WRITE` to `PERMISSIONS` const.
- Files: `apps/studio/db/src/schema/cron_tasks.ts`, `apps/studio/db/src/schema/agents.ts`, `apps/studio/db/src/queries/cron_tasks.ts`, `apps/studio/db/src/migrations/0004_add_cron_tasks.sql`, `apps/studio/server/src/cron/scheduler.ts`, `apps/studio/server/src/cron/tools.ts`, `apps/studio/server/src/routes/cron-tasks.ts`, `apps/studio/server/src/runtime/manager.ts`, `apps/studio/web/lib/api.ts`, `apps/studio/web/components/cron/cron-expression-input.tsx`, `apps/studio/web/app/(app)/studio/companies/[company]/projects/[project]/cron-tasks/**`, `packages/types/src/index.ts`

## 2026-04-08 — Usage Monitor Charts: switched to raw ResponsiveContainer (recharts)

- **Chart rendering fix** (`apps/studio/web/components/usage/usage-charts.tsx`): Replaced shadcn `ChartContainer` wrapper with raw `recharts` `ResponsiveContainer` using explicit `height={180}` prop. `ChartContainer` wraps `ResponsiveContainer` with `aspect-video` which conflicts with CSS height classes — charts rendered blank even though data was present. Direct `height` prop on `ResponsiveContainer` is the reliable pattern.
- **Styling maintained**: Tooltip, Legend, axis ticks all styled to match theme via inline CSS vars (`hsl(var(--popover))`, `hsl(var(--border))`, `hsl(var(--muted-foreground))`). Hard-coded `CHART_COLORS` object replaces the `var(--color-*)` pattern (which only works via `ChartContainer` context).
- Files: `apps/studio/web/components/usage/usage-charts.tsx`

## 2026-04-08 — Theme toggle button in all sidebar footers

- **New component** (`apps/studio/web/components/theme-toggle.tsx`): `ThemeToggle` button using `next-themes` `useTheme`. Shows `Sun` icon in light mode, `Moon` in dark mode with CSS cross-fade transition (`rotate` + `scale`). Uses `Button` from `@jiku/ui` with `variant="ghost" size="icon"`.
- **All 3 sidebars updated** — footer now wraps the user dropdown + `ThemeToggle` in a `flex items-center gap-1` div. Toggle sits to the right of the user action button:
  - `apps/studio/web/components/sidebar/root-sidebar.tsx`
  - `apps/studio/web/components/sidebar/company-sidebar.tsx`
  - `apps/studio/web/components/sidebar/project-sidebar.tsx`
- `ThemeProvider` with `attribute="class"` already configured in `components/providers.tsx` — no additional setup needed.
- Files: `apps/studio/web/components/theme-toggle.tsx` *(new)*, `components/sidebar/root-sidebar.tsx`, `components/sidebar/company-sidebar.tsx`, `components/sidebar/project-sidebar.tsx`

## 2026-04-07 — Usage Monitor Enhancement: Charts + Total Tokens + Estimated Cost

- **`aggregateByDay(logs)`** added to `apps/studio/web/lib/usage.ts` — groups logs into daily time-series buckets for the area chart.
- **`aggregateByAgent(logs)`** added to `apps/studio/web/lib/usage.ts` — groups logs by agent for the project-level bar chart.
- **`estimateTotalCost(logs, pricingMap)`** added to `apps/studio/web/lib/usage.ts` — sums cost across all logs using model-specific pricing with the same fallback rates as `estimateCost`.
- **`TokenUsageAreaChart`** — new component in `apps/studio/web/components/usage/usage-charts.tsx`. Stacked area chart (input vs output tokens over time) using shadcn `ChartContainer` + recharts `AreaChart`.
- **`AgentUsageBarChart`** — new component in same file. Horizontal bar chart showing total tokens per agent (top 10), used on the project usage page.
- **Agent usage page** (`apps/studio/web/app/.../agents/[agent]/usage/page.tsx`) — stats grid expanded from 3 → 5 cards (added Total Tokens + Estimated Cost). `TokenUsageAreaChart` inserted between stats and table.
- **Project usage page** (`apps/studio/web/app/.../projects/[project]/usage/page.tsx`) — stats grid expanded from 3 → 5 cards (same additions, all filter-aware). Two-column chart grid added (area chart + agent bar chart), both react to active filters via `useMemo`.
- **Project dashboard** (`apps/studio/web/app/.../projects/[project]/page.tsx`) — "Activity" card now shows actual total token count from usage summary API instead of "---".
- Files: `apps/studio/web/lib/usage.ts`, `apps/studio/web/components/usage/usage-charts.tsx`, `apps/studio/web/app/(app)/studio/companies/[company]/projects/[project]/agents/[agent]/usage/page.tsx`, `apps/studio/web/app/(app)/studio/companies/[company]/projects/[project]/usage/page.tsx`, `apps/studio/web/app/(app)/studio/companies/[company]/projects/[project]/page.tsx`

## 2026-04-08 — Conversation Management: Title Generation, Manual Rename, Soft Delete

- **Title generation** (`apps/studio/server/src/title/generate.ts`): New service that auto-generates conversation titles using the agent's own configured LLM after the first user message. Max 50 chars. Fire-and-forget (non-blocking).
- **Auto-trigger on first message** (`apps/studio/server/src/routes/chat.ts`): After first message is stored, `generateTitle()` is called asynchronously if conversation title is null.
- **Manual title rename endpoint** (`apps/studio/server/src/routes/conversations.ts`): New `PATCH /conversations/:id/title` route accepts `{ title: string }` body, validates max length, updates conversation.
- **Soft delete** (`apps/studio/db/src/schema/conversations.ts`): Added `deleted_at timestamp` column to conversations table. Not hard-deleted, just filtered from query results.
- **Soft delete queries** (`apps/studio/db/src/queries/conversation.ts`): New `softDeleteConversation(id)` function. `getConversationsByProject()` now filters `WHERE deleted_at IS NULL`.
- **Delete endpoint** (`apps/studio/server/src/routes/conversations.ts`): New `DELETE /conversations/:id` route calls `softDeleteConversation()`.
- **Web API** (`apps/studio/web/lib/api.ts`): Added `api.conversations.rename(convId, title)` and `api.conversations.delete(convId)`.
- **Inline title editing** (`apps/studio/web/components/chat/conversation-viewer.tsx`): Click pencil icon on conversation title to edit inline. Enter or blur to save, Escape to cancel. Displays title as primary text with agent name as secondary.
- **Sidebar delete** (`apps/studio/web/components/chat/conversation-list-panel.tsx`): Trash icon appears on hover. Click opens `AlertDialog` confirm dialog. Confirmed delete removes from sidebar and navigates away if deleting current conversation. Sidebar now shows title (primary) + agent name (secondary) instead of last_message.
- **Avatar removal**: Removed Avatar/AvatarFallback from both header and sidebar — agent avatar feature not yet implemented.
- **AlertDialog for delete project** (`apps/studio/web/app/.../settings/general/page.tsx`): Replaced native `confirm()` with `AlertDialog` component from `@jiku/ui`.
- **Migration**: Created `0003_add_conversation_deleted_at.sql` (requires `bun run db:push`).
- Files: `apps/studio/server/src/title/generate.ts`, `apps/studio/server/src/routes/chat.ts`, `apps/studio/server/src/routes/conversations.ts`, `apps/studio/db/src/schema/conversations.ts`, `apps/studio/db/src/queries/conversation.ts`, `apps/studio/db/src/migrations/0003_add_conversation_deleted_at.sql`, `apps/studio/web/lib/api.ts`, `apps/studio/web/components/chat/conversation-viewer.tsx`, `apps/studio/web/components/chat/conversation-list-panel.tsx`, `apps/studio/web/app/(app)/studio/companies/[company]/projects/[project]/settings/general/page.tsx`

## 2026-04-07 — Browser automation marked failed + UI rendering fixes

- **Screenshot renders as image in chat UI** (`packages/ui/src/components/ai-elements/tool.tsx`): `ToolOutput` component now handles `content[]` arrays (Vercel AI SDK tool output format). Image parts (`type: 'image'`) render as `<img>` with base64 src. Text parts render as CodeBlock. Single-image case renders without wrapper div.
- **Server path removed from screenshot result** (`apps/studio/server/src/browser/execute.ts`): `screenshot` case no longer returns `{ type: 'text', text: 'Screenshot saved: /path...' }` — only the image data part is returned. Prevents server filesystem paths from being exposed to end users.
- **Browser tool prompt improved** (`apps/studio/server/src/browser/tool.ts`): Added explicit WORKFLOW steps and COMMON MISTAKES section to tool description. AI no longer claims it cannot browse the web.
- **Browser automation marked FAILED** (`docs/`): ADR-026 added. `current.md`, `tasks.md`, `decisions.md`, `feats/browser.md` all updated to reflect that Plan 13 does not meet requirements and will be removed before MVP.
- Files: `packages/ui/src/components/ai-elements/tool.tsx`, `apps/studio/server/src/browser/execute.ts`, `apps/studio/server/src/browser/tool.ts`, `docs/builder/decisions.md`, `docs/builder/current.md`, `docs/builder/tasks.md`, `docs/feats/browser.md`

## 2026-04-07 — Plan 15: On-Demand Skills System

- **DB schema** (`apps/studio/db/src/schema/skills.ts`): New `project_skills`, `project_skill_files`, `agent_skills` tables. Skills are folder-like structures (multiple markdown files with an entrypoint) assigned to agents per-project.
- **CRUD queries** (`apps/studio/db/src/queries/skills.ts`): Full CRUD for skills, files, and agent assignments. `getAgentAlwaysSkills` / `getAgentOnDemandSkills` for runtime injection.
- **Skill service** (`apps/studio/server/src/skills/service.ts`): `SkillService` — loads entrypoints, nested files, builds "always" system prompt section + on-demand hint. Enforces 50 KB/file, 200 KB/skill limits.
- **Skill tools** (`apps/studio/server/src/skills/tools.ts`): `buildSkillTools(agentId)` → 3 built-in tools: `skill_list`, `skill_activate`, `skill_read_file`. Agent calls these to discover and load knowledge on-demand.
- **API routes** (`apps/studio/server/src/routes/skills.ts`): Full REST API: project skills CRUD, file tree CRUD, agent skill assignment CRUD. Calls `syncAgent()` after every mutation.
- **Core integration**: `buildSystemPrompt` now accepts `skill_section` + `skill_hint`. `AgentRunner` + `JikuRuntime.addAgent` forward skill context. `previewRun` includes `skill` segment. `ContextSegment.source` union extended with `'skill'`.
- **Runtime manager**: All 3 agent registration paths (`wakeUp`, `syncProjectTools`, `syncAgent`) now load skill tools + sections per-agent.
- **Web UI**: Project skills page (skill editor with file tree + markdown editor) + agent skills page (assign/remove skills, toggle always/on-demand mode). Skills nav added to project sidebar and agent layout.
- **Migration**: `apps/studio/db/src/migrations/0001_unique_wong.sql` generated.

## 2026-04-07 — Plan 12: Route Security Audit Completion + Agent Visibility Feature

- **`loadPerms` exported** (`apps/studio/server/src/middleware/permission.ts`): Changed from private to `export async function loadPerms(...)`. Enables route handlers to call it inline after manually injecting `res.locals['project_id']` — needed for routes where the entity param is not `:pid`/`:aid`.
- **Memory route guarded** (`apps/studio/server/src/routes/memory.ts`): `DELETE /memories/:id` — looks up memory, sets `res.locals['project_id'] = memory.project_id`, calls inline `loadPerms`, checks `memory:delete`.
- **Connector routes guarded** (`apps/studio/server/src/routes/connectors.ts`): Added `requireConnectorPermission(permission)` factory middleware — resolves connector → `project_id`, then calls `loadPerms`. Applied to all 16 `/connectors/:id*` routes (read/write/activate/bindings/identities/events/messages/stream).
- **Credential routes guarded** (`apps/studio/server/src/routes/credentials.ts`): Added `checkCredentialPermission` async helper. Only enforces ACL for `scope === 'project'` credentials; company-scoped credentials are accessible to any authenticated user. Applied to PATCH/DELETE/test routes.
- **Preview routes guarded** (`apps/studio/server/src/routes/preview.ts`): `POST /agents/:aid/preview` → `requirePermission('agents:read')`. `POST /conversations/:id/preview` → inline `loadPerms` after resolving agent, requires `chats:read`.
- **Conversation routes guarded** (`apps/studio/server/src/routes/conversations.ts`): `GET /conversations/:id` and `GET /conversations/:id/messages` → inline `loadPerms` after resolving agent, requires `chats:read`.
- **Run routes guarded** (`apps/studio/server/src/routes/runs.ts`): `GET /conversations/:id` and `POST /conversations/:id/cancel` → inline `loadPerms` after resolving agent, requires `runs:read`.
- **Attachment routes guarded** (`apps/studio/server/src/routes/attachments.ts`): All 4 attachment endpoints guarded with `requirePermission` (upload/list/delete → `chats:create`; token → `chats:read`).
- **Project routes guarded** (`apps/studio/server/src/routes/projects.ts`): `PATCH /projects/:pid` → `requirePermission('settings:write')`. `GET /projects/:pid/usage` → `requirePermission('settings:read')`.
- **Policy routes guarded** (`apps/studio/server/src/routes/policies.ts`): Added `requireCompanyMember` (caller is member of `:cid` company) and `requirePolicyCompanyMember` (looks up policy → company, checks membership). Applied to all 8 company policy routes.
- **Agent visibility filtering** (`apps/studio/server/src/routes/agents.ts`): `GET /projects/:pid/agents` now filters agents by `agentRestrictions` for non-superadmin, non-`agents:write` users. Superadmins and users with `agents:write` see all agents. Agent-to-agent calls via runtime engine are unaffected.
- **`AgentVisibilityConfig` component** (`apps/studio/web/components/permissions/agent-visibility-config.tsx`): New reusable component. Props: `{ agentId, projectId }`. Shows per-member Switch toggles. Superadmin and `agents:write` role members shown as "Always visible" (read-only). `canManage` gate: only renders interactive Switch if caller has `members:write` or is superadmin. Uses `api.acl.setAgentRestrictions` mutation.
- **Agent Access tab in project settings** (`apps/studio/web/app/.../settings/permissions/page.tsx`): Added third "Agent Access" tab. View by member — shows which agents each member can see, with per-agent Switch toggles and "Hide all" / "Show all" buttons.
- **Agent permissions tab** (`apps/studio/web/app/.../agents/[agent]/permissions/page.tsx`): Added `AgentVisibilityConfig` at top (Member Visibility section) above `AgentPolicyConfig`. View by agent — shows which members can see this specific agent.
- Files: `middleware/permission.ts`, `routes/memory.ts`, `routes/connectors.ts`, `routes/credentials.ts`, `routes/preview.ts`, `routes/conversations.ts`, `routes/runs.ts`, `routes/attachments.ts`, `routes/projects.ts`, `routes/policies.ts`, `routes/agents.ts`, `components/permissions/agent-visibility-config.tsx` *(new)*, `settings/permissions/page.tsx`, `agents/[agent]/permissions/page.tsx`

## 2026-04-07 — Task System Enhancements

- **`task_allowed_agents` column** (`apps/studio/db/src/schema/agents.ts`): New `text[]|null` column on `agents` table. `null` = allow all, `[]` = deny all, `[id…]` = specific agents. Migration generated.
- **`list_agents` tool** (`apps/studio/server/src/task/tools.ts`): New built-in tool exposed in `chat` and `task` modes. Returns all agents in the project (id, name, slug, description) — lets agents discover delegation targets.
- **`run_task` delegation guard** (`apps/studio/server/src/task/tools.ts`): When `agent_id` differs from the caller agent, `checkTaskDelegationPermission()` enforces `task_allowed_agents`. Returns `{ status: 'error', message }` if denied.
- **Heartbeat task-mode guard** (`apps/studio/server/src/task/heartbeat.ts`): `scheduleAgent()` skips scheduling if `task` not in `allowed_modes`. `triggerHeartbeat()` throws if task mode not enabled. Reschedule after run also checks task mode.
- **`serializeToolSchema()`** (`packages/core/src/runner.ts`): Converts Zod schema to plain JSON Schema via `zodToJsonSchema` before sending in preview API response. Fixes "No parameters" in context preview Tools tab.
- **Agent nav: "task" tab** (`apps/studio/web/app/.../agents/[agent]/layout.tsx` + `task/page.tsx`): New dedicated page for task delegation config (allow all / deny all / specific agents with toggle switches per agent).
- **Tools page** (`apps/studio/web/app/.../agents/[agent]/tools/page.tsx`): Now shows available tools list only (delegation section removed — moved to task tab).
- **Memory config desync fix** (`apps/studio/web/app/.../agents/[agent]/memory/page.tsx`): Replaced `initialized` flag + if-in-render pattern with `useEffect` synced to `resolvedData`. Selector buttons now correctly reflect saved values after save.
- Files: `schema/agents.ts`, `task/tools.ts`, `task/heartbeat.ts`, `runtime/manager.ts`, `packages/core/src/runner.ts`, `web/lib/api.ts`, `agents/[agent]/layout.tsx`, `agents/[agent]/task/page.tsx`, `agents/[agent]/tools/page.tsx`, `agents/[agent]/memory/page.tsx`


## 2026-04-07 — Plan 12: Permission Guard System + Policy Config Component

- **`useProjectPermission` hook** (`apps/studio/web/lib/permissions.ts`): Core hook wrapping `api.acl.getMyPermissions`. Returns `{ can(permission), isSuperadmin, isMember, isLoading }`. `can()` is optimistic (true while loading). Slug variant `useProjectPermissionBySlugs` resolves projectId from slugs.
- **Guard components** (`apps/studio/web/components/permissions/permission-guard.tsx`): `PermissionGuard` (inline, hide/show), `ProjectPageGuard` (page-level 403 UI), `withPermissionGuard` HOC (wraps page components automatically).
- **All project pages guarded** via `withPermissionGuard`: chats, runs, memory, agents, plugins, channels, usage, disk, browser.
- **Backend routes guarded**: agents, conversations, runs, memory, plugins, connectors, credentials — all with `requirePermission()`.
- **`requirePermission` refactored** (`apps/studio/server/src/middleware/permission.ts`): Added `resolveProjectId()` helper (handles `:pid`, `:aid`→agent lookup, `res.locals`). Unified `loadPerms()` with caching.
- **`AgentPolicyConfig` component** (`apps/studio/web/components/permissions/agent-policy-config.tsx`): Reusable policy editor for a single agent. Used in agent settings page (full) and project settings policies page (compact/accordion).
- **Project settings Policies tab** (`apps/studio/web/app/.../settings/policies/page.tsx`): Shows all agents with accordion to edit their policies without navigating to each agent.
- **Docs updated**: `docs/plans/12-acl.md` — added Section 13 (guard system notes). `docs/feats/permission-policy.md` — rewritten to cover both layers (roles+permissions and policies+rules).
- Files: `lib/permissions.ts`, `components/permissions/permission-guard.tsx`, `components/permissions/agent-policy-config.tsx`, `settings/policies/page.tsx`, `middleware/permission.ts`, 9 project page files

## 2026-04-07 — Plan 12: ACL Frontend (permissions settings page)

- **API client** (`apps/studio/web/lib/api.ts`): Added `api.acl.*` — listRoles, createRole, updateRole, deleteRole, listMembers, getMyPermissions, assignRole, setSuperadmin, removeMember, listMyInvitations, acceptInvitation, declineInvitation, listCompanyInvitations, sendInvitation, cancelInvitation.
- **ACL types** (`apps/studio/web/lib/api.ts`): Added `ProjectRole`, `ProjectMembership`, `ProjectMember`, `ResolvedProjectPermissions`, `InvitationItem`.
- **Permissions page** (`apps/studio/web/app/.../settings/permissions/page.tsx`): Replaced "Coming Soon" stub with full Members + Roles management UI. Members tab: list with role dropdown, superadmin star, remove button. Roles tab: list with permission counts, role editor dialog with permission checkboxes grouped by resource, preset import buttons.
- **`@jiku/types` dependency**: Added to `apps/studio/web/package.json` — needed for `PERMISSIONS` const and `ROLE_PRESETS`.
- Files: `apps/studio/web/lib/api.ts`, `apps/studio/web/app/.../settings/permissions/page.tsx`, `apps/studio/web/package.json`

## 2026-04-07 — Plan 12: ACL System (project roles, memberships, invitations)

- **DB schema** (`apps/studio/db/src/schema/acl.ts`): 4 new tables — `project_roles` (custom roles per project with `permissions text[]`), `project_memberships` (user in project with `is_superadmin`, `agent_restrictions` jsonb, `tool_restrictions` jsonb), `invitations` (email invite with `project_grants` jsonb, status, 7-day expiry), `superadmin_transfers` (audit log).
- **Relations** (`apps/studio/db/src/schema/relations.ts`): Added relations for all 4 new tables. Updated `projectsRelations`, `usersRelations`, `companiesRelations`.
- **DB queries** (`apps/studio/db/src/queries/acl.ts`): Full CRUD for project roles, memberships, invitations. `resolveProjectPermissions()` resolves isSuperadmin + permissions + restrictions for a user in a project.
- **`@jiku/types` permissions** (`packages/types/src/index.ts`): Added `PERMISSIONS` const (18 action strings), `Permission` type, `ROLE_PRESETS` (admin/manager/member/viewer), `ResolvedPermissions` interface, `ProjectGrant` interface.
- **Permission middleware** (`apps/studio/server/src/middleware/permission.ts`): `requirePermission(permission)` and `requireSuperadmin()` middleware. Resolves permissions from DB, caches in `res.locals`. Superadmin bypasses all permission checks.
- **Project roles routes** (`apps/studio/server/src/routes/acl-roles.ts`): CRUD for `/api/projects/:pid/roles` + `/roles/presets` endpoint.
- **Project members routes** (`apps/studio/server/src/routes/acl-members.ts`): List members, `me/permissions`, assign role, grant/revoke superadmin, agent/tool restrictions, remove member. Prevents removal of last superadmin.
- **Invitation routes** (`apps/studio/server/src/routes/acl-invitations.ts`): User-side: list pending invites, accept (creates memberships from project_grants), decline. Admin-side: send invite, cancel invite, list company invitations.
- **Auto-create superadmin** (`apps/studio/server/src/routes/projects.ts`): When creating a project, creator gets `is_superadmin: true` membership automatically.
- Files: `apps/studio/db/src/schema/acl.ts` *(new)*, `apps/studio/db/src/schema/index.ts`, `apps/studio/db/src/schema/relations.ts`, `apps/studio/db/src/queries/acl.ts` *(new)*, `apps/studio/db/src/index.ts`, `packages/types/src/index.ts`, `apps/studio/server/src/middleware/permission.ts` *(new)*, `apps/studio/server/src/routes/acl-roles.ts` *(new)*, `apps/studio/server/src/routes/acl-members.ts` *(new)*, `apps/studio/server/src/routes/acl-invitations.ts` *(new)*, `apps/studio/server/src/index.ts`, `apps/studio/server/src/routes/projects.ts`

## 2026-04-06 — Chat Image Attachments + ImageGallery preview component

- **`project_attachments` table** (`apps/studio/db/src/schema/attachments.ts`): New DB table for ephemeral chat attachments. Separate from `project_files` (virtual disk). Stores S3 key, filename, mime_type, size_bytes, scope (per_user/shared). S3 key layout: `jiku/attachments/{projectId}/{conversationId}/{uuid}.{ext}`.
- **Attachment upload/serve routes** (`apps/studio/server/src/routes/chat.ts`): `POST /api/attachments` — multipart upload, validates mime + size, stores in S3. `GET /api/attachments/:id` — proxy serve from S3 with auth check.
- **Image rendering in conversation** (`apps/studio/web/components/chat/conversation-viewer.tsx`): Attachment images rendered inline in chat messages. Each image is clickable to open fullscreen gallery.
- **`ImageGallery` component** (`apps/studio/web/components/ui/image-gallery.tsx`): Fullscreen overlay gallery. Features: fit-to-screen image display, prev/next navigation (arrow keys + buttons), minimap thumbnail strip at bottom for multi-image navigation, click outside / backdrop click to close. Supports multiple images in one message.
- **Duplicate image fix**: `conversation-viewer.tsx` had optimistic-update double-render bug — images appeared doubled until refresh. Fixed by deduplicating message parts before rendering.
- Files: `apps/studio/db/src/schema/attachments.ts` *(new)*, `apps/studio/db/src/schema/index.ts`, `apps/studio/db/src/schema/relations.ts`, `apps/studio/server/src/routes/chat.ts`, `apps/studio/web/components/ui/image-gallery.tsx` *(new)*, `apps/studio/web/components/chat/conversation-viewer.tsx`, `apps/studio/web/components/agent/chat/chat-interface.tsx`

## 2026-04-06 — Plan 14: Filesystem (S3/RustFS virtual disk)

- **DB schema** (`apps/studio/db/src/schema/filesystem.ts`): `project_filesystem_config` (one row per project: adapter_id, credential_id, enabled, total_files, total_size_bytes) + `project_files` (virtual path entries: path, name, folder_path, extension, storage_key, size_bytes, mime_type, content_cache). Content cache for files ≤ 50 KB avoids S3 round-trips.
- **S3 adapter** (`apps/studio/server/src/filesystem/adapter.ts`): `S3FilesystemAdapter` using `@aws-sdk/client-s3`. `forcePathStyle: true` for RustFS/MinIO compatibility. `buildS3Adapter()` factory resolves from decrypted credential fields.
- **FilesystemService** (`apps/studio/server/src/filesystem/service.ts`): Full CRUD — `list()`, `read()`, `write()`, `move()`, `delete()`, `deleteFolder()`, `search()`. Validates extension + size via `isAllowedFile()`. `normalizePath()` prevents path traversal. Virtual subfolder extraction via `extractImmediateSubfolders()`.
- **Filesystem tools** (`apps/studio/server/src/filesystem/tools.ts`): 6 built-in tools: `fs_list`, `fs_read`, `fs_write`, `fs_move`, `fs_delete`, `fs_search`. Tagged `group: 'filesystem'`. Injected at `wakeUp()` when filesystem enabled.
- **API routes** (`apps/studio/server/src/routes/filesystem.ts`): GET/PATCH config, POST test-connection, GET list, GET content, POST write, PATCH move, DELETE file, DELETE folder, GET search, POST upload (multipart).
- **File manager UI** (`apps/studio/web/app/.../disk/page.tsx`): File tree with breadcrumb navigation. Folder list + file list. CodeMirror editor panel (split view). `apps/studio/web/app/.../disk/code-editor.tsx` — syntax-highlighted editor.
- **Settings page** (`apps/studio/web/app/.../settings/filesystem/page.tsx`): Enable toggle, adapter selector (S3/RustFS), credential picker, storage stats, test connection button.
- **Sidebar**: "Disk" nav item added to project sidebar.
- Files: `apps/studio/db/src/schema/filesystem.ts`, `apps/studio/db/src/queries/filesystem.ts`, `apps/studio/server/src/filesystem/adapter.ts`, `apps/studio/server/src/filesystem/service.ts`, `apps/studio/server/src/filesystem/tools.ts`, `apps/studio/server/src/filesystem/utils.ts`, `apps/studio/server/src/routes/filesystem.ts`, `apps/studio/web/app/.../disk/page.tsx`, `apps/studio/web/app/.../disk/code-editor.tsx`, `apps/studio/web/app/.../settings/filesystem/page.tsx`, `apps/studio/web/components/sidebar/project-sidebar.tsx`

## 2026-04-06 — Plan 13: Browser Automation

- **OpenClaw browser engine ported** (`apps/studio/server/src/browser/`): ~80 files ported from OpenClaw. Entry: `browser/browser/server.ts` (`startBrowserControlServer(resolved)`). Config via `browser/config/config.ts`. All external OpenClaw config dependencies replaced with parameter-based config.
- **Browser server lifecycle** (`apps/studio/server/src/browser/index.ts` / `node-server-entry.ts`): `startBrowserServer(projectId, config)` / `stopBrowserServer()` / `stopAllBrowserServers()`. Each project gets its own browser server on a unique port.
- **Browser tool** (`apps/studio/server/src/browser/tool-schema.ts`): Single `browser` tool with `action` enum (status/start/stop/profiles/tabs/open/focus/close/navigate/snapshot/screenshot/console/pdf/upload/dialog/act). Zod schema. Tagged `group: 'browser'`, `permission: '*'`.
- **Manager integration** (`apps/studio/server/src/runtime/manager.ts`): `wakeUp()` checks `browser_enabled` on project, starts browser server, injects `browserTools` into all agent `built_in_tools`. `sleep()` stops browser server. `stopAll()` stops all browser servers.
- **API routes** (`apps/studio/server/src/routes/browser.ts`): GET config+status, PATCH enabled (triggers runtime restart), PATCH config.
- **Browser settings UI** (`apps/studio/web/app/.../browser/page.tsx`): Enable toggle + server status badge + config form (headless, port, timeout, sandbox, evaluate).
- Files: `apps/studio/server/src/browser/**` *(~80 new files)*, `apps/studio/server/src/routes/browser.ts`, `apps/studio/server/src/runtime/manager.ts`, `apps/studio/db/src/schema/projects.ts` (browser_enabled + browser_config columns), `apps/studio/web/app/.../browser/page.tsx`

## 2026-04-06 — Tool parts rendering bug fix (DB → UI format conversion)

- **`dbMessageToUIMessage` helper** (`apps/studio/web/lib/messages.ts` *(new)*): Converts DB-stored tool parts to AI SDK v6 UI format on load. DB stores `{ type: 'tool-invocation', toolInvocationId, args, state: 'result', result }` but AI SDK v6 expects `{ type: 'dynamic-tool', toolCallId, state: 'output-available', input, output }`. Without this conversion tools rendered as empty card with name "invocation".
- Both message pages now use `dbMessageToUIMessage` instead of raw cast: `chats/[conv]/page.tsx` and `runs/[conv]/page.tsx`.
- Files: `apps/studio/web/lib/messages.ts` *(new)*, `apps/studio/web/app/.../chats/[conv]/page.tsx`, `apps/studio/web/app/.../runs/[conv]/page.tsx`

## 2026-04-06 — Tool parts persistence, real-time streaming, get_datetime, Telegram context

- **Tool parts persisted to DB** (`packages/core/src/runner.ts`): Runner now saves ALL parts per assistant message — tool invocations (call + result) and text — not just text. Uses `result.steps` from AI SDK to collect every step's `toolCalls`+`toolResults` and builds `tool-invocation` parts with `state: 'result'`. History loading updated to reconstruct full `assistant` + `tool` model messages from saved parts so multi-step tool context survives page refresh.
- **Real-time streaming for connector conversations** (`server/src/connectors/event-router.ts`): `executeConversationAdapter` now registers to `streamRegistry` and tees the run stream. Observer tab (watching same conversation) and run detail page both receive live updates via polling.
- **`useLiveConversation` hook** (`apps/studio/web/hooks/use-live-conversation.ts`): Polls `/live-parts` at 400ms during active run. `autoDetect` mode polls `/status` every 2s to begin polling when a run starts (handles tabs opened before streaming begins). Reconstructs partial `UIMessage` from buffered chunks.
- **`streamRegistry` buffer** (`server/src/runtime/stream-registry.ts`): Added `buffer: StreamChunk[]` per active run. `bufferChunk()` accumulates chunks. `GET /conversations/:id/live-parts` exposes snapshot (returns `{running: false}` when idle).
- **`get_datetime` system tool** (`apps/studio/server/src/system/tools.ts`): Built-in tool returning `{ iso, timezone, local, unix }` — server timezone + formatted local time. Injected as first tool in all agents via `systemTools` array in `RuntimeManager.wakeUp/syncAgent`.
- **Telegram user context injection** (`server/src/connectors/event-router.ts`): `buildConnectorContextString` injects server timestamp, `language_code`, and estimated user timezone (35+ locale map) so AI can convert times correctly without asking. Telegram plugin now sends `metadata.language_code` and `metadata.client_timestamp` on message events.
- **ConversationViewer real-time** (`apps/studio/web/components/chat/conversation-viewer.tsx`): Uses `useLiveConversation` in readonly mode. Shows "streaming" badge during live run. `displayMessages` merges DB messages + live partial message.
- Files: `packages/core/src/runner.ts`, `apps/studio/server/src/runtime/stream-registry.ts`, `apps/studio/server/src/routes/chat.ts`, `apps/studio/server/src/connectors/event-router.ts`, `apps/studio/server/src/system/tools.ts` *(new)*, `apps/studio/server/src/runtime/manager.ts`, `plugins/jiku.telegram/src/index.ts`, `apps/studio/web/hooks/use-live-conversation.ts` *(new)*, `apps/studio/web/components/chat/conversation-viewer.tsx`, `apps/studio/web/lib/api.ts`

## 2026-04-06 — Connector System: Plugin architecture, Telegram polish, Zod fix

- **`@jiku/plugin-connector`** *(new — `plugins/jiku.connector/`)* : Core connector plugin. Contributes `ctx.connector.register(adapter)` to dependent plugins via module-level mutable ref pattern (safe across `contributes()` → `setup()` boundary). Server registers this before TelegramPlugin.
- **Telegram plugin refactor** (`plugins/jiku.telegram/src/index.ts`): Now `depends: [ConnectorPlugin]` and calls `ctx.connector.register(telegramAdapter)` instead of raw `ctx.hooks.callHook(...)`. Added `telegramify-markdown` for MarkdownV2-safe escaping. Added `splitMessage()` — splits responses at newlines near 4000-char boundary, sends as sequential messages (reply_parameters only on first chunk). Switched parse_mode `Markdown` → `MarkdownV2`.
- **Typing indicator** (`server/src/connectors/event-router.ts`): `sendTyping()` called immediately + repeated via `setInterval` every 4s while agent processes. Cleared in `finally` block.
- **Zod cross-instance fix**: All workspace packages (`core`, all plugins) standardized on `zod: 3.25.76`. Root `package.json` hoists single Zod instance. Removed `zodToJsonSchema` unused import from `packages/core/src/runner.ts`.
- **Binding architecture** (`output_adapter + output_config`): `ConnectorBinding` no longer has `agent_id` at root — uses `output_adapter: string` + `output_config: jsonb`. `ConversationOutputConfig { agent_id, conversation_mode? }` and `TaskOutputConfig { agent_id }` inside config. Pairing approve route, API types (`web/lib/api.ts`), and event-router all updated.
- Files: `plugins/jiku.connector/` *(new)*, `plugins/jiku.telegram/src/index.ts`, `plugins/jiku.telegram/package.json`, `apps/studio/server/src/index.ts`, `apps/studio/server/package.json`, `apps/studio/server/src/connectors/event-router.ts`, `apps/studio/server/src/routes/connectors.ts`, `apps/studio/web/lib/api.ts`, `packages/core/src/runner.ts`, root `package.json`

## 2026-04-06 — UX polish: Run Detail, Memory table, Persona refactor

- **ConversationViewer** (`apps/studio/web/components/chat/conversation-viewer.tsx`): Extracted shared component from chat page. Accepts `mode: 'edit' | 'readonly'`. In readonly mode: no PromptInput, same ContextBar + MemoryPreviewSheet. Both chat and run detail now use this component.
- **Run Detail page** (`runs/[conv]/page.tsx`): Replaced simple message list with `ConversationViewer mode="readonly"` — now has context bar, token count, tools preview, memory preview identical to chat page. Compact metadata bar (type/status/duration/goal/error/output) shown above.
- **Run list scroll fix**: Removed `runs/layout.tsx` that was blocking scroll on the list page. Run detail sets its own `height: calc(100svh - 3rem)` directly.
- **Memory browser** (`apps/studio/web/components/memory/memory-browser.tsx`): Converted card grid to compact table. Added **Agent** column (name resolved from agents list, fallback to UUID). Added **filter by agent** dropdown. Columns: Scope, Agent, Tier, Priority, Section, Content (truncated + tooltip), Hits, Created, Delete.
- **Persona refactor**: New `persona_prompt text` column on `agents` table (run `bun run db:push`). `persona_prompt` is injected directly into system prompt, bypassing memory-based persona. `AgentRunner` and `JikuRuntime.addAgent()` accept `personaPrompt` param. Old memory-seeding path still works when `persona_prompt` is null. Persona page replaced with single textarea. New routes: `GET/PATCH /api/agents/:aid/persona/prompt`.
- Files: `apps/studio/db/src/schema/agents.ts`, `apps/studio/db/src/queries/memory.ts`, `apps/studio/server/src/routes/persona.ts`, `packages/core/src/runner.ts`, `packages/core/src/runtime.ts`, `apps/studio/server/src/runtime/manager.ts`, `apps/studio/web/lib/api.ts`, `apps/studio/web/components/chat/conversation-viewer.tsx`, `apps/studio/web/components/memory/memory-browser.tsx`, `apps/studio/web/app/.../runs/[conv]/page.tsx`, `apps/studio/web/app/.../chats/[conv]/page.tsx`, `apps/studio/web/app/.../agents/[agent]/persona/page.tsx`

## 2026-04-05 — Plan 11 Task Mode, Heartbeat & Run History

- **DB schema**: Extended `conversations` table with `type`, `metadata`, `run_status`, `caller_id`, `parent_conversation_id`, `started_at`, `finished_at`, `error_message` (nullable `user_id`). Extended `agents` with `heartbeat_enabled`, `heartbeat_cron`, `heartbeat_prompt`, `heartbeat_last_run_at`, `heartbeat_next_run_at`.
- **DB queries**: `createTaskConversation`, `listRunsByProject` (server-side paginated with agent join + message count).
- **Types** (`@jiku/types`): `ConversationType`, `ConversationRunStatus`, `TaskMetadata`, `HeartbeatMetadata`, `ConversationRow`, `ListConversationsResult`.
- **Server task runner** (`apps/studio/server/src/task/runner.ts`): `runTaskConversation`, `spawnTask`, `buildCaller`.
- **Task tools** (`apps/studio/server/src/task/tools.ts`): `buildRunTaskTool` (run_task — always active in chat+task), `buildTaskLifecycleTools` (task_complete, task_fail).
- **HeartbeatScheduler** (`apps/studio/server/src/task/heartbeat.ts`): setTimeout-based scheduler, `scheduleAgent`, `triggerHeartbeat`, `rescheduleAgent`, `stopAll`. Integrated into `RuntimeManager` wakeUp/syncAgent/stopAll.
- **Server routes**: `GET /api/projects/:pid/runs`, `POST /api/conversations/:id/cancel`, `GET/PATCH /api/agents/:aid/heartbeat`, `POST /api/agents/:aid/heartbeat/trigger`.
- **Web**: Run History page (`/runs`) with type/status filters and pagination. Run Detail page (`/runs/[conv]`). Heartbeat settings tab in agent layout. "Runs" added to project sidebar. `api.runs` and `api.heartbeat` API client namespaces.
- Files: `apps/studio/server/src/task/runner.ts`, `tools.ts`, `heartbeat.ts`, `routes/runs.ts`, `routes/heartbeat.ts`. Web: `runs/page.tsx`, `runs/[conv]/page.tsx`, `agents/[agent]/heartbeat/page.tsx`.

## 2026-04-05 — Plan 10 Channels & Connector System

**Changed:** Full implementation of the Channels & Connector System (Plan 10).

- **Types** (`@jiku/types`): `ConnectorEventType`, `ConnectorEvent`, `ConnectorTarget`, `ConnectorContent`, `ConnectorSendResult`, `ConnectorContext`, `ConnectorBinding`, `ConnectorIdentity`, `UserIdentity`, `ConnectorRecord`, `ConnectorCallerContext`. Extended `CallerContext` with `connector_context?`.
- **Kit** (`@jiku/kit`): `ConnectorAdapter` abstract base class + `defineConnector()` factory that wraps a connector class as a JikuPlugin with `connector:register/activate/deactivate` hooks.
- **DB schema**: 7 new tables — `connectors`, `connector_bindings`, `connector_identities`, `connector_events`, `connector_messages`, `connector_message_events`, `user_identities`. GIN indexes on jsonb `ref_keys` columns. (Migration pending: `bun run db:push`)
- **DB queries** (`@jiku-studio/db`): Full CRUD for connectors, bindings, identities, events, messages, user_identities. `findIdentityByExternalId` via SQL jsonb query. `upsertUserIdentity` with `onConflictDoUpdate`.
- **ConnectorRegistry** (`server/src/connectors/registry.ts`): Singleton tracking registered adapters + active connector instances per project.
- **ConnectorEventRouter** (`server/src/connectors/event-router.ts`): `routeConnectorEvent()` — matches bindings, creates/updates identities, approval/rate-limit checks, logs events, executes conversation/task adapters via `runtimeManager.run()`, drains stream, sends response back via adapter.
- **Connector Routes** (`server/src/routes/connectors.ts`): Full CRUD API, binding CRUD, identity management, event/message read endpoints, SSE live event stream, inbound webhook route (`POST /webhook/:project_id/connector/:connector_id`), `GET /connector-plugins` listing.
- **Connector Tools** (`server/src/connectors/tools.ts`): 8 built-in tools: `connector_get_events`, `connector_get_thread`, `connector_send`, `connector_react`, `connector_binding_update`, `identity_get`, `identity_set`, `identity_find`. All tagged `group: 'connector'`.
- **RuntimeManager** updated to load connector tools alongside memory tools at wakeUp().
- **Telegram Plugin** (`plugins/jiku.connector.telegram`): `TelegramConnector` extends `ConnectorAdapter`. Supports message/reaction/edit events via Telegraf. Handles polling + webhook modes. `sendMessage`, `sendReaction`, `deleteMessage`, `editMessage`.
- **Server bootstrap** (`server/src/index.ts`): Registers `telegramConnectorAdapter` in `connectorRegistry` + `TelegramConnectorPlugin` in shared plugin loader.
- **Web UI** — 6 new pages under `/channels`:
  - `channels/page.tsx` — connector overview cards with status badge
  - `channels/new/page.tsx` — 2-step add connector (select plugin → configure)
  - `channels/[connector]/page.tsx` — detail: status, quick nav, bindings list, config display
  - `channels/[connector]/bindings/[binding]/page.tsx` — binding settings + identity approval workflow
  - `channels/[connector]/events/page.tsx` — event log + SSE live stream
  - `channels/[connector]/messages/page.tsx` — inbound/outbound message log with auto-refresh
- **Sidebar**: Channels nav item already present with `Webhook` icon.
- **API client** (`web/lib/api.ts`): `api.connectors` namespace with all CRUD + events/messages/plugins endpoints.
- **Carry-over Plan 9**: `extractPersonaPostRun()` in `packages/core/src/memory/persona-extraction.ts` — fire-and-forget LLM persona signal extraction, keyword-gated, saves as `agent_self` scope memories.

**Files touched:** `packages/types/src/index.ts`, `packages/kit/src/index.ts`, `apps/studio/db/src/schema/connectors.ts` *(new)*, `apps/studio/db/src/queries/connector.ts` *(new)*, `apps/studio/server/src/connectors/registry.ts` *(new)*, `apps/studio/server/src/connectors/event-router.ts` *(new)*, `apps/studio/server/src/connectors/tools.ts` *(new)*, `apps/studio/server/src/routes/connectors.ts` *(new)*, `apps/studio/server/src/runtime/manager.ts`, `apps/studio/server/src/index.ts`, `apps/studio/server/package.json`, `plugins/jiku.connector.telegram/` *(new)*, `apps/studio/web/lib/api.ts`, `apps/studio/web/app/.../channels/**` *(6 new pages)*, `packages/core/src/memory/persona-extraction.ts` *(new)*

---

## 2026-04-05 — Plan 9 Persona System + Active Tools UI + Tool Groups

**Changed:** Implemented the complete Persona System (Plan 9) plus two enhancements: Active Tools debug UI and tool group metadata.

- **Persona System core**: `agent_self` scope added to MemoryScope. `PersonaSeed` interface. `formatPersonaSection()` in `@jiku/core` formats `## Who I Am` block. `buildSystemPrompt()` accepts `persona_section` injected before memory. `AgentRunner.run()` and `previewRun()` both load `agent_self` memories and build persona section.
- **`ensurePersonaSeeded()`** (`apps/studio/server/src/memory/persona.ts`): new file. Bootstraps `agent_self` memories from `persona_seed` config on first run. No-op if `persona_seeded_at` is set.
- **DB schema**: `agents` table gets `persona_seed jsonb` + `persona_seeded_at timestamptz` columns. (Migration pending: `bun run db:push`)
- **Built-in persona tools**: `persona_read` + `persona_update` (append/replace/remove) always registered on agents. Both carry `group: 'persona'` in meta. All existing memory tools carry `group: 'memory'`.
- **API routes** (`apps/studio/server/src/routes/persona.ts`): `GET /persona/memories`, `GET+PATCH /persona/seed`, `POST /persona/reset`.
- **Persona settings page** (`agents/[agent]/persona/page.tsx`): PersonaSeed form, initial memories list, live Current Persona panel (agent_self memories), Reset to Seed AlertDialog.
- **Bug fix**: `previewRun()` was missing `built_in_tools` merge — tools count was always 0. Fixed to match `run()` merge logic.
- **Active Tools UI**: `ToolRow` in `context-preview-sheet.tsx` fully rewritten — expandable detail showing description, short tool ID (`memory_search` not `__builtin__:memory_search`), permission, parameters with type + required badges. `schemaToParams()` parses JSON schema properties.
- **Tool group metadata**: `ToolMeta.group?: string` added to `@jiku/types`. Runner mapper passes `group`. UI groups tools by `meta.group` (memory / persona / plugin) in `ActiveToolsList`.
- **Context preview sheet layout**: system prompt moved below usage bar (above tabs). Context tab groups segments by source with token total per group (`SegmentGroupList`). Category badge removed from tool row header.
- **ContextBar enhancement**: Tools button shows count. UsagePopover shows tool summary with built-in/plugin breakdown. `persona` added to SOURCE_LABELS/COLORS (violet).

**Files touched:** `packages/types/src/index.ts`, `packages/core/src/memory/builder.ts`, `packages/core/src/memory/index.ts`, `packages/core/src/resolver/prompt.ts`, `packages/core/src/runner.ts`, `packages/core/src/runtime.ts`, `apps/studio/db/src/schema/agents.ts`, `apps/studio/db/src/queries/memory.ts`, `apps/studio/server/src/memory/tools.ts`, `apps/studio/server/src/memory/persona.ts` *(new)*, `apps/studio/server/src/runtime/manager.ts`, `apps/studio/server/src/routes/persona.ts` *(new)*, `apps/studio/server/src/index.ts`, `apps/studio/web/lib/api.ts`, `apps/studio/web/app/.../agents/[agent]/layout.tsx`, `apps/studio/web/app/.../agents/[agent]/persona/page.tsx` *(new)*, `apps/studio/web/components/chat/context-bar.tsx`, `apps/studio/web/components/chat/context-preview-sheet.tsx`

---

## 2026-04-05 — Memory Preview Sheet + Post-test Bug Fixes + Backlog Completion

**Changed:** Resolved all remaining items from memory system backlog and automated test findings.

- **`memory_user_write` tool** (`apps/studio/server/src/memory/tools.ts`): 9th built-in memory tool added. Policy-gated by `config.policy.write.cross_user`. Writes `scope: agent_caller, visibility: agent_shared` for a target `caller_id`.
- **Memory expiration cleanup** (`apps/studio/db/src/queries/memory.ts`, `apps/studio/server/src/index.ts`): Added `deleteExpiredMemories()` DB function (delete where `expires_at < now()`). Registered as cleanup job in server bootstrap — runs immediately at boot and every 24h via `setInterval`.
- **`MemoryPreviewSheet`** (`apps/studio/web/components/chat/memory-preview-sheet.tsx`): New component. Reads memory segment from `previewRun()` (no separate API route). Parses raw markdown memory section into scoped blocks. Shows token count, grouped collapsible sections per scope (Project-Global / Agent-Global / User-Scoped), tier + importance badges, raw content toggle.
- **`ContextBar` Memory button** (`apps/studio/web/components/chat/context-bar.tsx`): Added `onMemoryClick?: () => void` prop. When provided, renders `[Memory]` button between model info and `[Context]` button. Footer layout: `[model · provider] ··· [Memory] [Context]`.
- **Chat page wire-up** (`chats/[conv]/page.tsx`): `memorySheetOpen` state + `MemoryPreviewSheet` render. Passes `onMemoryClick` to `ContextBar`.
- **Dashboard live counts**: Studio page now shows live Projects + Agents via cascading `useQueries`. Company page shows live Agents. Project page shows live Chats count via `conversations.listProject()`.
- **Bug fixes from automated test**: `MemoryItem.source` union added `'agent'`; `MemoryItem.project_id` field rename (was `runtime_id`); `staleTime: 0` on memory browser; `touchMemories` `.catch()` now logs warning instead of silently swallowing.
- **Implementation report updated** (`docs/plans/impl-reports/8-memory-system-implement-report.md`): Status 90% → 98%. All completed items marked done. Errors table extended with 4 new bug fixes.

**Files touched:** `apps/studio/server/src/memory/tools.ts`, `apps/studio/db/src/queries/memory.ts`, `apps/studio/server/src/index.ts`, `apps/studio/web/components/chat/memory-preview-sheet.tsx`, `apps/studio/web/components/chat/context-bar.tsx`, `apps/studio/web/app/(app)/studio/.../chats/[conv]/page.tsx`, `apps/studio/web/app/(app)/studio/page.tsx`, `apps/studio/web/app/(app)/studio/companies/[company]/page.tsx`, `apps/studio/web/app/(app)/studio/companies/[company]/projects/[project]/page.tsx`, `apps/studio/web/lib/api.ts`, `apps/studio/web/components/memory/memory-browser.tsx`, `docs/plans/impl-reports/8-memory-system-implement-report.md`

---

## 2026-04-05 — Memory System (Plan 8): Full Implementation

**Changed:** Implemented the complete memory system across all layers.

- **Core types** (`packages/types/src/index.ts`): Added `MemoryScope`, `MemoryTier`, `MemoryImportance`, `MemoryVisibility`, `AgentMemory`, `MemoryContext`, `ResolvedMemoryConfig`, `ProjectMemoryConfig`, `AgentMemoryConfig`. Extended `JikuStorageAdapter` with 5 optional memory methods (`agent_id` now optional in `getMemories`). Updated `ContextSegment.source` to include `'memory'`.
- **Core memory logic** (`packages/core/src/memory/`): `config.ts` — `DEFAULT_PROJECT_MEMORY_CONFIG` + `resolveMemoryConfig()` 2-level merge. `relevance.ts` — `tokenize()` with EN+ID stopwords, `scoreMemory()` (keyword+recency+access+importance), `findRelevantMemories()`. `builder.ts` — `buildMemoryContext()` + `formatMemorySection()`. `extraction.ts` — `extractMemoriesPostRun()` Zod-based LLM extraction, fire-and-forget.
- **Runner integration** (`packages/core/src/runner.ts`): Memory loaded before prompt, injected into system prompt, `touchMemories()` called after, post-run extraction triggered. `previewRun()` now also loads memories and includes a `memory` segment with token estimate.
- **DB schema**: `agent_memories` table (16 columns). `agents.memory_config` + `projects.memory_config` jsonb columns.
- **DB queries** (`apps/studio/db/src/queries/memory.ts`): 9 functions — `getMemories` (agent_id now optional), `saveMemory`, `updateMemory`, `deleteMemory`, `touchMemories`, `listProjectMemories`, `getMemoryById`, `updateProjectMemoryConfig`, `updateAgentMemoryConfig`.
- **Storage adapter** (`apps/studio/server/src/runtime/storage.ts`): All 5 memory methods implemented.
- **Memory tools** (`apps/studio/server/src/memory/tools.ts`): 8 built-in tools — core CRUD (append/replace/remove), extended insert, search, runtime read/write (policy-gated), user lookup (policy-gated).
- **Runtime manager** (`apps/studio/server/src/runtime/manager.ts`): `wakeUp()` loads project memory config, resolves per-agent config, builds and injects memory tools as `built_in_tools`.
- **API routes** (`apps/studio/server/src/routes/memory.ts`): 7 routes — memories list/delete, project config get/patch, agent config get/patch/resolved.
- **Web API** (`apps/studio/web/lib/api.ts`): `api.memory.list/delete`, `api.memoryConfig.getProject/updateProject/getAgent/updateAgent/getAgentResolved`. Added `'memory'` to `ContextSegment.source` union.
- **Web components**: `MemoryBrowser` (scope/tier filters, cards with badges, delete with confirm). `MemoryConfig` (Default Policy, Relevance Scoring, Core Memory, Extraction sections with sliders/switches).
- **Web pages**: `/memory` — tabs: Memories + Config (project-level). `/agents/[agent]/memory` — per-agent override with InheritToggle pattern (inherit/on/off), effective config panel.
- **Sidebar navigation**: Memory item (Brain icon) between Chats and Plugins. Plugins moved above Settings. Memory tab removed from settings layout.
- **Context preview**: Memory segment (teal color) now appears in context bar popover and context preview sheet when memories are loaded.
- **Bug fix**: `getMemories()` — `agent_id` was incorrectly required, causing `WHERE agent_id = ''` on `runtime_global` queries. Made optional, only added to WHERE when present.

**Files touched:** `packages/types/src/index.ts`, `packages/core/src/memory/*`, `packages/core/src/runner.ts`, `packages/core/src/resolver/prompt.ts`, `apps/studio/db/src/schema/memories.ts`, `apps/studio/db/src/schema/agents.ts`, `apps/studio/db/src/schema/projects.ts`, `apps/studio/db/src/queries/memory.ts`, `apps/studio/server/src/runtime/storage.ts`, `apps/studio/server/src/memory/tools.ts`, `apps/studio/server/src/runtime/manager.ts`, `apps/studio/server/src/routes/memory.ts`, `apps/studio/server/src/index.ts`, `apps/studio/web/lib/api.ts`, `apps/studio/web/components/memory/memory-browser.tsx`, `apps/studio/web/components/memory/memory-config.tsx`, `apps/studio/web/app/(app)/studio/.../memory/page.tsx`, `apps/studio/web/app/(app)/studio/.../agents/[agent]/memory/page.tsx`, `apps/studio/web/app/(app)/studio/.../agents/[agent]/layout.tsx`, `apps/studio/web/app/(app)/studio/.../settings/layout.tsx`, `apps/studio/web/components/sidebar/project-sidebar.tsx`, `apps/studio/web/components/chat/context-bar.tsx`, `apps/studio/web/components/chat/context-preview-sheet.tsx`

---

## 2026-04-05 — Chat UX Polish: Conversation list, Context bar, SSE observer, Sidebar footer

- **Conversation list panel** (`components/chat/conversation-list-panel.tsx`): Full rewrite. Replaced Radix `ScrollArea` with plain `overflow-y-auto` div (ScrollArea injected `min-width:100%; display:table` which broke `text-overflow: ellipsis`). Added date-based grouping (Today/Yesterday/This week/This month/Last 3 months/Older) as accordion sections — Today auto-expanded, rest collapsed. Load-more pagination (PAGE_SIZE=10). Proper ellipsis truncation on last message preview.
- **Context bar** (`components/chat/context-bar.tsx`): Added `isStreaming` prop to trigger preview refresh after each chat turn. Left side shows model_id + provider; right side shows token count. Popover shows model info, usage bar, segment breakdown, compaction count.
- **Context preview sheet** (`components/chat/context-preview-sheet.tsx`): Model info card moved above context usage bar; shows provider + model rows.
- **Stream registry** (`apps/studio/server/src/runtime/stream-registry.ts`): New file — in-memory Map tracking active runs per conversation. Concurrent lock (409 if already running). SSE broadcast to observer clients via `stream.tee()`.
- **Chat routes** (`apps/studio/server/src/routes/chat.ts`): `POST /conversations/:id/chat` returns 409 if already running; tees stream (one branch to caller, one to SSE broadcast). New `GET /conversations/:id/stream` SSE observer endpoint. New `GET /conversations/:id/status` returns `{ running: boolean }`.
- **Observer hook** (`apps/studio/web/hooks/use-conversation-observer.ts`): New file — EventSource to SSE stream, token passed as `?token=` query param. On `done` event, fetches fresh messages.
- **API types** (`apps/studio/web/lib/api.ts`): Added `compaction_count: number` and `model_info?` to `PreviewRunResult`. Added `api.conversations.status()`.
- **Project sidebar** (`components/sidebar/project-sidebar.tsx`): Settings moved into same menu group as Dashboard/Agents/Chats (no separator). User info dropdown added to `SidebarFooter`.
- **Company sidebar** (`components/sidebar/company-sidebar.tsx`): Same pattern — Settings in same menu group, user info in `SidebarFooter`.
- Files: `apps/studio/server/src/runtime/stream-registry.ts`, `apps/studio/server/src/routes/chat.ts`, `apps/studio/web/hooks/use-conversation-observer.ts`, `apps/studio/web/components/chat/conversation-list-panel.tsx`, `apps/studio/web/components/chat/context-bar.tsx`, `apps/studio/web/components/chat/context-preview-sheet.tsx`, `apps/studio/web/lib/api.ts`, `apps/studio/web/components/sidebar/project-sidebar.tsx`, `apps/studio/web/components/sidebar/company-sidebar.tsx`

## 2026-04-05 — Chat History: content → parts migration + AI SDK v6 fixes

- **DB schema**: Renamed `messages.content` jsonb column → `messages.parts` to align with AI SDK v6 `UIMessage.parts` format. Requires `bun run db:push` (interactive TTY).
- **@jiku/types**: Added `MessagePart` type aligned with AI SDK UIMessage parts shape. `Message.content: MessageContent[]` → `Message.parts: MessagePart[]`. `MessageContent` kept as deprecated alias.
- **StudioStorageAdapter**: Updated `toJikuMessage()` and `addMessage()` to read/write `parts` field.
- **@jiku/core runner.ts**: History loading now reads `m.parts` instead of `m.content`.
- **DB queries**: `extractLastMessageText` reads `msg.parts`.
- **lib/api.ts**: `messages` endpoint response type updated to `parts: { type: string; [key: string]: unknown }[]`.
- **Chat history fix — 3 bugs resolved**: (1) `!historyData` guard added — TanStack Query initial state is undefined even when loading=false; (2) `messages: initialMessages` in `useChat` (AI SDK v6 renamed from `initialMessages`); (3) `key={convId}` on `<ChatView>` forces remount on conversation change.
- Files: `apps/studio/db/src/schema/conversations.ts`, `packages/types/src/index.ts`, `apps/studio/server/src/runtime/storage.ts`, `packages/core/src/runner.ts`, `packages/core/src/storage/memory.ts`, `apps/studio/db/src/queries/conversation.ts`, `apps/studio/web/lib/api.ts`, `apps/studio/web/app/(app)/studio/.../chats/[conv]/page.tsx`

## 2026-04-05 — Plan 5 Polish: Empty states + Toast + shadcn Empty component

- **Empty states**: All pages migrated from manual `div`+icon+text to `shadcn Empty` (`Empty`/`EmptyMedia`/`EmptyTitle`/`EmptyDescription`/`EmptyContent`). Pages: companies/page, company/projects/page, project/agents/page, project/chats/page, conv/page, conversation-list-panel.
- **Toast coverage**: `toast.success/error` added to all mutation paths. `Toaster` wired in `providers.tsx`. `conversation-list-panel.tsx` added toast import.
- **CLAUDE.md**: Added "Environment Files" rule — never read `.env` files, use `.env.example` only.
- Files: `apps/studio/web/app/(app)/studio/companies/page.tsx`, `apps/studio/web/app/(app)/studio/companies/[company]/projects/page.tsx`, `apps/studio/web/app/(app)/studio/.../agents/page.tsx`, `apps/studio/web/app/(app)/studio/.../chats/page.tsx`, `apps/studio/web/components/chat/conversation-list-panel.tsx`, `CLAUDE.md`

## 2026-04-05 — Studio UI/UX Overhaul (Plan 5) — Server Endpoints

- **DB queries**: Added `getConversationsByProject(projectId, userId)` — returns conversations filtered by project with agent info + last_message text (extracted from jsonb content). Added `getConversationWithAgent(convId)` — conversation with agent info.
- **Server routes**: Added `GET /api/projects/:pid/conversations` and `GET /api/conversations/:id` to `conversations.ts` router.
- Files: `apps/studio/db/src/queries/conversation.ts`, `apps/studio/server/src/routes/conversations.ts`

## 2026-04-05 — Studio UI/UX Overhaul (Plan 5) — Phase 4 Polish

- **Error boundaries**: Added Next.js `error.tsx` files for `[company]`, `[project]`, and `[agent]` route segments. Added reusable `ErrorBoundary` React class component in `components/error-boundary.tsx`.
- **AgentCard**: Redesigned with Avatar (initials), description, Chat button (→ `/chats?agent=slug`), Overview button.
- **Empty states**: Project page shows FolderKanban icon + "No projects yet" with CreateProjectDialog. Agent list page shows Bot icon + "No agents yet" with CreateAgentDialog. Both have proper Card skeleton loaders.
- **Cleanup**: Deleted unused `lib/store/sidebar.store.ts`.
- Files: `apps/studio/web/app/(app)/[company]/error.tsx`, `apps/studio/web/app/(app)/[company]/[project]/error.tsx`, `apps/studio/web/app/(app)/[company]/[project]/agents/[agent]/error.tsx`, `apps/studio/web/components/error-boundary.tsx`, `apps/studio/web/components/agent/agent-card.tsx`, `apps/studio/web/app/(app)/[company]/page.tsx`, `apps/studio/web/app/(app)/[company]/[project]/page.tsx`

## 2026-04-05 — Studio UI/UX Overhaul (Plan 5) — Phase 2 + 3

- **3-Level Sidebar**: `RootSidebar`, `CompanySidebar`, `ProjectSidebar` using shadcn Sidebar components. Each layout level (`home/layout`, `[company]/layout`, `[project]/layout`) has its own `SidebarProvider` shell.
- **AppHeader + Breadcrumb**: `AppHeader` with `SidebarTrigger`. `AppBreadcrumb` resolves company/project/agent names from TanStack Query cache.
- **Agent Tabs**: `[agent]/layout.tsx` with URL-based tabs (Overview, Settings, Permissions). Settings has sub-tabs (General, Model & Provider). Agent overview page replaced chat with summary view.
- **Chat System**: `[project]/chats/layout.tsx` with `ResizablePanelGroup` split (orientation=horizontal). `ConversationListPanel` with search + active highlight. New chat page with agent selector (Popover+Command). Active conversation page using ai-elements: `Conversation`/`ConversationContent`, `Message`/`MessageResponse`, `PromptInput`/`PromptInputSubmit`.
- **Settings Tabs**: Company settings (`general`, `credentials`) and project settings (`general`, `credentials`, `permissions`) with URL-based tab layouts and redirect pages.
- **packages/ui exports**: Fixed shadcn export conflicts — renamed legacy `Sidebar*` and `Header`/`Breadcrumb` exports.
- **lib/api.ts**: Added `conversations.listProject(projectId)` and `conversations.get(convId)`. Added `ConversationItemWithAgent` type.
- Files: `apps/studio/web/app/(app)/[company]/[project]/chats/**`, `apps/studio/web/components/chat/conversation-list-panel.tsx`, `apps/studio/web/app/(app)/[company]/settings/**`, `apps/studio/web/app/(app)/[company]/[project]/settings/**`, `apps/studio/web/lib/api.ts`, `packages/ui/src/index.ts`

## 2026-04-05 — JikuRuntime Integration + Plugin KV Store + StudioStorageAdapter

- **Runtime Manager**: Rewrote `JikuRuntimeManager` — one `JikuRuntime` per project (project = runtime). Dynamic provider pattern: single `__studio__` provider registered at boot; `getModel()` reads from per-request `modelCache` Map. Decrypted keys never live in long-lived memory.
- **Chat route**: New `POST /api/conversations/:id/chat` in `routes/chat.ts` calls `runtimeManager.run()` → `JikuRuntime.run()` → `AgentRunner` → `streamText()`. All policy enforcement, tool filtering, and plugin system active through runtime.
- **StudioStorageAdapter**: Full `JikuStorageAdapter` implementation backed by PostgreSQL via `@jiku-studio/db`. `toJikuMessage()` handles both legacy plain-string content and new `MessageContent[]` jsonb arrays.
- **Plugin KV Store**: New `plugin_kv` DB table (`project_id`, `scope`, `key`, `value` jsonb, unique on `(project_id, scope, key)`). `pluginKvGet/Set/Delete/Keys` queries with `onConflictDoUpdate` upsert. `StudioStorageAdapter.pluginGet/Set/Delete/Keys` now persist to DB instead of in-memory.
- **DB queries**: Added `updateConversation`, `listConversationsByAgent`, `deleteMessagesByIds` to conversation queries.
- Files: `apps/studio/server/src/runtime/manager.ts`, `apps/studio/server/src/runtime/storage.ts`, `apps/studio/server/src/routes/chat.ts`, `apps/studio/db/src/schema/plugin_kv.ts`, `apps/studio/db/src/queries/plugin_kv.ts`, `apps/studio/db/src/queries/conversation.ts`, `apps/studio/db/src/index.ts`, `apps/studio/db/src/migrations/0001_lumpy_ezekiel.sql`

## 2026-04-05 — Chat Migration: WebSocket → Vercel AI SDK HTTP Streaming

- **Server**: Installed `ai`, `@ai-sdk/openai`, `@ai-sdk/anthropic`, `@openrouter/ai-sdk-provider` in `@jiku-studio/server`. Removed `ws` and `@anthropic-ai/sdk` from dependencies.
- **Server**: Added `buildProvider()` to `credentials/service.ts` — creates a Vercel AI SDK `LanguageModel` from resolved credential info (supports openai, anthropic, openrouter, ollama via OpenAI-compat).
- **Server**: New route `POST /api/conversations/:id/chat` in `routes/chat.ts` — uses `streamText()` + `toUIMessageStreamResponse()`, calls `resolveAgentModel()` + `buildProvider()`, persists messages to DB.
- **Server**: Removed `ws/chat.ts` and `ws/server.ts`. `index.ts` no longer attaches WebSocket server.
- **Web**: Installed `@ai-sdk/react`. Rewrote `components/agent/chat/chat-interface.tsx` to use `useChat` from `@ai-sdk/react` with `DefaultChatTransport` pointing to new HTTP endpoint. Custom auth headers + extra body fields (agent_id, project_id, company_id) via `prepareSendMessagesRequest`.
- **Web**: `lib/ws.ts` simplified to re-export `useChat` from `@ai-sdk/react` (backward-compat shim).
- Files: `apps/studio/server/src/credentials/service.ts`, `apps/studio/server/src/routes/chat.ts`, `apps/studio/server/src/index.ts`, `apps/studio/server/package.json`, `apps/studio/web/components/agent/chat/chat-interface.tsx`, `apps/studio/web/lib/ws.ts`, `apps/studio/web/package.json`

## 2026-04-05 — Credentials System (Plan 4)

- **DB**: New `credentials` table (AES-256-GCM encrypted fields, scope company/project, adapter_id, group_id, metadata JSONB). New `agent_credentials` join table (one-to-one agent→credential with model_id + metadata_override). Revised `agents` schema: removed `provider_id`/`model_id`, added `slug` with unique constraint per project. Updated `relations.ts` with credentials relations.
- **DB queries**: `getCompanyCredentials`, `getProjectCredentials`, `getAvailableCredentials` (union), `createCredential`, `updateCredential`, `deleteCredential`, `getAgentCredential`, `assignAgentCredential`, `updateAgentCredential`, `unassignAgentCredential`. Added `getAgentBySlug` to agent queries.
- **Server**: `credentials/encryption.ts` — AES-256-GCM encrypt/decrypt/mask. `credentials/adapters.ts` — registry with 5 built-in adapters (openai, anthropic, openrouter, ollama, telegram). `credentials/service.ts` — `formatCredential`, `testCredential` (live HTTP test), `resolveAgentModel`. `utils/slug.ts` — `generateSlug`, `uniqueSlug`.
- **Server routes**: `GET /api/credentials/adapters`, company/project credential CRUD, `GET /api/projects/:id/credentials/available`, `POST /api/credentials/:id/test`, agent credential assign/update/delete. Updated agents/projects/companies routes to auto-generate slugs.
- **Runtime manager**: Removed `provider_id`/`model_id` from `RuntimeAgent`, added `slug`.
- **Web api.ts**: Added `credentials.*` endpoints, updated `Agent` type (removed model_id/provider_id, added slug), updated company/project create to omit required slug.
- **packages/ui**: New credentials components — `CredentialCard`, `CredentialList`, `CredentialForm`, `CredentialSelector`, `ModelSelector`, `MetadataOverrideForm`. Exported from `index.ts`.
- **Web pages**: `[company]/settings/page.tsx`, `[company]/settings/credentials/page.tsx`, `[company]/[project]/settings/page.tsx`, `[company]/[project]/settings/credentials/page.tsx`, `[company]/[project]/settings/permissions/page.tsx` (placeholder). Settings button in company + project list pages.
- **Agent settings**: Revised settings page — added "Model & Provider" tab with `CredentialSelector` + `ModelSelector` + `MetadataOverrideForm`. Removed legacy model_id field from `AgentConfigForm`.
- **env**: Added `CREDENTIALS_ENCRYPTION_KEY` to `env.ts`.
- Files: `apps/studio/db/src/schema/credentials.ts`, `apps/studio/db/src/schema/agents.ts`, `apps/studio/db/src/schema/relations.ts`, `apps/studio/db/src/schema/index.ts`, `apps/studio/db/src/queries/credentials.ts`, `apps/studio/db/src/queries/agent.ts`, `apps/studio/db/src/index.ts`, `apps/studio/server/src/credentials/*`, `apps/studio/server/src/utils/slug.ts`, `apps/studio/server/src/routes/credentials.ts`, `apps/studio/server/src/routes/agents.ts`, `apps/studio/server/src/routes/projects.ts`, `apps/studio/server/src/routes/companies.ts`, `apps/studio/server/src/runtime/manager.ts`, `apps/studio/server/src/env.ts`, `apps/studio/server/src/index.ts`, `apps/studio/web/lib/api.ts`, `apps/studio/web/components/agent/agent-config-form.tsx`, `apps/studio/web/app/(app)/[company]/page.tsx`, `apps/studio/web/app/(app)/[company]/[project]/page.tsx`, `apps/studio/web/app/(app)/[company]/settings/**`, `apps/studio/web/app/(app)/[company]/[project]/settings/**`, `packages/ui/src/components/credentials/*`, `packages/ui/src/index.ts`

## 2026-04-04 — @jiku/ui: shadcn + ai-elements migration (Plan 4)

**Changed:** Copied all shadcn UI primitives (55 files) and AI-specific elements (48 files) from `apps/studio/web/components/` into `packages/ui/src/components/` so they can be shared via `@jiku/ui`. Fixed all `@/` alias imports to relative paths. Also copied `use-mobile` hook to `packages/ui/src/hooks/`. Updated `packages/ui/src/index.ts` to barrel-export all new components alongside existing layout/data/agent exports.
**Files touched:** `packages/ui/src/components/ui/*.tsx` (55 files), `packages/ui/src/components/ai-elements/*.tsx` (48 files), `packages/ui/src/hooks/use-mobile.ts`, `packages/ui/src/index.ts`

## 2026-04-04 — Policy System Revision (Plan 3.5)

- `@jiku/types`: Added `PolicyCondition`, `SubjectMatcher`, open-string `PolicyRule` (no more enums), `CallerContext.attributes`, `JikuRuntimeOptions.subject_matcher`
- `@jiku/core`: Rewrote `checkAccess()` + `evaluateConditions()` with `defaultSubjectMatcher` (role/permission/user/*/attributes); updated `resolveScope()` + `JikuRuntime` to propagate `subject_matcher`; exported `defaultSubjectMatcher`, `evaluateConditions`
- `@jiku-studio/db`: Rewrote `schema/policies.ts` — `policies` table (reusable entity), `policy_rules.policy_id` FK (was `agent_id`), new `agent_policies` join table; updated `relations.ts`; rewrote `queries/policy.ts` with `getPolicies`, `createPolicy`, `getAgentPolicies`, `attachPolicy`, `detachPolicy`, `loadProjectPolicyRules`; added `getAllProjects`, `deleteProject` to project queries; added `@jiku/types` as dependency
- `@jiku-studio/server`: Rewrote `JikuRuntimeManager` with `wakeUp/sleep/syncRules/syncAgent` pattern; `resolveCaller` now returns `attributes: { company_id }`; rewrote `routes/policies.ts` for company-level policy CRUD + attach/detach; `routes/projects.ts` triggers `wakeUp`/`sleep`; `routes/agents.ts` uses `syncAgent`; `ws/chat.ts` no longer queries policy rules per-request; `index.ts` boots all project runtimes on startup
- `apps/studio/web`: Updated `lib/api.ts` with Policy, PolicyCondition, AgentPolicyItem types and attach/detach APIs; rewrote permissions page to policy-entity model (attach existing / create+attach / detach, expandable rule view); `PolicyRulesTable` now takes `policyId`
- Files: `packages/types/src/index.ts`, `packages/core/src/resolver/access.ts`, `packages/core/src/resolver/scope.ts`, `packages/core/src/runtime.ts`, `packages/core/src/runner.ts`, `packages/core/src/index.ts`, `apps/studio/db/src/schema/policies.ts`, `apps/studio/db/src/schema/relations.ts`, `apps/studio/db/src/queries/policy.ts`, `apps/studio/db/src/queries/project.ts`, `apps/studio/db/package.json`, `apps/studio/server/src/runtime/manager.ts`, `apps/studio/server/src/runtime/caller.ts`, `apps/studio/server/src/routes/policies.ts`, `apps/studio/server/src/routes/projects.ts`, `apps/studio/server/src/routes/agents.ts`, `apps/studio/server/src/ws/chat.ts`, `apps/studio/server/src/index.ts`, `apps/studio/web/lib/api.ts`, `apps/studio/web/app/.../permissions/page.tsx`, `apps/studio/web/components/permissions/policy-rules-table.tsx`

## 2026-04-04 — Studio Base (Plan 3)

- Created `@jiku-studio/db` — Drizzle ORM schema (11 tables: users, companies, roles, permissions, role_permissions, company_members, projects, agents, policy_rules, agent_user_policies, conversations, messages), typed query helpers, Drizzle relations, client factory, seed (system permissions + per-company roles)
- Created `@jiku-studio/server` — Hono HTTP + Bun WebSocket server; JWT auth (jose); REST routes for auth/companies/projects/agents/policies/conversations; `JikuRuntimeManager` (in-memory runtime per project); `StudioStorageAdapter`; `resolveCaller()` (actual permissions + self-restriction intersection); streaming chat via Anthropic SDK
- Created `@jiku/ui` — shared React component library: layout (Sidebar, Header, PageHeader, EmptyState), data (DataTable, StatCard, PermissionBadge), agent (ChatBubble, ChatInput, ThinkingIndicator, ToolCallView)
- Created `apps/studio/web` pages: auth (login/register), app layout with sidebar, company selector, company→projects, project→agents, agent chat (WebSocket streaming), agent settings, agent permissions (policy rules table + user policy list + self-restriction modal)
- Added `apps/studio/*` to workspace entries in root `package.json`
- All packages type-check clean (`tsc --noEmit`)
- Files: `apps/studio/db/**`, `apps/studio/server/**`, `packages/ui/**`, `apps/studio/web/app/**`, `apps/studio/web/components/**`, `apps/studio/web/lib/**`

## 2026-04-04 — Plugin System V2

- `PluginDefinition` sekarang generic `<TContributes>` — plugin bisa `contributes` context ke dependents
- `Contributes<T>` = `() => T | Promise<T>` — always a factory, sync or async
- `depends: PluginDependency[]` replace `dependencies: string[]` — support string (sort only) dan instance (typed ctx)
- `MergeContributes<Deps>` extracts contributed types dari instance deps via phantom brand field `_contributes_type`
- `definePlugin<Deps, TContributes>()` — overloaded: with `depends` → typed ctx, without → `BasePluginContext`
- `PluginCircularDepError` — DFS 3-color detection, throws before boot with clear cycle path
- Missing dep detection — warning + plugin disabled, no throw
- `PluginLoader.override()` — partial override for bridge pattern
- `PluginLoader.isLoaded()` + `getLoadOrder()` — introspection
- Boot V2: circular check → missing warn → topo sort → resolve contributes → merge ctx → setup
- Playground split: `plugins.ts` (all plugin defs), `checks.ts` (edge case tests), `index.ts` (runtime + chat)
- Files: `packages/types/src/index.ts`, `packages/kit/src/index.ts`, `packages/core/src/plugins/dependency.ts`, `packages/core/src/plugins/loader.ts`, `packages/core/src/index.ts`, `plugins/jiku.social/src/index.ts`, `apps/playground/index.ts`, `apps/playground/plugins.ts`, `apps/playground/checks.ts`

## 2026-04-04 — Stream Architecture, AbortController, Model Providers

- Tambah `createUIMessageStream` pattern dari AI SDK (inspired by SenkenNeo) ke `AgentRunner`
- `runtime.run()` sekarang return `JikuRunResult { run_id, conversation_id, stream }` — caller consume stream
- Tambah `AbortController` support via `JikuRunParams.abort_signal` → di-pass langsung ke `streamText()`
- Buat `ModelProviders` class di `packages/core/src/providers.ts` — multi-provider, lazy init
- Tambah `createProviderDef()` helper untuk wrap `@ai-sdk/*` providers
- `AgentDefinition` + `JikuRunParams` sekarang support `provider_id` + `model_id` override per-agent/run
- `JikuStreamWriter` + `ToolContext.writer` — tools bisa push custom typed data chunks ke stream
- Tambah `JikuDataTypes` (jiku-meta, jiku-usage, jiku-step-usage, jiku-tool-data) ke `@jiku/types`
- Tambah `isJikuDataChunk<K>()` type guard untuk narrowing stream chunks tanpa `any`
- `tsconfig.json` sekarang punya `include` eksplisit — tidak scan `../refs-senken-neo` lagi
- Files: `packages/types/src/index.ts`, `packages/core/src/types.ts`, `packages/core/src/runner.ts`, `packages/core/src/runtime.ts`, `packages/core/src/providers.ts`, `packages/core/src/index.ts`, `apps/playground/index.ts`, `tsconfig.json`


## 2026-04-04 — Foundation Implementation

- Implemented `@jiku/types` — all core interfaces: ToolDefinition, PluginDefinition, AgentDefinition, CallerContext, RuntimeContext, PolicyRule, JikuStorageAdapter, PluginLoaderInterface
- Implemented `@jiku/kit` — definePlugin, defineTool, defineAgent, getJikuContext factory functions
- Implemented `@jiku/core`:
  - `PluginLoader` — 3-phase boot with topological sort
  - `SharedRegistry` — tool/prompt/provider storage
  - `AgentRunner` — LLM loop with streamText, tool filtering by mode
  - `JikuRuntime` — container with updateRules() hot-swap
  - `resolveScope()` + `checkAccess()` — pure permission resolver
  - `buildSystemPrompt()` — mode-aware prompt builder
  - `MemoryStorageAdapter` — in-memory storage for testing
- Created `plugins/jiku.social` — built-in social media plugin with list_posts, create_post, delete_post tools
- Created `apps/playground` — step-by-step demo: admin vs member access, chat vs task mode, updateRules live
- Updated `docs/product_spec.md` and `docs/architecture.md`
- Added `@types/node`, `@ai-sdk/anthropic@3`, `ai@6`, `zod@4`, `hookable` dependencies
- Added `plugins/*` to workspace
- Files: `packages/types/src/index.ts`, `packages/kit/src/index.ts`, `packages/core/src/index.ts`, `packages/core/src/runtime.ts`, `packages/core/src/runner.ts`, `packages/core/src/resolver/scope.ts`, `packages/core/src/resolver/access.ts`, `packages/core/src/resolver/prompt.ts`, `packages/core/src/plugins/loader.ts`, `packages/core/src/plugins/registry.ts`, `packages/core/src/plugins/dependency.ts`, `packages/core/src/plugins/hooks.ts`, `packages/core/src/storage/memory.ts`, `plugins/jiku.social/src/index.ts`, `apps/playground/index.ts`

## 2026-04-04 — Bootstrap: Automated Docs Setup

- Created `CLAUDE.md` with full automated docs protocol
- Created `.claude/commands/docs-update.md` for `/docs-update` command
- Created stub files: `docs/product_spec.md`, `docs/architecture.md`
- Created builder docs: `current.md`, `tasks.md`, `changelog.md`, `decisions.md`, `memory.md`
- Created `docs/feats/` directory
- Files: `CLAUDE.md`, `.claude/commands/docs-update.md`, `docs/product_spec.md`, `docs/architecture.md`, `docs/builder/current.md`, `docs/builder/tasks.md`, `docs/builder/changelog.md`, `docs/builder/decisions.md`, `docs/builder/memory.md`
