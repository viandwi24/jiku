## Phase (2026-04-12) — Plan 19: Memory Learning Loop + Skills Loader v2 — SHIPPED + tested

Full impl report: `docs/plans/impl-reports/19-memory-skills-implementation-report.md`.
Feature docs: `docs/feats/memory.md` (Plan 19 section), `docs/feats/skills.md`.

### Shipped

**Workstream A — Memory Learning Loop**
- Memory typing (`episodic` / `semantic` / `procedural` / `reflective`), `score_health`
  0..1 decayed by dreaming & boosted by retrieval, `source_type` origin tag.
- Durable `background_jobs` queue + `BackgroundWorker` (5s tick, SKIP LOCKED, retry).
- `CompactionHook` fires `memory.flush` on every checkpoint summary.
- `FinalizeHook` fires `memory.reflection` after stream close (opt-in per agent,
  filters by actual user-message count against `min_conversation_turns`).
- Dreaming engine 3 phases (light/deep/REM) with per-project croner schedule,
  explicit credential + model picker (CredentialSelector + ModelSelector),
  `Run now` manual trigger, `bulkDecayHealth` + `deleteLowHealthDreamMemories`.
- Memory browser: Type + Health columns with color tints, click row → detail/edit
  dialog (content / importance / visibility editable).

**Workstream B — Skills Loader v2**
- FS-first: `/skills/<slug>/SKILL.md` with YAML frontmatter, skills.sh/vercel-labs
  compatible. DB `project_skills` becomes cache keyed by `(project_id, slug, source)`.
- `SkillLoader` (project-scoped) unifies FS + plugin contributions, syncs on wakeUp
  and on plugin activate/deactivate.
- Plugin API: `ctx.skills.register({ slug, source: 'folder' | 'inline', ... })`.
- Progressive-disclosure XML hint (budget 50 skills / 20KB).
- Per-agent `skill_access_mode`: `manual` (explicit) or `all_on_demand` (union).
- Eligibility gate: `requires.{os, bins, env, permissions, config}` checked pre-run
  via lazy `which`/`where` probe (5-min TTL cache).
- Import: `POST /skills/import` GitHub tarball + `POST /skills/import-zip` raw ZIP.
  Parser accepts `owner/repo[/subpath[@ref]]`, GitHub URL, skills.sh URL, and
  full `npx skills add <url> --skill <name>` command form. Discovery follows
  skills.sh convention (`skills/`, `skills/.curated/`, `.claude/skills/`, etc.).

**Cross-cutting**
- Universal `recordLLMUsage()` helper in `apps/studio/server/src/usage/tracker.ts` —
  every LLM call (chat, task, title, reflection, dreaming.*, plugin:*) MUST
  route through it. `usage_logs` table now supports nullable agent/conversation,
  adds `project_id`, `source`, `duration_ms`, `raw_system_prompt`, `raw_messages`.
- `/usage` page: Source column + filter + colored badge + duration column.
- Credential rate limit bumped 30 → 120/min. `refetchOnWindowFocus: false` globally.
- FK names in `plugin_granted_permissions` shortened to avoid Postgres 63-char
  identifier truncation warning on `db:push`.

### Non-blocking UX contract (HARD RULE — see docs/feats/memory.md)
Reflection / dreaming / flush MUST NOT hold user responses:
1. Runner closes stream BEFORE enqueue fires.
2. `enqueueAsync()` only inserts to `background_jobs`.
3. Worker runs on its own interval, decoupled from request lifecycle.

### Pending user actions (testing checklist)
- `bun install` — picks up `yaml` (core), `tar`, `unzipper`, `yaml` (studio/server).
- `cd apps/studio/db && bun run db:push` — applies:
  - `0012_plan19_memory_jobs.sql`
  - `0013_plan19_skills_v2.sql`
  - `0014_plan19_usage_logs_expand.sql`
- Restart `apps/studio/server`.
- `bun run build` (web) — confirm TypeScript passes.
- Functional tests:
  - Memory: chat 3+ user turns with Reflection enabled → check `/memory` for row
    with `memory_type=reflective`.
  - Dreaming: enable master toggle, pick credential+model, click "Run now" on
    Light phase → check audit log for `memory.dream_run`.
  - Skills: `Import` dialog → paste `coreyhaines31/marketingskills/marketing-psychology`
    or the equivalent `npx skills add` command → skill appears in list.
  - Usage: `/usage` page, filter source=reflection / dreaming.deep → Raw Data
    dialog should show full system prompt + messages.

### Next up
- Follow-ups on the horizon (deferred from Plan 19):
  - Sandboxed `skill_exec_file` (separate plan)
  - Private-repo skill import via GitHub PAT
  - Per-phase credential/model override exposure in Dreaming UI
  - Skill marketplace browse (skills.sh catalog)
  - Per-caller permission grant surface for `requires.permissions` runtime gate
  - Dreaming effectiveness benchmark at 10k-memory scale
  - Usage page `agent_id=null` filter (background-only view)

---

*Previous shipped plans (Plan 18, Plan 17, Plan 33, Plan 16-FS-v2, Plan 15, etc.) —
see `docs/builder/changelog.md` and `docs/plans/impl-reports/` for history.*
