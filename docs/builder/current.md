## Phase
Idle — last session completed chat UX polish (conversation list, context bar, SSE observer, sidebar footer)

## Currently Working On
- Nothing active. Last session closed cleanly.

## Relevant Files
- `apps/studio/server/src/runtime/stream-registry.ts` — SSE broadcast + concurrent lock
- `apps/studio/server/src/routes/chat.ts` — POST chat (409 guard, tee), GET stream (SSE), GET status
- `apps/studio/web/hooks/use-conversation-observer.ts` — EventSource hook, token via ?token= param
- `apps/studio/web/components/chat/conversation-list-panel.tsx` — grouped accordion list, load-more
- `apps/studio/web/components/chat/context-bar.tsx` — model/token display, isStreaming prop
- `apps/studio/web/components/chat/context-preview-sheet.tsx` — model info card above usage bar
- `apps/studio/web/components/sidebar/project-sidebar.tsx` — Settings in main group, user in footer
- `apps/studio/web/components/sidebar/company-sidebar.tsx` — same pattern
- `apps/studio/web/lib/api.ts` — compaction_count, model_info, conversations.status()

## Important Context / Temporary Decisions
- **DB column rename pending**: `messages.content` → `messages.parts` requires `bun run db:push` from `apps/studio/server` (interactive TTY — user must run in their own terminal)
- `use-conversation-observer` hook exists but is not yet wired into chat UI pages — see backlog
- StreamRegistry is in-memory only — server restart clears all active run state (acceptable, runs are short-lived)
- EventSource token via ?token= query param — only for SSE endpoint, not other routes

## Next Up
- Wire `use-conversation-observer` into conversation page so secondary observers auto-refresh
- Backlog: update web imports to @jiku/ui, test suite, built-in plugins
