# Feature: Chat System

## What It Does

Enables real-time AI chat between a user and an agent. Messages are streamed via HTTP using Vercel AI SDK. The full `JikuRuntime` stack is active — policy enforcement, tool filtering, and the plugin system all run on every request.

## Architecture

```
Client (useChat)
  → POST /api/conversations/:id/chat
    → runtimeManager.run(projectId, { agent_id, caller, mode, input, conversation_id })
      → JikuRuntime.run()
        → AgentRunner
          → streamText() [Vercel AI SDK]
            → LLM (via dynamic provider → buildProvider())
```

Streaming response uses `x-vercel-ai-data-stream: v1` header, consumed by `useChat` on the client.

## Server: routes/chat.ts

- `POST /api/conversations/:id/chat`
- Reads `agent_id`, `project_id`, `company_id`, `input` (text string or `MessageContent[]`) from request body
- Resolves `caller` via `resolveCaller(c)`
- Calls `runtimeManager.run()` — returns `JikuRunResult { stream }`
- Returns stream as `Response` with AI SDK headers
- On error (no credential, access denied, etc.): returns `400 { error: string }`

## Client: chat-interface.tsx

- `useChat` from `@ai-sdk/react` (v3)
- Transport: `DefaultChatTransport` from `ai` — points to `/api/conversations/:id/chat`
- Auth: `Authorization: Bearer <token>` injected via `headers` factory
- Extra body: `agent_id`, `project_id`, `company_id` via `prepareSendMessagesRequest`
- Renders `message.parts[]` (not `message.content` string)
- Shows red error bubble when `error` is set (e.g. "No model configured")

## Dynamic Provider

Credentials are resolved per-request to avoid decrypted keys in long-lived memory. See ADR-007.

## Message Storage

- Messages stored in DB as `parts: MessagePart[]` (jsonb column) — aligned with AI SDK v6 `UIMessage.parts`
- Column was renamed from `content` → `parts` in Plan 5 polish (requires `bun run db:push`)
- `StudioStorageAdapter.toJikuMessage()` reads `row.parts`, `addMessage()` writes `message.parts`
- Conversation + message persistence is handled by `JikuRuntime` → `StudioStorageAdapter`

## Chat History Loading

- `GET /api/conversations/:id/messages` returns `{ messages: [{ id, role, parts }] }`
- Frontend maps to `UIMessage[]`: `{ id, role, parts: m.parts as UIMessage['parts'], metadata: {} }`
- Pass to `useChat` via `messages` option (NOT `initialMessages` — AI SDK v6 renamed this)
- Guard before mounting `ChatView`: `if (convLoading || historyLoading || !historyData)` — `historyData` can be undefined even when `historyLoading` is false

## New Chat Flow

1. `/chats` page — agent selector (Popover+Command) + PromptInput
2. On submit: store `pending_message` in `sessionStorage`, call `POST /api/conversations` to create conv
3. Redirect to `/chats/:id`
4. `ChatView` mounts, `useEffect` checks `sessionStorage` for pending message, auto-sends via `sendMessage()`

## Conversation Title Management

Auto-title generation and manual rename:

- **Title generation** (`apps/studio/server/src/title/generate.ts`): Async service that uses the agent's own configured LLM to generate a max-50-char title after the first message in a conversation. Fire-and-forget (non-blocking).
- **Auto-trigger** (`apps/studio/server/src/routes/chat.ts`): After first message is persisted, `generateTitle()` is called in the background if conversation title is null.
- **Manual rename** (`PATCH /api/conversations/:id/title`): Accept `{ title: string }`, validate length, update title.
- **Inline edit UI** (`conversation-viewer.tsx`): Click pencil icon on conversation title to edit inline (Enter/blur to save, Escape to cancel).

## Conversation Soft Delete

Conversations are soft-deleted (marked with `deleted_at` timestamp) rather than hard-deleted:

- **DB schema** (`schema/conversations.ts`): Added `deleted_at timestamptz | null` column.
- **Query filter** (`queries/conversation.ts`): `getConversationsByProject()` filters `WHERE deleted_at IS NULL` — deleted conversations never appear in the list.
- **Delete endpoint** (`DELETE /api/conversations/:id`): Soft-deletes the conversation.
- **UI** (`conversation-list-panel.tsx`): Trash icon on hover → click opens `AlertDialog` confirm. Confirmed delete triggers navigate away if deleting the active conversation.

## Sidebar Conversation Display

The sidebar list (`conversation-list-panel.tsx`) now displays:
- **Primary**: Conversation title (or system-generated label if null)
- **Secondary**: Agent name (smaller, gray text, right-aligned)
- Previously showed last message preview

## Related Files

- `apps/studio/server/src/title/generate.ts` — Title generation service (new)
- `apps/studio/server/src/routes/chat.ts` — HTTP streaming route + title generation trigger
- `apps/studio/server/src/routes/conversations.ts` — CRUD + messages history + rename + delete endpoints
- `apps/studio/server/src/runtime/manager.ts` — JikuRuntimeManager + dynamic provider
- `apps/studio/server/src/runtime/storage.ts` — StudioStorageAdapter (`parts` column)
- `apps/studio/server/src/credentials/service.ts` — buildProvider(), resolveAgentModel()
- `apps/studio/web/app/(app)/studio/.../chats/page.tsx` — new chat page with agent selector
- `apps/studio/web/app/(app)/studio/.../chats/[conv]/page.tsx` — active conversation with history
- `apps/studio/web/components/chat/conversation-list-panel.tsx` — conv list + search

## Conversation List Panel

`components/chat/conversation-list-panel.tsx` — sidebar list of conversations for a project.

- **Grouping**: Conversations bucketed by date: Today, Yesterday, This week, This month, Last 3 months, Older. Rendered as accordion sections. Today is auto-expanded; others start collapsed.
- **Pagination**: Load-more button, PAGE_SIZE = 10. Fetches next page on click.
- **Truncation**: Last message preview uses `truncate` (text-overflow: ellipsis). Uses plain `overflow-y-auto` div — NOT Radix `ScrollArea` (see ADR-011).
- **Search**: Filter input at top narrows visible conversations by name/content.
- **Collapsible**: Optional `onCollapse?: () => void` prop. When the parent passes one, the panel renders a `PanelLeftClose` ghost button next to the New-chat button in its header. Parent owns open/closed state.

`chats/layout.tsx` controls the open/closed state with `localStorage['chats.sidebar.open']` persistence. Default: open on viewport ≥768px, closed on <768px (mobile-friendly). When collapsed, a small `PanelLeftOpen` ghost button floats top-left of the chat area to re-open. State is per-user via localStorage; no server roundtrip.

## Context Bar

`components/chat/context-bar.tsx` — shown below the chat input. Footer layout:

```
[model_id · provider]  ···  [Memory] [Context]
```

- Left: model_id + provider name (from `previewRun()`)
- Right: Memory button (when `onMemoryClick` prop is provided) + Context token count button
- `onMemoryClick?: () => void` — when provided, renders a Brain-icon Memory button with `ml-auto` (pushes both Memory + Context to the right)
- Popover: model info card, context usage bar (segmented), compaction count
- `isStreaming` prop: when true, refreshes preview data after each streaming turn completes
- Segment colors: base_prompt=blue, mode=purple, user_context=green, plugin=orange, memory=teal, tool_hint=slate, history=indigo

`components/chat/context-preview-sheet.tsx` — full sheet view of context state.

- Model info card rendered above the context usage bar (provider row + model row)
- Memory segment (teal) appears when memories are loaded for the conversation

`components/chat/memory-preview-sheet.tsx` — dedicated memory preview sheet.

- Opened via Memory button in ContextBar footer
- Reuses `['preview', agentId, conversationId]` TanStack Query cache — no extra API request
- Parses raw memory segment text by markdown headings into `MemoryBlock[]`
- Groups by scope (runtime_global → "Project Memory", agent_global → "Agent Knowledge", agent_caller → "About You")
- Renders collapsible sections with tier + importance badges
- Shows total token estimate from `memorySeg.token_estimate`
- Includes raw text toggle for debugging

## SSE Observer (Stream Registry)

`apps/studio/server/src/runtime/stream-registry.ts` — in-memory registry of active chat runs.

- Tracks `conversationId → { stream, observerControllers }` while a run is active
- `POST /conversations/:id/chat`: 409 if conversation already has an active run; otherwise tees the run stream (one branch → HTTP response, one branch → registry for observers)
- `GET /conversations/:id/stream`: SSE endpoint for observer clients. Each observer tees the registered branch. Sends `data:` events per chunk, sends `event: done` when stream ends. Auth via `?token=` query param (EventSource cannot set headers — see ADR-013).
- `GET /conversations/:id/status`: Returns `{ running: boolean }` for polling.

`apps/studio/web/hooks/use-conversation-observer.ts` — client hook.

- Opens `EventSource` to the SSE endpoint with `?token=<jwt>` appended
- On `done` event: fetches fresh messages to update the UI
- Cleans up EventSource on unmount

## Related Files

- `apps/studio/server/src/routes/chat.ts` — HTTP streaming route + SSE observer + status
- `apps/studio/server/src/runtime/stream-registry.ts` — active run registry
- `apps/studio/server/src/routes/conversations.ts` — CRUD + messages history endpoint
- `apps/studio/server/src/runtime/manager.ts` — JikuRuntimeManager + dynamic provider
- `apps/studio/server/src/runtime/storage.ts` — StudioStorageAdapter (`parts` column)
- `apps/studio/server/src/credentials/service.ts` — buildProvider(), resolveAgentModel()
- `apps/studio/web/hooks/use-conversation-observer.ts` — SSE observer hook
- `apps/studio/web/app/(app)/studio/.../chats/page.tsx` — new chat page with agent selector
- `apps/studio/web/app/(app)/studio/.../chats/[conv]/page.tsx` — active conversation with history
- `apps/studio/web/components/chat/conversation-list-panel.tsx` — grouped accordion list
- `apps/studio/web/components/chat/context-bar.tsx` — model + token display
- `apps/studio/web/components/chat/context-preview-sheet.tsx` — full context sheet

## Tool Parts Persistence

Runner (`packages/core/src/runner.ts`) saves ALL parts per assistant message — tool invocations (call + result) and text. Uses `result.steps` from AI SDK to collect each step's `toolCalls` + `toolResults` and builds `tool-invocation` parts with `state: 'result'`.

**DB storage format**: `{ type: 'tool-invocation', toolInvocationId, toolName, args, state: 'result', result }`  
**UI format (AI SDK v6)**: `{ type: 'dynamic-tool', toolCallId, state: 'output-available', input, output }`

Conversion via `dbPartsToUIParts()` in `apps/studio/web/lib/messages.ts`. History loading reconstructs full `assistant` + `tool` model messages so multi-step tool context survives page refresh.

## Live Conversation (Connector / Run Detail)

For connector conversations and the run detail page, `useLiveConversation` hook polls `/live-parts` at 400ms during active run. `autoDetect` mode polls `/status` every 2s to begin polling when a run starts (handles tabs opened before the run begins).

`streamRegistry` keeps a `buffer: StreamChunk[]` per active run. `GET /conversations/:id/live-parts` returns a snapshot. `ConversationViewer mode="readonly"` uses this hook, shows "streaming" badge during live run, merges DB messages + live partial message.

## Image Attachments

Users can attach images to messages. Upload via `POST /api/attachments`, served via `GET /api/attachments/:id`. Images render inline in chat; click opens `ImageGallery` fullscreen overlay. See `docs/feats/attachments.md`.

## ConversationViewer Component

`components/chat/conversation-viewer.tsx` — shared component used by both chat page (mode=edit) and run detail page (mode=readonly).

- `mode='edit'`: full PromptInput, context bar, memory preview sheet, inline title editing
- `mode='readonly'`: no PromptInput, uses `useLiveConversation` for live updates, same context/tools/memory preview
- **Header**: Displays conversation title (clickable to edit) + agent name (secondary). Pencil icon appears on hover to indicate edit mode.
- **Title edit**: Click pencil → focus input. Enter or blur to save (calls `api.conversations.rename`). Escape to cancel.
- **No avatar**: Avatar component removed — agent avatar feature not yet implemented.

## Title Generation Timing

- Fire-and-forget: title generation starts after the first message response but does not block the HTTP response
- Title may not appear immediately in the UI — it's populated via background task
- If title generation fails silently, conversation title remains null (no error bubble to user)

## Known Limitations

- No WebSocket support (removed in Plan 4) — all chat is HTTP streaming
- Agent selector disappears once conversation is started (intentional — cleaner UX)
- StreamRegistry is in-memory — a server restart clears all active run state
- Live-parts buffer is in-memory — lost on server restart (polling client will fall back to DB messages on next poll)
- Soft delete is not reversible from the current UI (conversations remain in DB with `deleted_at` set)
