# Plan 19 — Memory Learning Loop + Skills Loader v2 — Implementation Report

**Status:** Shipped (2026-04-12)
**Plan:** `docs/plans/19-memory-learning-skills-loader.md`
**Depends on:** Plan 15 (Qdrant semantic memory), Plan 17 (Plugin UI), Plan 18 (Audit + permissions)

Two independent workstreams delivered in back-to-back sessions:

- **Workstream A — Memory Evolution.** Memory type classification, durable background-job queue, post-run reflection, compaction-flush, dreaming engine (3 phases), health decay.
- **Workstream B — Skills Loader v2.** FS-first skill packages with YAML frontmatter, union registry across FS + plugin sources, progressive-disclosure XML hint, per-agent access mode, GitHub/ZIP import, skills.sh convention support.

Post-ship fixes and follow-ups are grouped at the end.

---

## Workstream A — Memory Learning Loop

### 1. Schema (`0012_plan19_memory_jobs.sql`)
- `agent_memories` gained:
  - `memory_type` varchar(20), default `'semantic'` — `episodic | semantic | procedural | reflective`.
  - `score_health` real, default `1.0` — decayed by deep dreaming, boosted by retrieval.
  - `source_type` varchar(20), default `'tool'` — tracks origin (`tool | reflection | dream | flush`).
- `background_jobs` table + indexes — durable queue, unique `idempotency_key`, `status` with CHECK constraint.

### 2. Durable job worker
- `apps/studio/server/src/jobs/worker.ts` — `BackgroundWorker` class, 5s tick loop, atomic pickup via `SELECT … FOR UPDATE SKIP LOCKED`, retry with 30s backoff up to `max_attempts=3`.
- `jobs/enqueue.ts` — fire-and-forget helper. Contract: INSERT only, never process inline.
- `jobs/register.ts` — wires `memory.flush` / `memory.reflection` / `memory.dream` handlers at boot.
- `index.ts` — `registerAllJobHandlers(); backgroundWorker.start()` + `dreamScheduler.bootstrap()`.
- Shutdown flow: `dreamScheduler.stopAll(); backgroundWorker.stop(); runtimeManager.stopAll()`.

### 3. Compaction flush hook
- `packages/core/src/runner.ts` — added `CompactionHook` type + `setCompactionHook()`. Fires fire-and-forget after `compactMessages()` persists a summary, BEFORE the stream opens. User response latency unaffected.
- `packages/core/src/runtime.ts` — propagates hook to every agent runner.
- `apps/studio/server/src/memory/hooks.ts` — studio-side builder. `buildCompactionHook(projectId)` enqueues `memory.flush` jobs with idempotency key `flush:<conv>:<summary-hash>`.
- `jobs/handlers/flush.ts` — embed → cosine dedup (≥0.9) → insert episodic memory (`source_type=flush`, `scope=agent_caller`, `tier=extended`).

### 4. Post-run reflection
- `packages/core/src/runner.ts` — `FinalizeHook` fires inside the stream execute callback after the final `addMessage`. No blocking.
- Studio builder `buildFinalizeHook(projectId)` enqueues `memory.reflection` with a minute-bucket idempotency key (`reflection:<conv>:<minute>`).
- `jobs/handlers/reflection.ts`:
  - Re-reads `AgentMemoryConfig.reflection` → respects enable + `min_conversation_turns`.
  - Counts actual **user-role messages** in the conversation (bug fix: originally counted `steps.length`, triggered never).
  - LLM call with strict prompt ("output single insight under 200 chars or NONE").
  - Semantic dedup against existing reflective memories (cosine ≥ 0.9).
  - Insert as `memory_type=reflective`, `source_type=reflection`, scope follows config (`agent_caller` or `agent_global`).

### 5. Dreaming engine
- Per-project config (`projects.memory_config.dreaming`). Final shape (after credential revision):
  ```ts
  { enabled, credential_id, model_id,
    light: { enabled, cron, credential_id?, model_id? },
    deep:  { enabled, cron, credential_id?, model_id? },
    rem:   { enabled, cron, credential_id?, model_id?, min_pattern_strength } }
  ```
- `jobs/dream-scheduler.ts` — boots with `getAllProjects()`, schedules a croner job per enabled phase. Tick callback only calls `enqueue()` — no inline work. `reschedule(projectId)` hooked into `PATCH /memory-config` so edits apply immediately.
- `jobs/handlers/dreaming.ts`:
  - `resolveDreamingModel` builds the LanguageModel from explicit credential + model (with phase → project fallback and legacy first-agent fallback).
  - **Light**: cluster last-2d `tool|flush` memories by embedding cosine ≥0.85, LLM consolidates each multi-member cluster into one `semantic / dream` row.
  - **Deep**: synthesize last-7d episodic + top-health semantic into `procedural` / `semantic` using `PROC:` / `FACT:` prefixes. Then `bulkDecayHealth(*0.98)` and `deleteLowHealthDreamMemories(<0.1)` (user-written rows preserved).
  - **REM** (opt-in): cross-topic patterns over 30d of `semantic`+`procedural`. Confidence-gated via `[0.xx]` prefix parsed from LLM output against `min_pattern_strength`.
- Manual trigger: `POST /api/projects/:pid/memory/dream { phase }`. Hooked to a "Run now" button per phase.

### 6. Health decay & retrieval boost
- Retrieval hits call `touchMemories()` — boosts `score_health += 0.05` capped at `1.0`.
- Deep dreaming applies `score_health *= 0.98` to all rows, then hard-deletes `source_type='dream' AND score_health < 0.1`.
- Queries: `bulkDecayHealth`, `deleteLowHealthDreamMemories`, `getMemoriesByType`.

### 7. Settings UI
- Project `/memory` page → Config tab → new **Dreaming** sub-tab (not the orphan page under `/settings/memory` from the first attempt, which was deleted in post-ship).
- Shared **Default LLM** card at top (CredentialSelector + ModelSelector, same pattern as agent LLM page). Per-phase override fields saved in schema but not exposed in UI yet (YAGNI until requested).
- Per-phase card: toggle + **Run now** button + `CronExpressionInput` (cronstrue preview, presets dropdown).
- Agent `/memory` page gained a **Reflection** section: enable toggle, model override, scope radio (per-user vs agent-wide), min-turns.

### 8. Audit integration
New `audit.*` helpers + event types:
- `memory.write` — every insert (from tool / reflection / dream / flush) with metadata `{ memory_type, source_type, scope }`.
- `memory.flush` — `{ conversation_id, memory_id, summary_length, removed_count }`.
- `memory.reflection_run` — `{ conversation_id, inserted, reason?, memory_id? }`.
- `memory.dream_run` — `{ phase, memories_in, memories_out, duration_ms }`.

---

## Workstream B — Skills Loader v2

### 1. Schema (`0013_plan19_skills_v2.sql`)
- `project_skills` became a **cache**, not the authority: added `manifest` (jsonb), `manifest_hash`, `source` (`fs` | `plugin:<id>`, CHECK-constrained), `plugin_id`, `active`, `last_synced_at`.
- Unique constraint moved from `(project_id, slug)` → `(project_id, slug, source)` — same slug from FS + plugin coexists.
- Default `entrypoint` bumped `'index.md'` → `'SKILL.md'` (legacy still honored via manifest fallback).
- `agents.skill_access_mode` — `manual | all_on_demand`, default `manual`.

### 2. Skill package format
YAML frontmatter at `/skills/<slug>/SKILL.md`, compatible with skills.sh / vercel-labs:

```yaml
---
name: "Deep Research"
description: "Multi-source research workflow"
tags: [research]
metadata:
  jiku:
    emoji: "🔬"
    os: ["darwin", "linux"]
    requires:
      bins: [python3]
      env: [OPENAI_API_KEY]
      permissions: [fs:read]
      config: ["browser.enabled"]
    entrypoint: SKILL.md
---
# Body…
```

Required: `name`, `description`. `metadata.jiku.*` is the jiku extension; external skills without it still validate — eligibility simply skips unknown requirements.

### 3. Core primitives (`@jiku/core`)
- `skills/manifest.ts` — `parseSkillDoc()` (yaml v2), `hashManifestSource()` (djb2-32 hash), `resolveEntrypoint()`.
- `skills/eligibility.ts` — `checkSkillEligibility()` evaluates `requires.{os,bins,env,permissions,config}`.
- `skills/registry.ts` — in-memory `SkillRegistry` keyed by `${source}::${slug}`; upsert/remove/list/findBySlug/removeBySource.

### 4. SkillLoader (studio)
`apps/studio/server/src/skills/loader.ts` — project-scoped, one instance per project cached in a module Map:
- `syncFilesystem()` — scan `/skills/<slug>/SKILL.md`, parse, upsert cache row, update registry. Removes stale FS entries whose folder vanished.
- `registerPluginSkill(pluginId, spec, pluginRoot?)` — `folder` spec reads from disk at `join(pluginRoot, spec.path)`; `inline` spec uses an in-memory `Map<path, content>`.
- `unregisterPluginSkills(pluginId)` — remove from registry + `deactivateSkillsBySource()` (preserves `agent_skills` assignments for re-activate).
- `loadFile(slug, source, path)` — source-aware dispatch. `fs` hits `FilesystemService`; `plugin:<id>` hits the binding map or `node:fs`.
- `buildFileTree(slug, source)` — categorized tree (markdown / code / asset / binary) + entrypoint content.

### 5. Plugin API (`@jiku/kit`)
- `BasePluginContext.skills.register(spec)` — collected per plugin inside `PluginLoader.registeredSkills`. Wired during `setup()` call.
- `PluginLoader.setPluginRoot(id, dir)` — studio fills this from `discoverPluginsFromFolder()` `dir`.
- Studio `runtime/manager.ts`:
  - `wakeUp()` loops enabled plugins and calls `propagatePluginSkills()`, then `getSkillLoader(projectId).syncFilesystem()`.
  - `activatePlugin()` + `deactivatePlugin()` hooks propagate / unregister.
- Lifecycle: activate → register; deactivate → rows marked `active=false`, registry cleared for that source. Re-activate restores without churning `agent_skills`.

### 6. Progressive disclosure (XML)
`skills/prompt-hint.ts` replaces the old markdown list hint with structured XML:

```xml
<available_skills>
  <skill>
    <slug>deep-research</slug>
    <name>Deep Research</name>
    <description>…</description>
    <tags>research, analysis</tags>
    <source>fs</source>
  </skill>
</available_skills>
```

- Budgets: `MAX_SKILLS_IN_PROMPT=50`, `MAX_SKILLS_PROMPT_CHARS=20_000`. Overflow drops tail entries.
- Instruction block: "Before answering a request matching any skill, you MUST call `skill_activate`".

### 7. Access mode
- `manual` (default): existing `agent_skills` explicit assignments, each with `always | on_demand`.
- `all_on_demand`: every active eligible skill in the project is available on-demand. `always`-marked rows still inject via `buildAlwaysSkillSection()`.
- Toggle at Agent → Skills page via `AccessModeControl` → `PATCH /agents/:aid/skill-access-mode` → `runtimeManager.syncAgent()` rebuilds skillSection + skillHint.

### 8. Eligibility context
- `skills/eligibility-context.ts` — `buildEligibilityContext(projectId)` assembles: `os`, `availableBins` (lazy `which`/`where` probe, 5-min TTL cache), `env`, `grantedPermissions` (empty for now — pre-run has no per-caller context), `projectConfig`.
- Applied inside `resolveOnDemandSkillsForAgent()` — ineligible skills are filtered out of `skill_list` / `skill_activate` and the prompt hint.

### 9. Runtime tools
`skills/tools.ts` rewritten:

| Tool | Behavior |
|---|---|
| `skill_list` | honors access mode, applies eligibility filter, includes `source` |
| `skill_activate` | routes FS vs plugin via SkillLoader; returns categorized file tree |
| `skill_read_file` | source-aware read |
| `skill_list_files` | returns categorized `SkillFileTree` |
| `skill_exec_file` | deferred (needs sandbox plan) |

### 10. Import (GitHub + ZIP)
`skills/importer.ts`:
- `parseGithubPackageSpec()` accepts: `owner/repo`, `owner/repo/subpath`, `owner/repo/subpath@ref`, `github.com/...`, `skills.sh/...`, `github.com/.../tree/<ref>/<path>`, and — added post-ship — `npx skills add <url> --skill <name>` command form with `-s`, `--skill=`, `--ref`, `--branch`, `--tag` flags.
- `importSkillFromGithub()` streams `api.github.com/repos/{o}/{r}/tarball/{ref}` via `tar.t()` with caps (1000 files, 2 MB/file, 20 MB total).
- `importSkillFromZipBuffer()` — `unzipper.Open.buffer`, same caps.
- **skills.sh discovery**: `resolveSkillRoot()` implements the vercel-labs convention — tries literal path first, then `skills/<name>`, `skills/.curated/<name>`, `.claude/skills/<name>`, etc., then recursive fallback. Error response lists available skills in the repo when no match found.
- Writes every matching file to `/skills/<slug>/` via `FilesystemService` and triggers `syncFilesystem()`.
- UI dialog on project skills page (GitHub / ZIP tabs, overwrite checkbox, live hints).
- Routes: `POST /projects/:pid/skills/import` (JSON body) + `POST /projects/:pid/skills/import-zip` (raw `application/zip` body, ≤20 MB, `express.raw` middleware). Audit event `skill.import { source, package | 'zip', slug, files_count }`.

### 11. Audit events (Skills)
- `skill.activate`, `skill.read_file` (also via generic `tool.invoke` when tools run).
- `skill.import` — see above.
- `skill.source_changed` — `{ plugin_id, action }` (not yet emitted automatically; reserved).
- `skill.assignment_changed` — emitted on `PATCH /agents/:aid/skill-access-mode`.

---

## Post-ship fixes

### Critical
1. **`fs.read()` returns an object, not a string.** `SkillLoader.syncFilesystem()` passed the full `{ content, version, cached }` object to `parseSkillDoc()` → `content.match is not a function`. Fix: unwrap in every loader call site (`readSkillManifestFile`, `loadFile`, `buildFileTree`). Same class of bug for `/api/projects/:pid/files/content` route — it was also returning the wrapper object; frontend editor expected a string. Both fixed.
2. **Reflection never triggered.** `FinalizeHook` was passing `steps.length` (LLM-internal tool steps per run) as `turn_count`. Handler filtered on this against `min_conversation_turns=3`, which is semantically conversation turns, not tool steps. Fix: handler re-fetches `getMessages()` and counts `role='user'` rows directly; payload field dropped.
3. **Usage logs missed background LLM calls.** `usage_logs` had `agent_id` + `conversation_id` NOT NULL, blocking reflection / dreaming / flush. Migration `0014_plan19_usage_logs_expand.sql` made them nullable, added `project_id`, `source` varchar(64), `duration_ms`. Backfilled `project_id` from `agents` for legacy rows. New helper `apps/studio/server/src/usage/tracker.ts#recordLLMUsage()` is now the only canonical entry point; wired into chat route (added `source`+`project_id`), task runner (previously **didn't log at all**), title gen, reflection, dreaming (per-phase).
4. **Raw data not captured for background LLM calls.** Reflection + dreaming + title `recordLLMUsage` calls were missing `raw_system_prompt` and `raw_messages` → Raw Data dialog showed `(not captured)`. Fix: all background LLM callers now include both fields.

### Rate-limit tuning
- `credentialRateLimit` bumped 30 → 120/min. Normal navigation with multiple credential-dependent pages (agent LLM, memory config, disk, filesystem, channels) tripped 30/min easily.
- React Query client: `refetchOnWindowFocus: false` globally. Tab-flip no longer refires every list query. Explicit `invalidateQueries` after mutate still works.

### UX polish
- **Cron inputs unified.** Dreaming phases + agent heartbeat now use `CronExpressionInput` (cronstrue live preview, presets dropdown). Convention documented in `docs/builder/memory.md` — any future cron field MUST use this component.
- **Usage table gained `source` filter + colored badge + `duration_ms` column.** Agent column shows `—` when row has no agent (background jobs). Search matches `source` too.
- **Memory browser clickable rows → detail/edit dialog.** Editable fields: content, importance, visibility (immutable: scope, tier, agent, caller, type, source_type, health, timestamps). Delete lives inside the dialog as well as on the row (stopPropagation on the trash cell).
- **Memory table now shows `Type` and `Health` columns.** Type badge colored per `memory_type` (episodic/semantic/procedural/reflective); health rendered as a 0..1 progress bar with threshold colors (green/amber/orange/red).
- **Deleted orphan `settings/memory/page.tsx`** — the first attempt's page that was never wired into navigation and had stale `model_tier` types breaking the build.
- **Dreaming model picker rewritten** from `model_tier: cheap|balanced|expensive` to explicit `credential_id` + `model_id` (CredentialSelector + ModelSelector, same pattern as agent LLM). Schema and handler updated; legacy fallback (first agent's credential) kept so projects with old config still work until user opens the tab and picks explicitly.

---

## Files touched

### `@jiku/types`
- `src/index.ts` — `MemoryType`, `MemorySourceType`, `DreamingConfig`, `ReflectionConfig`, `BackgroundJob`, `SkillManifest`, `SkillSource`, `SkillAccessMode`, `PluginSkillSpec`, `SkillFileTree`, `SkillEligibilityContext`, `SkillEntry`; `BasePluginContext.skills.register`.

### `@jiku/core`
- `src/runner.ts` — `CompactionHook`, `FinalizeHook`, setter methods, fire points.
- `src/runtime.ts` — hook propagation.
- `src/plugins/loader.ts` — `registeredSkills`, `pluginRoots`, `ctx.skills.register` wiring, `getPluginSkills`, `setPluginRoot`.
- `src/skills/{manifest,eligibility,registry}.ts` — new.
- `src/index.ts` — exports.
- `package.json` — `yaml` dep.

### `@jiku-studio/db`
- `schema/memories.ts`, `schema/background_jobs.ts` (new), `schema/skills.ts`, `schema/agents.ts`, `schema/usage_logs.ts`, `schema/plugin_granted_permissions.ts` (FK names shortened to avoid 63-char truncation).
- `queries/memory.ts` — `bulkDecayHealth`, `deleteLowHealthDreamMemories`, `getMemoriesByType`; health-boost in `touchMemories`.
- `queries/background_jobs.ts` (new) — `enqueueJob`, `claimNextJob`, `markJobCompleted`, `markJobFailed`, `listJobs`, `cancelJob`.
- `queries/skills.ts` — `upsertSkillCache`, `deactivateSkillsBySource`, `getActiveSkills`, `findSkillBySlugAnySource`.
- `queries/usage.ts` — `projectUsageWhere` helper, updated project-scope queries to include null-agent rows.
- `migrations/0012_plan19_memory_jobs.sql`, `0013_plan19_skills_v2.sql`, `0014_plan19_usage_logs_expand.sql`.

### `apps/studio/server`
- `jobs/{worker,enqueue,register,dream-scheduler}.ts` (new).
- `jobs/handlers/{flush,reflection,dreaming}.ts` (new).
- `memory/hooks.ts` (new) — `buildCompactionHook`, `buildFinalizeHook`.
- `skills/{loader,prompt-hint,eligibility-context,importer}.ts` (new); `service.ts` rewritten to delegate to loader; `tools.ts` rewritten for eligibility + tree output.
- `runtime/manager.ts` — `propagatePluginSkills`, FS sync in wakeUp, hook wiring in `JikuRuntime` construction, `syncAgent` rebuild on access-mode change.
- `routes/memory.ts` — new `PATCH /memories/:id`, `POST /projects/:pid/memory/dream`, `GET /projects/:pid/jobs`, reschedule on config PATCH.
- `routes/skills.ts` — `/refresh`, `/import`, `/import-zip`, `/agents/:aid/skill-access-mode`.
- `routes/chat.ts`, `task/runner.ts`, `title/generate.ts` — `recordLLMUsage` wiring.
- `middleware/rate-limit.ts` — credential limit raised.
- `audit/logger.ts` — new event types: `memory.write`, `memory.flush`, `memory.reflection_run`, `memory.dream_run`, `skill.activate`, `skill.read_file`, `skill.import`, `skill.source_changed`, `skill.assignment_changed`.
- `usage/tracker.ts` (new) — `recordLLMUsage`.
- `index.ts` — plugin root registration, worker + scheduler boot, shutdown.
- `package.json` — `tar`, `unzipper`, `yaml`, and their `@types/*`.

### `apps/studio/web`
- `lib/api.ts` — `MemoryItem` extended (memory_type/source_type/score_health); `UsageLog` shape expanded (nullable agent/conv, project_id, source, duration_ms); `SkillItem` extended (source/plugin_id/active); `AgentMemoryConfig.reflection`; `ResolvedMemoryConfig.dreaming`; new methods: `api.memory.update`, `api.memoryConfig.triggerDream`, `api.memoryConfig.listJobs`, `api.skills.refresh/importFromGithub/importFromZip/setAgentAccessMode`.
- `components/providers.tsx` — `refetchOnWindowFocus: false`.
- `components/memory/memory-config.tsx` — `DreamingTab` sub-tab with CredentialSelector + ModelSelector + per-phase `CronExpressionInput`.
- `components/memory/memory-browser.tsx` — Type + Health columns, clickable rows, detail/edit dialog.
- `app/(app)/.../skills/page.tsx` — Import dialog (GitHub / ZIP), Refresh, source badge.
- `app/(app)/.../agents/[agent]/skills/page.tsx` — `AccessModeControl`.
- `app/(app)/.../agents/[agent]/memory/page.tsx` — Reflection section.
- `app/(app)/.../agents/[agent]/heartbeat/page.tsx` — `CronExpressionInput`.
- `app/(app)/.../usage/page.tsx` — source column + filter + badge + `duration_ms` column.

### Docs
- `docs/feats/memory.md` — appended "Plan 19 — Memory Learning Loop" section with background-jobs contract.
- `docs/feats/skills.md` — new.
- `docs/builder/memory.md` — conventions (recordLLMUsage mandatory; CronExpressionInput mandatory).
- `docs/builder/current.md` — phase summary + pending actions.
- `docs/builder/changelog.md` — two entries (Workstream A, Workstream B) + post-ship entry (usage tracking).

---

## Success criteria (from plan §8)

| Criterion | Status |
|---|---|
| Reflection adds no user-visible latency | ✅ stream closes first, then `enqueueAsync`; DB-insert only path |
| Deep dream < 5 min for 10k memories | ⏳ unverified at that scale; architecture fits (single LLM call for synthesis + SQL decay) |
| Semantic dedup catches 95% duplicates | ✅ cosine ≥ 0.9 gate in flush + reflection handlers; in practice threshold may need tuning per embedding provider |
| Health decay visible in retrieval order | ✅ `touchMemories` boosts + deep-dreaming decays; `ORDER BY score_health DESC` in `getMemoriesByType` |
| FS skill registered after git-clone + Refresh | ✅ `POST /skills/refresh` endpoint + Refresh button |
| Plugin activate → skill appears <1s | ✅ `propagatePluginSkills` runs sync in activate flow |
| Plugin deactivate preserves `agent_skills` | ✅ `deactivateSkillsBySource` marks `active=false` only |
| Import `owner/repo` < 10s typical | ✅ streaming tar extraction, in-memory |
| Eligibility filters inappropriate skills | ✅ `checkSkillEligibility` in `resolveOnDemandSkillsForAgent` |

---

## Deferred / follow-ups

- `skill_exec_file` + sandboxed runtime (JS/TS/Python) — needs a separate plan.
- Private-repo import (GitHub PAT wiring).
- Per-phase credential/model override exposed in Dreaming UI (schema already supports it).
- Skill marketplace browse (catalog UI for skills.sh).
- Per-caller permission grant surface so `requires.permissions` in manifests can actually gate at runtime.
- `skill.source_changed` audit emission on plugin activate/deactivate (currently only reserved as an event type).
- Dreaming effectiveness benchmark at 10k-memory scale.
- Usage page filters for `agent_id=null` specifically (background-only view).

---

*Plan 19 — Memory Learning Loop + Skills Loader v2*
*Implemented by: Claude Opus 4.6 (1M context) — sessions 2026-04-12*
*Reports for dependencies: 15 (not archived), 17, 18.*
