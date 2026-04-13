# Plan 23 — Branch Chat — Implementation Report

**Status:** Shipped (2026-04-13)
**Plan:** `docs/plans/23-branch-chat.md`
**Feature doc:** `docs/feats/branch-chat.md`
**ADRs:** ADR-067 → ADR-073 in `docs/builder/decisions.md`
**Migration:** `apps/studio/db/src/migrations/0024_plan23_branch_chat.sql`

Message-level branching for chat conversations — Claude.ai/ChatGPT-style edit & regenerate. Same conversation id, same URL; only the path through the message tree changes. Compaction is now branch-aware and append-only.

---

## What shipped

### 1. Schema (`0024_plan23_branch_chat.sql`)

Additive migration — wrapped in `BEGIN; … COMMIT;`, idempotent (`IF NOT EXISTS` on every column + index), no DROP / DELETE / overwrite.

- `messages.parent_message_id uuid REFERENCES messages(id) ON DELETE CASCADE` (nullable)
- `messages.branch_index integer NOT NULL DEFAULT 0`
- `conversations.active_tip_message_id uuid REFERENCES messages(id) ON DELETE SET NULL`
- Indexes: `idx_messages_parent`, `idx_messages_conv_parent (conversation_id, parent_message_id)`, `idx_conv_active_tip` (partial, NOT NULL)
- Backfill: existing messages get `parent_message_id = LAG(id) OVER (PARTITION BY conversation_id ORDER BY created_at, id)`. Each conversation's tip = its last message. After backfill, every old conversation reads identically to before via the active path walk.

Per project convention `_journal.json` stays at idx 2 — SQL files are loaded manually by the deployment script (same pattern as `0017–0023`).

### 2. Query layer (`apps/studio/db/src/queries/conversation.ts`)

- `getActivePath(convId)` — single recursive CTE that walks `tip → root` via `parent_message_id` and per-row sub-selects `sibling_count` + `sibling_ids` (ordered by `branch_index ASC, created_at ASC`). Uses `IS NOT DISTINCT FROM` so root messages (parent NULL) compare correctly. Returns `MessageWithBranchMeta[]` ready for the navigator.
- `getMessagesByPath(tipId)` — same walk but starts from a supplied tip, returns raw rows. Used by the runner when an explicit `parent_message_id` is supplied.
- `getLatestLeafInSubtree(rootId)` — descends from a sibling, always picking the child with the highest `branch_index`, until a leaf (ADR-071). Used before `setActiveTip` so `←/→` lands on the user's most recent leaf in that subtree.
- `setActiveTip(convId, tipId)` — persist a new tip.
- `addBranchedMessage({ conv, parent, role, parts })` — single-tx insert with auto-computed `branch_index = MAX(siblings) + 1` then bumps `active_tip_message_id` atomically.
- `getMessageById`, `conversationHasBranching` — utility.

### 3. Storage adapter (`apps/studio/server/src/runtime/storage.ts`)

`StudioStorageAdapter` implements the new optional `JikuStorageAdapter` methods: `getActivePathMessages`, `getMessagesByPath`, `addBranchedMessage`, `setActiveTip`. `Message` mapping carries `parent_message_id` + `branch_index`; `Conversation` mapping carries `active_tip_message_id`. In-memory adapter (`packages/core/src/storage/memory.ts`) is unchanged — runner falls back to flat `getMessages`/`addMessage` when these methods are absent.

### 4. Types (`packages/types/src/index.ts`)

- `Message.parent_message_id?` + `Message.branch_index?` (optional — kept backwards compatible with existing call sites).
- `Conversation.active_tip_message_id?`.
- `MessageWithBranchMeta extends Message` with `sibling_count`, `sibling_ids`, `current_sibling_index`.
- `JikuRunParams.parent_message_id?: string | null` and `regenerate?: boolean`.
- `JikuStorageAdapter` gains the four optional branching methods.

### 5. Runner (`packages/core/src/runner.ts`)

The interesting work. Three behaviors hinge on the same pair of computed values:

```ts
const preCompactionTip = conversation.active_tip_message_id ?? null
const _wasLinearExtend = params.parent_message_id === undefined
                       || params.parent_message_id === preCompactionTip
```

**(a) History reference** — what the model sees:
```ts
const historyRef = _wasLinearExtend
  ? (conversation.active_tip_message_id ?? null)        // latest tip (post-compaction)
  : (params.parent_message_id ?? null)                  // explicit override
// historyRef === null → []
// historyRef is uuid → getMessagesByPath(historyRef)
```
This is what makes edit *actually* edit — for an explicit fork (`params.parent_message_id !== preCompactionTip`), we walk only ancestors of the supplied parent so the model never sees the about-to-be-superseded turn.

**(b) `desiredParent`** — where to attach the new user message:
```ts
const desiredParent = _wasLinearExtend
  ? (conversation.active_tip_message_id ?? null)        // (re)read after compaction
  : (params.parent_message_id ?? null)
```
For a linear extend after compaction, this falls through to the latest tip (the just-inserted checkpoint), so the user message chains off it instead of becoming its sibling.

**(c) Compaction trigger** — only when neither flag is set:
```ts
const isExplicitBranchFork = params.parent_message_id !== undefined
                          && params.parent_message_id !== preCompactionTip
const isRegenerate = params.regenerate === true
const shouldCompact = !isExplicitBranchFork && !isRegenerate
                   && await this.checkCompactionThreshold(...)
```

Other runner changes:
- `checkCompactionThreshold` now measures **active branch path tokens** with `applyCompactBoundary` already applied, not flat conversation tokens.
- When triggered, compaction APPENDS a checkpoint via `addBranchedMessage(parent = preCompactionTip, role: 'assistant', parts: [{type:'text', text: '[Context Summary]\n…'}])` instead of `replaceMessages`. Old rows preserved, other branches still navigable. In-memory adapter (no `addBranchedMessage`) keeps the old `replaceMessages` fallback.
- After compaction: `conversation = await this.storage.getConversation(...)` to pick up the new tip.
- User-message persistence routes through `addBranchedMessage` with the computed `desiredParent`. Assistant message hangs off the just-saved user msg id.
- `regenerate: true` mode: skip the user-message save, set `lastUserMessageId = desiredParent`, and skip the `messages.push({ role: 'user', content: input })` line so the model context isn't a duplicated user turn.
- Preview snapshot path (`runner.ts:~1040`) switched to active-path token + checkpoint count.
- Tool-dedup map (`priorSideEffectResults`) inherits branch-awareness for free since it scans `history`, which is now per-branch.

### 6. HTTP routes (`apps/studio/server/src/routes/`)

- `POST /conversations/:id/chat` — body accepts optional `parent_message_id?: string | null`. The route preserves the null-vs-undefined distinction (`parent_message_id === undefined ? undefined : parent_message_id`) so explicit "branch at root" is not silently downgraded into "use active_tip".
- `GET /conversations/:id/messages` — returns `{ conversation_id, active_tip_message_id, messages: MessageWithBranchMeta[] }` when the conversation has a tip; falls back to the flat list for empty/legacy conversations.
- `GET /conversations/:id/sibling-tip?sibling_id=` — runs `getLatestLeafInSubtree`. Used by the navigator before switching.
- `PATCH /conversations/:id/active-tip { tip_message_id }` — validates the tip belongs to the conversation, updates `active_tip_message_id`, returns the new active path. **503** if `streamRegistry.isRunning(convId)` (ADR-072).
- `POST /conversations/:id/regenerate { user_message_id }` — validates the user message, calls `setActiveTip(convId, user_message_id)`, then `runtimeManager.run({ ..., parent_message_id: user_message_id, regenerate: true })`. Pipes the resulting stream back via `pipeUIMessageStreamToResponse` and registers it in `streamRegistry` for live-parts polling. **409** if a run is already active.

### 7. Frontend API client (`apps/studio/web/lib/api.ts`)

- `conversations.messages` return type extended with branch metadata (`active_tip_message_id`, per-row `parent_message_id`, `branch_index`, `sibling_count`, `sibling_ids`, `current_sibling_index`).
- `conversations.resolveSiblingTip(convId, siblingId)`, `conversations.setActiveTip(convId, tipId)`.
- `conversations.regenerate(convId, userMessageId)` — uses `${BASE_URL}` + `getAuthHeaders()` (returns the raw `Response` so the caller can drain the body).

### 8. UI

`apps/studio/web/components/chat/branch-navigator.tsx` — `← N/total →` with `disabled` while streaming. Hidden when `total <= 1`.

`apps/studio/web/components/chat/message-edit-input.tsx` — inline `Textarea` + Send/Cancel; ⌘/Ctrl+Enter submits, Esc cancels.

`ConversationViewer` updates:

- Tracks `activeTip` + `branchMeta` map (id → `{parent_message_id, branch_index, sibling_count, sibling_ids, current_sibling_index}`) + `editingId`.
- `activeTipRef` (mutable ref mirror) so `prepareSendMessagesRequest` always reads the latest tip without rebuilding the `useChat` transport.
- `prepareSendMessagesRequest` injects `parent_message_id: activeTipRef.current` into the body.
- **Mount**: only `hydrateBranchMetaOnly()` — fetches `/messages` and updates `branchMeta` + `activeTip` *without* touching `messages`. Critical to avoid racing `useChat`'s optimistic send from the `pending_message` handler (the empty DB fetch was wiping the just-typed message).
- **Post-stream refresh**: `useEffect([isStreaming])` only acts when `isStreaming` transitions `true → false` (tracked via `wasStreamingRef`). On transition, full `refreshMessages()` repopulates messages + meta + tip.
- **`switchBranch(siblingId)`**: `resolveSiblingTip` → `setActiveTip` → hydrate + setMessages.
- **`submitEdit(messageId, newText)`**: re-fetches branch meta if missing for the edited message (defensive against stale state); stamps `activeTip` to `parent_of_M`; optimistically prunes `messages` from the edited message onward so the UI looks branched immediately; calls `sendMessage`. The next `prepareSendMessagesRequest` reads the new `activeTipRef` and the chat route receives the correct parent.
- **`regenerate(assistantMessageId)`**: optimistically slices the old assistant out of `messages`; calls `startLive()` BEFORE the request; fires `api.conversations.regenerate`; drains `res.body` so the server's SSE stream actually flows (raw fetch leaves it unread → backpressure stalls writes); `useLiveConversation`'s `onDone` handles the canonical refresh.
- **Action bar layout**: `BranchNavigator` is rendered inline next to Copy/Edit/Regenerate buttons — not above the message — to match user feedback that the previous position read awkwardly.
- **`displayMessages`**: appends `liveMessage` (from `useLiveConversation`) in BOTH readonly mode AND edit mode (so regenerate streams in real time, not just readonly observers).
- **`displayStreaming`**: edit mode = `isStreaming || liveStreaming` so indicators show during regenerate too.

`apps/studio/web/hooks/use-live-conversation.ts` — added an 8-second startup grace to `start()`. The poller tolerates `running:false` until either it has seen `running:true` once OR the grace window expires. Without this, the first `/live-parts` poll (firing 400 ms after `startLive()`) would race the server's `streamRegistry.startRun(convId)` and tear down the indicator a frame after appearing.

---

## Architectural decisions (ADR-067 → ADR-073)

| ADR | Title | Summary |
|-----|-------|---------|
| 067 | Message-level branching via `parent_message_id` | Tree per conv; conv id and URL stable. |
| 068 | Conversation tracks `active_tip_message_id` server-side | Survives reload/multi-tab; last-writer-wins. |
| 069 | Active path loaded via single recursive CTE | One round-trip; sibling sub-selects use `IS NOT DISTINCT FROM`. |
| 070 | Branching is implicit, not via a dedicated endpoint | Server always sets `parent_message_id` + `branch_index = max+1`; no `/branch` endpoint. |
| 071 | Branch switch uses "latest leaf" descent | Always pick `MAX(branch_index)` child until leaf. |
| 072 | Branch / regenerate / edit blocked while a run is in progress | UI disables; server returns 503/409. |
| 073 (revised) | Compaction is branch-aware and append-only | Insert `[Context Summary]` checkpoint via `addBranchedMessage`; reuse `applyCompactBoundary`; skip on explicit fork / regenerate. |

---

## QA round (post-ship fixes)

User-driven testing surfaced bugs my static reading missed. Captured here for future reference:

1. **First message disappeared during redirect from `/new`.** Initial `refreshMessages()` raced `useChat`'s optimistic send. Fix: mount-time hydration is meta-only.
2. **Edit silently degraded to linear append.** `branchMeta` was stale right after a turn (no post-stream refresh) → edit couldn't find the parent → null sent → chat route's `?? undefined` → "use active_tip" → linear. Fix: refresh on stream-end transition + preserve null/undefined in chat route + defensive re-fetch in `submitEdit`.
3. **Edit visually appended to old turn before snapping into branch.** Optimistic `setMessages(prev.slice(0, idx))` before sending.
4. **Branch navigator placement.** Moved into the action bar inline.
5. **Regenerate ran in background with no indicator.** Wired `useLiveConversation` for regenerate; optimistic prune; drain `res.body`.
6. **Regenerate indicator vanished after one frame.** Race between first poll and server-side `startRun`. Fix: 8-second startup grace.
7. **Regenerate fetch had no auth.** Used `BASE_URL` + `getAuthHeaders()`.

Then an objective audit — *not* surfaced by user testing — found:

8. **Edit leaked old M + reply into model context.** Runner was loading via `active_tip` even when `parent_message_id` was supplied. Fix: walk via `getMessagesByPath(params.parent_message_id)` when override is present.
9. **Regenerate duplicated user message in model context.** Skip `input.push` when `regenerate === true`.
10. **Compaction was disabled on branched conversations.** User pointed out that `applyCompactBoundary` already supports the marker pattern; only `replaceMessages` was destructive. Redesigned to append-only via `addBranchedMessage`. ADR-073 revised.

---

## Backwards compatibility

- **Existing chats unaffected.** Migration backfills every old conversation as a single linear branch (`branch_index=0`, parent chain by `created_at`). The active-path walk returns the same rows in the same order as the old `getMessages` query.
- **In-memory adapter unchanged.** Runner's optional-method checks (`if (this.storage.addBranchedMessage)`) gracefully fall back to the old flat behavior when methods are absent. Playground/tests keep working.
- **Other call sites (compaction-flush hook, finalize hook, replay test fixtures, etc.)** continue to read `Message[]` shape — the new fields are optional. Nothing in the codebase needed to be updated to handle the new schema.
- **Connector path (Telegram event-router).** Not yet branch-aware (no UI to switch branches over Telegram), but reads work fine since `getActivePathMessages` returns the linear backfilled chain for any single-branch conversation. Future work if multi-branch awareness is needed for connectors.

---

## Files touched

| Layer | File |
|-------|------|
| Migration | `apps/studio/db/src/migrations/0024_plan23_branch_chat.sql` |
| Schema | `apps/studio/db/src/schema/conversations.ts` |
| Queries | `apps/studio/db/src/queries/conversation.ts` |
| Storage adapter | `apps/studio/server/src/runtime/storage.ts` |
| Runner | `packages/core/src/runner.ts` |
| Server routes | `apps/studio/server/src/routes/{chat,conversations}.ts` |
| Types | `packages/types/src/index.ts` |
| Web API | `apps/studio/web/lib/api.ts` |
| Web hooks | `apps/studio/web/hooks/use-live-conversation.ts` |
| Web UI | `apps/studio/web/components/chat/{conversation-viewer,branch-navigator,message-edit-input}.tsx` |
| Docs | `docs/builder/{current,changelog,decisions,memory,tasks}.md`, `docs/feats/branch-chat.md`, this report |

---

## Deferred / follow-ups

Tracked under "Plan 23 follow-ups" in `docs/builder/tasks.md`:

- Sidebar "(branched)" indicator on conversation list.
- Toast UI for branch-switch / regenerate / edit failures.
- Keyboard arrows on `BranchNavigator`.
- E2E coverage for edit / regenerate / multi-branch navigation / root-message edit / non-tip regenerate.
- QA: long compaction-crossing conversation under branching (verify per-branch checkpoint isolation).
- Visual hint for messages on a non-default branch.

---

## Verification

- **Type check:** `tsc -p apps/studio/web` → 0 errors. `tsc -p packages/core` → only the same pre-existing errors documented in Plan 22 rev 3 next-up (`UserContentPart[]` mismatch in runner.ts, NodeJS namespace, etc.) — unchanged by this work. Server has the same pre-existing pattern errors (`req.params: string|string[]`, `Record<string, unknown>` → `StreamChunk` casts) — Plan 23 added no new error categories.
- **Manual UX QA (user-driven):** halo → x=10 → edit to x=15 → branch correctly created with navigator showing 1/2 ↔ 2/2; regenerate streams in real time with thinking indicator; branch switch returns to other branch and back without state corruption; first-message-after-redirect renders immediately.
- **DB safety:** migration is `BEGIN/COMMIT`, idempotent (`IF NOT EXISTS`), additive only. Rollback is `DROP COLUMN` on the three new columns + `DROP INDEX` on the three new indexes.
