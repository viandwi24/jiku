## Backlog

- [ ] Update `apps/studio/web` to import from `@jiku/ui` instead of local `@/components/ui/` and `@/components/ai-elements/` — now that components live in @jiku/ui
- [ ] Connect `@jiku/core` JikuRuntime to `JikuRuntimeManager` (chat now uses Vercel AI SDK via buildProvider, but runtime is still separate)
- [ ] DB migrations — run `drizzle-kit generate` + `migrate` to generate and apply migrations
- [ ] Add `NEXT_PUBLIC_API_URL` to web `.env.local` (WS_URL no longer needed)
- [ ] Test suite — unit tests for resolveScope, checkAccess, PluginLoader, resolveCaller
- [ ] Tambah built-in plugins — jiku.cron, jiku.skills
- [ ] Invite member feature (currently only owner can be member)

## Done

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
