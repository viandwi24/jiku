# Decisions

## ADR-094 — Chat-run cancels are owner-only; `runs:cancel` only covers task/heartbeat

**Context:** The cancel endpoint (`POST /conversations/:id/cancel`) was gated by `runs:read`, which meant any project member who could view the Runs page could cancel anyone else's running conversation — including a colleague's personal chat with an agent. That's an abuse vector (malice or mistake) with no legitimate team use case: chat streams are one-to-one, the initiator is the only rightful owner. Task/heartbeat runs are different — they're autonomous, often cron-triggered with `caller_id=null`, and ops genuinely needs a way to stop runaway ones without requiring superadmin.

**Decision:** Split cancel authorization by `conversation.type`:
- `type='chat'` → `conv.caller_id === userId` OR `isSuperadmin`. Holding `runs:cancel` is NOT sufficient — no team permission can stop another user's personal chat.
- `type='task'` / `'heartbeat'` → owner OR superadmin OR `runs:cancel` permission.

New permission `RUNS_CANCEL` added to enum, role-editor UI, role presets (Manager/Admin/Owner get it; Member/Viewer don't). Migration `0034_runs_cancel_permission.sql` backfills existing preset roles.

**Consequences:** Members can always cancel their own chat (normal UX). Teammates cannot stop a chat they're observing. Ops gets a dedicated perm for task management. Owner-only rule is enforced even against `runs:cancel` to keep the semantics predictable ("chat cancel is never a team action"). UI surfaces the distinction in the role editor description so admins don't expect `runs:cancel` to unlock chat cancel.

## ADR-095 — Cancel signals the runtime via AbortController, not just a DB flip

**Context:** The prior cancel implementation just wrote `run_status='cancelled' + finished_at=now()` to the DB. The actual LLM stream continued executing to completion — the chat route's finally-block subsequently overwrote the row with the real end status, or (worse) the user saw a "cancelled" status in Runs while messages kept streaming in. DB-only cancel is a lie.

**Decision:** `streamRegistry.startRun()` returns an `AbortSignal` + `isAborted()` sourced from a per-run `AbortController`. New method `streamRegistry.abort(conversationId)` fires the controller + broadcasts an SSE `aborted` event. The chat route listens on the signal and calls `reader.cancel()` to unwind the underlying `ReadableStream`; the reader's finally block then writes `run_status='cancelled'` to DB (defense in depth against the endpoint's own earlier flip being overwritten). Cancel endpoint order: DB flip first (prevents race with finally block), then `abort()`.

Task/heartbeat runners don't currently register with `streamRegistry` — out of scope for this iteration. For now they still rely on DB-label + runner's next poll iteration observing it. Inline comment in `runs.ts` notes the gap.

**Consequences:** Chat cancel now stops the stream for real — no "ghost" messages after hitting Stop. Task cancel semantics remain best-effort until those runners are integrated too; a full fix requires adding task registration to `streamRegistry` and teaching `task/runner.ts` to listen on the abort signal. Until then, docs + UI should not claim task cancel is instant. The `ReadableStream.cancel()` chain may reject in-flight LLM requests mid-chunk; observed this is handled by the SDK's error propagation and does not crash the process.

## ADR-093 — Console is a plugin-wide ephemeral log feature, not a persistent audit trail

**Context:** Plugins (starting with Telegram bot + userbot) need an operator-visible log of what the instance is actually doing — inbound traffic, outbound sends, activation lifecycle, flood/retry events. `connector_events` table already exists for auditable per-event records; it's the wrong shape for free-form diagnostic lines and would bloat fast. `console.log` on the server is invisible to users. Needed: a lightweight, in-process log stream that can be read live from the Studio UI, without persistence requirements beyond the current server session.

**Decision:** Add a `ConsoleRegistry` keyed by free-form `consoleId` string (convention `<plugin_id>:connector:<uuid>`). Storage model: 100–200 entry ring in memory (newest), batched flush of 100 oldest to NDJSON tempfile at `os.tmpdir()/jiku-console/` when ring hits 200. On server boot, that directory is wiped — logs are session-scoped only. UI: `<ConsolePanel>` loads snapshot (memory) instantly, subscribes to SSE, reverse-paginates against `/history?before_ts=` when scrolled past memory window. File rotates at 10MB per console (one `.log.1` backup). Plugins emit via `ctx.console.get(id).info/warn/error/debug`; adapters that need console wiring expose an `attachConsole(api)` method that plugin setup() calls before registering with the connector registry.

**Consequences:** Zero DB cost; observability latency is in-memory speed. Accepted loss: if server crashes, up to 200 unflushed entries per console are lost — acceptable for live diagnostics, and we have `connector_events` for auditable trails. Reusable across any plugin (not Telegram-specific). Scale caveat: each console's memory footprint is ~200 entries × ~300 bytes = ~60KB; at 100 active consoles that's 6MB — fine for the expected Studio deployment size.

## ADR-090 — Telegram connector actions limited to message + media management

**Context:** Audit before production found bot-adapter `runAction` exposed group/channel administration tools (`ban_member`, `set_chat_description`, `create_invite_link`, `get_chat_members`) plus destructive message ops (`delete_message`, `pin_message`, `unpin_message`, `send_reaction`). Userbot exposed the same destructive ops plus `join_chat`/`leave_chat` which trigger Telegram spam flags when bursted. A prompt-injected agent with access to these actions could silently ban users, rewrite channel descriptions, or mass-unpin — high blast radius, low observability. The scope of Jiku's Telegram usage is conversational message automation, not group administration.

**Decision:** Restrict both adapters to message + media management only. Keep: send text (via sendMessage), send_photo, send_file, send_media_group, send_url_media, send_to_scope, forward_message, copy_message, edit_message (own messages only), get_chat_info (read-only), fetch_media. Userbot additionally keeps read-only helpers (get_chat_history, get_dialogs, search_messages, get_user_info) plus low-risk UX helpers (mark_read, set_typing). Delete, reaction, pin/unpin, ban, invite-link, description, admin listing, and join/leave are removed from the action registry entirely — not gated, not opt-in: not present.

**Consequences:** Agents cannot perform Telegram group administration through Jiku. If an operator needs those actions later, they should be reintroduced behind explicit per-action opt-in at the credential level and surfaced as high-risk in the UI — not as default capabilities. Reactions removed is a UX loss for some flows (engagement signals) but acceptable given the injection risk.

## ADR-091 — `runAction` threads `connectorId` through for multi-tenant routing

**Context:** Both Telegram adapters are singletons in the registry and hold per-credential state in a Map (`instances`, `userInstances`). The outbound send paths pass `target.connector_id` and resolve via `botFor()`/`clientFor()`, but `runAction(actionId, params)` had no connector context — it fell back to `this.bot`/`this.client` (last-activated). With two credentials active, tool calls could silently hit the wrong identity.

**Decision:** Extend `ConnectorAdapter.runAction` signature with optional `connectorId?: string`. `connectors/tools.ts` passes the tool's `connector_id` arg through. Both Telegram adapters resolve bot/client/queue via the per-connector Map before executing. Legacy adapters that ignore the argument retain existing behaviour.

**Consequences:** Tight multi-tenant correctness for all action branches without reshaping the adapter contract. Adapters that want full isolation now have a well-defined hook; adapters with single-credential scope can ignore it.

## ADR-092 — `runAction` enforces queue + retry on every API call

**Context:** Bot adapter's queue (`enqueueForChat`) and 429 retry (`withTelegramRetry`) wrapped only `sendMessageInner`. Every other `runAction` branch called `bot.api.*` directly — no per-chat spacing, no 429 backoff. A loop of agent-driven edits or reactions could flood Telegram and spiral 429s without honouring `retry_after`.

**Decision:** Every outbound Bot API call in `runAction` goes through `enqueueForChat(chatId, () => withTelegramRetry(fn, label))`. Scope-less reads (fetch_media's `getFile`) skip the chat queue but still run under `withTelegramRetry`. Userbot already routed all actions through `queue.enqueue`; the only gap there (`runAction` using scalar `this.queue`) is closed by ADR-091.

**Consequences:** Adding a new action requires wrapping it in the same helper — the pattern is explicit in the switch body. Modest per-call latency on bursts is acceptable given the flood-protection value.

## ADR-089 — Commands access-mode gate is uniform across all surfaces (supersedes §surface bypass in the Commands feature)

**Context:** While wiring the Commands system, I introduced a "chat surface bypasses the allow-list" shortcut — rationale was UX: "chat is user-triggered, user knows what they're doing, forcing an allow-list is friction." The Telegram connector surface was simultaneously deferred entirely (ADR-085). The result was asymmetric and confusing: `command_access_mode='manual'` with empty allow-list rejected Telegram calls (correct) but silently accepted chat calls (wrong — the config said manual). Config was a lie.

**Decision:** Remove the surface-specific bypass. `command_access_mode` is honored uniformly on every surface (chat, connector, cron, task, heartbeat). `manual` = allow-list only; `all` = any active project command. If a user wants free access in chat, they flip the agent to `all` — explicit and symmetric. Autocomplete UI mirrors the same gate: shows allow-list in manual mode, full project in all mode.

**Consequences:**
- Config contract is now honest: what's configured is what happens, everywhere.
- Asymmetric mental model gone — debugging "why does it work in chat but not Telegram" no longer exists.
- Small UX cost: users need one explicit step (set mode=all) to get "friction-free chat" behavior. That's the right trade — consistency > hidden shortcuts.
- Supersedes the "Eligibility: Lebih longgar (user tahu konteks)" line in scenario doc §6.1's Commands vs Skills table. The table was aspirational; practice showed uniformity is more valuable than per-surface tuning.

## ADR-088 — Connector inbound gets the command dispatcher (partially reverses ADR-085)

**Context:** ADR-085 (earlier same day) deferred wiring the Commands dispatcher into the connector inbound path because of a security concern: external Telegram members could type `/deploy-prod` if we naively dispatched. That decision assumed permission design was still unresolved. With ADR-089 settled, the `command_access_mode` gate is the permission design: `manual` + allow-list already prevents unauthorized members from invoking arbitrary commands.

**Decision:** Wire `dispatchSlashCommand` into `routeConnectorEvent` with `surface='connector'`. External members can invoke a command iff the admin has assigned it to the agent (manual mode) or the agent is in `all` mode. No per-binding flag needed — the agent-level config is sufficient.

**Consequences:**
- Scenario 1's Flow A (Telegram-triggered commands like `/summary`) is now possible without deferring to cron.
- Security boundary is the agent's `command_access_mode` + allow-list, same as every other surface. Single mental model.
- Future: if we ever need *per-binding* command restriction (e.g., "only this group can invoke `/deploy`"), add a binding-level allow-list that intersects with the agent-level one. Not needed yet.

## ADR-087 — Adapter owns streaming outbound, event-router handoff via `handleResolvedEvent`

**Context:** Before the streaming adapter handoff, the connector event-router did end-to-end handling: parseEvent → logArrival → resolve binding + identity → `runtimeManager.run()` → accumulate the full stream into `responseText` → `adapter.sendMessage({ text: fullText, simulate_typing: true })`. The adapter then did a *fake* progressive reveal (3 slice × 2s edits) on a message that was already final. Observable symptom: in the web runs viewer the stream completed first, THEN Telegram's `⌛` placeholder appeared and typing simulation began — sequential, not concurrent. Tool invocations (fs_read, connector_send, etc.) were invisible on Telegram entirely. Root cause was structural: the router drained the stream-to-completion before touching the adapter.

**Decision:** Split responsibilities cleanly.

- **Event-router** stays as first-contact + matchmaker: log arrival, resolve binding/identity/scope, create conversation, build connector_context block, scan `@file` refs, check auto-reply + queue_mode. It now also builds a `ResolvedEventContext` with injected callables (`startRun`, `registerObserverStream`, `logOutboundMessage`, `logOutboundEvent`, `recordUsage`) and hands off via a new optional adapter method:

  ```ts
  handleResolvedEvent?(ctx: ResolvedEventContext): Promise<void>
  ```

- **Adapter** (Telegram first) owns from there: send the initial `⌛` placeholder as a reply to the user's message; consume the agent stream chunk-by-chunk; debounce text-delta edits at 700ms; render tool-call chunks as `[🔧] tool_name` above the response text and flip to `[☑️]` / `[❌]` on result/error; split at 4000 chars by finalizing the current message and opening a fresh `⌛`; apply MarkdownV2 escape at final edit with plain-text fallback; log outbound + record usage via ctx callables; tee a branch back to the host via `registerObserverStream` so SSE subscribers (chat web) keep getting real-time chunks.

- **Backward compat:** if an adapter doesn't override `handleResolvedEvent`, router falls back to the legacy accumulate-then-sendMessage path. No other plugin needs to change on day one.

**Consequences:**
- Real streaming on Telegram — `⌛` appears immediately, text fills in as agent speaks, tool usage visible.
- No more placebo typing-sim ~6s after the agent already finished.
- Adapters get platform-aware control (Discord's 2000-char cap, WhatsApp's no-edit model, etc. — each implements their own `handleResolvedEvent` when ready).
- `@jiku/kit` and the Telegram plugin stay decoupled from `@jiku-studio/server`: studio-side services flow through the `ResolvedEventContext` callables, not direct imports.
- Trade-off: event-router now has two paths (handoff vs fallback) — a small maintenance burden. Acceptable because the fallback is short (the existing legacy block) and we can retire it once all adapters implement the hook.
- Queue drain path (`drainConnectorQueue`, for messages enqueued by `queue_mode='ack_queue'` while a prior run is in-flight) still uses the legacy fake simulate_typing for subsequent queued messages — documented follow-up in `tasks.md`. First-message UX (the 95% case) is fixed.

## ADR-086 — Connector param schema surfaced via tool output, not prompt injection

**Context:** Scenario 1 §9.D's original plan was to inject `<connector_params connector="telegram">` block ke system prompt saat binding aktif menyentuh connector tersebut — context-aware, tapi butuh runner menginspeksi binding + connector set tiap run, plus cara buka `connector_params` berebut tempat dengan skill hint, memory section, persona, dll. Setiap tambah segment = tambah complexity di `resolver/prompt.ts` dan tambah token footprint default setiap run.

**Decision:** Skip prompt injection. Extend existing `connector_list` tool output untuk emit `param_schema` per connector. Agent sudah punya disiplin "call `connector_list` fresh every iteration before using any connector_* tool" (sudah di description tool). Karena schema datang lewat tool result, token cost dibayar **hanya** kalau agent sebenar-benarnya akan panggil `connector_send` di turn itu — zero prompt-bloat untuk run yang tidak menyentuh connector sama sekali.

**Consequences:**
- Implementasi satu titik: tambah `param_schema` ke return value di `connector_list` execute handler. Tidak ada perubahan di `resolver/prompt.ts`, tidak ada segment baru.
- Context-aware "secara alami" — agent yang tidak perlu kirim tidak lihat schema.
- Trade-off: agent yang skip `connector_list` (disiplin gagal) tidak tahu ada param. Mitigasi: tool description `connector_send` dan `connector_send_to_target` eksplisit minta cek `connector_list > param_schema`.
- Pola ini bisa direplikasi untuk action-schema (`connector_list_actions` sudah mirip). Jadi convention: "discover-via-list-tool, bukan "inject-ke-prompt" untuk metadata per-connector.

## ADR-085 — Commands dispatcher: chat/cron/task/heartbeat only, skip connector inbound

**Context:** Scenario 1 §6.1 menyebut connector-inbound message sebagai scope trigger untuk `/slash` dispatcher, dengan catatan "gated permission supaya member eksternal tidak sembarangan invoke `/deploy-prod`". Untuk MVP Commands, wiring dispatcher ke event-router inbound berarti:
- Keputusan desain permission model per-binding (flag `allow_slash_commands`? allow-list per identity status? role-based?).
- Trust boundary berubah — saat ini connector inbound adalah untrusted text; dispatcher = semi-executor yang bisa resolve body kaya yang jalan sebagai system-caller.
- Bisa bikin skenario surface attack vector sebelum ada review keamanan.

**Decision:** Ship dispatcher hanya di empat surface internal: chat route, cron scheduler (via task runner), heartbeat (via task runner), manual task spawn (via task runner). Skenario marketing Flow B jalan clean lewat cron → task runner, yang sudah tercover. Connector inbound `/slash` masuk backlog sebagai item terpisah dengan permission design yang proper.

**Consequences:**
- User hanya bisa fire `/command` lewat chat UI atau cron/task — aman dari serangan external "Telegram member spam `/deploy-prod`".
- Flow B skenario (cron `0 15 * * *` → `/marketing-channel-execute "jam 15.00"`) tetap jalan end-to-end karena path-nya cron → task runner.
- Untuk masa depan, desain permission: kemungkinan flag `connector_bindings.allow_slash_commands` default false + explicit allow-list slugs per binding. Ditunda sampai ada use case konkret.

## ADR-084 — @file reference hint: stat-only, exact paths, no glob / relative in MVP

**Context:** Saat mendesain @file reference hint, dua pilihan obvious:
1. **Eager expand** — ambil konten file langsung di pre-prompt stage, inject ke context. Zero agent effort, tapi blow up token untuk file besar/banyak.
2. **Hint-only (stat)** — cuma validasi file exists + emit notice "file X tersedia, fs_read-lah", agent decide kapan/berapa baca.

Plus pertanyaan scope: support `@./relative`, `@../parent`, `@glob/*.md`, `@folder/` summarisation?

**Decision:**
- **Stat-only hint** — konsisten dengan pola progressive disclosure yang sudah dipakai Skills (Plan 19). Token cost cuma metadata ringkas; agent kontrol berapa detail yang dibaca via `fs_read` offset/limit.
- **Workspace-root only** untuk MVP — `@x/y` → `/x/y`, `@/abs` → `/abs`. `@./rel`, `@../esc`, `@glob/*` semua di-drop silent. `@alice` non-path-like diabaikan (treated as username mention).
- **Cap 20 matches** per invocation — di atas itu jadi noise dan kemungkinan prompt injection attempt.

**Consequences:**
- Implementasi ringan — regex scan + `getFileByPath` per match. Bisa jalan di sub-millisecond untuk typical input.
- Agent yang "terbiasa" dengan Skills pattern langsung paham flow (hint → on-demand read).
- Trade-off: user yang mengetik `@./file-di-folder-saya` di command body tidak dapat hint. Edukasi: selalu pakai absolute workspace path. Deteksi + warn di UI command editor bisa ditambah nanti.
- Glob + directory summarisation masuk backlog — waktunya datang kalau ada skenario spesifik yang butuh (misal "@reports/*" di marketing review).

## ADR-083 — FS tool permission: two tiers only, enforce at tool-layer not at-rest

**Context:** The FS tool permission feature needs a decision on granularity and enforcement location:
- Berapa tier? `read+write`, `read`, `none`, atau tier khusus per-tool?
- Enforce di FS service (block semua writes termasuk dari HTTP UI)? Atau hanya di agent tool layer?

**Decision:**
- **Dua tier: `read+write` (default) dan `read`.** Tier `none` ditunda — belum ada use case; agent read-only dari `/reports/` = skenario utama, dan agent butuh bisa BACA untuk self-improve loop. Tier `none` bisa ditambah nanti tanpa breaking change.
- **Enforcement di FS tool layer saja** (`fs_write`, `fs_edit`, `fs_append`, `fs_move`, `fs_delete`). File explorer manual user **TIDAK** kena gate — user adalah sumber otoritas yang set flag; menggate mereka = menggate diri sendiri. Route HTTP `PATCH /files` untuk user edit manual juga tidak kena gate (UI dipakai untuk edit sekalian).
- **Read operasi selalu boleh** — konsisten dengan semantics "shared open between members, restriction cuma untuk mutasi."

**Consequences:**
- Admin bisa set `/reports/` → `read` tapi masih bisa edit laporan dari UI kalau perlu manual koreksi. Jelas siapa "tuannya" — user.
- Agent yang coba `fs_write` ke path gated dapat error `FS_TOOL_READONLY` dengan source info → bisa self-correct.
- Implementasi resolver: walk self → ancestor chain. Biaya: O(depth) queries. Diasumsikan file tree tidak terlalu dalam (< 20 levels); cache tidak perlu di MVP.
- Gate dipanggil inline di tiap mutasi tool — duplikasi kecil (5 tool × 2 baris setup) tapi explicit. Lebih mudah debug daripada decorator pattern.

## ADR-082 — Orphan identity auto-reset on next inbound

**Context:** When an admin deletes a `connector_bindings` row, the FK cascade on `connector_identities.binding_id` sets the column to NULL but leaves `status` unchanged — usually `'approved'`. The next inbound DM from that user hit the "no matching binding" branch in `event-router.ts`, found the existing approved-but-orphan identity via `findIdentityByExternalId`, skipped the `!identity` create-pending path, fell through to `logEv(status='pending_approval', drop_reason='no_binding')`. The user received no bot reply, and the admin UI showed nothing because `getPairingRequestsForConnector` filters `status='pending'`. From the operator's viewpoint the system had silently broken itself in response to an explicitly requested delete.

**Decision:** In the Path B DM branch of `routeConnectorEvent`, when an existing identity is found with `binding_id IS NULL AND status='approved'`, treat it as orphan-by-delete: UPDATE `status='pending'`, set the local `identity.status='pending'`, and run the same `👋 access request sent` notification the fresh-identity path uses. Admin UI then surfaces the pairing request again and admin can re-approve.

We chose "reset on next inbound message" rather than "reset on DELETE binding" because the DELETE route doesn't know which DB identities were owned by that binding before cascade (the FK SET NULL happens atomically with the DELETE and the pre-image is lost to the app layer). Handling it at inbound time is self-healing and requires no `routes/connectors.ts` change, at the cost of the user seeing one dropped message before the reset takes effect — acceptable since binding-delete is rare and the system sends the approval-request notification on the second message onwards.

**Consequences:**
- Orphan identities self-heal on user activity; no explicit cleanup job needed.
- One message post-delete reaches the user as silence before the reset fires. Documented as known edge case; a future "Force re-pair" admin action (in tasks.md) would close it for cases where that single-message gap matters.
- Only applies to Path B (DM / no-scope). Group scope already recreates a draft binding lazily, so no parallel fix needed.

## ADR-081 — Telegram polling resilience: auto-reconnect + post-deactivate guard

**Context:** Production hit a stuck state where the process was alive, logs showed `[telegram] bot started (polling)`, but zero inbound events for 30+ minutes — even across forced restarts. Diagnosis revealed three compounding bugs in the activation path:

1. `bot.start()` returns a long-lived promise that resolves only when polling terminates. Prior code fire-and-forgot with `.catch(log)`: a single rejection (409 Conflict if another instance still holds the slot, 401 if the token changed, network drop, etc.) produced **permanent silent polling death** while the process kept running and appeared healthy.
2. Telegram server-side reserves a bot's long-poll slot for ~30s after any `close()` or connection drop. A rapid deactivate→reactivate — common when admin clicks Stop then Start, or the new Restart button — races against this window and the first `getUpdates` returns 409.
3. Exceptions inside async update handlers (a DB blip, an unhandled throw in event-router) surfaced as unhandled promise rejections that could terminate the grammy polling task without our `.catch` noticing.

Prior belief was "restart fixes it" — it doesn't, because the slot reservation and grammy rejection pattern reproduce on every boot within the same 30s window.

**Decision:**

1. `onActivate` wraps `bot.start()` in a backoff loop (1s → 60s max) inside a detached async IIFE. On any error we log + back off + retry. On 409 Conflict we additionally call `bot.api.close()` between retries to request slot release. The loop exits cleanly when `onDeactivate` sets `this.pollingStopRequested = true` or when `this.bot` is replaced.
2. Module-level `lastDeactivateByConnector: Map<connectorUuid, number>`. `onDeactivate` writes `Date.now()` keyed by connectorId. `onActivate` awaits the remainder of a 30s window since the last deactivate before calling `bot.start()`. 30s chosen to match Telegram's documented slot-reservation window.
3. `bot.catch((err) => console.error(...))` installed before starting — grammy's middleware-level error handler so update-handler exceptions are logged instead of escaping as unhandled rejections.

**Consequences:**
- Polling self-heals from all transient failure modes. Permanent misconfigurations (invalid token = repeated 401) still loop forever but are log-loud.
- Admin-triggered Restart button reliably works without 409 because the 30s guard enforces the wait. The UX shows "Restarting..." up to ~30s in the worst case (previous deactivate was just now) or instant (previous deactivate >30s ago).
- Backoff is capped at 60s rather than growing unbounded; we trade a bit more Telegram API traffic during pathological failures for faster recovery when the underlying issue clears.
- The 30s guard assumes `onActivate` and `onDeactivate` run in the same process. In a multi-process deploy this is moot — Telegram's slot reservation applies server-side and our local map just over-waits harmlessly; we don't race with our own other replicas because a 409 path would still retry with backoff.

## ADR-080 — Arrival log is non-blocking and lives outside any routing queue

**Context:** Inbound Telegram updates were being routed through a single `ctx.onEvent(event)` call that internally wrote to `connector_events` / `connector_messages` AND drove the agent runner AND sent outbound replies. When we introduced a batched FIFO inbound queue (ADR-079) to control concurrency, all of that logic moved behind the queue — including the DB write. A stalled queue (bug, DB deadlock, long agent run) meant zero rows hit `connector_events` even though Telegram was delivering updates. Operators lost the ability to distinguish "bot is offline" from "bot is overloaded" by looking at DB state.

**Decision:** Every inbound update the adapter receives is recorded in `connector_events` with `status='received'` **before** the routing queue is ever touched. The write is done via a dedicated `logArrivalImmediate(connectorId, event)` helper in the plugin, calling `logConnectorEvent()` directly from `@jiku-studio/db`. Errors are swallowed and logged — a DB failure must not block polling or drop the update. The adapter caches `ctx.connectorId` on activation so this call doesn't need a hop through `ConnectorContext.onEvent`.

Downstream routing (bindings, agents, outbound sends) still flows through the batch queue, and still writes its own rows for status transitions (`pending_approval`, `handled`, `dropped`, …). Short-term this produces 2+ rows per event (one arrival + one outcome); documented as known follow-up in tasks.md.

**Consequences:**
- Operators can diagnose "Telegram nyampe atau nggak" with a single `SELECT count(*) FROM connector_events WHERE created_at > now() - interval '5 min'` regardless of router health.
- Multiple rows per event is not a bug, it's two distinct observability signals. Event id uniqueness in logs still holds — rows are distinct DB rows.
- Future refactor to UPDATE-in-place requires threading the arrival event id through `routeConnectorEvent` all the way to every `logEv` call site. Non-trivial refactor.

## ADR-079 — Telegram send queue is per-chat; inbound queue is batched FIFO

**Context:** A production 429 (`retry_after: 38`) in `sendWithTypingSimulation`'s final `editMessageText` caused the connector to crash the event handler (ADR-081's bug 3), cascading into "bot ga nerima pesan" even after hard restart. Two orthogonal concurrency gaps contributed:

1. **Outbound send races to the same chat.** `simulate_typing` fires 4 Telegram API calls per message (placeholder send + 2 interim edits + final edit). Two overlapping `sendMessage()` calls to the same chat produce 8 concurrent API calls over a few seconds — deep into Telegram's per-chat rate limit.
2. **Inbound updates run agent runs concurrently with no ceiling.** A burst of 30 messages in one second fanned out 30 parallel agent runs, thrashing the DB and compounding outbound pressure.

**Decision:** Two queues with different shapes.

1. **Per-chat outbound queue.** Module-level `chatSendQueues: Map<chatId, Promise<unknown>>` — each `sendMessage` call appends its task to that chat's promise chain. Two sends to the same chat serialize; sends to different chats run in parallel. Combined with `withTelegramRetry(fn)` which respects `err.parameters.retry_after` on 429 (capped at 45s — beyond that the helper throws and callers degrade). Scoped per-chat because Telegram's rate limits are primarily per-chat, not global.
2. **Global inbound batch queue.** `enqueueInboundEvent(task)` pushes into a single module-level array. `drainInboundQueue` takes up to `INBOUND_BATCH_SIZE=5` tasks, runs them via `Promise.allSettled`, waits for the full batch to drain, then processes the next 5. FIFO across batches. `allSettled` — not `all` — so one failing event doesn't poison the batch.

**Consequences:**
- `simulate_typing` can no longer overlap itself on the same chat. Visible UX: if two messages arrive simultaneously, the second starts typing only after the first's final edit lands. Correct and desirable given we can't cheat the rate limit.
- Agent concurrency is capped at 5 per process. A heavier workload requires lifting the constant or sharding across processes; for current usage 5 comfortably absorbs bursts.
- Batch semantics (wait for all 5 to complete before starting the next 5) chosen over rolling concurrency because the user explicitly requested this shape — "ambil 5, tungguin kelar, ambil 5 lagi". Simpler reasoning; edge case: one slow event in a batch delays four fast ones. Accepted; average throughput still high.
- A bug that causes `drainInboundQueue` to throw at a bad moment could leave `inboundDraining=true` and stall forever. Mitigation: try/finally around the whole drain; `allSettled` inside so individual task errors never escape. Must preserve this invariant in future edits.

## ADR-078 — Trigger mode detection is adapter-authoritative; customization via per-binding text arrays

**Context:** Original `matchesTrigger` implementation had weak / buggy mode detection:
- `mention` was `text.includes('@')` — matched any `@` (emails, unrelated user mentions).
- `reply` had no case in the switch — fell through to default → always passed.
- `command` / `keyword` had no whitelist / regex support.

Platform signals needed for correct detection (Telegram entities, bot's own username/id, reply-to-message chain) aren't naturally available in the shared event-router — they're adapter-private knowledge. Meanwhile admin may want custom "trigger words" beyond the platform's formal mention feature (internal nicknames like "halo bro", alternate handles, etc.).

**Decision:** Two-layer model.

1. **Adapter populates boolean flags in `event.metadata`** for platform-authoritative detection:
   - `metadata.bot_mentioned` — true when THIS bot was explicitly mentioned via platform mechanisms (Telegram: `entities.type='mention'` matching `@<botUsername>` OR `type='text_mention'` with `user.id===botUserId`, scanned across both `text` + `caption` entities).
   - `metadata.bot_replied_to` — true when the user used the platform's reply feature to reply to one of this bot's own messages (Telegram: `reply_to_message.from.id===botUserId` and NOT the synthetic forum-topic-created pointer).

   The adapter caches bot identity (`botUsername`, `botUserId` from `getMe()`) at activation and clears on deactivation.

2. **`matchesTrigger` consults flags PLUS per-binding overrides**:
   - `mention`: in DM → implicit pass. In group → if `trigger_mention_tokens` list is set, any substring match wins; else fall back to `metadata.bot_mentioned`.
   - `reply`: in DM → implicit pass. In group → require `metadata.bot_replied_to`.
   - `command`: require `/` prefix. If `trigger_commands` list is set (e.g. `['help','ask']`), the command name (split on `[\s@]` to handle Telegram `/cmd@bot` format) must match.
   - `keyword`: require one of `trigger_keywords` to hit. If `trigger_keywords_regex=true`, each entry is compiled as case-insensitive regex; otherwise substring.

Migration `0029_binding_trigger_custom.sql` adds `trigger_mention_tokens text[]`, `trigger_commands text[]`, `trigger_keywords_regex boolean DEFAULT false`. UI binding detail surfaces the relevant field conditionally based on `trigger_mode`.

**Consequences:** Platforms with different mention/reply semantics (Discord, Slack, WhatsApp) plug in by populating the same two boolean flags during their own `parseEvent` equivalent — matchesTrigger logic stays unchanged. Admins get flexible config (internal nicknames, command whitelist, regex keywords) without exposing platform API complexity in the schema. DM messages intentionally bypass the mention/reply gate because "the whole message is addressed to the bot" — modelling groups and DMs identically would force admins to pass tokens even for direct conversations.

---

## ADR-077 — Connector input composition + agent tool contract (platform-agnostic)

**Context:** The `[Connector Context]` block was originally plain text separated from the user message by a blank line — a crafted message could inject a fake `[Connector Context]` header and the model would read it as trusted metadata. The block also only included the platform + connector UUID (not display name), the raw `chat_id` (not chat_title), and the Telegram `message_id` (not our internal row ids — so agents couldn't fetch the full DB row later). Agent query tools (`connector_get_events`, `connector_get_thread`) had minimal filters (only `direction` + `event_type` + `limit`); no way to discover chat_ids or user_ids; no pagination. This made multi-tenant / multi-platform observation unsafe and inefficient. And the whole stack had creeping Telegram assumptions that would block WhatsApp/Discord/Slack adapters.

**Decision:** Four simultaneous contracts, all adapter-agnostic:

1. **Input composition is XML-tagged**: every connector-triggered agent run composes input as `<connector_context>…</connector_context>\n\n<user_message>…</user_message>`. The context block opens with an explicit instruction treating everything inside `<user_message>` as UNTRUSTED. No adapter overrides this — adapter only supplies `ConnectorEvent`; the event-router owns composition.

2. **Context block carries enough for the agent to self-locate**:
   - `Connector: <display_name> (id=<uuid>)` — both human + machine identity.
   - `Internal event_id: <uuid>` and `Internal message_id: <uuid>` — point to OUR DB rows (`connector_events` / `connector_messages`), distinct from the platform ids under `Chat ref`. Agents use them with `connector_get_event` / `connector_get_message` to load `raw_payload` + metadata.
   - `Chat: "<title>" (<type>, chat_id=<id>, → topic "<name>" (thread_id=<id>)?)` — structured location.
   - `Sender: <display_name> @<username> (external user_id=<id>)` — grounded identity.
   - `Chat scope key: <key>` — exposes the binding scope system.

3. **Agent tool contract** follows a discovery-first pattern:
   - `connector_list` — list bots/integrations; **call fresh every iteration**.
   - `connector_list_entities({ scope: 'chats'|'users'|'threads' })` — AUTHORITATIVE discovery (distinct entities with labels + counts + last_seen).
   - `connector_list_targets` — ADMIN-REGISTERED ALIASES only, NOT the full chat list.
   - `connector_get_events` / `connector_get_thread` — always filter; cursor paginated.
   - `connector_get_event` / `connector_get_message` — by internal UUID from the context block.
   Tool descriptions enforce: "tables are LARGE — never fetch without a filter", "re-list discovery every turn".

4. **ref_keys + metadata vocabulary is normalized** across adapters:
   - `ref_keys.chat_id` — required (platform wadah percakapan).
   - `ref_keys.message_id` — required (individual platform message).
   - `ref_keys.thread_id` — optional (forum topic / thread / sub-channel).
   - `sender.external_id` — platform user id (NOT in ref_keys; `source_ref_keys.user_id` is compared against this via special-case in `matchesTrigger`).
   - `metadata.{chat_title, chat_type, thread_title, client_timestamp, language_code}` — optional but recommended.
   - `raw_payload` — original platform JSON on both `ConnectorEvent` (via adapter `parseEvent` or webhook `req.body`) and `ConnectorSendResult` (adapter `sendMessage` return).

**Consequences:** Adding a new connector adapter (WhatsApp/Discord/Slack) = one plugin file implementing `ConnectorAdapter` from `@jiku/kit`, normalising to the vocabulary above. Everything else (routing, pairing flow, binding scope gate, member_mode, SSE, channels UI, Scope Lock, Group Pairing, Blocked Identities, agent tools, context block, internal-id injection, stale-file detection, raw payload inspection) works unchanged. Telegram-specific quirks (`my_chat_member` auto-register, forum topic name extraction from `reply_to_message.forum_topic_created.name`, grammy long-poll `deleteWebhook + close` pre-flight) live exclusively in `plugins/jiku.telegram/src/index.ts`. Context block XML wrapping prevents prompt-injection from user text. Internal-id injection lets agents resolve DB rows without a second lookup path. Status vocabulary (ADR-076) + scope model (ADR-074) + read-before-write filesystem (ADR-075) slot into this contract without modification.

---

## ADR-076 — Inbound message status vocabulary

**Context:** `connector_messages.status` started as free-form text; inbound rows used `'sent'` (conflict with outbound `'sent'`), missing rows when no binding matched, no way to filter "agent handled" vs "pending"/"dropped" in the Messages UI or via `connector_get_thread`.

**Decision:** Every message event produces exactly one inbound row with a vocabulary that reflects the routing outcome:
- `handled` — binding matched, agent ran (row carries `conversation_id`)
- `unhandled` — no binding matched this chat
- `pending` — binding matched but identity is pending approval
- `dropped` — binding matched but identity is blocked
- `rate_limited` — binding matched but rate limit hit

Outbound keeps `sent` / `failed`. Written at each decision point in `routeConnectorEvent` (no-match branch, blocked branch, pending branch, rate-limited branch) and inside `executeConversationAdapter` for the `handled` case.

**Consequences:** Messages table is now a complete inbound traffic log. The Messages tab filter surfaces the distinction explicitly so admins can audit "what did we miss". The inbound-routed row no longer collides with outbound `sent` when filtering.

---

## ADR-075 — Claude-Code-style filesystem safety (read-before-write + stale detection)

**Context:** Native `fs_read` + `fs_write` required the agent to re-send the entire file content on every partial edit — wasted tokens on growing files (user's marketing-journal scenario ballooned to >8 KB in 3 turns). Claude Code enforces read-before-edit and detects external modification via a per-session read tracker. refs-clawcode itself doesn't implement this (pure `replacen()`), but the production Claude Code pattern is well-suited to our multi-agent / multi-user environment.

**Decision:**
1. New table `conversation_fs_reads (conversation_id, path, version, content_hash, read_at)` PK `(conversation_id, path)`, cascade on conversation delete. Upserted by `fs_read`; consulted by `fs_write`/`fs_edit`; dropped on `fs_move` (old path) / `fs_delete`.
2. `fs_write` and `fs_edit` reject with `MUST_READ_FIRST` when the file wasn't read in this conversation (exception: `fs_write` for a brand-new file), and with `STALE_FILE_STATE` when the DB `version` differs from the tracked one.
3. New `fs_edit` tool does substring replacement (`old_string` → `new_string`, optional `replace_all`, `old_string` must be unique unless `replace_all`).
4. `fs_read` returns `cat -n` format with `offset`/`limit` pagination + per-line truncation + paging hint.
5. `fs_append` tool bypasses the gate (append-only = no clobber) but clears the tracker row to force re-read if the agent later wants to `fs_edit`.
6. `upsertFile()` now actually increments `version` on update (it was silently stuck at 1) and stores `content_hash = sha256(content)` so the optimistic lock is meaningful.

**Consequences:** Agents prefer `fs_edit` for partial changes (huge token win) and `fs_append` for growing logs (zero-token payload). Concurrent mutation from UI / other sessions is now detected rather than silently clobbered. Per-session tracker state persists across server restarts because it's in DB — acceptable overhead (one row per path read per conversation) in exchange for correctness.

---

## ADR-074 — Binding scope model: DM lock + implicit scope gate + member_mode

**Context:** A binding created for user A's private chat with the bot silently captured messages from user B in a shared group — auto-creating a new identity for user B under user A's binding, sharing user A's conversation, and letting the agent respond. Root cause was three layered gaps: pairing approval created bindings without any sender scope; `matchesTrigger()` had no scope gate derived from `source_type`; any matching binding auto-approved new identities with `status='approved'`.

**Decision:** A binding is a strict chat-window contract:
- **DM binding** = `source_type='private'` + `source_ref_keys={ user_id: <external_id> }`. Pairing approval always sets both. `matchesTrigger` compares `source_ref_keys.user_id` against `event.sender.external_id` (user_id is not in `event.ref_keys` so this is a special-cased lookup).
- **Group/channel binding** = `source_type='group'` (or `'channel'`) + `scope_key_pattern='group:<chat_id>'` + `source_ref_keys.chat_id=<id>`. Admission gated by `member_mode` column: `require_approval` (default) makes new members' first message create a pending identity; `allow_all` auto-approves.
- **Implicit scope gate** from `source_type`: `private` requires empty `event.scope_key`; `group`/`channel` require non-empty. `any` is legacy + flagged unsafe in UI.
- **Group auto-pairing**: `my_chat_member` creates a disabled draft binding (`enabled=false`, no `agent_id`). First group message also creates the draft lazily if none exists for that scope (covers bot added before the hook existed). Admin approves via "Group Pairing Requests" section → picks agent + member_mode → binding enabled.

Migration `0028_binding_member_mode.sql` adds `connector_bindings.member_mode text NOT NULL DEFAULT 'require_approval'`.

**Consequences:** Backwards-incompatible UX for legacy loose bindings (`source_type='any'` with null scope + null ref_keys) — they keep working but are flagged in the UI; admin should re-approve or manually scope them. A single group needs ONE draft binding (not one pending identity per member), which reduces admin triage load. DM pairing flow unchanged from the user's perspective (first DM → "access request sent" → admin approves in UI) but now produces a strict binding.



## ADR-067 — Message-level branching via `parent_message_id` (Plan 23)

**Context:** Want Claude.ai/ChatGPT-style edit & regenerate UX. Two options: (a) conv-level branching (clone conversation per branch — bloats sidebar, breaks deep links), (b) message-level branching inside one conversation.

**Decision:** Option b. `messages.parent_message_id` (self-FK, `ON DELETE CASCADE`) + `messages.branch_index` (int) form a tree. Conversation id and URL stay stable.

**Consequences:** Every reader of `messages` for chat must now traverse the active branch path instead of scanning the flat list. Backfill is safe: existing rows form a single linear branch (parent = previous-by-created_at, branch_index = 0).

---

## ADR-068 — Conversation tracks `active_tip_message_id` server-side (Plan 23)

**Context:** Need to know which leaf the user is currently viewing across reloads, devices, and tabs. Client-only state would race when two tabs are open and lose state on reload.

**Decision:** `conversations.active_tip_message_id uuid REFERENCES messages(id) ON DELETE SET NULL`. Updated atomically inside `addBranchedMessage` (insert + tip update in one tx) and via `setActiveTip` on branch switch / regenerate.

**Consequences:** Last-writer-wins for multi-tab — acceptable. Cleared automatically if the message is deleted (rare; we don't expose hard delete yet).

---

## ADR-069 — Active path loaded via single recursive CTE (Plan 23)

**Context:** Branch navigator needs `sibling_count` + `sibling_ids` per row alongside the linear active path. Two-query approach (path then per-row siblings) means N+1.

**Decision:** Single Postgres recursive CTE — walks tip → root via parent links, then per-row sub-selects use `IS NOT DISTINCT FROM` so root messages (parent NULL) compare correctly. Index on `(conversation_id, parent_message_id)` keeps sibling sub-selects O(log n).

**Consequences:** All branch-navigator data flows in one round-trip. Postgres-only — in-memory adapter falls back to flat `getMessages`.

---

## ADR-070 — Branching is implicit, not via a dedicated endpoint (Plan 23)

**Context:** Could expose `POST /branch` to fork a conversation explicitly, or branch as a side-effect of normal sends.

**Decision:** Implicit. Server always sets `parent_message_id` on inserts and computes `branch_index = max(siblings)+1`. Edit-message and regenerate flows just supply a different `parent_message_id` from the chat client — the data model handles "is this a branch" automatically.

**Consequences:** Only one new write endpoint (`/regenerate`) — purely because regenerate skips the user-message save. Send + edit reuse `POST /chat`.

---

## ADR-071 — Branch switch uses "latest leaf" descent (Plan 23)

**Context:** When the user clicks `→` on a sibling navigator, the chosen sibling may itself have descendants (sub-branches). Which tip do we land on?

**Decision:** Walk down from the chosen sibling, always picking the child with the highest `branch_index`, until a leaf. Deterministic, no extra `last_visited_at` tracking, matches "newest first" intuition.

**Consequences:** A user who explored an old sub-branch and then walked away will not auto-resume there — they get the newest leaf. Acceptable for v1; can revisit if users complain.

---

## ADR-072 — Branch / regenerate / edit blocked while a run is in progress (Plan 23)

**Context:** Switching tip mid-stream would corrupt the active path the streaming run is appending to. Concurrent regenerate would double-bill the model and create racey assistant rows.

**Decision:** All three operations are disabled in the UI while `streaming|submitted` and rejected with 503 (`/active-tip`) or 409 (`/regenerate`) on the server when `streamRegistry.isRunning(convId)`.

**Consequences:** UX cost is small (runs are short). Clean alternative would be cancel-first-then-switch — defer until user demand exists.

---

## ADR-073 — Compaction is branch-aware and append-only (Plan 23, revised)

**Context:** Initial Plan 23 disabled compaction whenever any branching existed because `replaceMessages(conv, [...summary, ...recent])` deletes every message in the conversation — destroying alternate branches. That made branched conversations hit context limits faster.

**Decision:** Compaction now operates per active branch and is **append-only**:
- Token threshold check (`checkCompactionThreshold`) measures the active branch path only, not the flat conversation.
- When triggered, summarize the older portion of the active path, then insert a new assistant message `[Context Summary]\n…` via `addBranchedMessage(parent = current_tip)`. Old rows are NOT deleted — other branches still walk through them.
- Reuses the existing `applyCompactBoundary()` filter, which already trims everything before the latest `[Context Summary]` checkpoint when loading history. No new schema, no new abstractions.
- Skipped on explicit branch forks (edit-message flow with `parent_message_id !== current_tip`) and on regenerate, so the user moving away from a branch doesn't dump a checkpoint into it on the way out.
- Linear extends after compaction automatically chain off the new checkpoint (see ADR-067/068 — `desiredParent` falls through to the latest tip when the client sent "extend off current tip").

**Consequences:** Branched conversations now compact correctly. Storage cost slightly higher than the old `replaceMessages` because old rows stay in the DB — acceptable price for never-destroy-a-branch semantics. In-memory adapter (no `addBranchedMessage`) still uses `replaceMessages` as a fallback.

---

## ADR-073-old (superseded) — Compaction disabled on branched conversations

Original: skip compaction when any sibling group exists. Replaced by the append-only design above once it became clear `applyCompactBoundary` already supports the marker pattern and only `replaceMessages` was destructive.

---

## ADR-064 — Built-in tools use bare `meta.id` as `tool_name` (no `builtin_` prefix)

**Context:** Previously the runner prefixed every built-in tool's exposed `tool_name` with `builtin_` (e.g. `connector_send` → `builtin_connector_send`). System prompts authored by Studio (cron preamble, capability hints, delivery instructions) referenced bare names like `connector_send(...)`, but the AI SDK's tool list saw `builtin_connector_send`. Models could not match the two and frequently refused with "I cannot access that tool". Workaround was to repeat the prefix in every prompt — wasteful tokens + maintenance churn.

**Decision:** Built-in tools now use `tool_name = meta.id`. The internal `resolved_id` keeps the `__builtin__:<id>` namespace for tool_states + audit. Plugin tools still use the existing `<plugin_id>:<id>` sanitized name so collisions with built-ins remain impossible (plugin tool names always carry the plugin id).

**Consequences:** Prompts can reference tools by their natural name (`cron_create`, `connector_send`, `fs_read`). Token-cost drops in tool list + system prompt. No collision risk because plugin namespacing is preserved on the plugin side. Risk: a plugin would have to choose a `meta.id` matching a built-in to collide — but plugin tools sit under the plugin namespace anyway, so they'd surface as `jiku_xyz_cron_create` not `cron_create`.

---

## ADR-065 — Auto-reply path defaults `simulate_typing: true`; agent tools default false

**Context:** "Typing simulation" (placeholder + progressive edit) is great UX when a user is waiting for a reply, terrible when a cron-triggered agent broadcasts a notification. Earlier iterations placed the toggle on the binding (too coarse) or as a per-call agent param (forces every agent to remember to set it).

**Decision:** Two-tier default. The connector auto-reply path (`executeConversationAdapter` in event-router) hardcodes `simulate_typing: true` because by definition the user is waiting. Agent-callable tools (`connector_send`, `connector_send_to_target`) accept `simulate_typing` as an optional input defaulting `false` — agents must opt in for proactive sends where they want the effect.

**Consequences:** Zero-config UX win for chat replies (Telegram users see typing). Notifications/broadcasts stay clean by default. Agent retains opt-in. Implementation: `ConnectorContent.simulate_typing` flag flows through `sendMessage`; TelegramAdapter does the placeholder/edit dance only when set + text-only + ≤4000 chars.

---

## ADR-066 — Heartbeat cron parser uses `croner`, not hand-rolled

**Context:** `task/heartbeat.ts` had a minimal hand-rolled cron parser that only matched literal integer minute/hour fields. Expressions with `*/N` step syntax, ranges, lists (`MON-FRI`, `0,30`) silently failed by hitting the "every minute" fallback. Symptoms in the wild: `*/30 * * * *` configured by a user fired every minute with stats showing "in <1 min" forever.

**Decision:** Replace with `croner` (already used by `cron/scheduler.ts` and `dream-scheduler.ts`). `getNextCronDate(expr) = new Cron(expr).nextRun(from)`. Reject anything that is not exactly 5 fields — croner accepts 6-field "seconds-first" by default which would let a typo (`*/30 * * * * *`) become every-30-second runaway.

**Consequences:** All standard cron syntax works. Minute resolution enforced at the heartbeat layer. Single source of cron parsing semantics across the codebase.

---

## ADR-060 — Side-effectful tool dedup on replay

**Context:** AI SDK replays tool executions when the user edits a previous chat message. Side-effectful tools (cron_create, connector_send, fs_write) get called again → duplicate DB rows, double-sent messages, lost delivery context.

**Decision:** `ToolMeta.side_effectful?: boolean`. The runner builds a map `${tool_name}:${stableHash(args)} → cached_result` from full conversation history at run start. The tool-call `execute()` wrapper short-circuits for side-effectful tools when the key exists in the map.

**Consequences:** Edit safe for mutating tools. Legitimate retry with identical args is collapsed (rare — usually a real retry changes at least one arg). Non-side-effectful tools are unaffected so read-heavy tools still refresh on every call.

---

## ADR-061 — Cron context separation (prompt vs context jsonb)

**Context:** Delivery + origin + subject blocks were baked into `cron_tasks.prompt`. Editing `prompt` via UI wiped delivery, orphaning the cron. Scheduler had no structured way to re-compose the prelude.

**Decision:** New `cron_tasks.context` jsonb column holding `{ origin, delivery, subject, notes }`. `prompt` becomes pure intent (short, editable). Scheduler composes `[Cron Trigger]` + `[Cron Origin]` + `[Cron Subject]` + prompt + `[Cron Delivery]` at fire time via `cron/context.ts`.

`cron_create` accepts `origin`, `delivery`, `subject` as separate input fields. `cron_update` shallow-merges `context`.

**Consequences:** Prompt edits no longer destroy context. Structured context queryable/inspectable. Subject distinct from originator — supports "user A minta diingatkan user B".

---

## ADR-062 — Per-run extra_system_segments (no global plugin for per-project context)

**Context:** Plugin prompt segments inject globally. Per-project data (members, roles, identities) needs project + caller context that plugins don\'t receive. Adding projectId to every `getPromptSegmentsAsync()` call would bleed scope across the plugin API.

**Decision:** `JikuRunParams.extra_system_segments?: string[]`. Studio runtimeManager.run always appends a `[Company & Team]` segment — members + role + identities (user_identities + mapped connector_identities). Kept outside the plugin system so it doesn\'t pretend to be project-agnostic.

**Consequences:** Agents have cross-user awareness without extra tool round-trips. Segment is refetched per run (two indexed queries — cheap). Not cached; stale risk is minimal (membership changes rare vs run frequency).

---

## ADR-063 — Cron-triggered runs keep cron mutation tools (no blanket suppression)

**Context:** Initial proposal was to strip `cron_create/update/delete` from cron-fired runs to prevent infinite self-scheduling loops.

**Decision:** Revert. Conditional/dynamic cron chains ("if X tomorrow, schedule Y") are a real use case. Loop prevention handled by `[Cron Trigger]` preamble + `side_effectful` dedup + prompt-shape rails.

**Consequences:** More flexibility, with loop risk pushed to prompt discipline. `JikuRunParams.suppress_tool_ids` remains as an escape hatch but is not applied to cron.

---

## ADR-056 — scope_key as conversation isolation unit for multi-chat connectors

**Context:** `connector_identities.conversation_id` is keyed by identity — fine for DMs, broken for group chats where many users share a "room". Topic-enabled supergroups add a second axis. Storing per-identity conversations in a group would fragment context and mis-attribute history.

**Decision:** Introduce `scope_key` — a string computed by the adapter that names the platform-side conversation space. DM = undefined, Telegram group = `group:<chat_id>`, Telegram forum topic = `group:<chat_id>:topic:<thread_id>`. Mapping lives in new `connector_scope_conversations(connector_id, scope_key, agent_id, conversation_id)`. DM path (scope_key undefined) continues to use `identity.conversation_id`.

**Consequences:** Group participants share one agent conversation. Topic isolation is free. Backward compat preserved — existing DM connectors keep working until their adapter implements `computeScopeKey()`. Per-binding override is possible via `scope_key_pattern`.

---

## ADR-057 — Channel Targets as named outbound destinations

**Context:** Cron tasks and proactive agent runs have no "incoming event" to reply to, so `connector_send` requires the AI to know the raw `chat_id` — brittle and hard to express in a prompt.

**Decision:** New table `connector_targets(name, ref_keys, scope_key)` + tools `connector_list_targets` / `connector_send_to_target`. Agents reference destinations by name (`"morning-briefing"`), Studio UI manages them. `connector_send` remains for advanced cases.

**Consequences:** Cron prompts become natural ("send the daily summary to target `briefing`"). Destination renames don't break prompts. Name-uniqueness is per-connector.

---

## ADR-058 — Media pipeline via event log metadata (lazy fetch)

**Context:** Three options for handling inbound Telegram media:
1. Eager download at event-router time — writes every file, even ignored ones; duplicated for reacted/edited messages.
2. In-memory Map<message_key, file_id> in adapter — lost on restart; sync with DB is fragile.
3. Store `file_id` in `connector_events.metadata` (jsonb column already exists) and download lazily on `fetch_media(event_id)` action.

**Decision:** Option 3. `file_id` never leaves the DB row; AI sees only a hint (`Media available: photo 234KB — use fetch_media(event_id="...")`) and calls the action when it actually needs the bytes.

**Consequences:** Persistent across restarts, auditable, consistent with how events are already logged. Telegram `file_id` is valid indefinitely for the same bot, so late fetches still work. Media never appears in AI context unless the agent asks — keeps prompts lean.

---

## ADR-059 — Scope filter on bindings via `scope_key_pattern` (not source_ref_keys)

**Context:** `source_ref_keys` already filters by exact ref key match (e.g. specific `chat_id`). But expressing "all groups" or "DMs only" requires a pattern, not an exact match. Adding wildcards into `source_ref_keys` would overload its semantics.

**Decision:** New column `connector_bindings.scope_key_pattern` with a small pattern language: `null` = match all, `dm:*` = DMs, `group:*` = all groups, exact string = specific scope. Prefix wildcard only (no regex).

**Consequences:** `source_ref_keys` stays simple and fast (exact match). Scope-level routing lives on a dedicated dimension. The two can be combined (AND).

---

## ADR-052 — HarnessAgentAdapter: two-phase (tool_choice=none → tool_choice=auto) per iteration

**Context:** OpenAI Chat Completions API cannot emit text + tool_call in one response — a given response is either text OR tool calls. A prompt telling the model "narrate before every tool" is unreliable: GPT batches tool calls with a single final summary, which makes the harness UX feel like the default adapter. Claude doesn't have this limitation.

**Decision:** Per iteration, the harness adapter runs two `streamText` calls sequentially.
- **Phase 1** — `tool_choice: 'none'`, `stepCountIs(1)`. Forces text output (narration OR direct answer). Uses `NARRATION_PHASE_INSTRUCTION` addendum so the model doesn't hallucinate "I can't access tools".
- **Phase 2** — `tool_choice: 'auto'`, `stepCountIs(max_tool_calls_per_iteration)`. Tool call (possibly chained) or final text.

Loop control: an English+Indonesian action-intent regex (`ACTION_INTENT_RE`) is applied to phase 1 text. Match → run phase 2. No match → phase 1 IS the final answer, break. If phase 2 emits no tool call, also break.

**Consequences:**
- Works on GPT Chat Completions. Doubles LLM calls per tool step (can be disabled via `force_narration: false`).
- Phase 1 narration is NOT appended to `messages` (otherwise GPT decides "I already announced, done" and emits empty → loop stalls).
- Phase 2 uses `'auto'` not `'required'`: `required` forces the model to pick any tool when the task is complete, leading to infinite random tool calls (`jiku_social_list_posts` × ∞ was the observed failure).
- All action-phase steps are appended to `messages`, not just the last — otherwise with `max_tool_calls_per_iteration > 1` the next iteration sees a truncated history.
- Residual risk: phase 2 can drop a tool call occasionally on GPT. Loop exits early, user sees incomplete output. Acceptable — retry UX is less bad than infinite tool loops.

---

## ADR-053 — Harness streaming: merge UI stream BEFORE awaiting steps

**Context:** The original harness pattern was `merge(result.toUIMessageStream(...))` AFTER `await result.steps`. That works for single-tool iterations but with phase 2's `stepCountIs(N > 1)` internal chaining, UI chunks stay buffered until all N steps complete, then flush at once — producing a visible "3 tools flash in together" UX.

**Decision:** Call `sdkWriter.merge(result.toUIMessageStream({ sendFinish: false }))` IMMEDIATELY after `streamText(...)` returns, before `await result.steps`. AI SDK sequences merged streams, so phase 1 drains to UI before phase 2 starts emitting. Because every phase merges with `sendFinish: false`, a manual `ctx.sdkWriter.write({ type: 'finish' })` closes the UI message after the outer loop exits.

**Consequences:** Real-time streaming of tool calls regardless of `max_tool_calls_per_iteration`. Lost ability to gate `sendFinish` on "is this the last iteration" — replaced with the manual emit. Future finish-chunk changes go through that single call, not per-phase.

---

## ADR-054 — Plugin prompt segments labeled by `<Plugin Name> (<plugin.id>)` in preview

**Context:** Preview Context UI displayed plugin prompts as `Plugin Segment 1`, `Plugin Segment 2`, … which is opaque — user can't tell which plugin contributed what, or why a big block of tokens is being injected.

**Decision:** Added `PluginLoader.getPromptSegmentsWithMetaAsync()` which returns `{ plugin_id, plugin_name, segment }[]` (looks up `plugin.meta.name` per segment). `AgentRunner.previewRun` uses this for the plugin `ContextSegment` labels. Existing `getPromptSegmentsAsync()` kept for backwards-compat (still used elsewhere when metadata isn't needed).

**Consequences:** Preview now shows `Narration (jiku.narration)`, `Analytics (jiku.analytics)`, etc. Per-plugin token counts are instantly attributable. No DB or API schema changes.

---

## ADR-049 — Plugin tools must use `permission: '*'` to be visible to agents

**Context:** Tools registered via `ctx.project.tools.register()` go through `resolveScope` which filters by `caller.permissions.includes(tool.resolved_permission)`. The prefix function turns `permission: 'filesystem:read'` into `jiku.sheet:filesystem:read`. No caller ever has that compound permission, so the tools are silently invisible in agent tool lists, context preview, and at runtime.

**Decision:** Plugin tools that should be available to all agents unconditionally MUST use `permission: '*'`. This short-circuits the permission check in `resolveScope` the same way built-in tools (which are force-set to `resolved_permission: '*'`) bypass it. Security-sensitive plugin tools that should be explicitly gated should use `required_plugin_permission` in `ToolMeta` (Plan 18 path) rather than `permission`.

**Consequences:** Any plugin tool with a non-`*` permission that was silently invisible will need to be audited. `csv_read` and `sheet_read` fixed in this session. Check `jiku.analytics` and `jiku.social` tools if they're also invisible.

---

## ADR-051 — Custom action registry instead of per-adapter extra tools

**Context:** `BrowserAdapter` already had `additionalTools?()` that could emit fresh `ToolDefinition`s per adapter. For CamoFox (youtube_transcript, macro, links, images, downloads, stats, import_cookies) this would mean 7+ extra top-level tools per profile — tool-list bloat scales with `profile_count × action_count`, and LLM context has to load every schema upfront even when most aren't used.

**Decision:** Mirror the `ConnectorAdapter.actions` / `connector_list_actions` + `connector_run_action` pattern. Adapter declares `readonly customActions: BrowserCustomAction[]` (id + displayName + description + Zod inputSchema + example) and implements `runCustomAction(id, params, ctx)`. Two tools added globally in `buildBrowserTools()`: `browser_list_actions(profile_id?)` returns the catalog for a profile, `browser_run_action(profile_id?, action_id, params)` validates via `inputSchema.safeParse()` and dispatches.

**Consequences:** Tool count stays flat at 3 (browser, list, run) regardless of how many adapters/custom actions exist. One extra round-trip for discovery, but schema isn't loaded into every LLM turn's tool list. Adapters keep platform-specific surface without touching the shared `BrowserAction` enum. `additionalTools()` still exists for cases where an adapter needs a truly custom top-level tool (e.g. future `puppeteer_screenshot_comparison`).

---

## ADR-052 — CamoFox is REST, not CDP — plugin keeps its own HTTP client

**Context:** Initial Plan 20 assumption treated CamoFox as CDP-compatible (Firefox DevTools Protocol superset). Upstream README says otherwise — CamoFox exposes a REST API on port 9377 (`POST /tabs`, `GET /tabs/:id/{snapshot,screenshot}`, `POST /tabs/:id/{click,type,press,scroll,wait,navigate}`, `POST /youtube/transcript`, etc.). No CDP endpoint.

**Decision:** `CamofoxAdapter.execute()` does NOT delegate to `@jiku/browser`. It's a pure HTTP client with its own session/tab tracking (`userId` per profile, `sessionKey` per agent, `tabId` cached in-memory). Unsupported BrowserActions (`pdf`, `eval`, `cookies_*`, `storage`, `batch`, `drag`, `upload`, `dblclick`, `hover`, `focus`, `check`, `uncheck`, `select`, `scrollintoview`) throw clear "not supported by CamoFox" errors.

**Consequences:** Plugin has zero dependency on `@jiku/browser`. No shared mutex with `JikuBrowserVercelAdapter` — CamoFox handles its own concurrency server-side, so the plugin doesn't acquire `browserMutex`. Feature parity is intentionally partial — users pick CamoFox for anti-fingerprinting, not for every possible browser action. Future protocol additions (e.g. CDP in CamoFox v2) would need a new adapter id.

---

## ADR-053 — `@jiku/camofox` wrapper package owns the Dockerfile

**Context:** Upstream camofox-browser doesn't publish to any public registry. README tells users to `make build` locally, which bakes Camoufox binary in via their Makefile. For our stack we need a deterministic, CI-friendly build.

**Decision:** New `packages/camofox/` mirrors `packages/browser/docker/` pattern. Self-contained Dockerfile: `FROM node:20-bookworm-slim`, system deps for Firefox/Camoufox, `git clone --depth 1 --branch ${CAMOFOX_REF}`, `npm install`, `npx camoufox fetch` as `node` user (bakes Firefox binary into image), `CMD npm start`. Compose files (dokploy + dev) build from this local context with `CAMOFOX_REF` arg.

**Consequences:** Single source of truth for the image. Pin upstream via commit SHA for reproducibility. First build ~200MB image and slow (needs to download Camoufox binary), but subsequent container starts are instant (no runtime fetch). Skipping `camoufox fetch` makes the image boot-time-lighter but every POST /tabs crashes with `"Version information not found"`. We keep it in the image.

---

## ADR-054 — CamoFox cookies volume: writable, not read-only

**Context:** Upstream README mounts `~/.camofox/cookies:/home/node/.camofox/cookies:ro` — read-only, for *importing* cookies from the host. Our use case is persistence across restarts (browser keeps writing cookies during sessions).

**Decision:** Our compose files mount a named volume (`camofox-cookies`) writable at the same documented path `/home/node/.camofox/cookies` (not the broader `.camofox` parent). Override via `CAMOFOX_COOKIES_DIR` env is supported upstream if users need a different path.

**Consequences:** Matches documented CamoFox path exactly — no guessing on undocumented subdirs. Writable so REST-imported cookies and runtime-written cookies both survive container restart. Cost: if an attacker compromises CamoFox, they can write to the cookies dir. Acceptable for our threat model (container already has full browser access).

---

## ADR-055 — Adapter config UI driven by Zod schema reflection

**Context:** Add Profile modal originally had three hardcoded input kinds (bool/number/string). Field type detection was broken because `serializeAdapter` called `typeName.toLowerCase()` on `ZodOptional` → `"optional"` — every field fell into the string branch. Even with the reflection bug fixed, users got empty inputs with no defaults, no labels, no hints.

**Decision:** Backend `unwrapZod()` walks `ZodOptional`/`ZodDefault`/`ZodNullable`/`ZodEffects` to the leaf and extracts: inner type, optional flag, default value, min/max, description, enum options. Frontend shared `ConfigField` component renders: Switch for booleans, numeric Input with `min`/`max`/`step` for number/integer, Select for enums, Input for strings. Humanizes keys (`timeout_ms` → "Timeout (ms)"). Defaults become placeholders. `initialConfigFor()` prefills modal state with all declared defaults so the form is never empty. Adapters drive UX by adding `.describe(...)` + `.default(...)` to each Zod field — no per-field React code.

**Consequences:** New adapters get a usable UI for free by writing rich Zod schemas. No brittle frontend switch statements per adapter. Loss: JSON-schema corner cases (unions, discriminated unions, records) aren't handled yet — adapters stick to flat ZodObject of primitives for now.

---

## ADR-050 — Chat route: frontend sends only last user message, server loads history from DB

**Context:** `useChat` from `@ai-sdk/react` sends the full `messages` array on every request by default. For long conversations with large tool results (e.g. sheet data with hundreds of rows), the body grew to 200KB+ and hit the 100KB `express.json()` limit. The server never used `messages` beyond extracting the last user message text and its file parts — full history was already in the DB via `StudioStorageAdapter`.

**Decision:** `prepareSendMessagesRequest` in both chat components filters to `[lastUserMessage]` only. Body size is now O(1) regardless of conversation length. The 10MB limit is kept as a safety net for edge cases (large file attachments in the message part). No server changes needed — the server already only reads `lastUser` from the array.

**Consequences:** Any future feature that needs to send additional client-side context (e.g. draft state, optimistic UI data) must add it as explicit extra fields in the body, not via the `messages` array.

---

## ADR-048 — Skills loader: DB is a cache, filesystem is the authority

**Context:** Plan 15 stored skill content in DB. Plan 19 needed to accept external
skill packages (from skills.sh, vercel-labs/agent-skills, GitHub repos, plugins
contributing their own skills) which naturally live as folders with `SKILL.md`.
Continuing DB-as-source made every external import a sync step with its own
consistency problems. Alternative: drop DB entirely and scan filesystem per-request.

**Decision:** `project_skills` becomes a **cache** of parsed manifests, not the
source of truth. Unique key shifts from `(project_id, slug)` to
`(project_id, slug, source)` to let FS and plugin sources coexist for the same
slug. Columns added: `manifest` (jsonb), `manifest_hash`, `source` (`fs` or
`plugin:<id>`), `plugin_id`, `active`, `last_synced_at`. SkillLoader syncs cache
on project wakeUp and on plugin activate/deactivate. Entrypoint default bumped
`'index.md'` → `'SKILL.md'` but legacy honored.

**Consequences:**
- Single source of truth = `/skills/<slug>/SKILL.md` content. Users can edit
  skills via git, file explorer, or UI; all roads lead to the same file.
- Cache-invalidation strategy: SHA-ish `manifest_hash` compared on sync. Simple
  djb2 hash, not cryptographic — plenty for change detection.
- Plugin deactivate sets `active=false` instead of deleting rows, so
  `agent_skills` assignments survive re-activation.
- Harder to query "all skills" without the loader warm — but `getActiveSkills()`
  is a simple SQL query over the cache.
- Backward compat: existing FS-only skills were already stored at
  `/skills/<slug>/` since Plan 14, so no data migration needed.

## ADR-047 — Dreaming model config: credential + model_id, not abstract tier

**Context:** Plan 19 original spec proposed `model_tier: 'cheap' | 'balanced' | 'expensive'`
with a project-level model router mapping tiers to concrete models. We don't have
a project-level model router — models are resolved per-agent via `agent_credentials`.
The initial implementation fell back to "use first agent's credential" which was
a leaky abstraction: admin couldn't actually pick which model dreaming used.

**Decision:** Replace `model_tier` with explicit `credential_id` + `model_id` at
two levels: dreaming-level default, optional per-phase override. UI uses the
same `CredentialSelector` + `ModelSelector` components as the agent LLM page,
so the mental model is identical. Backend `resolveDreamingModel()` cascades
phase → dreaming default → legacy first-agent fallback.

**Consequences:**
- Zero magic: user picks exactly the model dreaming runs on, with the same
  provider-scoped credentials they already manage.
- Per-phase override stays in the schema but is NOT exposed in UI yet (YAGNI
  until a real use case emerges — most teams want the same model for all phases).
- Legacy fallback means existing projects without `credential_id` keep working;
  they see a quiet warning in server logs and the admin can set credential when
  they open the tab.
- `DreamingModelTier` export retained in `@jiku/types` as `@deprecated` so
  external callers (unlikely but possible) don't hard-break.

## ADR-046 — Reflection trigger counts user turns, not LLM steps

**Context:** `FinalizeHook` fires per-run (one user message → one assistant
response = one run). The reflection handler was configured with
`min_conversation_turns` and initially passed `steps.length` (internal LLM
step count including tool calls) as `turn_count`. Result: a conversation with
5 user messages never reached the threshold because each run only had 1-2
steps. Alternative: count conversation turns in the finalize hook and pass as
payload.

**Decision:** Handler re-fetches `getMessages(conversation_id)` from DB and
counts `role='user'` rows directly. Payload `turn_count` field removed.
Idempotency key changed from `reflection:<conv>:<turns>` to
`reflection:<conv>:<minuteBucket>` to prevent multiple fires per minute while
still allowing growing conversations to re-reflect.

**Consequences:**
- Semantics match user mental model: "at least 3 messages before reflecting".
- One extra `getMessages()` per reflection — acceptable (this path is already
  off the request critical path).
- Minute-bucket idempotency is coarser than per-turn but correct: multiple
  fast-succeeding runs in the same minute are de-duped; over time, the handler
  still runs and the semantic dedup (cosine ≥ 0.9 against existing reflective
  memories) prevents duplicate insertion even across minute boundaries.

## ADR-045 — Universal `recordLLMUsage` helper, no per-caller ad-hoc logging

**Context:** Post-Plan 19, LLM calls happen from 7+ places: chat runner, task
runner, title gen, reflection handler, dreaming (×3 phases), and soon
plugin-invoked calls. Before, only the chat route persisted `usage_logs` (task
runner didn't log at all). Without a central helper, each caller would roll
its own DB insert and the cost dashboard would quietly under-report.

**Decision:** Single fire-and-forget helper at
`apps/studio/server/src/usage/tracker.ts#recordLLMUsage()`. Accepts a
`source` enum (`chat` | `task` | `title` | `reflection` | `dreaming.{light,deep,rem}`
| `flush` | `plugin:<id>` | `custom`), optional `agent_id`/`conversation_id`,
required-when-known `project_id`, provider/model, token counts, duration,
and optional raw prompt/messages. Schema migration `0014_plan19_usage_logs_expand.sql`
makes `agent_id`+`conversation_id` nullable and adds `project_id` + `source` +
`duration_ms`. Convention codified in `docs/builder/memory.md` — new LLM paths
MUST use this helper or the cost dashboard silently under-reports.

**Consequences:**
- Project-level usage totals now cover background jobs and plugin-invoked
  calls. Union query in `getUsageLogsByProject` matches by `project_id` OR
  agent FK to handle both legacy rows and new null-agent rows.
- Raw system prompt + messages captured for debug — Raw Data dialog in UI
  surfaces the actual LLM exchange.
- Duration tracked → UI can show speed per source and catch pathological slow
  calls.
- Agent-scoped `/agents/:id/usage` page intentionally does NOT union null-agent
  rows — that view is agent-specific by definition. Project page is the
  all-sources view.

## ADR-044 — Background LLM jobs use durable queue, never inline enqueue + handler

**Context:** Reflection, dreaming, and compaction-flush all run LLM calls that
take seconds-to-minutes. Running them inline on the chat response path would
hold the user stream open. In-memory fire-and-forget (`setImmediate` / unawaited
promise) risks losing work on crash. Alternative durable approaches: external
queue (Bull/BullMQ/Redis), pg_cron, or a simple `background_jobs` table with
a tick-based worker.

**Decision:** New `background_jobs` table + in-process `BackgroundWorker` class.
Worker ticks every 5s, atomically claims one pending job via
`UPDATE ... WHERE id = (SELECT id ... FOR UPDATE SKIP LOCKED LIMIT 1) RETURNING *`,
runs the registered handler for that type, marks completed or retries with 30s
backoff (up to `max_attempts=3`). `enqueueAsync()` only INSERTs — the caller
never awaits handler execution. Runner is required to close its stream BEFORE
calling enqueue. Documented as HARD RULE in `docs/feats/memory.md` "Background
Jobs Contract".

**Consequences:**
- Zero user-visible latency from reflection/dreaming — measured `finalize()`
  completion is DB-INSERT time only.
- Jobs survive crash; worker resumes on next boot. Attempts/backoff/error
  stored on row.
- SKIP LOCKED is safe under multiple worker instances (future scale-out),
  though we run single-instance today.
- Idempotency keys on `memory.flush` (content-hash) and `memory.reflection`
  (minute-bucket) prevent duplicate work from retry storms or rapid-succession
  enqueues.
- No external Redis dependency — aligns with self-hosted Dokploy target.
- Trade-off: pg-as-queue doesn't scale to 1000+ jobs/sec, but at that scale
  we'd already need rearchitecture anyway.

## ADR-043 — Settings navigation: vertical sidebar with Access Control grouping

**Context:** Settings had 7 horizontal tabs (General, Credentials, Permissions, Policies, MCP, Plugin Permissions, Audit Log) after Plan 18 landed. Admins had trouble reasoning about overlap between Policies (runtime rule engine) and Plugin Permissions (static capability grants) because they were presented as peer tabs with no visual relationship, and Members/Roles/Agent Access lived as internal sub-tabs of one "Permissions" page — invisible from the top nav.

**Decision:** Replace the horizontal Tabs bar with a **GitHub-style vertical sidebar** (`settings/layout.tsx`). Three groups with uppercase mini-headings:

- **Project** — General, Credentials, MCP Servers
- **Access Control** — Members, Roles, Agent Access, Policies, Plugin Permissions
- **Observability** — Audit Log

Memory and Filesystem configs intentionally excluded from Settings — they already live on dedicated `/memory` and `/disk` pages. Members / Roles / Agent Access stay on one URL (`/settings/permissions`) but the internal `<Tabs>` is now **URL-controlled** via `?tab=roles` / `?tab=agents`, so sidebar links deep-link and highlight the correct sub-tab.

**Consequences:**
- All permission-related configuration is discoverable in one visual group, with a clear semantic gradient (members → role → agent scope → runtime rules → plugin capability).
- Policies vs Plugin Permissions distinction becomes obvious by position alone — you see them in a single sidebar column, not two hops apart.
- Internal state of `/settings/permissions` is now URL-synced — deep links into a specific sub-tab work and can be bookmarked.
- Slight duplication in the sidebar (three links pointing at the same URL with different `?tab=`), but this is intentional — each feels like its own nav entry to the user.

## ADR-042 — Plan 18 plugin permission model: per-member grant, not per-project

**Context:** Plan 17 introduced a `project_plugins.granted_permissions` jsonb column, granting capabilities project-wide. Plan 18 required per-member enforcement so that e.g. "Jane can send Telegram messages but Bob cannot" within the same project. Option A: extend the jsonb blob with member filters. Option B: new normalized table.

**Decision:** New table `plugin_granted_permissions(project_id, membership_id, plugin_id, permission, granted_by, created_at)` with unique constraint `(membership_id, plugin_id, permission)`. Enforcement lives in `packages/core/src/runner.ts` which checks `caller.granted_plugin_permissions` against `tool.meta.required_plugin_permission` before `execute()`; superadmin bypasses. `RuntimeManager.run()` enriches the caller with `getGrantedPluginPermissions(user_id, project_id)` + `membership.is_superadmin` on every run.

**Consequences:**
- Per-member granularity without reshaping the Plan 17 jsonb column — both coexist; the new table is the source of truth for Plan 18 enforcement.
- Foreign key `membership_id` cascades on membership delete, so removed members automatically lose all grants.
- `project_plugins.granted_permissions` is effectively deprecated as an enforcement mechanism going forward, but left in place for Plan 17 backwards compat. Consider dropping in a later sweep.
- New `ToolMeta.required_plugin_permission` field is opt-in — tools without it bypass enforcement. This preserves the default-open behavior of existing tools until plugin authors explicitly mark sensitive ones.

## ADR-041 — Plan 18 audit logging: new broad table, coexist with plugin_audit_log

**Context:** Plan 17 shipped a `plugin_audit_log` table scoped to plugin actions (tool.invoke, file.write, secret.get, api.call). Plan 18 needs audit coverage for auth events, member changes, permission changes, broader filesystem events, agent lifecycle — none of which fit the plugin_id-keyed schema. Options: extend plugin_audit_log (make plugin_id nullable, rename), or introduce a second table.

**Decision:** New table `audit_logs` with richer schema — `actor_type`, `resource_type` + `resource_id` + `resource_name`, structured `metadata jsonb`, plus `ip_address` + `user_agent`. All Plan 18 coverage writes to `audit_logs` via `insertAuditLog()` + the `audit.*` convenience helpers in `apps/studio/server/src/audit/logger.ts`. Tool invocations are captured here too via `ToolHooks` in the core runner. The old `plugin_audit_log` and its `writeAuditLog`/`listAuditLog` functions remain untouched — plugin-ui.ts still writes to them for backwards compat.

**Consequences:**
- Two audit tables during the transition. Read-side (`settings/audit` UI) only reads `audit_logs`; plugin-ui's own audit viewer still reads the old table. No migration/backfill between them.
- Future cleanup: a later sweep can fold plugin_audit_log into audit_logs once the UI no longer depends on it — the `event_type` field already supports `tool.invoke` so the data shape is compatible.
- Fire-and-forget writes — audit failures never block request flow, only log a warning. Trade: occasional missing log entries under DB pressure, versus never-failing user operations.

## ADR-040 — Plugin UI asset serving: signed URLs instead of per-request auth

**Context:** Plugin UI bundles are served at `/api/plugins/:id/ui/*.js` and loaded by the browser via dynamic `import(url)`. Dynamic import cannot attach an `Authorization` header, so the endpoint must either be public or carry auth inside the URL. A naive public endpoint exposes enumeration, DoS, and accidental-secret-leak risk.

**Decision:** **HMAC-signed URLs with 10-minute TTL.** The authed `ui-registry` endpoint mints `?sig=<HMAC>&exp=<epoch>` over `(pluginId, file, exp)` using `JWT_SECRET`. The asset router (`apps/studio/server/src/routes/plugin-assets.ts`) verifies the signature before streaming. Signatures are bound to a specific file; URL replay for a different asset is rejected. Complemented by an in-memory 120 req/min per-IP rate limiter and a `.map` serving gate (404 in production). `.map` files in dev are served unsigned so DevTools can fetch them (still rate-limited + path-traversal-guarded). See `docs/dev/plugin/security.md` for the full threat model + operator notes.

**Consequences:**
- Public URL but not anonymous — every served request traces back to a registry fetch during an authed session.
- TanStack Query `staleTime: 30s` on ui-registry keeps sigs rotated before expiry.
- Plugin bundles are still readable by any authed Studio user (signed URL ≠ per-user ACL); the do-not-do checklist in `docs/dev/plugin/security.md` makes this explicit.
- `JWT_SECRET` must be a strong random value in production — documented.

## ADR-039 — Plugin UI dev tooling lives in `apps/cli`, not `@jiku/kit`

**Context:** Plan 17 needs a developer CLI (build, watch, scaffold plugins, inspect manifest). Putting the code in `@jiku/kit` would work, but `@jiku/kit` is imported by the web client — anything shipped there is a potential client bundle inclusion. The CLI depends on tsup, Ink, commander, child_process — all Node-only, all dev-time. Leaking them to the browser bundle is wrong on principle and wastes bytes in practice.

**Decision:** New workspace app at `apps/cli/` (package `@jiku/cli`, binary `jiku`). Depends only on `@jiku/core` + `@jiku/types` + dev-time libs (commander, Ink, tsup, React for Ink). Apps/studio/server and apps/studio/web do NOT depend on it. Root `package.json` exposes `bun run jiku` as a convenience runner.

Commands: `jiku plugin list|info|build|watch|create`, interactive Ink TUI as default entry. Placeholder namespaces (`agent`, `db`, `dev`) reserved for future growth.

**Consequences:**
- Zero risk of tsup/Ink/commander leaking to client.
- CLI can grow into a general Jiku dev tool beyond plugin management without disturbing runtime packages.
- `build` / `watch` detect cwd: running from inside a plugin folder scopes to that plugin; from the root, all plugins.
- The old `build:plugins` / `watch:plugins` root scripts removed — one obvious way to do it.

## ADR-038 — `@jiku-plugin/studio` uses `contributes`/`depends`, not TS module augmentation

**Context:** Studio-host-specific ctx fields (`ctx.http`, `ctx.events`, `ctx.connector`, and UI-side `ctx.studio.api`) shouldn't live in `@jiku/types` because that package is host-agnostic shared runtime types. A naive first attempt used `declare module '@jiku/types'` augmentation inside `@jiku-plugin/studio` to add these fields. This worked but (a) bypassed the plugin system's existing `contributes` mechanism, which already does exactly this, and (b) is harder to discover via IDE navigation and TS error messages.

**Decision:** Use the plugin system's native `contributes` + `depends` inference. `@jiku-plugin/studio` declares `contributes: () => ({} as unknown as StudioContributes)` — an empty object at runtime but typed as `{ http, events, connector }`. Plugins that `depends: [StudioPlugin]` get `MergeContributes<Deps>` applied to their `setup(ctx)` parameter, so `ctx.http` / `ctx.events` / `ctx.connector` are typed and non-optional.

Runtime values continue to come from the Studio server's context-extender (`apps/studio/server/src/plugins/ui/context-extender.ts`) — per-plugin HTTP handler maps, event emitters, connector register closures. The loader's spread order `{ ...extended, ...mergedFromDeps }` means contributes's empty object does NOT clobber the extender's real bindings.

Browser-side: `@jiku-plugin/studio` exports `StudioPluginContext = PluginContext & { studio: PluginStudioHost }` and `StudioComponentProps = PluginComponentProps<StudioPluginContext>`. Plugin UI authors type their components with `StudioComponentProps` — the generic on `defineMountable<C>` infers `C = StudioPluginContext` automatically.

Also required a one-line relaxation: `ContributesValue = object` (was `Record<string, unknown>`) in `@jiku/types`, so concrete interfaces like `StudioContributes` satisfy the constraint without needing an index signature.

**Consequences:**
- Types flow through the same mechanism as plugin dependencies — one thing to learn, not two.
- `depends: [StudioPlugin]` doubles as a runtime dependency signal: if a host doesn't have the extender, `ctx.http` is still typed but undefined at runtime — plugins can (and should) use optional-chaining for portability.
- Connector functionality (`ctx.connector.register`) moved from `plugins/jiku.connector/` into `@jiku-plugin/studio.contributes`; that plugin was deleted. Telegram's `depends: [ConnectorPlugin]` became `depends: [StudioPlugin]`.

## ADR-037 — Plugin UI runtime isolation: tsup bundles + own React + dynamic URL import

**Context:** The original Plan 17 spec called for ESM native + import map + dynamic `import(url)` + Vite preset + per-plugin SRI. The first implementation cut corners with a "workspace component registry" (ADR-PLUG-17-A): plugin UI modules imported as TS source into Studio's Next.js build, tree-shaken by Next, resolved at render via a string → lazy-import map. This worked but **coupled plugin TS errors to Studio's build** — a type error in a plugin broke `next build`. Not acceptable.

**Decision:** Commit to the spec's isolation pattern. Each plugin:

1. Has a `tsup.config.ts` that builds `src/ui/*.tsx → dist/ui/*.js` as self-contained ESM with `noExternal: [/^@jiku\//, /^@jiku-plugin\//, 'react', 'react-dom', 'react-dom/client']`. The bundle carries its OWN React + ReactDOM + `@jiku/kit/ui` copies.
2. Default-exports a `Mountable = { mount(el, ctx, meta, subPath) => unmount }` via `defineMountable(Component)`. The host creates a `<div>` and calls `mount(el, ctx, ...)`, which spins up a separate React root inside that div.
3. Registry manifest (`GET /api/plugins/ui-registry`) includes `assetUrl` pointing to `/api/plugins/:id/ui/<module>.js` (served from `plugins/<id>/dist/ui/`).
4. Studio web loads the bundle via opaque dynamic import: `new Function('u', 'return import(u)')(url)` — bypasses Turbopack's bundle-time resolver so the URL stays runtime-only.

Guarantees:
- **Build isolation.** Studio's Next.js never touches plugin source — plugin TS errors can't break Studio's build.
- **Runtime isolation.** Plugin's own React instance means a render crash is caught by the host `PluginErrorBoundary` at the island boundary. Studio's React tree stays clean.
- **Hot reload.** `invalidatePlugin(id)` in `mount-runtime.ts` bumps a per-plugin counter; `usePluginBustVersion(id)` subscribes via `useSyncExternalStore`; all islands of that plugin re-fetch a fresh bundle on next render. Zero Studio restart.

**Consequences:**
- Each plugin bundle carries ~50KB React. Acceptable for isolation; first-party plugins ship few bundles.
- Context hooks like `usePluginQuery` are implemented with plain `useState` + `useEffect` (not TanStack Query) so they work with the plugin's own React instance — no cross-instance context sharing.
- `ctx` is passed as a plain object to the mount call (not via React context), since cross-React-instance context is impossible.
- ADR-PLUG-17-A (workspace component registry) is **superseded** — its `registerPluginComponent` / `lib/plugins/built-in.ts` barrel was removed.

## ADR-036 — Browser concurrency: per-project mutex + per-agent tab affinity

**Context:** With Plan 33 shipped, the browser tool became usable end-to-end
— but a project can have many agents, and agent-browser only operates on a
single "active tab" per CDP endpoint. Two agents calling the browser tool
concurrently would race on shared state with no warning: element refs from
a snapshot would go stale, fills would overwrite each other, navigations
would interleave. There was no lock, no queue, no isolation.

We considered three approaches:

- **A) Per-project queue + shared single tab.** Cheap. Single shared session.
  Acceptable for collaborative agents but bad for "Agent A on Tokopedia,
  Agent B on Shopee" — they tab-collide on every navigation.
- **B) Per-project queue + per-agent tab affinity.** Each agent gets its own
  chromium tab; the queue only serializes commands at the chromium level.
  Same isolation a real multi-tab session gives, no throughput parallelism.
- **C) Container pool — N chromium containers per project, agent assigned
  to a container.** True parallelism. ~500 LoC pool manager + ~300MB RAM
  per container. Overkill at current scale.

**Decision:** Option B. Implementation in
`apps/studio/server/src/browser/{concurrency,tab-manager}.ts`:

1. **`KeyedAsyncMutex`** (~50 LoC, no dependencies) keyed by `projectId`.
   Every browser command acquires the lock before talking to chromium;
   different projects don't block each other. The `/preview` endpoint
   acquires the same lock so it can't race with agent commands.
2. **`BrowserTabManager`** tracks one tab per agent as an ordered list per
   project (index 0 = system tab from container startup, index 1..N = agent
   tabs). The mutex guarantees indexes stay coherent. Capacity hard-cap of
   10 tabs per project; LRU eviction on overflow.
3. **`tab_*` and `close` actions are reserved.** The dispatcher rejects
   them so the LLM can't desync our index tracking. The actions still exist
   in `BROWSER_ACTIONS` for parity with `BrowserCommand` but throw a clear
   error at runtime.
4. **Idle eviction.** `startBrowserTabCleanup()` runs every 60s and closes
   tabs idle > 10 minutes inside the per-project mutex. The interval is
   `unref()`'d so it doesn't pin the event loop.
5. **Lifecycle hooks.** `runtimeManager.sleep(projectId)` and the browser
   config PATCH routes call `browserTabManager.dropProject(projectId)` to
   invalidate stale indexes when state could have changed underneath us.
6. **Diagnostic endpoint.** `GET /browser/status` returns the mutex busy
   flag, the tab table, and the capacity counters. The Browser settings
   page renders a Debug panel that polls it every 2 seconds.

**Consequences:**
- Multiple agents in one project can use the browser tool without colliding,
  even when their commands interleave. Element refs are guaranteed valid
  for the next command in the same agent's sequence.
- No throughput parallelism within a project — commands run one at a time.
  Acceptable: most browser commands are I/O-bound (200ms-2s) and the
  realistic concurrency level on a single project is low.
- Two agents in different projects don't block each other (mutex is per-key).
- In-memory mutex doesn't coordinate across multiple Studio server
  instances. Current deployment is single-server, so not an issue.
- Cookies are still shared at the chromium profile level (chromium
  constraint, not Studio's). Two agents logging into different gmail
  accounts on the same project will collide; workaround is to put them in
  separate projects.
- Migration path to container pool (Option C) is straightforward later: the
  pool manager just owns N CDP endpoints + N mutex keys, the rest of the
  logic is unchanged.

---

## ADR-035 — Browser automation rebuilt as @jiku/browser CLI bridge (Plan 33)

**Context:** Plan 13 (ADR-026) failed: ~80 files of OpenClaw engine code ported into `apps/studio/server`, headless-only, untestable, schema enum drift. Needed a clean replacement that's actually visible in noVNC, has tests, and is decoupled from Studio internals.

**Decision:** Build a standalone `packages/browser/` package as a CLI bridge to Vercel `agent-browser` (Rust binary) over CDP. Studio integration lives in `apps/studio/server/src/browser/` and only contains the tool definition + dispatch + screenshot persistence — no engine code. The Docker container is owned by the package, not by Studio. Three rules locked in by experience:

1. **CDP-only project config.** A single `cdp_url` per project. No managed mode, no headless toggle, no executable path. Plan 13's config sprawl is gone.
2. **Tool input schema is a flat `z.object`.** OpenAI's function calling API rejects schemas without `type: "object"` at the JSON Schema root. A `z.discriminatedUnion` serializes to `anyOf` and breaks this. Per-action requirements are validated at runtime by a `need()` helper, with a `never`-typed default branch for compile-time exhaustiveness over `BrowserAction`.
3. **Chromium in Docker uses `--no-sandbox`.** Docker Desktop on macOS/Windows doesn't expose unprivileged user namespaces, so the zygote dies without it. The container itself is the isolation boundary, so this is safe and standard.

Screenshots are persisted via the unified `persistContentToAttachment()` from ADR-034 and returned as `{ type: 'image', attachment_id, storage_key, mime_type }`. The settings page has a Live Preview box (one-shot screenshot, optional 3s auto-refresh) so users get visual confirmation without opening noVNC separately.

**Consequences:**
- Browser feature is genuinely production-grade end-to-end: backend, API, UI, container, docs.
- ~9000 lines of OpenClaw port replaced by ~600 lines of package + ~400 lines of Studio integration. 52 tests in `packages/browser/src/tests`.
- Future tool authors must use a flat `z.object` for OpenAI compatibility — documented in `docs/builder/memory.md` to prevent regression.
- Single active tab limitation remains. True multi-user requires a container per user; deferred.

---

## ADR-034 — Content references use attachment_id + storage_key, never URLs

**Context:** Binary content (screenshots, generated files, tool outputs) were stored as inline base64 in tool output parts or as URLs in database records. URLs are fragile (domain changes, proxy endpoint changes break data). Inline base64 wastes 33% space and bloats LLM context window.

**Decision:** All binary content references in DB (conversation_messages.parts, tool outputs) use the shape `{ type: 'image', attachment_id, storage_key, mime_type }`. No URL, no base64 data is stored. URL generation happens exclusively at two points: (1) UI rendering layer builds `<img src>` URLs on-demand from `attachment_id`, (2) LLM delivery resolves attachment references to base64 or proxy URL based on `agent.file_delivery` config. Storage key format is standardized: `jiku/attachments/{projectId}/{scope}/{uuid}.{ext}`.

**Consequences:** Data is portable — export conversation, change domains, import, all references remain valid. Single source of truth for content format across stream, DB, and UI. Slight complexity increase: rendering layer must resolve references on-demand, and LLM delivery must resolve before API calls. Trade-off is worth it for data integrity and context efficiency.

---

## ADR-033 — Credential resolution always uses getAvailableCredentials (company + project union)

**Context:** Features that resolve credentials at runtime (embedding API key, LLM provider, etc.) were using `getProjectCredentials(projectId)` which only returns credentials scoped to the project. Users creating credentials at company level (a common pattern for shared API keys like OpenAI) got "no credential found" errors.

**Decision:** Any runtime credential resolution must use `getAvailableCredentials(companyId, projectId)` which returns a union of company-level and project-level credentials. `companyId` is looked up from the project row. Frontend pickers must use `api.credentials.available(projectId)` (hits `/api/projects/:pid/credentials/available`) instead of `api.credentials.listProject`.

**Consequences:** Company credentials (defined once per company) are now visible to all their projects. No more "add credential to every project" workaround. This is the correct inheritance model — applies to embedding, future LLM key resolution, and any other credential-dependent feature.

---

## ADR-032 — LLM memory extraction removed; explicit tool calls only

**Context:** `extractMemoriesPostRun()` ran a small LLM call after each conversation to auto-extract facts into memory. It caused duplicate memories because the extraction ran before tool-saved memories from the same run had committed in the DB (stale read window). Also: OpenClaw doesn't use auto-extraction; explicit tool calls are the correct model.

**Decision:** Remove `extractMemoriesPostRun()` and `extractPersonaPostRun()` from the run lifecycle entirely. Agents must explicitly call `memory_core_append`, `memory_extended_insert`, etc. to persist facts. The `extraction` block in `ResolvedMemoryConfig` is kept in types for future opt-in use but is not evaluated.

**Consequences:** No more silent duplicate memories. Agent behavior is fully deterministic and auditable via tool calls. Agents need to be prompted explicitly to use memory tools when persistence matters.

---

## ADR-031 — Browser automation: CLI bridge to agent-browser instead of OpenClaw port

**Context:** Plan 13 ported OpenClaw browser engine (~9000 lines, ~80 files) directly into `apps/studio/server`. It failed because Playwright spawned a headless process instead of connecting to the visible Chromium in the Docker container. CDP attach mode silently fell back to headless, so users saw no browser activity in noVNC.

**Decision:** Replace with `@jiku/browser` package — a thin CLI bridge to [Vercel agent-browser](https://github.com/vercel-labs/agent-browser) (Rust binary). Each command spawns `agent-browser --cdp <endpoint> --json <action>`. CDP connection goes through a socat proxy in Docker to make Chrome's HTTP `/json/version` API accessible from outside the container. Pre-connect pattern used (`agent-browser connect <endpoint>` once per endpoint) because `--cdp` alone fails on first use. Screenshots return base64 instead of file paths — client handles persistence.

**Consequences:**
- ~600 lines vs ~9000 — massively simpler, testable (52 tests)
- Stateless per command — no persistent page state between calls (console logs, network requests lost)
- Depends on agent-browser binary (Rust, installed via npm)
- Single active tab constraint — concurrent users on same profile will conflict
- Tool definition lives in `apps/studio/server`, not in the package (clean separation)

---

## ADR-030 — Cron task permissions: caller context snapshotted at creation

**Context:** Cron tasks run periodically on behalf of the original creator. If the creator's role later changes (e.g. demoted from superadmin to member), should the cron task still have access to previous permissions?

**Decision:** Snapshot the caller context (`caller_id`, `caller_role`, `caller_is_superadmin`) at creation time and store in the `cron_tasks` table. Permission checks use the snapshotted context, not the current user state. This ensures:
- Cron tasks execute with predictable permissions regardless of later role changes
- Simplified permission model: superadmin can modify all tasks; non-superadmin can only modify their own tasks, but only if role unchanged (security gate)

**Consequences:** Cron task permissions are immutable after creation. If a user loses superadmin status, their snapshotted tasks retain their original privilege level during scheduled execution. This is acceptable for a studio-internal tool where users are trusted. For public APIs, a role-change hook could re-validate task permissions before execution.

---

## ADR-029 — Cron Task System architecture: croner for scheduling, cronstrue for display

**Context:** Need to schedule recurring tasks and display cron expressions in human-readable form.

**Decision:** 
- Server uses `croner@10.0.1` for parsing and scheduling cron expressions (CRON syntax) in `CronTaskScheduler` class
- Web frontend uses `cronstrue@3.14.0` for displaying expressions in English (e.g., "Every Monday at 9:00 AM")
- Two separate libraries for different purposes: scheduling vs display

**Consequences:** Cron expression validation happens server-side when tasks are created/updated. Frontend displays human-readable descriptions via `CronExpressionInput` component (real-time feedback, green/red validation). If cron expression syntax changes, only the server needs updating; frontend cronstrue will adapt on next parse.

---

## ADR-027 — Conversation title generation is fire-and-forget, non-blocking

**Context:** Conversations need human-readable titles instead of generic labels. Options: generate title synchronously (blocks chat response), or asynchronously (responsive but title may appear with a delay).

**Decision:** Title generation runs asynchronously after the first message is stored. The HTTP response is not blocked. The title is generated using the agent's own configured LLM via the same `buildProvider()` and `resolveAgentModel()` dynamic provider pattern used by chat runs. Max 50 characters.

**Consequences:** Chat UX remains fast (first message response is not delayed). Titles appear after a brief moment (50–500ms depending on LLM response time). If generation fails (credential not assigned, LLM error), the title remains null — no error is exposed to the user. This is acceptable because the conversation is still usable even without a title.

---

## ADR-028 — Conversation soft delete via deleted_at column

**Context:** Conversations can be deleted from the UI. Hard delete loses history permanently. Soft delete preserves data for audit/analytics while removing conversations from the user-facing list.

**Decision:** Add `deleted_at timestamptz | null` column. `DELETE /conversations/:id` sets `deleted_at = now()`. All query operations (`getConversationsByProject`, etc.) filter `WHERE deleted_at IS NULL`. Frontend displays a delete confirmation (`AlertDialog`) before triggering the delete.

**Consequences:** Deleted conversations remain in the DB but never appear in the conversation list or UI. Soft delete is permanent from the user's perspective (no undelete button in the current UI). If needed in the future, undelete is easy to implement (clear the `deleted_at` column).

---

## ADR-026 — Browser automation (Plan 13) abandoned — to be removed at MVP

> **STATUS: RESOLVED 2026-04-09 by Plan 33.** OpenClaw port was deleted, replaced
> by `@jiku/browser` (CLI bridge to Vercel agent-browser) + hardened Docker
> container + flat Zod tool schema. See ADR-035 for the design of the
> replacement and `docs/plans/impl-reports/13-browser-implement-report.md`
> for the full arc.

**Context:** Plan 13 implemented browser automation using the ported OpenClaw engine. The goal was to let the AI control the visible Chromium browser running in the LinuxServer/noVNC container (visible at localhost:4000) so users can watch the AI browse in real time.

**Decision:** Feature is marked FAILED and will be removed before MVP release. The implementation does not meet planning requirements:
- The browser tool launches a headless Playwright-managed Chromium (new process), not the visible one at localhost:4000.
- CDP remote attach mode (`BROWSER_CDP_URL=http://browser:9223`) fails silently — the `chromium-cdp.sh` init script does not execute inside the LinuxServer container, so no CDP endpoint is exposed on port 9222. The system falls back to headless mode without warning.
- Users see no browser activity in the noVNC viewer; AI automation happens invisibly in a headless process.

**Consequences:** All browser-related code (`apps/studio/server/src/browser/`, browser tool injection in `manager.ts`, browser settings page) must be deleted before MVP. Corresponding DB config columns and routes should also be removed in the cleanup pass.

---

## ADR-025 — Chat attachments are ephemeral, separate from project_files

**Context:** Chat messages can include image uploads. Two options: store in the virtual filesystem (project_files) or a separate ephemeral table. Virtual disk files are persistent and addressable by agents via fs_* tools — not appropriate for transient chat images.

**Decision:** Separate `project_attachments` table. S3 key layout `jiku/attachments/{projectId}/{conversationId}/{uuid}.{ext}` allows bulk-delete by conversation. Schema includes `scope: 'per_user' | 'shared'` for future multi-user access control.

**Consequences:** Agents cannot see chat attachments via `fs_read` — only via image content in the AI message. Chat images don't pollute the virtual disk. Deletion can be done per-conversation (e.g. on conversation delete). Binary files (images) are explicitly allowed here, unlike virtual disk which is text-only.

---

## ADR-024 — Filesystem route is /disk, not /files

**Context:** Plan 14 originally named the UI route `/files`. Conflict: agent has an `/agents/[agent]/files` page (for future agent-scoped files). Also `/files` is ambiguous — does it mean project files or all files?

**Decision:** Route the virtual disk file manager at `/disk`. Settings at `/settings/filesystem`. Sidebar label "Disk". This makes it clearly refer to the project-level virtual storage, not a generic file concept.

**Consequences:** URL is `/projects/[project]/disk` — memorable and distinct. Settings lives at `/settings/filesystem` to match the DB config table name `project_filesystem_config`.

---

## ADR-023 — Browser engine as ported OpenClaw code, not plugin

**Context:** Browser automation requires deep Playwright integration (~80 files). Plugin system is designed for lightweight, composable capabilities. Porting as a plugin would require wrapping the entire browser server lifecycle in plugin hooks — forcing the plugin system to manage process lifecycle, which it was not designed for.

**Decision:** Browser engine lives in `apps/studio/server/src/browser/` as a server-layer feature, identical to how memory and filesystem are structured. Browser tools are injected as `built_in_tools` at `wakeUp()`. OpenClaw browser engine files are ported verbatim (only import paths changed).

**Consequences:** ~91% is ported code; only ~9% is new glue code. Browser feature cannot be enabled/disabled via plugin toggle — only via project settings. Per-project browser server isolation via unique port per project.

---

## ADR-022 — Filesystem content cache: files ≤ 50 KB stored in DB

**Context:** Reading a file requires an S3 round-trip on every `fs_read` call. For small text files (code, configs, markdown) this adds 50–200ms latency and unnecessary S3 API calls.

**Decision:** Files ≤ 50 KB have their content stored in `content_cache text` column on `project_files`. On `write()`, if `sizeBytes <= 50_000`, the content is cached. On `read()`, `content_cache` is returned directly if present; falls back to S3 download otherwise.

**Consequences:** Small files (the common case for code/text) are served from DB with zero S3 latency. Content_cache is always kept in sync with storage — updated on every write. Large files (>50 KB) never cache and always hit S3.

---

## ADR-021 — Tool group metadata lives in ToolMeta, not derived from ID

**Context:** The `context-preview-sheet.tsx` previously grouped tools by ID prefix (`__builtin__:` → "built-in", `pluginId:` → plugin name). This was fragile and leaky — UI logic was parsing internal ID conventions. Alternatives: dedicate a grouping layer in the runner, or carry it in the tool definition itself.

**Decision:** Add `group?: string` field to `ToolMeta` in `@jiku/types`. Tool authors declare their group when defining the tool. The runner passes it through unchanged to `PreviewRunResult.active_tools`. UI reads `t.group` directly, with fallback to ID-prefix heuristic when unset.

**Consequences:** Grouping is explicit and semantically meaningful (e.g. "memory", "persona", "social"). Tool ID format changes won't break the UI. Third-party plugin tools that don't set `group` fall back gracefully to ID-prefix grouping.

---

## ADR-020 — agent_self scope uses varchar(50), not ALTER ENUM

**Context:** Plan 9 adds a 4th memory scope `agent_self`. The original Plan 8 schema defined scope as a DB enum (`memory_scope`). `ALTER TYPE ... ADD VALUE` inside a transaction requires PostgreSQL 12+ and cannot be rolled back. The existing `memories.scope` column is actually `varchar(50)` (Plan 8 implemented it this way intentionally to avoid enum rigidity).

**Decision:** No schema migration needed for the `memories` table. `agent_self` is a new string value accepted by the varchar column. Only the `agents` table needs migration (adding `persona_seed` + `persona_seeded_at` columns).

**Consequences:** Scope values are not DB-enforced — only application-layer validated. This is acceptable; the set of scopes is small and well-controlled. New scopes can be added without touching the DB enum.

---

## ADR-019 — Persona seeding runs at studio server layer, not in @jiku/core

**Context:** `ensurePersonaSeeded()` needs to check `persona_seeded_at` on the agent record and write to the DB. This is a DB operation. Alternatives: put it in `AgentRunner` (core), or in `RuntimeManager` (studio server).

**Decision:** Lives in `apps/studio/server/src/memory/persona.ts`, called from `RuntimeManager.run()` before `runtime.run()`. `@jiku/core` is kept DB-free — it only calls `getMemories()` through the storage adapter interface.

**Consequences:** The seeding concern is co-located with the studio's DB layer. If jiku core is used standalone (without studio), consumers must implement their own seeding logic. This is acceptable — persona seeding is studio-specific behaviour.

---

## ADR-018 — MemoryPreviewSheet reuses previewRun() instead of a dedicated API route

**Context:** The Memory Preview Sheet needs to show memories injected into the current session. A dedicated `/api/conversations/:id/memory-preview` route was considered, but `previewRun()` already returns `ContextSegment[]` which includes a `source: 'memory'` segment containing the full injected memory text.

**Decision:** No new API route. `MemoryPreviewSheet` reads from the existing `['preview', agentId, conversationId]` TanStack Query cache (same key as `ContextBar`). The memory segment's `.content` is parsed client-side by `parseMemorySection()` which splits on markdown headings and bullet lines.

**Consequences:** Zero extra network requests; memory preview is always in sync with context preview. Downside: parsing is brittle if `formatMemorySection()` output format changes — both must be kept in sync manually.

---

## ADR-017 — getMemories agent_id is optional (runtime_global has no agent scope)

**Context:** `runtime_global` memories belong to the project, not to any specific agent. When the runner loads `runtime_global` scope, it does not pass an `agent_id`. The original `GetMemoriesParams` had `agent_id: string` (required), causing `WHERE agent_id = ''` which always returns empty results and errors on the DB side.

**Decision:** Make `agent_id` optional in `GetMemoriesParams`. The DB query only adds `WHERE agent_id = $n` when `agent_id` is truthy. Both the `JikuStorageAdapter` interface and `StudioStorageAdapter` implementation updated to match.

**Consequences:** Queries for `runtime_global` scope now correctly fetch all project-scoped memories without filtering by agent. Agent-scoped queries still pass `agent_id` and behave as before.

---

## ADR-016 — Memory config lives on /memory page, not /settings

**Context:** The initial implementation put memory config under `/settings/memory` (a settings tab). User feedback: the config belongs on the `/memory` page itself, alongside the memory browser — not buried in settings.

**Decision:** Move memory config to a "Config" tab on the `/memory` page (alongside the "Memories" browser tab). Remove the Memory tab from project settings layout. The `/settings/memory` page file remains but is not linked from navigation.

**Consequences:** Clearer UX — memory browser and its config are co-located. Settings stays focused on project-level general/credentials/permissions concerns. The `/settings/memory` route still exists as a dead page; it can be deleted in cleanup.

---

## ADR-015 — Memory is app-layer, not a plugin

**Context:** Memory could have been implemented as a plugin (e.g. `jiku.memory`) following the existing plugin system. However, memory requires deep integration with the runner lifecycle (before-run load, after-run extraction, system prompt injection) and config inheritance (project → agent), which the plugin system's `setup()` + `contributes()` pattern doesn't cleanly support.

**Decision:** Memory is a first-class feature of `@jiku/core` and `@jiku-studio/server`. Built-in memory tools are injected as `built_in_tools` on `AgentDefinition` (bypassing plugin system), and the runner has explicit memory lifecycle steps.

**Consequences:** Memory cannot be disabled via plugin toggle. The tradeoff is intentional — memory is a fundamental capability, not an optional extension. Future extensibility (custom memory backends) should be done via the `JikuStorageAdapter` interface, not via plugins.

---

## ADR-014 — Per-agent memory config: inherit/on/off override model

**Context:** Memory config has a 2-level hierarchy: project-level defaults and per-agent overrides. The agent level only needs to override specific fields (e.g. disable extraction for a specific agent), not redeclare the full config.

**Decision:** `AgentMemoryConfig` is a deeply partial version of `ResolvedMemoryConfig`. Agent config is stored as nullable jsonb on the `agents` table. `resolveMemoryConfig(projectConfig, agentConfig)` merges them — project defaults win where agent config is null/undefined. The web UI uses an `InheritToggle` (inherit/on/off) per field. "Inherit" = null in agent config (falls back to project). The `GET /api/agents/:aid/memory-config/resolved` endpoint exposes the final merged config.

**Consequences:** Clear semantics: inherit means project default, on/off means explicit override. The resolved config endpoint lets the UI show the effective value and its source (project vs agent).

---

## ADR-013 — EventSource auth via ?token= query param (not Authorization header)

**Context:** The SSE observer endpoint (`GET /conversations/:id/stream`) needs the auth token. `EventSource` is a browser native API and does not support custom request headers — there is no way to set `Authorization: Bearer <token>` on an `EventSource` connection.

**Decision:** Pass the JWT token as a `?token=` URL query parameter for the SSE observer endpoint only. The server reads `c.req.query('token')` and validates it the same way as the `Authorization` header.

**Consequences:** Token appears in server access logs for the SSE URL. Acceptable for a studio-internal tool. Do not apply this pattern to any non-SSE endpoint where header-based auth is possible.

## ADR-012 — SSE broadcast via stream.tee()

**Context:** When a chat run starts, the caller (who sent the POST) needs the stream. Other tabs or observers also need to see the output live (e.g. a second browser tab watching the same conversation). Buffering the full response before broadcasting would add latency and memory pressure.

**Decision:** Use `ReadableStream.tee()` to split the stream produced by `runtime.run()` into two branches: one piped to the HTTP response for the caller, and one registered in `StreamRegistry` for SSE observers. The `StreamRegistry` keeps an in-memory `Map<conversationId, { stream, controllers }>`. Each SSE observer tees the registered stream again to read it independently.

**Consequences:** `tee()` buffers the stream in memory until both readers have consumed each chunk — acceptable since LLM output is relatively small per turn. The registry must clean up on stream end and on observer disconnect to prevent memory leaks. Concurrent lock (409) prevents two POST callers from fighting over the same conversation stream.

## ADR-011 — Replace Radix ScrollArea with plain overflow-y-auto div in conversation list

**Context:** `@radix-ui/react-scroll-area` renders an inner viewport div with inline style `min-width: 100%; display: table`. This causes flex children inside the scroll area to expand to the content width instead of being clipped by the container, which breaks `text-overflow: ellipsis` on conversation preview text — the text never truncates regardless of `truncate` or `overflow-hidden` classes.

**Decision:** Remove `ScrollArea` from `conversation-list-panel.tsx` and replace with a plain `<div className="overflow-y-auto h-full">`. Custom scrollbar styling is handled via Tailwind's `scrollbar-thin` utilities or CSS if needed.

**Consequences:** Loses Radix's cross-browser custom scrollbar rendering. For this panel the native browser scrollbar is acceptable. Any future component that needs a custom scrollbar skin must avoid putting text-overflow children inside `ScrollArea` — use plain `overflow-y-auto` instead.

## ADR-010 — Message storage format: parts[] instead of content[]

**Context:** Messages were initially stored in DB as `content: MessageContent[]` (custom jiku type). AI SDK v6 uses `UIMessage.parts[]` as the canonical message format. Frontend tried `.map()` on the stored `content` field causing runtime error `m.content.map is not a function`.

**Decision:** Rename DB column `messages.content` → `messages.parts`. Update `MessagePart` type to align with AI SDK UIMessage parts shape. All layers (DB, server storage adapter, core runner, web API types) now use `parts` consistently.

**Consequences:** Breaking DB migration (requires `db:push`). All server-side code that read/wrote `content` had to be updated. Frontend no longer needs to remap — `m.parts` maps directly to `UIMessage['parts']`. `MessageContent` kept as deprecated alias in `@jiku/types` for potential backward compatibility.

## ADR-009 — Plugin KV store persisted in DB, not in-memory

**Context:** `StudioStorageAdapter.pluginGet/Set/Delete/Keys` was implemented with a `Map<string, unknown>` in-memory. Any server restart or runtime sleep would wipe plugin state.

**Decision:** Add `plugin_kv` table (`project_id`, `scope`, `key`, `value` text JSON-serialized, unique on composite) and route all plugin KV calls through DB queries.

**Consequences:** Plugin state survives server restarts. Slightly higher latency per KV call (DB round-trip vs in-memory). Upsert via `onConflictDoUpdate` avoids manual check-then-insert.

## ADR-008 — project = runtime (studio terminology follows @jiku/core)

**Context:** `@jiku/core` uses "runtime" as the top-level unit. Studio originally named the equivalent unit "project". Having two names for the same concept caused confusion when wiring the system together.

**Decision:** Studio terminology adopts `@jiku/core` terminology: one `JikuRuntime` per project. "Project" remains the user-facing name (URL slugs, UI labels), but internally the runtime is referred to as "the project's runtime". Comments and variable names reflect this alignment.

**Consequences:** Clearer code. `JikuRuntimeManager` maps `projectId → JikuRuntime` — the mapping is explicit and consistent.

## ADR-007 — Dynamic provider pattern for per-request credential resolution

**Context:** `JikuRuntime` initializes providers at boot time and does not support swapping a provider's model factory post-boot. Storing decrypted API keys in long-lived memory is a security risk.

**Decision:** Register a single sentinel provider (`__studio__`) at boot whose `getModel()` reads from a per-request `modelCache: Map<string, LanguageModel>`. Before each `runtime.run()`, `resolveAgentModel()` + `buildProvider()` are called; the result is cached under a unique key (`agentId:timestamp:random`). The stream is wrapped in a custom `ReadableStream` that deletes the cache key only after the stream is fully consumed or cancelled.

**Consequences:** Decrypted API keys exist in memory only for the duration of a single request. Concurrent requests don't collide (unique cache key). Minor overhead per request for credential lookup and provider construction.

## ADR-006 — shadcn + ai-elements live in @jiku/ui, not in app

**Context:** `apps/studio/web/components/ui/` and `apps/studio/web/components/ai-elements/` held 103 component files. These are general-purpose and should be reusable across any app in the monorepo.

**Decision:** Copy all files into `packages/ui/src/components/ui/` and `packages/ui/src/components/ai-elements/`. Fix all `@/` Next.js alias imports to relative paths. Export everything from `packages/ui/src/index.ts`. The web app's local copies remain untouched until a separate import-update pass.

**Consequences:** `@jiku/ui` is now the canonical source for all UI components. The web app temporarily has duplicate files — the import-update pass (separate task) will remove the local copies and switch to `@jiku/ui` imports.

## ADR-004 — Phantom brand field untuk PluginDefinition type extraction

**Context:** `MergeContributes<Deps>` perlu extract `TContributes` dari `PluginDefinition<T>`. Tapi `setup: (ctx: Base & T) => void` ada di contravariant position — TypeScript tidak bisa `infer C` dari interface yang punya function parameter contravariant.

**Decision:** Tambah phantom brand field `readonly _contributes_type?: TContributes` di interface — covariant position. `ExtractContributes` infer dari brand ini. `setup` type di interface jadi `(ctx: BasePluginContext) => void` — actual typed ctx di-enforce di `definePlugin()` call signature, bukan di interface.

**Consequences:** Phantom field muncul di IntelliSense tapi tidak pernah di-set runtime. `PluginDefinition<Specific>` sekarang assignable ke `PluginDefinition<ContributesValue>` tanpa contravariance issue.

## ADR-005 — Contributes harus function, bukan union

**Context:** `Contributes<T>` awalnya `T | (() => T) | (() => Promise<T>)` — 3-way union. TypeScript tidak bisa infer `TContributes` dari union type — saat user tulis `contributes: async () => ({db})`, TS gagal match ke branch mana.

**Decision:** `Contributes<T>` = `() => T | Promise<T>`. Always a function — single inference site via return type. Object form dihilangkan.

**Consequences:** Plugin author harus wrap object dalam arrow function: `contributes: () => ({ server })`. Tradeoff kecil dibanding type inference yang 100% reliable.

## ADR-001 — PluginLoaderInterface di @jiku/types

**Context:** `AgentRunner` di `@jiku/core` perlu tahu tentang `PluginLoader` untuk memanggil `getResolvedTools()` dan `resolveProviders()`. Tapi `PluginLoader` ada di `@jiku/core` sendiri — kalau import langsung akan circular.

**Decision:** Definisikan `PluginLoaderInterface` di `@jiku/types` dengan method-method yang dibutuhkan runner. `PluginLoader` concrete class mengimplementasi interface ini. `JikuRuntime` menerima `PluginLoader` concrete, tapi meneruskannya ke `AgentRunner` sebagai concrete type via dynamic import type.

**Consequences:** Sedikit lebih verbose, tapi tidak ada circular dependency. `@jiku/types` tetap zero-runtime-deps.

## ADR-002 — Tool permission wildcard bypass access check

**Context:** Tool dengan `permission: '*'` seharusnya accessible oleh siapapun tanpa perlu rule eksplisit.

**Decision:** Di `resolveScope()`, tool dengan `resolved_permission === '*'` langsung dimasukkan ke `active_tools` tanpa memanggil `checkAccess()`.

**Consequences:** Semantik jelas: `*` berarti "tidak ada restriction sama sekali". Tool tetap bisa di-deny lewat rule eksplisit di `resource_id` level.

## ADR-003 — Vercel AI SDK v6 sebagai LLM layer

**Context:** Butuh LLM loop yang mendukung multi-provider (Anthropic, OpenAI, dll) dan tool calling.

**Decision:** Gunakan Vercel AI SDK v6 (`ai@6`). Semua LLM interaction lewat `streamText()` + `tool()` dari SDK ini.

**Consequences:** API v6 berbeda dari v3/v4 — `inputSchema` bukan `parameters`, `stopWhen` bukan `maxSteps`. Provider SDK (`@ai-sdk/anthropic`) harus versi 3+ untuk kompatibilitas dengan `LanguageModelV3`.
