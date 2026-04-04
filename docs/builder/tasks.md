## Backlog

- [ ] Implementasi `@jiku/db` — drizzle schema + migrations + query helpers (postgres)
- [ ] Implementasi `@jiku/adapter-postgres` — PostgresStorageAdapter implementasi JikuStorageAdapter
- [ ] API layer — HTTP server (Hono atau Elysia) untuk expose runtime lewat REST/WebSocket
- [ ] Tambah built-in plugins — jiku.cron, jiku.skills
- [ ] Streaming output ke client — expose SSE atau WebSocket dari AgentRunner
- [ ] Test suite — unit tests untuk resolveScope, checkAccess, PluginLoader

## Done

- [x] Setup automated docs architecture — completed 2026-04-04
- [x] Implement @jiku/types — completed 2026-04-04
- [x] Implement @jiku/kit — completed 2026-04-04
- [x] Implement @jiku/core (runtime, runner, resolver, loader, storage) — completed 2026-04-04
- [x] Create plugins/jiku.social built-in plugin — completed 2026-04-04
- [x] Create apps/playground demo — completed 2026-04-04
