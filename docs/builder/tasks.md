## Backlog

### Plan 19 follow-ups
- [ ] Sandboxed `skill_exec_file` runtime (separate plan — needs JS/TS/Python sandbox)
- [ ] Private-repo skill import via GitHub PAT (credentials vault integration)
- [ ] Expose per-phase credential/model override in Dreaming UI (schema already supports)
- [ ] Skill marketplace browse — catalog from skills.sh inside app
- [ ] Per-caller permission grant surface so `requires.permissions` in manifests actually gates at runtime (currently `grantedPermissions` passed as empty Set)
- [ ] `skill.source_changed` audit event emission on plugin activate/deactivate (currently reserved, not emitted)
- [ ] Dreaming effectiveness benchmark at 10k-memory scale
- [ ] Usage page: `agent_id=null` filter (background-only view)
- [ ] Memory browser: add `source_type` column to the table (currently only shown via Type badge tooltip)

### Plan 17 follow-ups
- [ ] Third-party plugin sandboxing (iframe origin isolation, code signing, per-publisher keys, bundle SRI) — deferred from original Plan 18 scope; current Plan 18 implements per-user permission grants but not iframe isolation
- [ ] Wire `ctx.files.*` to filesystem service (currently stubbed — returns empty)
- [ ] Wire `ctx.secrets.*` to credentials vault (currently throws)
- [ ] Implement `ctx.api.stream` (SSE streaming from plugin server to UI)
- [ ] Client-side `ctx.events.on` subscription (EventSource with query-string token similar to signed-URL flow)
- [ ] `ctx.ui.openModal` / `global.modal` slot host
- [ ] Rate-limit per plugin × user (complement to per-IP limiter on asset router)
- [ ] Bundle-size budget enforcement (warn on > 50KB, error on > 200KB gzipped)
- [ ] axe-core a11y CI check for plugin slot variations
- [ ] Add `jiku plugin reload <id> --project <p>` CLI command (needs server-side invalidate endpoint)
- [ ] Migrate `jiku.skills` / `jiku.social` to contribute UI entries (pattern now trivial)

### Other
- [ ] Cron Task System nice-to-haves (schedule_paused state, timezone support, run history pagination)
- [ ] Verify Telegram bot responds end-to-end after `depends: [StudioPlugin]` switch (test: send message → typing indicator → get_datetime tool call → MarkdownV2 response)
- [ ] DB migration: `cd apps/studio/db && bun run db:push` — applies Plan 17 migration plus any previously pending (filesystem, attachments, persona_prompt)
- [ ] Update `apps/studio/web` to import from `@jiku/ui` instead of local `@/components/ui/` and `@/components/ai-elements/`
- [ ] Add `NEXT_PUBLIC_API_URL` to web `.env.local` (WS_URL no longer needed)
- [ ] Test suite — unit tests for resolveScope, checkAccess, PluginLoader, resolveCaller, `discoverPluginsFromFolder`, `signAsset` / `verifyAsset`
- [ ] Invite member feature (currently only owner can be member)
- [ ] Agent Tools tab — currently placeholder "coming soon", needs real tool assignment UI
- [ ] `extractPersonaPostRun()` — auto-extract persona signals after conversation (implemented but needs keyword tuning)
- [ ] Filesystem: add RustFS service to docker-compose.yml and set up default credentials for dev

## Done

- [x] Plan 19 — Memory Learning Loop + Skills Loader v2: memory typing (episodic/semantic/procedural/reflective) + health decay, durable `background_jobs` queue + `BackgroundWorker` (SKIP LOCKED, retry), compaction-flush hook, post-run reflection (opt-in per agent), 3-phase dreaming engine (light/deep/REM) with explicit credential+model picker, FS-first skills with YAML frontmatter (skills.sh compatible), plugin `ctx.skills.register()` API, progressive-disclosure XML hint, per-agent access mode (`manual`/`all_on_demand`), eligibility gate, GitHub tarball + ZIP import (accepts `npx skills add` URL form), universal `recordLLMUsage()` usage tracker (all sources), usage page source filter + duration column + color-coded badges, memory browser Type/Health columns + clickable detail/edit dialog, FK names shortened in plugin_granted_permissions, `fs.read` unwrap fix, `refetchOnWindowFocus: false` globally, credential rate limit 30→120/min, deleted orphan `settings/memory` page — completed 2026-04-12. See `docs/plans/impl-reports/19-memory-skills-implementation-report.md`.
- [x] Plan 18 — Production Hardening: rate limiting (5-layer `express-rate-limit`), broad `audit_logs` table + `audit.*` helper + settings/audit UI with CSV export, plugin policy enforcement via `ToolMeta.required_plugin_permission` + `plugin_granted_permissions` + core runner `ToolHooks`, tool hot-unregister on plugin activate/deactivate, plugin-permissions admin UI, and settings navigation refactor (vertical sidebar with Access Control group) — completed 2026-04-12. See `docs/plans/impl-reports/18-production-hardening-report.md`.
- [x] Plan 17 — Plugin UI System (full): isolated runtime (tsup bundles + dynamic URL import + own React), auto-discovery loader, `apps/cli` (commander + Ink), `@jiku-plugin/studio` host anchor via native contributes/depends, signed-URL + rate-limit + prod .map gate on asset router, `jiku.analytics` demo plugin, Active Plugins tab split into System/Project sections, jiku.connector merged into Studio anchor, jiku.telegram switched to `depends: [StudioPlugin]` — completed 2026-04-12. See `docs/plans/impl-reports/17-plugin-ui-implementation-report.md`.
- [x] Plan 16 — Cron Task System: full end-to-end (DB schema, scheduler, tools, REST API, web UI, expression preview) — completed 2026-04-07
- [x] Memory System (Plan 8): core types, relevance scoring, builder, extraction, DB schema, server tools + routes, web browser + config UI — completed 2026-04-05
- [x] Memory previewRun integration — memory section visible in context preview sheet — completed 2026-04-05
- [x] Fix getMemories agent_id bug — agent_id now optional in DB query so runtime_global queries work — completed 2026-04-05
- [x] `memory_user_write` tool — added to tools.ts, policy-gated by write.cross_user — completed 2026-04-05
- [x] Memory expiration cleanup job — deleteExpiredMemories() + daily setInterval in server bootstrap — completed 2026-04-05
- [x] Memory Preview Sheet — MemoryPreviewSheet component, wired via onMemoryClick in ContextBar footer — completed 2026-04-05
- [x] Run Detail page uses ConversationViewer mode=readonly — same context/tools/memory preview as chat — completed 2026-04-06
- [x] Memory browser table layout + agent column + filter by agent — completed 2026-04-06
- [x] Persona refactor — persona_prompt field, direct system prompt injection, simple textarea UI — completed 2026-04-06
- [x] `@jiku/plugin-connector` — new core plugin exposing `ctx.connector.register()` via contributes — completed 2026-04-06
- [x] Telegram plugin: depends on ConnectorPlugin, MarkdownV2 + telegramify-markdown, multi-chunk messages — completed 2026-04-06
- [x] Typing indicator in event-router (sendTyping + 4s interval repeat) — completed 2026-04-06
- [x] Zod v3.25.76 standardization across all workspace packages — completed 2026-04-06
- [x] Binding architecture: output_adapter + output_config jsonb (no agent_id at root) — completed 2026-04-06
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
- [x] Tool parts persistence — runner saves tool-invocation parts (call+result) per step to DB; history loading reconstructs full model messages with tool roles — completed 2026-04-06
- [x] Real-time streaming for connector conversations — streamRegistry teed in event-router, useLiveConversation hook polls /live-parts — completed 2026-04-06
- [x] `get_datetime` system tool — returns iso/timezone/local/unix; injected into all agents — completed 2026-04-06
- [x] Telegram user timezone context — language_code → timezone map injected into connector context string — completed 2026-04-06
- [x] Plan 13 — Browser Automation: OpenClaw engine ported, browser tools injected at wakeUp(), settings UI — completed 2026-04-06 ⚠️ MARKED FAILED — does not meet planning requirements (see ADR-026)
- [x] Plan 33 — Browser rebuild via `@jiku/browser` (CDP bridge to agent-browser CLI), unified attachment persistence, CDP-only config, hardened Docker container (--no-sandbox + readiness probe), settings page rewrite with Live Preview box, OpenAI-safe flat z.object tool schema — completed 2026-04-09. See `docs/plans/impl-reports/13-browser-implement-report.md`.
- [x] Plan 14 — Filesystem: S3/RustFS adapter, virtual path DB, agent tools (fs_list/read/write/move/delete/search), file manager UI (/disk), settings page — completed 2026-04-06
- [x] Chat image attachments: upload + serve endpoint (/api/attachments), project_attachments DB table, image rendering in chat, ImageGallery fullscreen preview component — completed 2026-04-06
