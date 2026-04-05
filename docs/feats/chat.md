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

## Related Files

- `apps/studio/server/src/routes/chat.ts` — HTTP streaming route
- `apps/studio/server/src/routes/conversations.ts` — CRUD + messages history endpoint
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

## Context Bar

`components/chat/context-bar.tsx` — shown below the chat input.

- Left: model_id + provider name
- Right: token count
- Popover: model info card, context usage bar (segmented), compaction count
- `isStreaming` prop: when true, refreshes preview data after each streaming turn completes

`components/chat/context-preview-sheet.tsx` — full sheet view of context state.

- Model info card rendered above the context usage bar (provider row + model row)

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

## Known Limitations

- No WebSocket support (removed in Plan 4) — all chat is HTTP streaming
- `PluginLoader` in `wakeUp()` is empty — built-in plugins not yet registered
- Agent selector disappears once conversation is started (intentional — cleaner UX)
- `use-conversation-observer` hook is not yet wired into chat pages — observer pattern exists but is unused in UI
- StreamRegistry is in-memory — a server restart clears all active run state
