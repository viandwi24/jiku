# Branch Chat (Plan 23)

Message-level branching for chat conversations. Same conversation id, same URL — only the *path through the message tree* changes when the user edits a previous message or regenerates a response.

## What it does

- Every `messages` row has a `parent_message_id` (self-FK, ON DELETE CASCADE) and a `branch_index`. The set of messages forms a tree per conversation.
- `conversations.active_tip_message_id` points at the leaf of the currently selected branch.
- "Active path" = `tip → … → root` walked via `parent_message_id`.
- Branching is implicit: any new message inserted with a `parent_message_id` that already has children becomes a sibling. `branch_index = MAX(siblings) + 1`.

## Public API

### Routes

- `GET /conversations/:id/messages` → `{ conversation_id, active_tip_message_id, messages: MessageWithBranchMeta[] }`. Each message in the response carries `parent_message_id`, `branch_index`, `sibling_count`, `sibling_ids`, `current_sibling_index` when the conversation has a tip set.
- `POST /conversations/:id/chat` — body accepts `parent_message_id?: string | null`. When omitted the runner falls back to `conversation.active_tip_message_id` (linear extend).
- `POST /conversations/:id/regenerate { user_message_id }` — re-run the model from an existing user message. The new assistant reply is saved as a sibling of any prior reply. 409 if a run is in progress.
- `PATCH /conversations/:id/active-tip { tip_message_id }` — switch the active branch. Returns the new active path. 503 if a run is in progress.
- `GET /conversations/:id/sibling-tip?sibling_id=` — resolve the latest leaf inside a sibling subtree (used by the navigator before switching).

### Runner params (`@jiku/types` → `JikuRunParams`)

- `parent_message_id?: string | null` — override which message the new user message hangs off.
- `regenerate?: boolean` — when true, skip the user-message save and treat `parent_message_id` (must be a user msg) as the existing turn.

### Storage adapter (`@jiku/types` → `JikuStorageAdapter`, optional methods)

- `getActivePathMessages(conv_id)` — load root → tip with sibling counts.
- `getMessagesByPath(tip_id)` — same, but pinned to a supplied tip.
- `addBranchedMessage({ conv, parent, role, parts })` — single-tx insert + tip bump.
- `setActiveTip(conv_id, tip_id)` — persist a new tip.

## UI

- `apps/studio/web/components/chat/branch-navigator.tsx` — `← N/total →` shown above any message with `sibling_count > 1`. Label "Edit" on user messages, "Response" on assistant. Hidden entirely when there's only one sibling.
- `apps/studio/web/components/chat/message-edit-input.tsx` — inline `Textarea` + Send/Cancel; ⌘/Ctrl+Enter submits, Esc cancels.
- `ConversationViewer` — Pencil button on user messages, RefreshCw on assistant messages. Both disabled while streaming.

## Known limitations

- ~~Compaction is disabled on branched conversations~~ — **revised:** compaction is now branch-aware and append-only (ADR-073 revised). Insertions a `[Context Summary]` assistant message via `addBranchedMessage(parent = current_tip)`; `applyCompactBoundary` trims pre-checkpoint history at load time. Old rows stay in DB so other branches remain navigable. Skipped during edit-fork and regenerate.
- **No branch merging.** No way to combine two branches.
- **No branch labels.** Navigator shows `2 / 3` only — no user-supplied names.
- **No branching in `task` mode.** Chat only.
- **Multi-tab race:** last writer wins on `active_tip_message_id`. Acceptable; SSE notification could fix this if it becomes a complaint.
- **Latest-leaf descent on switch (ADR-071):** walking into a sibling always lands on its newest leaf. We don't remember per-user "last visited leaf".
- **Sidebar "(branched)" indicator:** not yet implemented.
- **No toast UI yet** — failures are `console.error` only.

## Related files

- Migration: `apps/studio/db/src/migrations/0024_plan23_branch_chat.sql`
- Schema: `apps/studio/db/src/schema/conversations.ts`
- Queries: `apps/studio/db/src/queries/conversation.ts`
- Storage: `apps/studio/server/src/runtime/storage.ts`
- Runner: `packages/core/src/runner.ts` (history load, user-msg save, assistant-msg save, compaction guard)
- Routes: `apps/studio/server/src/routes/{chat,conversations}.ts`
- Types: `packages/types/src/index.ts`
- Web: `apps/studio/web/lib/api.ts`, `apps/studio/web/components/chat/{conversation-viewer,branch-navigator,message-edit-input}.tsx`
- ADRs: ADR-067 … ADR-073 in `docs/builder/decisions.md`
