## Phase
Plan 5 — Studio Web UI/UX Overhaul — COMPLETE + Polish done

## Currently Working On
- Nothing — all phases complete, all polish items done.

## Relevant Files
- `apps/studio/web/app/(app)/studio/companies/[company]/projects/[project]/chats/**` — full chat system (new route prefix)
- `apps/studio/server/src/routes/conversations.ts` — all conversation endpoints including GET messages
- `apps/studio/db/src/schema/conversations.ts` — `parts` column (was `content`)
- `apps/studio/server/src/runtime/storage.ts` — reads/writes `parts` not `content`
- `packages/core/src/runner.ts` — reads `m.parts` not `m.content`

## Important Context / Temporary Decisions
- **DB column rename pending**: `messages.content` → `messages.parts` requires `bun run db:push` from `apps/studio/server` (interactive TTY — user must run in their own terminal)
- Chat uses ai-elements: Conversation/ConversationContent, Message/MessageResponse, PromptInput
- AI SDK v6 `useChat` option is `messages` (NOT `initialMessages`) — breaking rename from older versions
- `!historyData` guard needed: TanStack Query initial state has `historyData = undefined` even when `historyLoading = false`
- `key={convId}` on `<ChatView>` forces remount on conversation change
- ToolUIPart in ai SDK v6: properties (state, output) are directly on part; use isStaticToolUIPart + isToolUIPart helpers
- ResizablePanelGroup uses `orientation` not `direction`
- pending_message in sessionStorage for new chat → conversation flow

## Next Up
- Run `cd apps/studio/server && bun run db:push` to apply `messages.content → messages.parts` column rename
- Backlog items: update web imports to @jiku/ui, test suite, built-in plugins
