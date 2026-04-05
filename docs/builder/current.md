## Phase
Post-testing fixes + Memory Preview Sheet — COMPLETE

## Currently Working On
- Nothing active. All backlog items from memory system session resolved.

## Relevant Files
- `apps/studio/web/components/chat/memory-preview-sheet.tsx` — new Memory Preview Sheet component
- `apps/studio/web/components/chat/context-bar.tsx` — added `onMemoryClick` prop + Memory button
- `apps/studio/web/app/(app)/studio/.../chats/[conv]/page.tsx` — wired MemoryPreviewSheet
- `apps/studio/server/src/memory/tools.ts` — all 9 tools including memory_user_write
- `apps/studio/db/src/queries/memory.ts` — added deleteExpiredMemories()
- `apps/studio/server/src/index.ts` — memory cleanup job (boot + 24h interval)
- `apps/studio/web/app/(app)/studio/page.tsx` — live Projects + Agents count
- `apps/studio/web/app/(app)/studio/companies/[company]/page.tsx` — live Agents count
- `apps/studio/web/app/(app)/studio/companies/[company]/projects/[project]/page.tsx` — live Chats count
- `docs/plans/impl-reports/8-memory-system-implement-report.md` — updated to 98% COMPLETE

## Important Context / Temporary Decisions
- Memory config is on `/memory` page (not `/settings`) — config tab lives alongside memory browser
- `getMemories()` `agent_id` is now optional — runtime_global queries don't need agent_id
- `previewRun()` in runner now loads and shows memory as a context segment (teal color)
- Memory Preview Sheet: `MemoryPreviewSheet` component reads memory segment from `previewRun()` — no separate API route needed
- `ContextBar` now accepts `onMemoryClick` prop — renders Memory button between model info and Context button
- Footer layout: `[model id · provider]` ··· `[Memory] [Context]`
- Dashboard metrics now live: Studio (Projects+Agents), Company (Agents), Project (Chats)
- Memory expiration cleanup: runs at server boot + every 24h via `setInterval`

## Next Up
- Test suite — unit tests for resolveScope, checkAccess, PluginLoader, resolveCaller
- Invite member feature
- Agent Tools tab (currently placeholder)
