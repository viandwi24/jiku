# Skills (Plan 19 Workstream B)

FS-first, plugin-extensible skill system with progressive disclosure.

## Concepts

- **Skill** = a self-contained folder `/skills/<slug>/` containing at least a `SKILL.md`
  with YAML frontmatter. Compatible with `skills.sh` / `vercel-labs/agent-skills` packages.
- **Source**: where a skill comes from. Two kinds:
  - `fs` — scanned from the project's virtual disk under `/skills/`.
  - `plugin:<id>` — contributed by a plugin via `ctx.skills.register({...})` in `setup()`.
- **Access mode** (per agent): `manual` (explicit assignments) or `all_on_demand`
  (every active eligible skill is available; `always`-pinned rows still get injected).

## SKILL.md format

```yaml
---
name: "Deep Research"
description: "Multi-source research workflow"
tags: [research, analysis]
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

# Body...
```

Required: `name`, `description`. `metadata.jiku.*` is our extension; external skills
without it still validate — eligibility simply skips unknown requirements.

## Storage model

`project_skills` is a **cache** of manifests — not a primary source. Columns:

| Column | Purpose |
|---|---|
| `source` | `fs` or `plugin:<id>`; part of unique constraint |
| `plugin_id` | the plugin that registered a `plugin:*` row |
| `manifest` (jsonb) | parsed frontmatter |
| `manifest_hash` | SHA/djb2 of SKILL.md for cache invalidation |
| `active` | false when source goes away (plugin deactivated etc.) |
| `last_synced_at` | last time cache was refreshed |

Unique key: `(project_id, slug, source)` — same slug can come from FS + plugin simultaneously.

## SkillLoader

`apps/studio/server/src/skills/loader.ts` is project-scoped. One instance per project,
cached in `loaders` map.

- `syncFilesystem()` — scan `/skills/<slug>/SKILL.md`, parse, upsert cache, update registry.
- `registerPluginSkill(pluginId, spec, pluginRoot?)` — invoked from plugin activation flow.
- `unregisterPluginSkills(pluginId)` — called on plugin deactivate; marks source rows `active=false`.
- `loadFile(slug, source, path)` — source-aware read (FS via FilesystemService, plugin-folder
  via node:fs, plugin-inline from in-memory Map).
- `buildFileTree(slug, source)` — categorized tree (markdown/code/asset/binary) + entrypoint content.

In-memory union is a `SkillRegistry` (from `@jiku/core`).

## Plugin API

```ts
definePlugin({
  meta: { id: 'jiku.research', ... },
  setup(ctx) {
    ctx.skills?.register({
      slug: 'deep-research',
      source: 'folder',
      path: './skills/deep-research',
    })
    // OR inline:
    ctx.skills?.register({
      slug: 'quick-lookup',
      source: 'inline',
      manifest: { name: 'Quick Lookup', description: '...' },
      files: { 'SKILL.md': '---\nname: ...' },
    })
  },
})
```

Registration happens once at boot (collected in `PluginLoader.registeredSkills`).
When a project activates the plugin (wakeUp or activatePlugin), studio propagates
the specs to that project's `SkillLoader`. Deactivate cleans them up without losing
`agent_skills` assignments — the rows are marked `active=false` and restored on
re-activate.

## Progressive disclosure

`buildOnDemandSkillHint(agentId)` (in `skills/prompt-hint.ts`) now emits structured XML:

```xml
<available_skills>
  <skill>
    <slug>deep-research</slug>
    <name>Deep Research</name>
    <description>...</description>
    <tags>research, analysis</tags>
    <source>fs</source>
  </skill>
  ...
</available_skills>
```

Budget: `MAX_SKILLS_IN_PROMPT = 50`, `MAX_SKILLS_PROMPT_CHARS = 20_000`. Overflow
drops tail entries (client-side relevance ranking is a future follow-up).

## Eligibility

`checkSkillEligibility(manifest, ctx)` (core) evaluates `requires.{os, bins, env, permissions, config}`
against a runtime context built by `buildEligibilityContext(projectId)`:

- `availableBins` uses lazy `which`/`where` probes with 5-min TTL cache
- `env` → `process.env`
- `grantedPermissions` → empty set for now (pre-run; per-caller grant flow is future work)
- `projectConfig` → project `memory_config` (dotted-path lookups)

Applied inside `resolveOnDemandSkillsForAgent`; ineligible skills are excluded from
`skill_list` + `skill_activate`.

## Import

`POST /api/projects/:pid/skills/import` — GitHub:
```json
{ "source": "github", "package": "owner/repo/subpath@ref", "overwrite": false }
```
`POST /api/projects/:pid/skills/import-zip` — raw `application/zip` body (≤ 20MB).

Flow:
1. fetch tarball or accept ZIP buffer
2. extract in-memory (caps: 1000 files, 2MB/file, 20MB total)
3. locate shallowest `SKILL.md`/`index.md`
4. parse manifest → derive slug (kebab from name or subpath basename)
5. collision check against existing FS row in project — honor `overwrite`
6. write every file under that root to `/skills/<slug>/` via FilesystemService
7. trigger `SkillLoader.syncFilesystem()` → populate DB cache
8. audit: `skill.import { source, package, slug, files_count }`

## Runtime tools

| Tool | Change vs v1 |
|---|---|
| `skill_list` | Honors access mode + eligibility filter; includes `source` |
| `skill_activate` | Routes FS vs plugin source; returns categorized file tree |
| `skill_read_file` | Works across both sources |
| `skill_list_files` | Returns categorized tree, not flat list |
| `skill_exec_file` | **Deferred** (sandboxing in later plan) |

## Migrations

`0013_plan19_skills_v2.sql` — adds `manifest`, `manifest_hash`, `source`, `plugin_id`,
`active`, `last_synced_at`; drops `(project_id, slug)` unique, adds
`(project_id, slug, source)`; bumps default entrypoint from `index.md` → `SKILL.md`;
adds `agents.skill_access_mode` (default `'manual'`).

## Audit events

- `skill.activate`, `skill.read_file` — (tool invocations also log via `tool.invoke`)
- `skill.import` — `{ source, package | 'zip', slug, files_count }`
- `skill.source_changed` — `{ plugin_id, action }`
- `skill.assignment_changed` — `{ agent_id, access_mode?, pinned? }`

## Key files

- `packages/core/src/skills/{manifest,eligibility,registry}.ts`
- `packages/core/src/plugins/loader.ts` — `ctx.skills.register` wiring, `getPluginSkills`, `setPluginRoot`
- `packages/types/src/index.ts` — `SkillManifest`, `SkillSource`, `SkillAccessMode`, `PluginSkillSpec`, `SkillFileTree`
- `apps/studio/db/src/schema/skills.ts`, `schema/agents.ts`
- `apps/studio/db/src/queries/skills.ts` — `upsertSkillCache`, `deactivateSkillsBySource`, `getActiveSkills`, `findSkillBySlugAnySource`
- `apps/studio/db/src/migrations/0013_plan19_skills_v2.sql`
- `apps/studio/server/src/skills/loader.ts`, `prompt-hint.ts`, `eligibility-context.ts`, `importer.ts`
- `apps/studio/server/src/runtime/manager.ts` — `propagatePluginSkills`, FS sync at wakeUp
- `apps/studio/server/src/routes/skills.ts` — `/skills/refresh`, `/skills/import`, `/skills/import-zip`, `/agents/:aid/skill-access-mode`
- `apps/studio/server/src/audit/logger.ts` — new `skill.*` events
- `apps/studio/web/app/(app)/.../skills/page.tsx` — Import dialog, Refresh, source badge
- `apps/studio/web/app/(app)/.../agents/[agent]/skills/page.tsx` — `AccessModeControl`

## Known limitations

- Eligibility permissions set is empty pre-run; `requires.permissions` effectively blocks until
  a per-caller grant flow exists.
- Skill `exec_file` is deferred pending the sandboxing system.
- Only public GitHub repos supported; private requires PAT (future work).
- No in-app marketplace browse yet.
