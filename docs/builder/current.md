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
