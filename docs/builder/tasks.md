## Backlog

- [ ] DB migration: `cd apps/studio/db && bun run db:push` — applies persona_seed + persona_seeded_at columns (required for Plan 9 to work in production)
- [ ] Update `apps/studio/web` to import from `@jiku/ui` instead of local `@/components/ui/` and `@/components/ai-elements/` — now that components live in @jiku/ui
- [ ] Add `NEXT_PUBLIC_API_URL` to web `.env.local` (WS_URL no longer needed)
- [ ] Test suite — unit tests for resolveScope, checkAccess, PluginLoader, resolveCaller
- [ ] Tambah built-in plugins — jiku.cron, jiku.skills (plugin files exist at plugins/jiku.cron + plugins/jiku.skills, belum diaktifkan di server)
- [ ] Invite member feature (currently only owner can be member)
- [ ] Agent Tools tab — currently placeholder "coming soon", needs real tool assignment UI
- [ ] `extractPersonaPostRun()` — auto-extract persona signals after conversation (deferred from Plan 9)

## Done

- [x] Memory System (Plan 8): core types, relevance scoring, builder, extraction, DB schema, server tools + routes, web browser + config UI — completed 2026-04-05
- [x] Memory previewRun integration — memory section visible in context preview sheet — completed 2026-04-05
- [x] Fix getMemories agent_id bug — agent_id now optional in DB query so runtime_global queries work — completed 2026-04-05
- [x] `memory_user_write` tool — added to tools.ts, policy-gated by write.cross_user — completed 2026-04-05
- [x] Memory expiration cleanup job — deleteExpiredMemories() + daily setInterval in server bootstrap — completed 2026-04-05
- [x] Memory Preview Sheet — MemoryPreviewSheet component, wired via onMemoryClick in ContextBar footer — completed 2026-04-05
- [x] Dashboard metrics live counts — Studio (Projects+Agents), Company (Agents), Project (Chats) via useQueries — completed 2026-04-05
- [x] Bug fixes from automated test — MemoryItem type fields (source, project_id), staleTime:0, touchMemories warning — completed 2026-04-05
- [x] Chat UX polish: conversation list grouping, context bar, SSE observer, sidebar footer — completed 2026-04-05
- [x] Setup automated docs architecture — completed 2026-04-04
- [x] Implement @jiku/types — completed 2026-04-04
- [x] Implement @jiku/kit — completed 2026-04-04
- [x] Implement @jiku/core (runtime, runner, resolver, loader, storage) — completed 2026-04-04
- [x] Create plugins/jiku.social built-in plugin — completed 2026-04-04
- [x] Create apps/playground demo — completed 2026-04-04
- [x] Plugin System V2 (contributes, typed deps, circular detection, override pattern) — completed 2026-04-04
- [x] Studio Base Plan 3: @jiku-studio/db, @jiku-studio/server, @jiku/ui, apps/studio/web — completed 2026-04-04
- [x] Policy System Revision Plan 3.5: policy entity, agent_policies, SubjectMatcher, wakeUp/syncRules — completed 2026-04-04
- [x] Migrate shadcn UI + ai-elements into @jiku/ui (packages/ui/src/components/) — completed 2026-04-04
- [x] Write Plan 3 + 3.5 implementation reports — completed 2026-04-04
- [x] Fix create project 500 error (middleware path mismatch in projects route) — completed 2026-04-04
- [x] Credentials system end-to-end (Plan 4): DB schema, AES-256-GCM encryption, adapters, API routes, UI — completed 2026-04-05
- [x] Connect `@jiku/core` JikuRuntime to `JikuRuntimeManager` — one JikuRuntime per project, dynamic provider pattern — completed 2026-04-05
- [x] Chat migration: WebSocket → HTTP streaming via Vercel AI SDK + JikuRuntime — completed 2026-04-05
- [x] StudioStorageAdapter: implement full JikuStorageAdapter interface (conversations, messages as MessageContent[], plugin KV) — completed 2026-04-05
- [x] Plugin KV store: persist in `plugin_kv` DB table instead of in-memory — completed 2026-04-05
- [x] DB migrations: generated `0001_lumpy_ezekiel.sql`, pushed to DB — completed 2026-04-05
- [x] buildProvider(): support openai, anthropic, openrouter, ollama via @ai-sdk/* — completed 2026-04-05
- [x] UX fix: show error bubble in ChatInterface when server returns error (e.g. no credential assigned) — completed 2026-04-05
- [x] Plan 5 — Studio Web UI/UX Overhaul: sidebar, chat system, agent tabs, settings tabs, error boundaries, empty states, toast — completed 2026-04-05
- [x] Chat history fix: content→parts migration, AI SDK v6 `messages` option, `!historyData` guard — completed 2026-04-05
- [x] Plan 9 — Persona System: agent_self scope, PersonaSeed, ensurePersonaSeeded, formatPersonaSection, persona_read + persona_update tools, persona settings page, API routes — completed 2026-04-05
- [x] Active Tools UI — ToolRow expandable detail (description, ID, params schema), ContextBar tools button + count — completed 2026-04-05
- [x] Tool group metadata — `group` field in ToolMeta, all memory/persona tools tagged, grouping in context preview sheet — completed 2026-04-05
- [x] Context preview sheet layout — system prompt below usage bar, segment grouping by source, tab context/tools — completed 2026-04-05
