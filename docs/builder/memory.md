# Memory

## Drizzle schema must mirror migration ALTER TABLE — silently-dropped fields turn into empty SET clauses

When a migration adds a column via `ALTER TABLE ... ADD COLUMN`, the corresponding `pgTable(...)` declaration in `apps/studio/db/src/schema/*.ts` MUST be updated too. Drizzle's type-safe `.set({ new_col: val })` FILTERS out fields that aren't in the schema object. If that's the only field you're setting, the emitted SQL becomes `UPDATE "table" SET WHERE id=$1` — literal empty SET — and Postgres rejects with `42601: syntax error at or near "where"`. We hit this on `agents.command_access_mode` (migration 0030 ALTER'd; schema file wasn't updated until a user tried to PATCH the field). Whenever adding a migration that touches existing tables, grep `schema/*.ts` for the table and add the column there in the same commit.

## Plugin tools get `project_id` via `toolCtx.runtime['project_id']`, NOT via `caller.user_data.project_id`

`CallerContext.user_data` is the place for user profile + company context (`name`, `email`, `company_id`, `actual_permissions`) — `resolveCaller` deliberately does NOT put `project_id` there. The runner injects `project_id` into every `RuntimeContext` as a top-level key (see `jiku.sheet` pattern around line 365). Plugins that read from `caller.user_data.project_id` get `undefined` silently — tool-triggered code paths stop working while plugin HTTP endpoints (which get `projectId` from their own ctx closure) keep working, producing confusing "works in playground, broken for agent" bugs. We hit this on `jiku.web-reader` history save. Canonical access: `const projectId = toolCtx.runtime['project_id'] as string | undefined`.

## Telegram `editMessageText` "message is not modified" is a SUCCESS, not an error

Telegram compares the **rendered** output against the current message content. If your new text (after applying `parse_mode`) renders identical to what's already on screen, `editMessageText` returns `400: Bad Request: message is not modified`. This bit us in the streaming adapter: the final MarkdownV2 edit identity-matches the last interim plain edit when the body has no MarkdownV2-escapable chars (so `telegramifyMarkdown(x, 'escape') === x`). Treat `err.description.includes('message is not modified')` as a no-op success path — content is already on screen, nothing to do. The same guard should wrap any plain-text fallback edit. Don't warn-log it; spam drowns real errors. If you add new edit sites, copy the `isNotModifiedError` helper pattern.

## Telegram streaming adapter renders narrative-ordered, not header-pinned

`handleResolvedEvent` in `plugins/jiku.telegram/src/index.ts` keeps a `segments: ({ type:'text',content } | { type:'tools',items })[]` array, not a parallel `text + toolList` pair. Consecutive text-delta chunks grow the current text segment; consecutive tool-call chunks stack in the current tool group; transition between types inserts a `---` separator. This matches the agent's actual narrative ("said X, did Y, said Z") instead of pinning all tools above everything. If you're tempted to re-flatten for "simplicity", don't — the `---` separators + segment ordering is a UX decision (ADR-087 revision), not a code-style call. Final MarkdownV2 escaping is per-segment: text via `telegramifyMarkdown`, tool lines as `_[icon] <escaped_name>_`, separators as literal `\-\-\-`. Tool names often have underscores (`fs_read`, `connector_send_to_target`) — always escape before italic-wrapping, otherwise MarkdownV2 parse fails mid-name.

## Interim edits stay plain; MarkdownV2 only at final

During streaming, the adapter edits with no `parse_mode` — MarkdownV2 on partial content risks "unclosed" errors mid-stream (half of `*bold*` or unterminated code fence). Final edit after `reader done` is where we escape + apply parse_mode. Anyone adding new interim rendering paths: resist the urge to "make it look nice live with bold/italic" — you'll earn a parade of `can't parse entities` errors. Italic/bold go at finalize, not during.

## Skills / Commands share a pattern — factor carefully, don't rewrite

Skills (Plan 19) dan Commands keduanya: FS scan `/<root>/<slug>/<MANIFEST>.md` OR single-file `/<root>/<slug>.md`, parse frontmatter + body, cache di `project_<thing>s`, plugin contributions via `registerPlugin<Thing>()`, project-level registry + per-agent assignment table. Kalau nanti fitur ketiga dengan shape sama muncul (mis. "Docs" FS-first) pertimbangkan factoring `ManifestLoader<T>` generic — tapi BUKAN refactor wajib. Commands sengaja copy ~70% dari SkillLoader struktur supaya cepat ship + mudah dibandingkan saat debug. Konsistensi baris-per-baris (tabel columns, audit event naming `<thing>.assignment_changed`, route layout) lebih penting daripada DRY. Kalau muncul plan ketiga, sebaiknya bareng-bareng dengan refactor generic, bukan sambil memperkenalkan fitur baru.

## `@file` hint itu PRE-prompt, bukan system prompt

`scanReferences` dipanggil di route/runner BEFORE `runtimeManager.run()`, dan hasil `hintBlock` di-prepend langsung ke `input` string. Ini bukan segment `resolver/prompt.ts` — menghindari perlu berebut slot dengan skill_section, memory_section, persona, dll. Prepend ke input juga natural karena hint memang berkaitan dengan DARI USER teks saat itu, bukan state agent. Kalau nanti butuh "hint untuk setiap turn automatically", pertimbangkan jadi segment; kalau cuma ad-hoc per message, tetap pre-prompt.

## FS tool permission gate TIDAK kena `fs_mkdir` karena `fs_mkdir` tidak ada

Saat mengerjakan FS tool permission sempat hampir nambah gate untuk `fs_mkdir` mengikuti scenario doc, tapi `fs_mkdir` sebagai tool terpisah memang tidak ada di `filesystem/tools.ts` — folder dibuat otomatis saat file pertama ditulis ke path baru (via `upsertFile` + folder backfill). Kalau nanti `fs_mkdir` benar-benar ditambah sebagai tool, wire-kan `checkToolPermGate(projectId, path, 'mkdir', ...)` di executor-nya — sudah ada precedent di 5 tool existing.

## `audit.write` passthrough was added on purpose — pakai untuk event ad-hoc

`audit/logger.ts` punya `write(entry)` passthrough di object `audit` (di ujung `commandInvoke`). Dipakai oleh dispatcher karena event bawa actor info yang tidak cocok dengan helper-helper `commandInvoke(ctx, slug, meta)` (dispatcher tidak punya Express `req`, rakit `AuditContext` manual). Jangan hapus — ini keran safety-valve untuk event yang actor-nya system atau agent_id-driven tanpa req context.

## `connector_list` adalah kontrak "tool yang wajib fresh tiap iteration"

Tool description sudah eksplisit minta agent panggil `connector_list` fresh tiap iterasi yang akan pakai `connector_*`. Pattern ini dimanfaatkan Connector custom params untuk surface `param_schema` per connector — tidak perlu prompt injection karena agent sudah wajib call tool ini. Kalau nanti tambah field baru di `connector_list` output (action schema, rate-limit hint, maintenance status), ikut pattern yang sama: tambah ke return value, tool description tetap "call fresh every iteration". Zero prompt-bloat.

## Telegram: `bot started (polling)` log is a lie on its own

The `console.log('[telegram] bot started (polling)')` line in `onActivate` fires synchronously after dispatching `bot.start()` — NOT when polling is actually working. `bot.start()` is a long-lived promise that sits pending for the lifetime of the polling loop. Seeing that log line only means the call was made. Proof that polling is working is inbound updates hitting `connector_events` (now recorded via `logArrivalImmediate` before the routing queue — ADR-080). If you're debugging "bot seems dead", the two definitive checks are (1) any new rows in `connector_events` with `status='received'` in the last N seconds, (2) `curl api.telegram.org/bot<TOKEN>/getUpdates?timeout=0` — 409 Conflict means another instance holds the slot.

## Telegram: 30s poll-slot reservation is real, not theoretical

After any `bot.stop()` / process death / network drop, Telegram reserves the bot's long-poll slot for ~30s. Reactivating inside that window returns 409 Conflict on `getUpdates`. The adapter now enforces this via module-level `lastDeactivateByConnector` map + wait at top of `onActivate` (ADR-081). Don't remove that wait. Don't try to shortcut by calling `bot.api.close()` and assuming it releases instantly — `close()` itself returns 429 in the first 10min after a fresh launch and is swallowed. The nuclear option, documented in `docs/feats/connectors.md`, is `POST /bot<TOKEN>/logOut` which force-kicks all sessions server-side.

## Orphan `connector_identities` after binding delete

`connector_bindings` deletion cascades `connector_identities.binding_id` to NULL via `ON DELETE SET NULL`. Identity `status` is unchanged — usually stays `'approved'`. Next inbound from that user will find the orphan via `findIdentityByExternalId` and, prior to ADR-082, silently drop with `no_binding` because the "create pending identity" branch is guarded by `if (!identity)`. Event-router's Path B now detects `binding_id IS NULL AND status='approved'`, resets to `pending`, and re-sends the approval notification. If you ever add new branches that early-return on identity existence, repeat the orphan check there too.

## Every inbound update MUST land in DB before the routing queue

`logArrivalImmediate(connectorId, event)` in the Telegram plugin writes `connector_events` with `status='received'` BEFORE `enqueueInboundEvent(...)` runs. This is load-bearing: it's the only way ops can tell "is Telegram delivering updates at all" from a DB query alone. A future refactor that moves logging back into the routing pipeline re-introduces the stuck-queue-silent-DB failure mode that took production down once. If you introduce a new inbound path / event type, it MUST call `logArrivalImmediate` before queueing. Keep logging errors swallowed so a DB hiccup can't kill polling.

## Two-level queues in the Telegram plugin — don't collapse them

Outbound sends serialize per-chat via `chatSendQueues: Map<chatId, Promise>`. Inbound updates batch-drain globally via `inboundQueue` + `INBOUND_BATCH_SIZE=5`. These solve different problems (ADR-079): per-chat send serialization is about Telegram's rate limits; global batch drain is about capping agent/DB concurrency. Don't refactor into a single queue — the constraints are orthogonal and the shapes (per-chat promise chain vs global FIFO batch) reflect that.

## `drainInboundQueue` must always reset `inboundDraining=false`

The in-flight flag is the only thing preventing re-entrant drains. If a throw escapes the try block before the `finally`, the flag stays true and no future arrivals ever get processed — the exact silent failure ADR-080 exists to prevent. Keep the try/finally invariant. Individual task errors never escape because we use `Promise.allSettled`, not `Promise.all`.

## Chat messages form a tree (Plan 23) — never assume linear

`messages.parent_message_id` (self-FK, ON DELETE CASCADE) + `messages.branch_index` make every chat conversation a tree. `conversations.active_tip_message_id` points at the leaf of the currently selected branch. To render or send to model, walk root → tip via `getActivePath(convId)` (recursive CTE in `apps/studio/db/src/queries/conversation.ts`). **Don't `SELECT * FROM messages WHERE conversation_id = ?` for chat history** — that mixes siblings from other branches into model context. New writes must go through `addBranchedMessage()` so `branch_index` and `active_tip_message_id` stay consistent — never insert into `messages` directly from new code paths. Branching is implicit (ADR-070): supplying any `parent_message_id` that already has children automatically creates a sibling.

## Compaction is append-only and branch-aware (ADR-073, revised)

Don't call `replaceMessages` for compaction in branched conversations — it deletes ALL rows and erases alternate branches. The runner now appends a `[Context Summary]\n…` assistant message via `addBranchedMessage(parent = current_tip)` and lets `applyCompactBoundary()` (in `packages/core/src/compaction.ts`) skip everything before the checkpoint at history load time. Old messages stay in DB so other branches keep walking through them. Compaction is skipped when the user is forking (edit-message with parent != tip) or regenerating, so checkpoints aren't dumped into branches the user is leaving.

## Active path is the per-branch context budget

Token threshold checks, preview snapshots, and anything that asks "how much context does this conversation use" must walk the **active branch path** — not the flat `getMessages`. Counting all branches over-reports the budget and misrepresents what the model actually sees.

## Built-in tool names are bare `meta.id` (no `builtin_` prefix anymore)

`packages/core/src/runner.ts` exposes built-in tools to the AI SDK as `tool_name = meta.id` (was `builtin_${meta.id}`). Internal `resolved_id` keeps `__builtin__:<id>` for tool_states / audit / dedup. **Any prompt text referencing tools must use the bare name** (e.g. `cron_create`, `connector_send`, `fs_read`) — using the old `builtin_*` form will not match the model's tool list and the model will refuse with "I cannot access". Plugin tools still namespace via `<plugin_id>:<id>` so they cannot collide.

## Side-effectful tools dedup on conversation replay

When user edits a chat message, AI SDK replays the rewritten history and re-invokes any tool whose call appears in it. Without protection, `cron_create` / `connector_send` / `fs_write` etc. fire twice. `ToolMeta.side_effectful: true` opts a tool into runner-level dedup — at run start the runner builds `${tool_name}:${stableHash(args)} → cached_result` from full conversation history and short-circuits `execute()` for repeats. Identical retries collapse, distinct args don't. Marked side-effectful: `cron_create/update/delete`, `connector_send`, `connector_send_to_target`, `connector_run_action`, `connector_create_target/update_target/delete_target/save_current_scope`, `identity_set`. Add the flag to any new tool that mutates external state.

## Cron-fired task runs need a strong `[Cron Trigger]` preamble

A cron-fired agent runs in `task` mode with no live user. Two compounding failure modes:
1. Treats the stored prompt as a fresh user request → calls `cron_create` again → infinite loop.
2. Outputs the reminder as text and never calls `connector_send` → user gets nothing.
The `[Cron Trigger]` preamble (composed by `cron/context.ts.composeCronRunInput`) explicitly addresses both: states the user is not in the loop (forbids clarifying questions), states "any text you write goes to /dev/null — you MUST call a delivery tool from `[Cron Delivery]`", and prescribes a required output format (one short narration sentence + tool call in the SAME response). Conditional cron-creates-cron is still allowed by ADR-063, but only when the Instruction explicitly describes such logic.

## Cron prompt and cron context are stored separately

`cron_tasks.prompt` is pure intent (short, editable from the UI). `cron_tasks.context jsonb` carries `{ origin, delivery, subject, notes }`. Scheduler composes `[Cron Trigger]` + `[Cron Origin]` + `[Cron Subject]` + Instruction + `[Cron Delivery]` at fire time via `cron/context.ts`. Editing the prompt via UI no longer destroys delivery wiring. `cron_create` tool input takes `origin/delivery/subject` as separate fields; `cron_update` shallow-merges context.

## Use `croner` everywhere for cron parsing — no hand rolls

`croner` is the project's standard cron parser (used by `cron/scheduler.ts`, `dream-scheduler.ts`, and now `task/heartbeat.ts`). Hand-rolled parsers will silently mishandle `*/N`, ranges, lists, day-of-week specials. Heartbeat had a buggy hand roll that made `*/30 * * * *` fire every minute — replaced with `new Cron(expr).nextRun(from)`. When accepting cron input, also reject anything that isn't exactly 5 fields — croner accepts 6-field "seconds-first" by default which lets a typo (`*/30 * * * * *`) become every-30-second runaway.

## System prompt structure (Plan 22 revision)

`buildSystemPrompt` emits markdown sections in this order:
1. `## Runtime Context (Priority Rules)` — `prepend_segments` (highest precedence; e.g. Scheduling Capability)
2. `## Base Prompt`
3. `## Persona` / `## Skills` / `## Memory` / `## Mode Instruction` / `## User Context` / `## Skills (on-demand hint)` / `## Tool Hints`
4. `## Plugins` — labeled by `<plugin name> (<plugin.id>)` from `getPromptSegmentsWithMetaAsync()`
5. `## Runtime Context` — `runtime_segments` (Company & Team, Project Context, etc.)

`buildSystemPrompt` accepts `LabeledSegment[]` (or legacy `string[]`) for plugin/prepend/runtime sections. Auto-strips a leading `[Foo]` line from segment content because the markdown header replaces it. Hard rules that must override base_prompt persona belong in `prepend_segments`, not in plugin segments — plugin segments come AFTER base_prompt and lose precedence on weak / restrictive base prompts.

## Connector auto-reply uses `simulate_typing: true` by default; agent tools default false

`event-router.executeConversationAdapter` (auto-reply path) hardcodes `simulate_typing: true` when calling `adapter.sendMessage` — the user is waiting, typing UX is appropriate. Agent-callable tools (`connector_send`, `connector_send_to_target`) accept `simulate_typing` as opt-in input defaulting `false` so cron / proactive sends stay clean. TelegramAdapter implements progressive reveal in 3 stages (33% / 66% / 100%) at 2-second intervals when `simulate_typing && text-only && length ≤ 4000`. Loading indicator `\n\n⚪` on its own line; final edit applies markdown.

## Non-UUID actor ids must not reach Postgres uuid columns

Cron / heartbeat jobs and connector events run with `caller.user_id = 'system'` or `'connector:<uuid>'`. `project_memberships.user_id` and `audit_logs.actor_id` are uuid columns and reject these strings with `invalid input syntax for type uuid`. Always guard with a UUID regex check before passing to a uuid-typed query: `runtime/manager.ts` skips plugin permission lookup; `audit/logger.ts` nulls `actor_id` and stores the original label in `metadata.actor_label` plus sets `actor_type = 'connector' / 'system'` accordingly. Apply the same guard whenever a new path can carry a non-user caller id.

## OpenAI Chat Completions cannot emit text + tool_call in one response

Every response from a Chat Completions model is either text OR tool_calls — never both. No prompt will reliably change this. Claude can emit both natively. The only robust workaround for GPT is to run TWO separate `streamText` calls per logical "turn": one with `tool_choice: 'none'` (forces text) and one with `tool_choice: 'auto'` (permits tools). This is the core reason `HarnessAgentAdapter` exists. Reference threads: community.openai.com/t/1128779, /436653, /844498.

## Never use `tool_choice: 'required'` in an iterative loop

`required` forces the model to emit a tool call in every response. Once the actual task is complete, the model has nothing left to do — but still must call something, so it picks a random unrelated tool. Observed failure: a file-read task cascaded into infinite `jiku_social_list_posts` / `jiku_social_create_post` calls because the task was done and `required` kept forcing tool emission. Use `'auto'` and accept that the model may occasionally drop a tool call; early exit is better than infinite wrong tools.

## Do NOT append phase-1 narration to the `messages` array in harness

When harness phase 1 narrates "Now I'll read X", appending that text as `{ role: 'assistant', content: narration }` to `messages` before phase 2 makes GPT decide the work is already announced/done and emit an empty response → `hasToolCalls=false` → loop exits prematurely. Keep `messages` identical between phase 1 and phase 2; only `toolChoice` differs. Narration still gets to the user (via `sdkWriter.merge`) and the DB (via `allSteps` → `persistAssistantMessage`), just not into the LLM's prompt.

## AI SDK v6 UIMessageStreamWriter: merge BEFORE awaiting `result.steps`

The pattern `await result.steps; sdkWriter.merge(result.toUIMessageStream(...))` buffers everything until steps complete, then flushes at once — user-visible as a "flash" when multiple tool calls arrive together. Pattern `sdkWriter.merge(result.toUIMessageStream(...)); await result.steps` streams in real time. Use `sendFinish: false` on every merge except the last; or always false + emit `ctx.sdkWriter.write({ type: 'finish' })` manually after the last stream drains.

## AI SDK v6 rejects `Date` / `undefined` inside `tool-result` payloads

`streamText` validates the `messages` array against a strict JSONValue schema on each call. Tool results returned directly from DB queries often contain `Date` objects (`created_at`, `updated_at`) — appending them raw produces `AI_TypeValidationError: expected null|string|number|boolean|record, received Date`. Normalize with `JSON.parse(JSON.stringify(value))` before attaching as `{ type: 'tool-result', output: { type: 'json', value } }`. Default adapter doesn't hit this because AI SDK handles tool-result encoding internally; harness DOES because we manually reconstruct `messages` between iterations.

## When harness `stepCountIs(N > 1)`, append EVERY action step, not just the last

With `max_tool_calls_per_iteration > 1`, AI SDK internally chains steps within one phase 2 `streamText`. If only the last step is appended to `messages` for the next outer iteration, intermediate tool calls + results are lost — next iteration's LLM has partial history and may duplicate work or fail. Iterate every `StepResult` and append `(assistant{text+tool_calls}, tool{results})` per step.

## Deferred tool fetch via ToolSearch + `UIMessageChunk { type: 'finish' }`

`UIMessageStreamWriter.write({ type: 'finish' })` synthesizes the UI message's terminal chunk without any LLM call. Useful when a multi-phase operation wants to keep the UI message open across several `streamText` runs (each merged with `sendFinish: false`) and close it once at the end.

## Zod schema reflection: always unwrap wrappers before reading `typeName`

`_def.typeName` on a wrapped Zod node returns the wrapper name, not the inner type. `z.string().optional()._def.typeName === 'ZodOptional'` — `typeName.toLowerCase()` gives `"optional"`, NOT `"string"`. Always walk `ZodOptional` / `ZodDefault` / `ZodNullable` / `ZodEffects` via `_def.innerType` (or `_def.schema` for Effects) until you hit a leaf. Cap the walk at 5-10 iterations to avoid cycles. Pattern: `unwrapZod(node)` helper lives in `apps/studio/server/src/routes/browser-profiles.ts` and `apps/studio/server/src/browser/tool.ts`. Reuse it.

## Shadcn DialogFooter has built-in `-mx-4 -mb-4` — breaks with custom DialogContent padding

`@jiku/ui` `DialogFooter` assumes `DialogContent` has default `p-4` and uses `-mx-4 -mb-4` to stretch the footer's muted background edge-to-edge. If you override DialogContent to `p-0` (e.g. to build a scrollable body with pinned header/footer), DialogFooter overshoots the container. Fix: pass `className="mx-0 mb-0 rounded-b-xl"` to DialogFooter. Same trap doesn't apply to DialogHeader (it's just `flex flex-col gap-2`).

## Chromium in Docker: wipe `Singleton{Lock,Cookie,Socket}` at entrypoint

If Chromium's profile dir lives on a named volume (so it survives container restarts), stale `SingletonLock` / `SingletonCookie` / `SingletonSocket` files left by SIGKILL'd previous containers cause "profile appears to be in use by another Chromium process (PID) on another computer (HOSTNAME)" and refuse to start. Safe to delete at entrypoint BEFORE chromium launches — nothing else in the container holds the profile and the old hostname can never match. Files are pure coordination markers, not data — cookies / localStorage / history live in separate SQLite files. Same pattern applies to Firefox (`lock` / `.parentlock`).

## CamoFox gotchas (jo-inc/camofox-browser)

- **Not CDP.** Exposes REST at port 9377 — don't use `@jiku/browser` or any CDP client. See `plugins/jiku.camofox/src/adapter.ts`.
- **URL scheme blocklist.** `POST /tabs` and `POST /tabs/:id/navigate` reject anything that isn't `http://` or `https://`. `about:blank`, `data:`, `file:` all error 400 `"Blocked URL scheme: X (only http/https allowed)"`. Preview tabs must load a real URL (configurable via `preview_url` profile field).
- **`GET /tabs/:id/screenshot` returns raw `image/png` binary**, not JSON. Use `res.arrayBuffer()` + base64-encode, don't `res.json()`.
- **`GET /tabs/:id/snapshot` returns JSON** with nested `screenshot: { data, mimeType }` if `?includeScreenshot=true`. Different endpoint, different shape.
- **Firefox binary must be fetched during image build.** Upstream's Makefile does `camoufox fetch` on the host before `docker build`. We bake it into our image via `RUN npx camoufox fetch` AFTER `USER node` (so cache lands at `/home/node/.cache/camoufox/`). Without this, every POST /tabs crashes with `"Version information not found at /home/node/.cache/camoufox/version.json"`.
- **No public image.** Upstream doesn't publish to any registry. `packages/camofox/docker/Dockerfile` is our build source — clones upstream at `CAMOFOX_REF` (default `master`, pin to SHA for reproducibility).

## Custom action registry pattern (browser / connector)

For platform-specific adapter features that don't fit a shared enum, use the `list_actions` + `run_action` pattern instead of emitting separate tools. Adapter declares `readonly customActions: CustomAction[]` (id + displayName + description + Zod inputSchema + example) and implements `runCustomAction(id, params, ctx)`. Two tools at the top level: `<domain>_list_actions(profile_id?)` returns the catalog, `<domain>_run_action(profile_id?, action_id, params)` validates via `inputSchema.safeParse()` + dispatches. Tool count stays flat regardless of adapter/action count; schemas load on-demand. Same pattern: `ConnectorAdapter.actions` + `connector_run_action`, `BrowserAdapter.customActions` + `browser_run_action`.

## Plugin tools need `permission: '*'` to be visible — named permissions are silently invisible

`ctx.project.tools.register()` / `ctx.tools.register()` tools go through `resolveScope` which checks `caller.permissions.includes(tool.resolved_permission)`. The loader prefixes non-`*` permissions: `filesystem:read` → `jiku.sheet:filesystem:read`. No caller has that compound string, so the tool silently disappears from agent tool lists. **Always use `permission: '*'`** for tools that should be available unconditionally. For genuinely access-controlled tools, use `ToolMeta.required_plugin_permission` (Plan 18 path).

## Chat frontend: only send last user message — don't send full history

`prepareSendMessagesRequest` in both `chat-interface.tsx` and `conversation-viewer.tsx` filters to `[lastUserMessage]` only. The server loads conversation history from DB via `StudioStorageAdapter`. Sending all messages scales O(n) with conversation length and causes 413 errors for long conversations with large tool results. Do not revert this — if you need to pass client-side context, add explicit extra body fields, not via `messages`.

## Task runner must capture `data-jiku-run-snapshot` for usage raw data

When draining a task run stream, capture the `data-jiku-run-snapshot` chunk and pass its `system_prompt` + `messages` to `recordLLMUsage` as `raw_system_prompt` / `raw_messages`. Without this, the usage Raw Data dialog shows `(not captured)`. Pattern already established in `routes/chat.ts` — `task/runner.ts` now follows the same pattern. Any future stream-draining code (heartbeat, cron, etc.) that calls `recordLLMUsage` should do the same.

## `??` vs `||` when handling optional string params from LLM tool calls

LLMs often pass `""` (empty string) for optional fields they don't know the value of. `??` only replaces `null`/`undefined` — `"" ?? fallback` = `""`. Use `||` when you want to treat empty string as missing: `args.sheet || wb.sheetNames[0]`. This bit `sheet_read` where the agent passed `"sheet": ""` and got a false "workbook is empty" error.

## Every LLM call MUST log via `recordLLMUsage`

Any code that invokes `generateText` / `streamText` / `generateObject` in
`apps/studio/server` (or plugins via studio) MUST call `recordLLMUsage(...)`
from `apps/studio/server/src/usage/tracker.ts` immediately after the call
returns. This is how the usage/cost dashboard stays truthful.

- `source` field is required. Use one of: `chat`, `task`, `title`,
  `reflection`, `dreaming.light`, `dreaming.deep`, `dreaming.rem`, `flush`,
  `plugin:<id>`, `custom`.
- `agent_id` and `conversation_id` are OPTIONAL — background jobs (reflection,
  dreaming, flush) have neither. Always include `project_id` when known so
  project-level totals include the row.
- The tracker is fire-and-forget; do NOT `await`.

Existing wire sites: runner (chat/task via `jiku-usage` stream event →
`createUsageLog`), `jobs/handlers/reflection.ts`, `jobs/handlers/dreaming.ts`
(per-phase), `title/generate.ts`. If you add a new LLM-calling path and skip
this helper, the cost dashboard will silently under-report.

## `fs.read()` returns `{ content, version, cached }`, not a string

Since Plan 16 v2, `FilesystemService.read()` returns an object with content +
version (for optimistic locking) + cached flag. Every consumer MUST unwrap
`.content` before using it as a string. Bugs caught twice in Plan 19:
- SkillLoader passed the object to YAML parser → `content.match is not a function`.
- `/api/projects/:pid/files/content` route returned the object as the `content`
  field → frontend editor showed "value must be typeof string but got object"
  for both disk and skills pages.

Pattern:
```ts
const res = await fs.read(path)
const text = typeof res === 'string' ? res : res?.content
// OR: const { content } = await fs.read(path); ... content
```

Defensive `typeof res === 'string'` fallback kept in hot paths because this
same footgun showed up in multiple places.

## Background jobs contract: non-blocking, enqueue-only

Any LLM-invoking background work (reflection, dreaming, compaction-flush,
future plugin-invoked) MUST go through `apps/studio/server/src/jobs/enqueue.ts`.
Rules:
1. **Runner closes stream FIRST.** Hooks like `CompactionHook` / `FinalizeHook`
   in `packages/core/src/runner.ts` fire fire-and-forget and MUST NOT be awaited.
2. `enqueue()` is DB INSERT only. Never call a handler inline.
3. The worker picks up on its own interval. Handlers have no request context.
4. Use an `idempotencyKey` whenever you can express uniqueness — the `UNIQUE`
   constraint on `background_jobs.idempotency_key` prevents retry-storm dupes.

When adding a new job type: register the handler in `jobs/register.ts`, make
sure `agent_id` / `conversation_id` / `project_id` are all propagated through
the payload so the handler can attribute LLM usage correctly via
`recordLLMUsage`.

## Cron inputs must use `CronExpressionInput`, not a plain `<Input>`

Any UI field where the user types a cron expression MUST use
`@/components/cron/cron-expression-input` (wraps `cronstrue` for realtime human
preview + presets dropdown). Known sites: cron-tasks page, agent heartbeat page,
project memory → Dreaming tab. When adding a new cron field anywhere, reuse the
same component — do NOT add a raw `<Input>` with a static hint paragraph. Users
rely on the realtime "at 01:01" / "every hour" preview to sanity-check their
expression before save.

## Rate limit keying: use res.locals['user_id'], NOT req.user

The auth middleware attaches user identity to `res.locals['user_id']`, not to `req.user`. The Plan 18 rate limiter (`apps/studio/server/src/middleware/rate-limit.ts`) respects this convention — its `keyGenerator` reads `res.locals['user_id']` with IP fallback. Any future middleware that needs the authenticated user must do the same. If you write `req.user` you'll get undefined silently.

## Audit logging is fire-and-forget; never await audit.* calls

The `audit.*` helpers in `apps/studio/server/src/audit/logger.ts` return `void`, not a Promise. Internally they catch write failures and log a warning. Do not `await` them — if you do, TypeScript will still compile but you gain nothing and lose the fire-and-forget intent. In particular: never wrap an audit write in the same try/catch as a request-critical DB write, because a DB-down situation will cascade the failure.

## Two audit tables coexist: audit_logs (new) vs plugin_audit_log (legacy)

Plan 18 introduced `audit_logs` (broad coverage). Plan 17's `plugin_audit_log` still exists and is still written to by `routes/plugin-ui.ts`. The settings/audit UI reads only `audit_logs`. Do NOT add new writes to `plugin_audit_log` — send all new audit events via the `audit.*` helper into `audit_logs`. If you need to query cross-plugin activity, query `audit_logs` with `resource_type = 'tool'`.

## Plugin permissions: two layers exist, don't confuse them

- `project_plugins.granted_permissions` (jsonb, Plan 17) — project-wide, controls whether a plugin has been granted its declared capabilities at all during activation.
- `plugin_granted_permissions` table (Plan 18) — **per-member** grants, enforced at tool invoke time against `ToolMeta.required_plugin_permission`. This is the source of truth for runtime enforcement.

When adding a sensitive tool to a plugin, set `required_plugin_permission` in its `ToolMeta`. The runner will then require the caller to have a matching grant in `plugin_granted_permissions` (or be a superadmin) before executing.

## ToolHooks in core runner: use for cross-cutting tool concerns

`JikuRuntime` / `AgentRunner` accept a `ToolHooks` option (`onInvoke`, `onBlocked`, `onError`). Studio uses this to write audit log entries (`RuntimeManager` constructs `buildToolHooks(projectId)` per-project). If you need to add other cross-cutting behavior to every tool execution (metrics, cost tracking, circuit breaker), plug into these hooks instead of wrapping individual tool `execute` functions — it's a single choke point and it already fires for both streaming and non-streaming tools.

## Settings layout: vertical sidebar, three groups

`apps/studio/web/app/(app)/studio/companies/[company]/projects/[project]/settings/layout.tsx` uses a 220px vertical sidebar with three groups: **Project**, **Access Control**, **Observability**. To add a new settings page, drop it into the correct group in the `groups` array. Memory and Filesystem configs are intentionally NOT under /settings — they live on `/memory` and `/disk` (dedicated feature pages).

Access Control sub-sections (Members/Roles/Agent Access) all live at `/settings/permissions` — the internal Tabs is URL-controlled via `?tab=roles` / `?tab=agents`. The sidebar links to these query strings directly, so deep-linking works and active highlighting uses `searchParams.get('tab')`.

## Credential inheritance: always use getAvailableCredentials, not getProjectCredentials

`getProjectCredentials(projectId)` returns only project-scoped credentials. When you need to resolve credentials that may live at company level (e.g. a shared OpenAI key defined once for all projects), always use `getAvailableCredentials(companyId, projectId)` — it returns a union. You need to look up `companyId` from the project first (`getProjectById`).

Frontend: `api.credentials.available(projectId)` hits `/api/projects/:pid/credentials/available` which already calls `getAvailableCredentials` internally.

This gotcha affects any feature that resolves credentials at runtime — e.g. embedding, LLM provider selection.

## Semantic memory embedding config

Embedding config lives in `projects.memory_config.embedding` (JSONB). Fields: `enabled`, `provider`, `model`, `credential_id`, `dimensions`. The `embedding.ts` service reads this at runtime and caches per-project for 5 minutes. Clear cache with `clearEmbeddingCache(projectId)` — called automatically on `PATCH /memory-config`.

If `embedding.enabled = false` (default), `createEmbeddingService()` returns `null` and semantic search is silently skipped. Enable via Memory → Config → Semantic Search tab.

## LLM extraction removed (Plan 15 decision)

`extractMemoriesPostRun()` and `extractPersonaPostRun()` were removed from the run lifecycle. Reason: caused duplicate memories when tool-saved memories hadn't yet committed before extraction read stale data. The agent's built-in memory tools (`memory_core_append`, `memory_extended_insert`, etc.) are sufficient — explicit tool calls are more controllable than auto-extraction. The `extraction` block in `ResolvedMemoryConfig` still exists in types but is no longer used.

## Connector tools: always call connector_list first

Connector tools (`connector_send`, `connector_list_actions`, `connector_run_action`) require a valid `connector_id` (UUID). **Never hardcode display_name into agent prompts.** Instead:

1. Agent calls `connector_list()` (no params needed) → returns all connectors with IDs
2. Agent finds the connector by `display_name` or `plugin_id`
3. Agent uses the returned UUID in subsequent connector tool calls

Example flow:
```
builtin_connector_list
→ { connectors: [{ id: "uuid-123", display_name: "Telegram Jiku Agent", plugin_id: "jiku.telegram", status: "active" }] }
→ Use id: "uuid-123" in connector_send({ connector_id: "uuid-123", ... })
```

This pattern works because `connector_list` is stateless and returns fresh data each time.

## Cron Task System conventions

**Conversation type & trigger tracking:**
- Cron task conversations have `type: 'task'` (not a separate 'cron' type — only 3 types exist: chat, task, heartbeat)
- Trigger source tracked via `metadata.trigger: 'cron'` and `metadata.cron_task_id`
- `mode: 'task'` is passed to runtime; agent gets access to task-only tools (run_task, progress_report, etc.)

## Cron Task System conventions

**Cron expression library split:**
- Server (scheduling): `croner@10.0.1` — parses and schedules CRON syntax, no UI needed
- Frontend (display): `cronstrue@3.14.0` — converts expressions to English phrases (e.g. "Every Monday at 9 AM")

**CronExpressionInput component:** Provides real-time validation with visual feedback (green checkmark for valid, red error for invalid). Located at `apps/studio/web/components/cron/cron-expression-input.tsx`. Reusable for any form that needs cron input.

**Cron task permissions:** Caller context (`caller_id`, `caller_role`, `caller_is_superadmin`) is snapshotted at task creation time and stored in the DB. Permission checks during scheduled execution use the snapshot, not current user state. This ensures predictable permissions regardless of later role changes.

**Cron task enablement:** `agents.cron_task_enabled` column (default true) allows disabling cron execution per agent without deleting the tasks. When false, cron tools are not injected into the agent's runtime.

**Cron conversation metadata:** Conversations triggered by a cron task have:
- `metadata.cron_task_id: string` — the task that triggered it
- `metadata.trigger: 'cron_task'` — indicates the trigger source
- `type: 'cron'` — conversation type classification

**Scheduler integration:** `CronTaskScheduler` is instantiated once per project in `RuntimeManager.wakeUp()`. `loadAndScheduleProject()` is called at boot to register all enabled tasks. `scheduleAgent()` is called during `syncAgent()` to update individual agent task schedules. All tasks are unscheduled during `stopAll()`.

## ChartContainer (shadcn) conflicts with explicit height — use ResponsiveContainer directly

`ChartContainer` from `@jiku/ui` wraps Recharts' `ResponsiveContainer` and adds `aspect-video` to the container class. This conflicts with any explicit CSS height class (`h-45`, `h-[180px]`, etc.) — the `aspect-video` ratio wins and the chart renders blank. When you need a fixed pixel height for a Recharts chart, bypass `ChartContainer` and use `<ResponsiveContainer width="100%" height={180}>` directly. Style tooltips manually via `contentStyle={{ background: 'hsl(var(--popover))', ... }}`.

## Theme toggle: next-themes is already configured

`ThemeProvider attribute="class"` is set up in `apps/studio/web/components/providers.tsx` with `defaultTheme="system" enableSystem`. To add theme toggle anywhere: import `useTheme` from `next-themes`, call `setTheme('dark' | 'light')`. No additional provider setup needed.

## Sidebar footer convention: user dropdown + ThemeToggle side by side

All three sidebars (root, company, project) use the same footer pattern: a `flex items-center gap-1` wrapper containing the `DropdownMenu`-wrapped `SidebarMenuButton` (with `flex-1`) and a `ThemeToggle` button to its right. When adding new footer actions, follow this pattern.

## Conversation title generation is fire-and-forget

`generateTitle()` in `apps/studio/server/src/title/generate.ts` is called asynchronously after the first message in a conversation is stored. It does NOT block the HTTP response. The title may not appear immediately in the UI — a brief poll/refresh may be needed. This is intentional to keep the chat UX responsive.

## AlertDialog import from @jiku/ui

The `AlertDialog` component is imported directly from `@jiku/ui/components/ui/alert-dialog.tsx`, not re-exported from the `@jiku/ui` index. This is temporary until the index is updated.

## Conversation soft delete: deleted_at column

Conversations are soft-deleted via `deleted_at IS NOT NULL`. `getConversationsByProject()` query automatically filters `WHERE deleted_at IS NULL`, so deleted conversations never appear in the UI. Hard delete is not used to preserve conversation history for audit purposes.

## Sidebar conversation list now shows title + agent name

The sidebar was updated to show `<title> · <agent_name>` instead of showing the last message preview. This makes conversations easier to find by their title. Agent name is secondary context (smaller, gray text).

## ACL: project_memberships vs company_members

Two separate membership systems:
- `company_members` (existing) — user in a company, has a company-level `role_id` (old roles table with `role_permissions`)
- `project_memberships` (Plan 12) — user in a project, has `is_superadmin` + `role_id` (project_roles table with `permissions text[]`)

Never confuse them. `resolveProjectPermissions()` reads from `project_memberships + project_roles`. `getMember()` reads from `company_members`.

## ACL: requirePermission middleware caches in res.locals

`requirePermission()` and `requireSuperadmin()` store resolved permissions in `res.locals['resolved_permissions']`. If multiple middleware run on the same request, DB is only hit once. The `project_id` is read from `req.params['pid']` (cast to string).

## ACL: PERMISSIONS const location

`PERMISSIONS`, `Permission`, `ROLE_PRESETS`, `ResolvedPermissions`, `ProjectGrant` are all in `packages/types/src/index.ts`. Import from `@jiku/types`.

## ACL: invitation accept creates project_memberships from project_grants

`project_grants` in `invitations` is `[{ project_id, role_id }]`. On accept: create `company_member` (if not exists) + create `project_membership` per grant. Superadmin on created membership is always `false` — must be granted separately.

## Radix ScrollArea breaks text-overflow ellipsis

`@radix-ui/react-scroll-area` injects `min-width: 100%; display: table` on the inner viewport div. This causes flex children to stretch to content width, preventing `text-overflow: ellipsis` from working no matter how many Tailwind truncation classes are applied. Use a plain `<div className="overflow-y-auto h-full">` instead whenever truncated text lives inside the scroll container.

## SSE observer pattern: stream.tee() + StreamRegistry

`apps/studio/server/src/runtime/stream-registry.ts` manages active chat runs. When `POST /conversations/:id/chat` starts a run, it tees the stream and registers one branch for SSE observers. `GET /conversations/:id/stream` is the SSE endpoint — each new observer tees the registered branch again. `GET /conversations/:id/status` returns `{ running: boolean }` for polling clients. Cleanup happens on stream end and on observer disconnect. Concurrent runs to the same conversation return 409.

## EventSource auth via query param

Browser `EventSource` does not support custom headers. For the SSE observer endpoint (`GET /conversations/:id/stream`), the JWT is passed as `?token=<jwt>` in the URL. The server reads it with `c.req.query('token')`. Only use this pattern for SSE — all other endpoints use the `Authorization: Bearer` header.

## SidebarFooter convention: always show user info dropdown

Both `company-sidebar.tsx` and `project-sidebar.tsx` (and the root sidebar) render user info in `SidebarFooter` using the same dropdown pattern. Settings link lives in the same menu group as the primary nav items — no separator between Settings and the other nav entries.

## AI SDK v6 Tool API

Vercel AI SDK v6 menggunakan `inputSchema` (bukan `parameters` seperti v3/v4) dan helper `zodSchema()` dari `ai`:
```ts
import { tool, zodSchema } from 'ai'
tool({ inputSchema: zodSchema(myZodSchema), execute: async (args) => ... })
```

## AI SDK v6 StepCount

`maxSteps` sudah tidak ada di v6. Gunakan `stopWhen: stepCountIs(N)` dari import `ai`.

## @ai-sdk/anthropic versi

Gunakan `@ai-sdk/anthropic@^3` — versi 1.x masih pakai `LanguageModelV1` yang tidak kompatibel dengan `ai@6` yang butuh `LanguageModelV2/V3`.

## process.env tidak dikenal oleh tsc

Untuk mengakses `process.env` dan globals Node/Bun, tambahkan `"types": ["node"]` di `tsconfig.json`. Jangan gunakan `bun-types` — tidak ada di devDependencies workspace root.

## PluginLoader harus setStorage() sebelum boot()

`PluginLoader.boot()` membutuhkan storage untuk membuat `PluginStorageAPI` per plugin. `JikuRuntime.boot()` otomatis call `setStorage()` sebelum `boot()`.

## Tool permission dengan wildcard

Tool dengan `permission: '*'` di-skip dari access check — langsung allow tanpa butuh rule atau permission di caller.

## Plugin tool naming convention

Tool ID di plugin adalah raw (contoh: `create_post`). Setelah di-load PluginLoader jadi `resolved_id: 'jiku.social:create_post'`. Semua rules menggunakan resolved ID.

## Stream architecture — createUIMessageStream

Runner pakai `createUIMessageStream<JikuUIMessage>` dari AI SDK + `writer.merge(result.toUIMessageStream(...))`. Jangan buat custom ReadableStream sendiri — pakai pattern ini agar kompatibel dengan AI SDK ecosystem (pipe ke Response, SSE, dll).

## JikuStreamChunk data narrowing

`JikuStreamChunk` adalah `InferUIMessageChunk<JikuUIMessage>`. Data chunk bertipe `{ type: 'data-jiku-usage', data: unknown }` — `data` tidak otomatis ter-narrow dari `type`. Gunakan type guard `isJikuDataChunk(chunk, 'jiku-usage')` dari `@jiku/types` untuk narrowing yang type-safe.

## Plugin contributes harus function

`Contributes<T>` = `() => T | Promise<T>`. Selalu function, sync atau async. Object form dihilangkan karena TypeScript tidak bisa infer `TContributes` dari union type 3-cabang. Arrow function wrapping: `contributes: () => ({ server: ... })`.

## Plugin type inference via phantom brand

`PluginDefinition` punya `readonly _contributes_type?: TContributes` — phantom field di covariant position. `MergeContributes` extract types dari field ini, bukan dari `setup` parameter (yang contravariant). Jangan hapus field ini.

## PluginDependency pakai `any`

`PluginDependency = string | PluginDefinition<any>` — harus `any`, bukan `ContributesValue`. Kalau pakai `ContributesValue`, TypeScript widen setiap element di `depends[]` ke `PluginDefinition<ContributesValue>` sehingga specific type hilang.

## definePlugin overloads

`definePlugin` punya 2 overloads:
1. Dengan `depends: Deps` (required) → `setup(ctx: BasePluginContext & MergeContributes<Deps>)`
2. Tanpa `depends` (`depends?: never`) → `setup(ctx: BasePluginContext)`

Overload pertama harus punya `depends` sebagai required field agar TypeScript pilih overload ini saat ada `depends` array.

## @jiku/types boleh deps ke `ai`

`@jiku/types` diizinkan depend ke `ai` karena dibutuhkan untuk `UIMessage`, `InferUIMessageChunk`, dll. Bukan zero-deps lagi sejak stream types diperkenalkan.

## JikuRunResult.stream adalah ReadableStream<JikuStreamChunk>

`runtime.run()` return `stream: ReadableStream<JikuStreamChunk>`. Consume dengan `.getReader()` atau pipe ke `createUIMessageStreamResponse()` untuk HTTP response.

## @jiku/ui import path conventions

Components di `packages/ui/src/components/ui/` gunakan:
- `../../lib/utils` untuk `cn()`
- `./other-ui-component` untuk sibling di ui/

Components di `packages/ui/src/components/ai-elements/` gunakan:
- `../../lib/utils` untuk `cn()`
- `../ui/component-name` untuk ui primitives
- `./sibling` untuk sibling ai-elements

Jangan pakai alias `@/` di dalam packages/ui — tidak ada Next.js tsconfig path alias di sini.

## apps/studio/web masih punya salinan lokal ui/ dan ai-elements/

Setelah migration ke @jiku/ui, `apps/studio/web/components/ui/` dan `ai-elements/` masih ada. Import di web belum diupdate. Task terpisah diperlukan untuk switch import ke `@jiku/ui` dan hapus lokal copies.

## @ai-sdk/react v3 useChat API (AI SDK v6 companion)

- Import: `import { useChat } from '@ai-sdk/react'` (bukan `ai/react`)
- Transport: `new DefaultChatTransport({ api, headers, prepareSendMessagesRequest })` dari `import { DefaultChatTransport } from 'ai'`
- `sendMessage({ text })` untuk kirim pesan (bukan `append`)
- `status`: `'ready' | 'submitted' | 'streaming' | 'error'`
- `message.parts[]` array (bukan `message.content` string) — render iterating parts
- `error` field ada saat request gagal — tampilkan ke user

## Dynamic provider pattern (studio)

Satu `__studio__` provider di-register saat `wakeUp()`. `getModel(cacheKey)` reads dari `modelCache: Map<string, LanguageModel>`. Sebelum `runtime.run()`, cache diisi; setelah stream habis/cancel, cache dihapus. Key format: `agentId:timestamp:random` untuk menghindari collision concurrent requests.

## Message storage: parts[] di DB (bukan content[])

Messages disimpan dengan kolom `parts: MessagePart[]` (jsonb array) — aligned dengan AI SDK v6 `UIMessage.parts`. Kolom ini di-rename dari `content` → requires `bun run db:push` saat pertama kali migrate.

`toJikuMessage()` di `StudioStorageAdapter` membaca `row.parts` dan return `Message` dengan `parts` field.

## AI SDK v6 useChat: option `messages` bukan `initialMessages`

`useChat({ messages: initialMessages, ... })` — option name di AI SDK v6 adalah `messages` (bukan `initialMessages` seperti di versi lama). Kalau salah nama option, history tidak load dan tidak ada error — silent bug.

## TanStack Query + historyData guard pattern

`historyData` bisa `undefined` saat `historyLoading === false` (initial state sebelum query pertama jalan). Guard yang benar:
```ts
if (convLoading || historyLoading || !historyData) return <Loading />
```
Tanpa `|| !historyData`, `ChatView` akan mount dengan `undefined` data.

## @openrouter/ai-sdk-provider (bukan @ai-sdk/openrouter)

Package npm yang benar adalah `@openrouter/ai-sdk-provider`, bukan `@ai-sdk/openrouter`. Yang terakhir tidak ada di npm.

## drizzle-orm import hanya dari @jiku-studio/db

`@jiku-studio/server` tidak punya `drizzle-orm` sebagai dependency. Semua query DB harus diimplementasi di `@jiku-studio/db` dan di-export dari `index.ts`. Server hanya import fungsi-fungsi query, tidak pernah import `drizzle-orm` atau schema langsung.

## Memory system: getMemories agent_id is optional

`getMemories()` in `@jiku-studio/db` has `agent_id` as optional. When loading `runtime_global` scope, the runner does NOT pass `agent_id` — those memories are project-wide, not agent-scoped. Always omit `agent_id` when querying `runtime_global`. Pass it when querying `agent_global` or `agent_caller`.

## Memory config location: /memory page, not /settings

Project memory config is on the `/memory` page via a "Config" tab (alongside the "Memories" browser tab). It is NOT in project settings. The settings layout only has: General, Credentials, Permissions.

## Memory in context preview

`previewRun()` in `packages/core/src/runner.ts` loads memories (read-only, no `touchMemories`) and injects a `memory` context segment. In the UI, the memory segment renders in teal. The `ContextSegment.source` union includes `'memory'` — update both `packages/types/src/index.ts` and `apps/studio/web/lib/api.ts` if adding new segment sources.

## Memory tools are built_in_tools, not plugin tools

Memory tools are injected via `built_in_tools` on `AgentDefinition` in `RuntimeManager.wakeUp()` / `syncAgent()`. They do NOT go through the plugin system. The `AgentRunner` merges `agent.built_in_tools` with plugin-resolved tools before building the AI SDK tool map.

## resolveMemoryConfig: always call before running

`resolveMemoryConfig(projectConfig, agentConfig)` from `@jiku/core` must be called in `wakeUp()` and `syncAgent()` to produce the `ResolvedMemoryConfig` passed to `runtime.addAgent()`. The agent config is partial — field-by-field merge, project defaults fill missing keys.

## zod is a direct dep of @jiku-studio/server

Added `zod@^4.3.6` to `apps/studio/server/package.json` — required by `memory/tools.ts` for tool input schemas. Server does not re-use core's zod; it needs its own declaration.

## Persona scope (agent_self) never enters memory queries

`agent_self` memories are always queried with explicit `scope: 'agent_self'`. Regular memory queries (`buildMemoryContext`, `findRelevantMemories`) never include `agent_self` — they only query `agent_caller`, `agent_global`, `runtime_global`. Persona and memory are injected into separate system prompt sections and can never collide.

## Tool group metadata — declare in ToolMeta

Each `defineTool()` call can include `meta.group?: string`. This is the canonical grouping for UI display. Convention: `'memory'` for memory CRUD tools, `'persona'` for persona tools, plugin tools use their plugin domain (e.g. `'social'`). If unset, UI falls back to ID-prefix parsing.

## previewRun() must mirror run() for built_in_tools

`AgentRunner.previewRun()` must merge `built_in_tools` the same way `run()` does, otherwise the active tools count will be 0. Pattern:
```ts
const builtInResolved = (this.agent.built_in_tools ?? []).map(t => ({
  ...t, plugin_id: '__builtin__', resolved_id: `__builtin__:${t.meta.id}`,
  tool_name: `builtin_${t.meta.id}`, resolved_permission: '*',
}))
const modeTools = [
  ...scope.active_tools.filter(t => t.modes.includes(mode)),
  ...builtInResolved.filter(t => t.modes.includes(mode)),
]
```

## shortToolId convention in UI

In `context-preview-sheet.tsx`, the displayed tool ID strips the `__builtin__:` prefix to save space: `memory_search` instead of `__builtin__:memory_search`. The full ID is still used internally for grouping logic.

## Filesystem route is /disk not /files

The virtual disk file manager page lives at `/disk` (not `/files`). The settings page is at `/settings/filesystem`. The DB config table is `project_filesystem_config`. "Files" was avoided because `/agents/[agent]/files` already exists for a different purpose.

## S3 adapter: forcePathStyle required for RustFS/MinIO

`S3FilesystemAdapter` sets `forcePathStyle: true` on the S3Client. This is required for MinIO-compatible servers (RustFS) — they don't support virtual-hosted-style bucket URLs. Without this, requests fail with 404/403.

## Filesystem content cache threshold: 50 KB

Files ≤ 50,000 bytes store content in `project_files.content_cache`. This avoids S3 round-trips for small text files. `fs_read` returns `content_cache` if set, otherwise downloads from S3. Always sync cache on write.

## Attachments vs project_files: different concepts

- `project_attachments` — ephemeral chat images uploaded alongside messages. Accessible via `/api/attachments/:id`. Agents see them as image parts in message history.
- `project_files` — persistent virtual disk. Accessible via `fs_*` tools and the /disk UI. Text files only (≤5MB, allowed extensions only).

Do not confuse these or use one for the other's purpose.

## ImageGallery component: click outside closes

`ImageGallery` (`apps/studio/web/components/ui/image-gallery.tsx`) is a fullscreen overlay. Click the backdrop (not the image itself) closes it. Arrow keys navigate. Minimap strip at bottom shows thumbnails for multi-image messages. `open/onClose` props control visibility.

## DB tool part format vs UI format

DB stores tool calls as `{ type: 'tool-invocation', toolInvocationId, toolName, args, state: 'result', result }`. AI SDK v6 expects `{ type: 'dynamic-tool', toolCallId, state: 'output-available', input, output }`. Always convert via `dbPartsToUIParts()` in `apps/studio/web/lib/messages.ts` when loading messages for display.

## task_allowed_agents: null vs [] vs [id…]

`agents.task_allowed_agents` column controls delegation in `run_task`:
- `null` (default) = unrestricted, can delegate to any agent
- `[]` = delegation fully disabled
- `[id1, id2]` = only the listed agent IDs are allowed as targets

Check is enforced server-side in `checkTaskDelegationPermission()` in `apps/studio/server/src/task/tools.ts`. Self-delegation (same agent ID) always bypasses the check.

## Heartbeat requires task mode

`heartbeatScheduler.scheduleAgent()` silently returns if `task` is not in `agent.allowed_modes`. `triggerHeartbeat()` throws if task mode absent. This prevents heartbeat runs from spawning conversations in agents that have task mode disabled. Always check `allowed_modes` before scheduling.

## serializeToolSchema: Zod → JSON Schema for preview

`previewRun()` in `packages/core/src/runner.ts` uses `serializeToolSchema(t.input)` to convert each tool's Zod input schema to a plain JSON Schema object before serializing to the API response. This is needed because Zod objects are not JSON-serializable. Uses `zodToJsonSchema` from `zod-to-json-schema` (already a dep of `@jiku/core`).

## Agent memory config: useEffect not initialized flag

`apps/studio/web/app/.../agents/[agent]/memory/page.tsx` uses `useEffect(() => { ... }, [resolvedData])` to sync form state from server data. Do NOT use the `initialized` flag + if-inside-render pattern — it causes desync because `invalidateQueries` is async and stale data triggers a premature re-init before fresh data arrives.

## Browser automation: @jiku/browser (replaces Plan 13)

Plan 13 (OpenClaw port) is replaced by `packages/browser/`. Key conventions:

**Pre-connect pattern:** `agent-browser connect <endpoint>` must run once before `--cdp` flag works. `ensureConnected()` in `spawner.ts` handles this with an in-memory `Set<string>` cache.

**ws:// → http:// conversion:** `resolveCdpEndpoint()` converts `ws://localhost:9222` to `http://localhost:9222`. agent-browser `--cdp` accepts `http://` URLs or port numbers, NOT `ws://` URLs (except full `wss://` paths for remote services).

**Docker CDP proxy:** Chrome HTTP `/json/version` API is not accessible from outside the container natively. `socat` in the container forwards `0.0.0.0:9222 → 127.0.0.1:19222` (Chrome's internal port). Both HTTP and WebSocket traffic go through socat.

**Screenshot returns base64:** `execBrowserCommand` for screenshot: CLI saves to temp file → read → base64 encode → delete temp file. Response: `{ base64: "...", format: "png" }`. Client handles saving if needed.

**Non-root Chromium:** Docker container runs Chromium as user `browser` (not root). No `--no-sandbox` flag needed, no warning banner in noVNC.

**Tool definition in studio, not in package:** `@jiku/browser` is a library. Tool definitions for AI agents go in `apps/studio/server`, using `execBrowserCommand()` directly. The package does NOT define AI tools.

**Browser tool input schema must be a flat `z.object`:** `apps/studio/server/src/browser/tool-schema.ts` is a flat `z.object` (NOT a `z.discriminatedUnion`) where `action` is a required enum and every other field is optional. This is mandatory because OpenAI's function calling API rejects schemas without `type: "object"` at the root, and `z.discriminatedUnion` serializes via `zod-to-json-schema` to `anyOf` at the root — which OpenAI parses as `type: None` and refuses with `"Invalid schema for function ...: schema must be a JSON Schema of 'type: \"object\"'"`. Per-action field requirements are enforced at runtime by the `need()` helper in `execute.ts`'s `mapToBrowserCommand`. The mapper still has a `never`-typed default branch over `BrowserAction` for compile-time exhaustiveness. The `BROWSER_ACTIONS` const is the single source of truth for the action enum — schema and mapper both reference it.

**Browser config is CDP-only:** `BrowserProjectConfig` (in `@jiku-studio/db`) only contains `cdp_url`, `timeout_ms`, `evaluate_enabled`, `screenshot_as_attachment`. Legacy Plan 13 fields (`mode`, `headless`, `executable_path`, `control_port`, `no_sandbox`) were dropped. The route Zod schema (`apps/studio/server/src/routes/browser.ts`) strips anything else on save.

**Browser concurrency: per-project mutex + per-agent tab affinity.** agent-browser operates on a single active tab per CDP endpoint, so two agents in the same project would race on the shared "active tab" state without coordination. Studio's solution lives in `apps/studio/server/src/browser/{concurrency,tab-manager}.ts`: a hand-written `KeyedAsyncMutex` keyed by `projectId` serializes every browser command (agent commands + the `/preview` endpoint), and `BrowserTabManager` gives each agent its own chromium tab via index tracking. The `tab_*` and `close` actions are reserved by Studio (rejected at the dispatcher) so the LLM can't desync tab indexes. Idle agent tabs are evicted after 10 minutes by `startBrowserTabCleanup()` (started from `index.ts`); the LRU tab is evicted when a project hits its tab cap. The cap is per-project, configurable via `BrowserProjectConfig.max_tabs` (default `DEFAULT_MAX_TABS_PER_PROJECT = 10`, range 2..50). `runtimeManager.sleep()` and the browser config PATCH routes call `browserTabManager.dropProject()` to keep state coherent across config changes and project restarts. The Debug panel at the bottom of the browser settings page polls `GET /api/projects/:pid/browser/status` every 2s to render the live tab table + mutex state — use it when debugging "agent X is stuck" or "two agents stepping on each other".

**System tab (index 0) is intentional and never evicted.** The chrome container starts with `chromium ... about:blank`, which becomes index 0 in `BrowserTabManager`. It has `agentId: null`. `pickIdleTabs()` and `pickEvictionCandidate()` both skip system tabs (`if (t.agentId === null) continue`), so the system tab persists for the entire project runtime. It's there to (a) be the chromium fallback when all agent tabs are evicted and (b) give `/preview` something to snapshot when no agents are active. The Debug panel UI shows it as `— always on` instead of an idle counter because the idle timer doesn't apply.

**Chromium in Docker MUST use `--no-sandbox`:** `packages/browser/docker/entrypoint.sh` runs chromium with `--no-sandbox` because Docker Desktop on macOS/Windows does not expose unprivileged user namespaces to containers. Without it, chromium's zygote dies at startup with `ERROR:zygote_host_impl_linux.cc:128] No usable sandbox!` and only fluxbox/noVNC's blank wallpaper is visible. The entrypoint also waits for chromium's CDP HTTP endpoint to become reachable on `127.0.0.1:19222` before starting socat — without this readiness probe, socat would race and emit "Connection refused" forever if chromium is slow.

**Browser container logs:** `packages/browser/docker/entrypoint.sh` writes per-process logs into `/var/log/jiku-browser/{xvfb,fluxbox,chromium,nginx-error,x11vnc}.log` inside the container. When debugging "Chromium doesn't appear in noVNC", `docker exec <id> tail /var/log/jiku-browser/chromium.log` is the fastest path to the actual error.

## Plan 16 — Filesystem Revision V2

**S3 keys are UUID-based and immutable:** `adapter.buildKeyFromId(fileId)` produces `objects/{2-char-prefix}/{fileId}`. The key never changes after file creation — `move()` and rename only update DB metadata (path, name, folder_path), not the S3 key. Legacy keys (`projects/{projectId}{path}`) are migrated lazily on first read via `ensureModernKey()`. Detection: `S3FilesystemAdapter.isLegacyKey(key)` checks `key.startsWith('projects/')`.

**FilesystemService is LRU-cached in `factory.ts`:** `getFilesystemService(projectId)` caches the constructed service (adapter + decrypted credential) per project, max 500 entries, TTL 5min. All consumers import from `service.ts` which re-exports from `factory.ts`. Call `invalidateFilesystemCache(projectId)` when config changes (PATCH /config, manager.sleep, credential rotation).

**`project_folders` table replaces virtual folder derivation:** `list()` queries `project_folders` for subfolders (index on `project_id, parent_path`) instead of fetching ALL file paths and deriving subfolders in application code. `write()` auto-upserts ancestor folders via `getAncestorPaths()`. `deleteFolder()` cleans up folder entries.

**File deletion is tombstone-based:** `delete()` removes the DB row immediately and enqueues the `storage_key` into `storage_cleanup_queue`. `StorageCleanupWorker` (started from `index.ts`, runs every 30s) processes pending entries with retry (max 3 attempts).

**`read()` returns `{ content, version, cached }`:** `version` enables optimistic locking in `fs_write` (via `expected_version`). `cached` tells the agent whether content came from DB cache or S3. Cache validity: `cache_valid_until` (24h TTL) + `content_version` bump on every write.

**tsvector search uses a generated column + GIN index:** `search_vector TSVECTOR GENERATED ALWAYS AS (to_tsvector('simple', name || ' ' || path)) STORED` is added via manual SQL migration (Drizzle lacks native tsvector type). `searchFiles()` tries `search_vector @@ to_tsquery('simple', query || ':*')` first, falls back to ILIKE if the column doesn't exist. Prefix-only (not substring like `%query%`), but complemented by `name_lower` B-tree index for `LIKE lower(query)%` patterns.

**Chromium DNS rebinding protection requires an HTTP proxy in front of CDP:** Chromium's DevTools HTTP handler rejects every `/json/*` request whose `Host` header is not `localhost`, `127.0.0.1`, or an IP address — error message: `"Host header is specified and is not an IP address or localhost."`. This breaks every cross-container CDP call, because the inbound `Host` header is the chrome service's docker compose alias (e.g. `bitorex-...-chrome-1`). The previous design used `socat` for the 9222→19222 forward, which is purely TCP and passes the Host header through unchanged — so it worked locally (`localhost:9222`) but silently failed in production (Dokploy). The fix in `packages/browser/docker/{Dockerfile,nginx.conf,entrypoint.sh}` is **nginx-light** as the public listener on 9222: it forwards to `127.0.0.1:19222` and unconditionally `proxy_set_header Host "localhost"`. nginx also handles the WebSocket upgrade for the CDP socket. **Never** replace the nginx step with a TCP-only forwarder again.

## ToolOutput renders content[] arrays with image support

`packages/ui/src/components/ai-elements/tool.tsx` `ToolOutput` component handles tool output that is `{ content: ContentPart[] }`. Image parts (`type: 'image'`, `data`, `mimeType`) render as `<img src="data:...">`. Text parts render as CodeBlock. Single-image-only responses render without wrapper div. This pattern is used by the browser screenshot tool.

Never return `{ type: 'text', text: 'Screenshot saved: /path...' }` from server tool handlers — it exposes server filesystem paths to end users. Return only the image data part.

## Wrap stream untuk cleanup after full consume

`modelCache.delete(cacheKey)` tidak bisa dilakukan di `finally` setelah `runtime.run()` karena stream di-consume setelah method return. Bungkus stream dalam custom `ReadableStream` yang delete cache key di: `done === true` (drain selesai) dan `cancel()` (client disconnect).

## Plugin UI — Plan 17 gotchas

### Plugin bundles run with their own React instance

Each plugin is a self-contained ESM bundle (tsup) — bundles its own React + ReactDOM + `@jiku/kit/ui`. The host does not share its React instance with plugins. Consequences:

- **Do not use React context across the host/plugin boundary.** Pass `ctx` as a plain prop (that's what `defineMountable` does).
- **`usePluginQuery` / `usePluginMutation` in `@jiku/kit/ui` are plain `useState` + `useEffect`**, not TanStack Query. They work with any React instance. Do not rewrite them using Studio's query client.
- **Host components use their own React.** `<Slot>` → `<SlotIsland>` → `<div ref>` + `useEffect(mount)` — Studio's React tree stops at the div; the plugin's React takes over inside.

### Dynamic URL import must bypass the bundler

Turbopack and webpack both try to resolve `import(someVar)` at build time. For plugin bundles loaded at runtime from `/api/plugins/:id/ui/*.js`, use:

```ts
const runtimeImport = new Function('u', 'return import(u)') as (u: string) => Promise<any>
```

in `apps/studio/web/lib/plugins/mount-runtime.ts`. Do not switch to a plain `import(url)` — the bundler will try to analyze it and fail.

### tsup config must `noExternal` workspace + React

tsup externalizes deps by default. Plugin bundles MUST force-bundle React + workspace packages or the browser gets bare-specifier imports it can't resolve:

```ts
noExternal: [/^@jiku\//, /^@jiku-plugin\//, 'react', 'react-dom', 'react-dom/client']
```

Without this: `Failed to resolve module specifier '@jiku/kit/ui'` in the browser.

### Studio host types: `depends: [StudioPlugin]`, not TS augmentation

Plugins that need `ctx.http` / `ctx.events` / `ctx.connector` declare `depends: [StudioPlugin]` (from `@jiku-plugin/studio`). Typed access comes from the plugin system's `MergeContributes<Deps>` — NOT from `declare module` augmentation. See ADR-038.

For plugin UI components, import `StudioComponentProps` from `@jiku-plugin/studio` as the prop type:

```tsx
import type { StudioComponentProps } from '@jiku-plugin/studio'
function Dashboard({ ctx }: StudioComponentProps) { ctx.studio.api.get(...) }
export default defineMountable(Dashboard)
```

### `ContributesValue = object` (not `Record<string, unknown>`)

In `@jiku/types`. A stricter constraint (with index signature) rejects concrete interfaces. Kept at `object` so any shape is acceptable; the inferred `TContributes` carries the narrow type through `MergeContributes` unchanged.

### Plugin asset router must be registered BEFORE authed routers

In `apps/studio/server/src/index.ts`, `pluginAssetsRouter` must come before any router that calls `router.use(authMiddleware)` globally. Otherwise the first authed router 401's the unauth'd browser dynamic-import request, and the request never falls through to the public asset handler. Signature-based auth at the asset router is the only gate; prior routers must not pre-empt.

### Plugin asset URLs are signed (HMAC) with `JWT_SECRET`

Registry (authed) mints `?sig=<HMAC>&exp=<epoch>` per file; asset router verifies. TTL 10 min. TanStack Query `staleTime: 30s` keeps sigs rotated. If adding a reload-bust param, use `&` (not `?`) since the URL already carries a query string.

### Plugin UI provider lives at `studio/layout.tsx`

`PluginUIProvider` MUST wrap both sidebar + project tree. Putting it inside `projects/[project]/layout.tsx` leaves the sidebar (rendered by parent) outside the context and crashes `usePluginUIRegistry`. Use `useOptionalPluginUIRegistry()` defensively in shared sidebar components.

### No `process.env.*` in plugin `src/ui/*`

tsup inlines `process.env.*` at build time. The bundle is served via signed-but-shareable URL — any Studio-authed user can fetch + read it. Plugin authors MUST move any config into `src/index.ts` (server-side) and expose it through `ctx.http` handlers filtered per user.

### Plugin loader auto-discovery; NarrationPlugin registered explicitly

`apps/studio/server/src/index.ts` calls `discoverPluginsFromFolder('<repo>/plugins')` at boot — every subfolder with a valid `package.json` + default-exported `PluginDefinition` is loaded. The one exception is `NarrationPlugin` (`apps/studio/server/src/plugins/narration.ts`), registered explicitly because its behavior (baseline system-prompt injection) is Studio-product-specific, not plugin contract.

Connector functionality (the `jiku.connector` plugin) is NO LONGER a separate plugin — it's part of `@jiku-plugin/studio`'s contributes. Runtime is wired via the existing `connector:register` hook in the context-extender.

### `jiku` CLI is in `apps/cli/`, NOT in kit or server

Plugin management tooling (commander + Ink + tsup) lives in `apps/cli/`. It's not imported by studio server or web — so tsup/Ink/commander can never leak into the client bundle. See ADR-039.

Run via `bun run jiku ...`. `jiku plugin build` + `jiku plugin watch` are cwd-aware: inside a plugin folder → scope to that plugin; else all plugins with UI entries.

## Content attachment persistence pattern (Plan 33)

Tool outputs (screenshots, exported data) should be persisted as attachments, not returned as base64 inline. Pattern:

1. **Tool execution** (e.g. `executeBrowserAction` for screenshot):
   - Call `persistContentToAttachment({ projectId, data: buffer, mimeType, sourceType, metadata })`
   - Returns `{ attachmentId, storageKey, mimeType }` (no URL — only storage references)
   - Upload to S3 via filesystem adapter; DB record created automatically

2. **Tool output format**: Return `ToolContentPart` array:
   ```typescript
   { content: [{ type: 'image', attachment_id, storage_key, mime_type }] }
   ```
   NOT: `{ content: [{ type: 'image', data: 'base64...', mimeType }] }`

3. **URL generation** happens at TWO layers:
   - **UI rendering**: `useAttachmentUrl()` hook generates `/api/attachments/:id/inline?token=JWT` with token injection
   - **LLM delivery**: Chat route converts `attachment://id` to proxy_url or base64 per agent's `file_delivery` setting

4. **Why storage_key + attachment_id, not URL**:
   - Decouples storage from URLs (domain changes don't break data)
   - Single source of truth in DB; URLs are derived on-demand
   - Enables URL generation in multiple contexts (UI proxy, LLM delivery, etc.)

Never store URLs in the database. Always resolve attachments via ID at the edge (UI or API).

## Binding semantics: scope is explicit and strict (ADR-074)

Do NOT create bindings with `source_type='any'` + null `scope_key_pattern` + null `source_ref_keys` — that's the legacy loose mode and will capture unrelated users / scopes. DM bindings MUST have `source_ref_keys={ user_id: X }`; group/channel bindings MUST have `scope_key_pattern='group:<chat_id>'`. Pairing approval endpoint enforces this for DMs. `my_chat_member` + first-group-message fallback enforce it for groups. When you add a new adapter / flow that creates bindings, replicate the same strict scoping — `matchesTrigger()` now has implicit scope gates from `source_type` but `any` still bypasses them.

## `source_ref_keys.user_id` is special — it comes from `event.sender.external_id`, not `event.ref_keys`

Platforms don't put the sender id in `ref_keys` (Telegram uses `{message_id, chat_id, thread_id}`). The DM sender lock is implemented by treating the key name `user_id` specially inside `matchesTrigger()`: it's compared against `event.sender.external_id`. Other keys in `source_ref_keys` (e.g. `chat_id`) still compare against `event.ref_keys`. Don't add a synthetic `user_id` into `event.ref_keys` in the adapter — it would shadow the special-case path and break cross-plane consistency.

## Always log inbound messages even when no binding matches

`connector_messages` is a complete inbound traffic log — `routeConnectorEvent` writes an `unhandled` row at the no-match branch so the Messages UI and the `connector_get_thread` agent tool see every message. `connector_events` was already complete. Inbound status vocabulary (ADR-076): `handled` / `unhandled` / `pending` / `dropped` / `rate_limited`. Outbound: `sent` / `failed`. When adding a new routing branch, write a corresponding `logMsg` with the right status or the Messages UI will silently miss that case.

## Group pairing = ONE draft binding per scope, not one pending identity per member

Groups are auto-detected two ways: `my_chat_member` when bot is added (Telegram), and lazily on first message event with `event.scope_key` set (fallback for bots added before the hook existed). Both paths create a SINGLE disabled binding with `scope_key_pattern='group:<id>'` + `output_config.agent_id` empty. Admin approves via the "Group Pairing Requests" UI (distinct from DM pairing requests) — picks agent + `member_mode` and flips `enabled=true`. Do NOT create per-user pending identities for group events at the no-binding-match branch; that floods the admin UI.

## Filesystem: read-before-write + stale-state protection (ADR-075)

`fs_write` / `fs_edit` require a `fs_read` in the same conversation and reject on external modification. Tracker is `conversation_fs_reads (conversation_id, path, version, content_hash, read_at)` PK `(conversation_id, path)`. Exception: `fs_write` for a file that doesn't exist yet. Error codes are user-facing: `MUST_READ_FIRST`, `STALE_FILE_STATE`. When adding a new write-path (e.g. a plugin tool that mutates project files), call `getFsRead` + validate version against `getFileByPath` before writing, and `recordFsRead` after writing so subsequent calls chain correctly. Prefer `fs_append` for append-only workflows — it bypasses the gate but invalidates the tracker row (forces re-read for next edit).

## `fs_read` returns `cat -n` format — strip prefixes for `fs_edit`

`fs_read` output is line-number prefixed (`  12\tcontent`) with per-line truncation at 2000 chars. `fs_edit`'s `old_string` must match the RAW file content, NOT the prefixed display. The tool description warns the model about this but it's worth remembering when debugging "why does fs_edit say not-found when I clearly see the string".

## `upsertFile` must increment `version` on every update

Optimistic lock was silently broken for a long time because `upsertFile()` only set `size_bytes` / `mime_type` / `content_cache` / `updated_at` on update — version stayed at 1 forever. Fixed: `version += 1` per update, `content_version += 1` only when `content_hash` (SHA-256 of content, computed in `filesystem/service.ts`) changes. When writing new queries that update `project_files`, keep this invariant or downstream stale detection breaks.

## Raw platform payload is preserved on events + messages

`connector_events.raw_payload` and `connector_messages.raw_payload` hold the original platform JSON (Telegram Update, Telegram sendMessage response, etc.) so the detail drawer can show it and agents can mine it for entities / custom_emoji / attachments. Inbound webhook handler attaches `req.body` if not set; polling handlers (Telegram `bot.on('message'|'message_reaction'|'edited_message'|'channel_post'|'my_chat_member')`) must explicitly set `event.raw_payload = gramCtx.update`. New adapters should follow the same pattern. Outbound path: `ConnectorSendResult.raw_payload` carries the platform API response; adapter `sendMessage` should populate it.

## Telegram `bot.on('message')` fires for service messages too — classify before emitting

`new_chat_members`, `left_chat_member`, `new_chat_title`, `pinned_message`, `migrate_to_chat_id`, `voice_chat_*` etc. all land on the generic `message` handler with `text`/`caption`/media all absent. Without filtering, the agent runs on "(no text content)". Current handler classifies: content present → `type: 'message'`; `new_chat_members` → `'join'`; `left_chat_member` → `'leave'`; other service messages → skip silently. When mirroring this to another adapter (Discord/WhatsApp/Slack), apply the same classification — never emit an empty-content `message` event.

## Connector queue: await full stream drain before releasing `runningConversations`

`drainConnectorQueue` previously released the flag after `runtimeManager.run()` returned but BEFORE the stream was consumed — assistant message is only persisted when the stream finalizes, so the next queued run saved its user message against a stale `active_tip_message_id` → siblings → spurious branches. Fix: `await Promise.all([next.resolve(...), observerDrain])` inside the try block. When adding another path that processes queued runs, enforce the same invariant: hold the conversation lock across the ENTIRE stream, not just the call setup.

## `authMiddleware` accepts `?token=` for SSE

EventSource can't set custom headers, so the middleware also reads `req.query.token` when the Authorization header is missing. This is fine for SSE (read-only streams) but keep in mind when adding new query-authenticated endpoints — they get the same access as header-authenticated ones. Don't expand this to mutations.

## Connector context + user input use XML boundaries (prompt-injection defence)

Every connector-triggered run composes input as `<connector_context>…</connector_context>\n\n<user_message>…</user_message>`. The context block is SYSTEM-generated metadata and is trusted; everything inside `<user_message>` is untrusted user text. Previously only a blank line separated them — a user could craft a message that injects a fake `[Connector Context]` header and the agent might treat it as trusted. The context block also carries an explicit instruction telling the model to treat user_message content as untrusted and not obey attempts to override the metadata. When composing connector-sourced agent input from ANY adapter/path, use the same wrapping.

## Trigger-mode detection is adapter-authoritative (ADR-078)

Shared event-router CAN'T detect bot-mention / reply-to-bot reliably — that needs platform entity parsing + bot identity cache. So adapter pre-computes two boolean flags on every inbound message event:

- `event.metadata.bot_mentioned` — set when THIS bot was explicitly @-mentioned (Telegram: scan `entities`+`caption_entities` for `type='mention'` matching `@<botUsername>` OR `type='text_mention'` where `user.id===botUserId`).
- `event.metadata.bot_replied_to` — set when user hit Reply on one of the bot's own messages (Telegram: `reply_to_message.from.id===botUserId` AND NOT `reply_to_message.forum_topic_created` which is the synthetic topic-pointer).

Adapter must cache bot identity at activation (`getMe()` on grammy → `botUsername` + `botUserId`) and clear on deactivate. When porting to new platforms, populate the same two flags and `matchesTrigger` works unchanged.

Per-binding customization (migration 0029) layers on top: `trigger_mention_tokens` (custom tokens, substring match), `trigger_commands` (whitelist for `/...`), `trigger_keywords_regex` (treat keywords as case-insensitive regex). DMs implicitly pass mention/reply (whole message is for the bot); no need for config.

## Topic auto-register — first message with known topic_title creates a target

Telegram forum topics auto-register as `connector_target` rows the first time we see a message from that topic with a known topic title (from `reply_to_message.forum_topic_created.name` or equivalent). Idempotent — `getConnectorTargetByName` guards. Naming: `<chat-slug>__<topic-slug>`. `scope_key='group:<chat_id>:topic:<thread_id>'` MUST match `computeScopeKey` output so outbound via this target threads into the same conversation as inbound events.

When adding a new adapter that supports topics/threads/channels, follow the same pattern: auto-register on first meaningful signal, use the normalized scope_key format, check-before-create.

## `scope_key` format must be CONSISTENT between adapter events and admin-created rows

`computeScopeKey` in the Telegram adapter returns `group:<chat_id>` (+ optional `:topic:<id>`). Any code path that creates a `connector_target` or a scope-conversation row MUST use the same format. A prior bug: `my_chat_member` auto-register was using `scope_key='chat:<id>'` which never matched inbound `group:<id>` events → outbound-via-target created a SEPARATE scope conversation from inbound, fragmenting history. When adding new auto-register paths across any adapter, use the adapter's `computeScopeKey` conventions exactly.

## Adapter portability — normalise, don't leak platform quirks into shared code

Connector infrastructure (event-router, pairing flow, member_mode gate, scope gate, channels UI, agent tools, context block, internal-id injection) is platform-agnostic. Adapter's job is to normalise platform events into the project's ref_keys + metadata vocabulary:

- `ref_keys`: `{ chat_id, message_id, thread_id? }` — required names, even if the platform uses different native ids (WhatsApp JID, Discord snowflake, etc. — all remapped to `chat_id`).
- `sender.external_id` is the platform user id — NOT in `ref_keys`. Matcher has a special case that compares `source_ref_keys.user_id` against `sender.external_id`.
- `metadata.{chat_title, chat_type, thread_title, client_timestamp, language_code}` — optional but strongly recommended; the context block + `listConnectorDistinctEntities` query use them for labels.
- `raw_payload` — both inbound (`ConnectorEvent.raw_payload` via `parseEvent` return OR webhook's `req.body`) and outbound (`ConnectorSendResult.raw_payload` from the adapter's `sendMessage`). Agents rely on this for platform-specific extraction.
- `scope_key` — normalise to `group:<id>` or `group:<id>:topic:<id>` or `undefined` (DM). Channels UI patterns (`group:*`, exact, `group:X:*`) are prefix/exact text matching — adapter format is opaque but must be consistent.
- Service messages — filter BEFORE emitting. NEVER emit a `message`-type event with empty content (no `text`/`caption`/media).

Telegram-only quirks live in `plugins/jiku.telegram/src/index.ts`: `my_chat_member` auto-register, `forum_topic_created.name` extraction, `deleteWebhook + close` pre-flight, simulate-typing. When adding WhatsApp/Discord/Slack, copy THE CONVENTIONS but implement platform glue fresh. See ADR-077 + `docs/feats/connectors.md` → "Adapter portability".

## Context block embeds internal DB ids alongside platform ids

Every agent invocation from a connector event carries `Internal event_id: <uuid>` + `Internal message_id: <uuid>` in the `<connector_context>` block. These point to rows in OUR `connector_events` / `connector_messages` tables (distinct from the platform `message_id` / `chat_id` under `Chat ref`). Agents use them via `connector_get_event({event_id})` / `connector_get_message({message_id})` to load the full row including `raw_payload`. IMPORTANT: `logMsg` must run BEFORE `buildConnectorContextString` in the event-router so the row id exists to embed. When adding a new routing branch that emits a context block, keep this ordering or the internal ids will be absent.

## Always `deactivate` before `delete` on a connector

`DELETE /connectors/:id` must call `deactivateConnector(id)` FIRST to tear down the in-memory adapter (stop polling, clear timers, remove SSE subscriptions) before deleting the DB row. Skipping this leaves an orphaned adapter running against the external platform — symptom on Telegram: `409 Conflict: terminated by other getUpdates request` when the admin recreates a connector with the same bot token. Same invariant applies to any future connector CRUD operation that invalidates an adapter (token swap, credential change, plugin_id swap).

## Telegram adapter `onActivate` pre-flight: `deleteWebhook` + `close`

On `onActivate`, the Telegram adapter calls `bot.api.deleteWebhook({ drop_pending_updates: true })` then `bot.api.close()` before `bot.start()`. `close()` tells Telegram to release the bot token's server-side long-poll slot — even if the previous local poller exited cleanly, Telegram's slot lingers for up to ~30s, which otherwise collides with the new polling loop. Both calls are idempotent and safe to fail; errors are logged + ignored (429 "too early" from `close()` is normal if the bot hasn't been polled yet).

## Discovery-first + fresh-per-iteration — connector tool discipline

Tool descriptions enforce a strict order when agent touches connector traffic:
1. `connector_list` (connectors) — call FRESH every iteration; never cache across turns.
2. `connector_list_entities` (chats/users/threads) — AUTHORITATIVE discovery; always call before `connector_get_events` / `connector_get_thread` when target ids aren't already verified this turn.
3. `connector_list_targets` is ALIAS-only — an admin-registered subset, NOT the full chat list. Use only when user explicitly references a named alias.
4. `connector_list_scopes` is even narrower — shows scopes that currently have an ACTIVE agent conversation bound. Prefer list_entities for general discovery.

Every observe-or-act flow re-fetches discovery in-iteration — data from earlier turns is considered stale. When adding new connector tools, copy this same freshness + discovery language so the agent's behavior stays consistent.

## `connector_list_entities` before paging — agent discipline

Event and message tables get LARGE. Agents must NOT call `connector_get_events({limit:100})` blindly. The tool descriptions enforce filter-first usage by listing every filter dimension explicitly. When the agent doesn't know which chat_id / user_id to target, call `connector_list_entities({ scope: 'chats'|'users'|'threads' })` first — it returns distinct entities with labels + counts so the agent can pick the right one. Then `connector_get_events` / `connector_get_thread` with `chat_id` / `user_id` / `content_search` filters + `cursor` pagination. `next_cursor` opaque base64 of `<iso>|<uuid>` — matches the REST cursor so frontend + agent share the same pagination model.

## `connector_list_targets` returns connector metadata per row; `connector_send_to_target` detects ambiguity

Each target row includes `{ connector: { id, plugin_id, display_name, status } }` so the agent doesn't need a follow-up `connector_list` call. `connector_send_to_target` with omitted `connector_id` accepts unique target names, but returns `{ success: false, code: 'AMBIGUOUS_TARGET', candidates: [...] }` when the same name exists on multiple connectors — the agent retries with explicit `connector_id`. When adding similar "address by name" APIs, use the same pattern (enriched list + explicit ambiguity error) rather than silently picking the first match.
