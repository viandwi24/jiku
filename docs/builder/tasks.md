## Backlog

- [ ] Update `apps/studio/web` to import from `@jiku/ui` instead of local `@/components/ui/` and `@/components/ai-elements/` — now that components live in @jiku/ui
- [ ] Add `NEXT_PUBLIC_API_URL` to web `.env.local` (WS_URL no longer needed)
- [ ] Test suite — unit tests for resolveScope, checkAccess, PluginLoader, resolveCaller
- [ ] Tambah built-in plugins — jiku.cron, jiku.skills (PluginLoader saat ini kosong di studio)
- [ ] Invite member feature (currently only owner can be member)
- [ ] Wire `use-conversation-observer` hook into chat UI so secondary observers (other tabs/windows) auto-refresh when a stream completes

## Done

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
