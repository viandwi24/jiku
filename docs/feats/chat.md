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

## Known Limitations

- No WebSocket support (removed in Plan 4) — all chat is HTTP streaming
- `PluginLoader` in `wakeUp()` is empty — built-in plugins not yet registered
- Agent selector disappears once conversation is started (intentional — cleaner UX)
