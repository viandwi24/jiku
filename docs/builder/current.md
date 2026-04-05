## Phase
Post Plan 11 — UX polish & Persona refactor

## Currently Working On
- Post-implementation polish on Run History, Run Detail, Memory browser, and Persona system.

## Relevant Files
- `apps/studio/db/src/schema/agents.ts` — added `persona_prompt text` column (needs `bun run db:push`)
- `apps/studio/db/src/queries/memory.ts` — added `updateAgentPersonaPrompt()`
- `apps/studio/server/src/routes/persona.ts` — added `GET/PATCH /agents/:aid/persona/prompt`
- `packages/core/src/runtime.ts` — `addAgent()` accepts `personaPrompt` 4th arg
- `packages/core/src/runner.ts` — if `personaPrompt` set, inject directly to system prompt (skip memory-based persona)
- `apps/studio/server/src/runtime/manager.ts` — passes `persona_prompt` to `addAgent()` in wakeUp + syncAgent
- `apps/studio/web/app/.../agents/[agent]/persona/page.tsx` — replaced multi-field form with single textarea
- `apps/studio/web/components/memory/memory-browser.tsx` — table layout, agent column, filter by agent
- `apps/studio/web/app/.../runs/[conv]/page.tsx` — uses ConversationViewer mode="readonly"
- `apps/studio/web/app/.../runs/layout.tsx` — DELETED (was causing scroll block on list page)
- `apps/studio/web/app/.../chats/[conv]/page.tsx` — uses ConversationViewer mode="edit"
- `apps/studio/web/components/chat/conversation-viewer.tsx` — shared component, mode edit/readonly

## Important Context / Temporary Decisions
- HeartbeatScheduler uses setTimeout (not a real cron library) — simplified 5-field cron parsing.
- run_task tool injected via built_in_tools in wakeUp/syncAgent.
- Conversations schema: `user_id` is now nullable (heartbeat/task convs have no user).
- `persona_prompt` takes priority over memory-based persona in runner — if set, `agent_self` memories are NOT loaded for persona section.
- Runs list page scroll: fixed by NOT having a shared layout.tsx — detail page sets its own `height: calc(100svh - 3rem)`.
- ConversationViewer is shared between chat (edit) and run detail (readonly) — only difference is PromptInput visibility.

## Next Up
- Run `bun run db:push` to apply `persona_prompt` column
- Plan 12 or backlog items
