# Plan 19 — Memory Learning Loop + Skills Loader v2

> Status: Planning Done
> Depends on: Plan 18 (Audit, Permissions, Hot-Unregister), Plan 17 (Plugin Marketplace), Plan 15 (Memory semantic search)
> Layer: Core + App layer
> Goal: Upgrade memory jadi self-improving (dreaming + reflection + health decay), dan rebuild skills loader jadi FS-first dengan progressive disclosure + import + plugin-contributed skills

---

## 1. Overview

Plan 19 adalah **two-workstream plan** untuk lompatan kualitas agent:

**Workstream A — Memory Evolution**
Memory sekarang sudah punya semantic search (Qdrant), scope, tier, policy. Yang kurang: **learning loop**. Memory tumbuh tanpa sintesis, insight belajar hilang. Plan 19 tambah:
- Memory type klasifikasi (`episodic | semantic | procedural | reflective`)
- Dreaming engine 3 fase (light/deep/REM)
- Reflection hook post-run (non-blocking, dedup-guarded)
- Session flush hook di compaction
- Health score decay
- Durable background job queue

**Workstream B — Skills Loader v2**
Skills sekarang berjalan tapi DB-centric, single entrypoint, flat file access, tidak ada eligibility, tidak ada import. Plan 19 rewrite jadi FS-first:
- FS source of truth, DB jadi cache
- `SKILL.md` + YAML frontmatter (self-contained package)
- Union loader: FS + plugin-contributed skills
- Progressive disclosure XML injection
- Eligibility check (bins, env, permissions, config)
- Agent skill access mode (manual vs all_on_demand)
- Plugin `ctx.registerSkill()` API
- Import dari GitHub / skills.sh-compatible + ZIP upload

Dua workstream independent, boleh parallel delivery.

---

## 2. Workstream A — Memory Evolution

### 2.1 Memory Type Classification

Tambah semantic classifier di atas scope/tier yang sudah ada.

**Migration:** `agent_memories` tambah kolom:
```sql
ALTER TABLE agent_memories
  ADD COLUMN memory_type varchar(20) NOT NULL DEFAULT 'semantic'
    CHECK (memory_type IN ('episodic', 'semantic', 'procedural', 'reflective')),
  ADD COLUMN score_health real NOT NULL DEFAULT 1.0,
  ADD COLUMN source_type varchar(20) NOT NULL DEFAULT 'tool'
    CHECK (source_type IN ('tool', 'reflection', 'dream', 'flush'));

CREATE INDEX idx_memories_type ON agent_memories(memory_type);
CREATE INDEX idx_memories_health ON agent_memories(score_health);
```

| memory_type | Arti | Contoh |
|-------------|------|--------|
| `episodic` | Event/observasi tunggal ber-timestamp | "Post ID 123 dapat 5K view pada 2026-04-12" |
| `semantic` | Fakta stabil (default, backward compat) | "User alergi udang" |
| `procedural` | Cara/pola kerja, template, how-to | "Template X untuk kategori Y" |
| `reflective` | Insight hasil belajar lintas data | "Engagement peak konten A di jam 19-21" |

`source_type` track asal insert: `tool` (agent explicit call), `reflection` (post-run hook), `dream` (dreaming synthesis), `flush` (session compaction).

**Memory tools update:**
- `memory_core_append`, `memory_extended_insert` tambah optional param `memory_type` (default `semantic` untuk backward compat)
- Tool description jelaskan kapan pakai masing-masing tipe

### 2.2 Durable Background Job Queue

**Pre-requisite** untuk reflection + dreaming. Tidak pakai `setImmediate`/in-memory queue — harus durable supaya crash tidak hilangkan job.

**Migration:**
```sql
CREATE TABLE background_jobs (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  type            varchar(64) NOT NULL,          -- 'memory.reflection', 'memory.dream', 'memory.flush'
  project_id      uuid REFERENCES projects(id) ON DELETE CASCADE,
  idempotency_key varchar(255) UNIQUE,           -- prevent duplicate
  payload         jsonb NOT NULL,
  status          varchar(20) NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending', 'running', 'completed', 'failed', 'cancelled')),
  attempts        int NOT NULL DEFAULT 0,
  max_attempts    int NOT NULL DEFAULT 3,
  scheduled_at    timestamptz NOT NULL DEFAULT now(),
  started_at      timestamptz,
  completed_at    timestamptz,
  error           text,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_jobs_pending ON background_jobs(status, scheduled_at)
  WHERE status = 'pending';
CREATE INDEX idx_jobs_project ON background_jobs(project_id, created_at DESC);
```

**Worker:**
```typescript
// apps/studio/server/src/jobs/worker.ts
export class BackgroundWorker {
  private handlers = new Map<string, JobHandler>()

  register(type: string, handler: JobHandler) {
    this.handlers.set(type, handler)
  }

  async start(intervalMs = 5000) {
    setInterval(() => this.tick(), intervalMs)
  }

  private async tick() {
    // SELECT ... FOR UPDATE SKIP LOCKED — atomic pickup
    const job = await claimNextJob()
    if (!job) return
    try {
      await this.handlers.get(job.type)?.(job.payload)
      await markCompleted(job.id)
    } catch (err) {
      await markFailed(job.id, err, job.attempts + 1 >= job.max_attempts)
    }
  }
}

export async function enqueue(params: {
  type: string
  projectId?: string
  idempotencyKey?: string
  payload: unknown
  scheduledAt?: Date
}): Promise<void> {
  // INSERT ON CONFLICT (idempotency_key) DO NOTHING
}
```

**Non-blocking contract (CRITICAL):**
- `enqueue()` insert row ke DB + return — **tidak nunggu handler jalan**.
- Caller (reflection/flush trigger) fire-and-forget, response user tidak diblok.
- Handler jalan di worker loop terpisah dari request/response lifecycle.
- SSE/stream response **harus close dulu** sebelum enqueue dipanggil di chat handler.

### 2.3 Reflection Hook Post-Run

**Tujuan:** setelah run selesai, LLM kecil review conversation → tulis **satu** insight reflective. Bukan fact extractor (itu yang sebelumnya bikin duplicate).

**Config per-agent** (`agents.memory_config.reflection`):
```typescript
reflection: {
  enabled: boolean              // default false, opt-in sadar
  model: string                 // model ID untuk reflection LLM
  scope: 'agent_caller' | 'agent_global'  // default 'agent_caller'
  min_conversation_turns: number // default 3 — skip conversation terlalu pendek
}
```

**Flow:**
```
Runner finishes
    ↓
Runner.finalize() streams closed + response sent to user
    ↓
if (reflection.enabled && turns >= min_turns)
    enqueue('memory.reflection', {
      conversation_id, agent_id, project_id,
      turn_ids: [...],
    }, idempotencyKey: hash(conversation_id + last_message_id))
    ↓
Worker picks up job
    ↓
1. Load conversation messages
2. LLM call: "Summarize a single learning insight from this conversation.
    Focus on patterns, preferences, or behaviors — NOT individual facts.
    If no clear insight, respond with NONE."
3. If NONE → mark completed, skip
4. Embed insight → cosine search existing reflective memories
5. If similarity > 0.9 → update existing score_health += 0.1, skip insert
6. Else → insert with memory_type='reflective', source_type='reflection'
7. Audit: memory.reflection_run
```

**Guard-guard supaya duplicate tidak balik:**
- Idempotency key per conversation+last_message — satu conversation tidak di-reflect 2x untuk rentang message yang sama.
- Scope hanya `reflective` — tidak bisa tulis fakta mentah (yang itu tanggung jawab agent tool call).
- Dedup semantic sebelum insert.
- `min_turns` filter — percakapan singkat tidak triggers.
- Default **off**.

File:
- `packages/core/src/memory/reflection.ts` — logic
- `apps/studio/server/src/jobs/handlers/reflection.ts` — worker handler
- `packages/core/src/runner.ts` — trigger hook di `finalize()` setelah stream close

### 2.4 Session Flush Hook di Compaction

Saat ini `packages/core/src/compaction.ts` sudah bikin `[Context Summary]` checkpoint dalam conversation. Tambah hook: summary juga disimpan sebagai memory **sekali** per compaction event.

**Trigger:** ketika `compactMessages()` generate summary baru, panggil:
```typescript
enqueue('memory.flush', {
  conversation_id, agent_id, project_id, caller_id,
  summary,
  checkpoint_message_id,
}, idempotencyKey: `flush:${checkpoint_message_id}`)
```

**Handler:**
- Embed summary
- Dedup check (cosine > 0.9 with existing episodic in same caller scope) → skip kalau sudah ada
- Insert: `scope: agent_caller`, `tier: extended`, `memory_type: episodic`, `source_type: flush`, content = summary
- Audit: `memory.flush`

**Non-blocking:** compaction terjadi saat prompt build, tapi enqueue di akhir — tidak nahan prompt flow.

File:
- `packages/core/src/compaction.ts` — tambah hook call ke enqueue
- `apps/studio/server/src/jobs/handlers/flush.ts`

### 2.5 Dreaming Engine (3 Fase)

**Config per-project** (`projects.memory_config.dreaming`):
```typescript
dreaming: {
  enabled: boolean            // default false
  light: {
    enabled: boolean          // default true (if dreaming.enabled)
    cron: string              // default '0 */6 * * *'
    model_tier: 'cheap' | 'balanced' | 'expensive'  // default 'cheap'
  }
  deep: {
    enabled: boolean          // default true
    cron: string              // default '0 3 * * *'
    model_tier                // default 'expensive'
  }
  rem: {
    enabled: boolean          // default false (opt-in, expensive)
    cron: string              // default '0 5 * * 0'
    model_tier                // default 'expensive'
    min_pattern_strength: number  // default 0.75
  }
}
```

**Model tier mapping** — reuse model router existing:
- `cheap` → gpt-4o-mini / claude haiku
- `balanced` → gpt-4o / claude sonnet
- `expensive` → claude opus / gpt-o1

**Light Dreaming (every 6h):**
```
1. Query memories where source_type='tool' OR 'flush', created in last 2 days
2. Cluster by embedding similarity (threshold 0.85)
3. For each cluster with > 1 members:
   - LLM consolidate: "merge into single concise semantic memory"
   - Insert consolidated as memory_type='semantic', source_type='dream'
   - Mark source members score_health *= 0.5 (decay, but keep)
4. Audit: memory.dream_run { phase: 'light', clusters: N }
```

**Deep Dreaming (daily):**
```
1. Query all memory_type='episodic' last 7 days + memory_type='semantic' top-health
2. LLM synthesis (expensive model, high thinking):
   "Identify recurring patterns, preferences, and procedures.
    Output procedural memories (how-to's) and high-level semantic facts."
3. Insert results as memory_type='procedural' or 'semantic', source_type='dream'
4. Decay: all memories score_health *= 0.98
5. Hard delete memories with score_health < 0.1 AND source_type='dream' (avoid cascade loss)
6. Audit: memory.dream_run { phase: 'deep' }
```

**REM Dreaming (weekly):**
```
1. Query memory_type='semantic' + 'procedural' last 30 days
2. LLM pattern detection (slow, high thinking):
   "Identify cross-topic patterns, cause-effect relations, meta-insights.
    Only emit if pattern strength >= min_pattern_strength."
3. Insert as memory_type='reflective', source_type='dream'
4. Audit: memory.dream_run { phase: 'rem' }
```

**Scheduler:**
- Node-cron based, per-project schedule loaded at boot.
- Enqueue job `memory.dream` with phase param. Worker handler does the LLM work.
- Cron tick fire-and-forget enqueue — tidak block server.

File:
- `packages/core/src/memory/dreaming.ts` — core logic per phase
- `apps/studio/server/src/jobs/handlers/dreaming.ts` — worker
- `apps/studio/server/src/jobs/scheduler.ts` — cron setup per project

### 2.6 Health Score Decay & Cleanup

- Retrieval hit → `score_health = min(1.0, score_health + 0.05)` via `touchMemories()` extended
- Dreaming cycle → all memories `*= decay_factor`
- Hard delete in deep dreaming: `score_health < 0.1 AND source_type='dream'` (user-written tool memories preserved)
- Memory browser UI tampilkan `score_health` sebagai health bar

### 2.7 Settings UI

**Project memory config — tab baru "Dreaming":**
```
┌─ Dreaming ───────────────────────────────────────┐
│ [  ] Enable dreaming                             │
│                                                   │
│ Light  [✓] every 6h      Model: [Cheap   ▼]      │
│ Deep   [✓] daily 03:00   Model: [Expensive ▼]    │
│ REM    [ ] weekly Sun    Model: [Expensive ▼]    │
│                                                   │
│ [Run Light Now] [Run Deep Now] [View Job Log]    │
└──────────────────────────────────────────────────┘
```

**Agent memory config — tambah section "Reflection":**
```
┌─ Reflection ─────────────────────────────────────┐
│ [ ] Enable post-run reflection (default off)     │
│ Model: [Cheap ▼]                                 │
│ Target scope: (•) Per-user  ( ) Agent-wide       │
│ Min turns: [3]                                   │
└──────────────────────────────────────────────────┘
```

### 2.8 Memory Audit Integration

Tambah event types (via Plan 18 audit infrastructure):
- `memory.write` — setiap insert (dari tool, reflection, dream, flush)
- `memory.read_sampled` — 1% sampling retrieval events (full logging terlalu noisy)
- `memory.dream_run` — `{ phase, memories_in, memories_out, duration_ms }`
- `memory.reflection_run` — `{ conversation_id, inserted: bool }`
- `memory.flush` — `{ conversation_id, summary_length }`

---

## 3. Workstream B — Skills Loader v2

### 3.1 Skill Package Format (Convention)

Self-contained folder, compatible dengan skills.sh / `vercel-labs/skills`:

```
/skills/<slug>/
├── SKILL.md           ← WAJIB, frontmatter + instructions
├── references/*.md    ← optional nested markdown
├── scripts/*.py,.sh   ← optional code (exec deferred, Plan N)
├── templates/*.md     ← optional assets
└── data/*             ← optional binary/large files
```

**SKILL.md frontmatter schema:**
```yaml
---
name: "Human-Readable Name"          # required
description: "Short description"     # required
tags: [tag1, tag2]                   # optional
metadata:
  jiku:                              # optional, jiku-specific
    emoji: "🔧"
    os: ["darwin", "linux"]
    requires:
      bins: ["command"]
      env: ["API_KEY"]
      permissions: ["fs:read"]
      config: ["feature.enabled"]
    entrypoint: "SKILL.md"           # default 'SKILL.md' atau 'index.md'
---

# Content...
```

Required fields: `name`, `description` (compatible with skills.sh).
`metadata.jiku.*` adalah extension kita, skills dari skills.sh yang tidak punya bagian ini tetap valid — eligibility check skip.

### 3.2 DB Schema Changes

**Ramping `project_skills`** — jadi cache, bukan primary metadata store:
```sql
ALTER TABLE project_skills
  ADD COLUMN manifest          jsonb,                    -- parsed frontmatter
  ADD COLUMN manifest_hash     varchar(64),              -- SHA-256 of SKILL.md
  ADD COLUMN source            varchar(64) NOT NULL DEFAULT 'fs'
    CHECK (source ~ '^(fs|plugin:.+)$'),
  ADD COLUMN plugin_id         varchar(128),
  ADD COLUMN active            boolean NOT NULL DEFAULT true,
  ADD COLUMN last_synced_at    timestamptz;

-- Allow same slug from different sources (edge case but safe)
ALTER TABLE project_skills DROP CONSTRAINT project_skills_project_id_slug_key;
ALTER TABLE project_skills ADD UNIQUE (project_id, slug, source);

CREATE INDEX idx_skills_source_active ON project_skills(project_id, source, active);
```

Columns `name`, `description`, `tags`, `entrypoint` dipertahankan tapi sekarang **derived** dari manifest saat sync. User tidak bisa edit via UI — harus edit SKILL.md.

**`agents` tambah kolom:**
```sql
ALTER TABLE agents
  ADD COLUMN skill_access_mode varchar(20) NOT NULL DEFAULT 'manual'
    CHECK (skill_access_mode IN ('manual', 'all_on_demand'));
```

### 3.3 SkillLoader Architecture

```
┌─────────────────────────────────────────────────────┐
│  Runtime Tools (unchanged API)                      │
│  skill_list, skill_activate, skill_read_file,       │
│  skill_list_files                                   │
└─────────────────────┬───────────────────────────────┘
                      │
┌─────────────────────▼───────────────────────────────┐
│  SkillRegistry (in-memory, per-project)             │
│  • union of FS + plugin sources                     │
│  • eligibility filter                               │
│  • cache invalidation on hash change                │
└─────────────────────┬───────────────────────────────┘
                      │
      ┌───────────────┴────────────────┐
      │                                │
┌─────▼──────────┐          ┌─────────▼──────────┐
│  FS Source     │          │  Plugin Source     │
│  (project FS)  │          │  (ctx.registerSkill)│
│                │          │                    │
│  /skills/<slug>│          │  • folder          │
│                │          │  • inline          │
└─────┬──────────┘          └────────────────────┘
      │
┌─────▼─────────────────────────────────────────────┐
│  FilesystemService (existing, from Plan 14/16)    │
└───────────────────────────────────────────────────┘
```

**Class shape:**
```typescript
// packages/core/src/skills/loader.ts
export class SkillLoader {
  constructor(private projectId: string) {}

  /** Discover from FS + plugins, upsert cache, return current registry state */
  async sync(): Promise<SkillEntry[]>

  /** Parse SKILL.md frontmatter (YAML) */
  async parseManifest(content: string): Promise<SkillManifest>

  /** Recursive tree of all files in skill folder, classified by ext */
  async buildFileTree(slug: string, source: string): Promise<SkillFileTree>

  /** Check eligibility against runtime context */
  checkEligibility(manifest: SkillManifest, ctx: EligibilityContext): boolean

  /** Load full content of entrypoint or nested file */
  async loadFile(slug: string, source: string, path: string): Promise<string | null>
}

export interface SkillFileTree {
  entrypoint: { path: string; content: string }
  files: Array<{
    path: string
    category: 'markdown' | 'code' | 'asset' | 'binary'
    size_bytes: number
  }>
}
```

### 3.4 FS Source

- Scan `/skills/` (root of project FS) → folder list
- Untuk tiap folder, cek `SKILL.md` (fallback `index.md` untuk legacy, warning deprecation)
- Parse frontmatter pakai `yaml` lib (bukan custom parser)
- Hash SHA-256 dari SKILL.md content → compare dengan `manifest_hash` di DB → skip kalau sama
- Kalau beda atau baru: upsert `project_skills` row dengan parsed manifest

### 3.5 Plugin Source — `ctx.registerSkill()` API

**`@jiku/kit` extension:**
```typescript
// packages/kit/src/plugin.ts
export interface PluginContext {
  // ... existing
  registerSkill(spec: PluginSkillSpec): void
}

export type PluginSkillSpec =
  | {
      slug: string
      source: 'folder'
      path: string                 // relative to plugin root
    }
  | {
      slug: string
      source: 'inline'
      manifest: SkillManifest
      files: Record<string, string>  // { 'SKILL.md': '...', 'ref/x.md': '...' }
    }
```

**Usage:**
```typescript
definePlugin({
  id: 'jiku.research',
  setup(ctx) {
    ctx.registerSkill({
      slug: 'deep-research',
      source: 'folder',
      path: './skills/deep-research',
    })
  },
})
```

**Lifecycle:** server studio plugin runtime sudah punya tracking per-plugin untuk tools — skills piggyback mechanism yang sama. Plugin deactivate → semua skill registered otomatis di-remove dari SkillRegistry + cache row `active=false` (preserve agent_skills assignments untuk re-activate case).

File:
- `packages/kit/src/plugin.ts` — tambah `registerSkill` di context type
- `apps/studio/server/src/plugin-runtime/context.ts` — implementation
- `apps/studio/server/src/plugin-runtime/lifecycle.ts` — cleanup on deactivate (hook ke pattern Plan 18 section 5)

### 3.6 Inline Source Storage

Inline skill files disimpan in-memory per plugin instance (tidak ditulis ke disk). Read via `SkillLoader.loadFile()` check source type → kalau `plugin:<id>` dan plugin register inline → serve dari memory map.

Advantage: plugin bisa generate skill dinamis dari external API saat setup, tanpa cluttering FS.

### 3.7 Eligibility Check

```typescript
function checkEligibility(manifest, ctx: {
  os: NodeJS.Platform
  availableBins: Set<string>   // cached, TTL 5min
  env: NodeJS.ProcessEnv
  grantedPermissions: Set<string>  // dari plugin_granted_permissions (Plan 18 §3)
  projectConfig: unknown
}): boolean {
  const req = manifest.metadata?.jiku?.requires
  if (!req) return true

  if (req.os && !req.os.includes(ctx.os)) return false
  if (req.bins?.some(b => !ctx.availableBins.has(b))) return false
  if (req.env?.some(e => !ctx.env[e])) return false
  if (req.permissions?.some(p => !ctx.grantedPermissions.has(p))) return false
  if (req.config?.some(c => !getNestedConfig(ctx.projectConfig, c))) return false

  return true
}
```

Applied di `skill_list` tool, `buildOnDemandSkillHint`, dan UI skill list. Skill yang tidak eligible tidak di-hide tapi di-tag `ineligible` + reason — UI tampilkan warning, tool filter keluarkan.

### 3.8 Agent Skill Access Mode

**Mode `manual` (default):** behavior sekarang. `agent_skills` table = sumber kebenaran, per-skill mode `always`/`on_demand` dipilih user.

**Mode `all_on_demand`:**
- Resolver `getAgentOnDemandSkills(agentId)` return semua skill `active=true` di project (FS + plugin sources union)
- `always` skills tetap harus eksplisit di `agent_skills` (karena inject ke system prompt = mahal)
- Plugin activate → skill auto-available ke agent ini
- Plugin deactivate → skill auto-hilang

**UI tab Skills (agent page):**
```
┌─ Skills ─────────────────────────────────────────┐
│ Access Mode:                                      │
│   ( ) Manual — choose skills individually         │
│   (•) All skills allowed (on-demand)              │
│                                                   │
│ ┌── In "all" mode, you can still pin to always ──│
│ Pinned (always-injected):                         │
│   [+ Pin skill]                                   │
│   • deep-research  [Unpin]                        │
│                                                   │
│ All available (auto):                             │
│   • skill-a  (fs)                                 │
│   • skill-b  (plugin:jiku.research)               │
│   • skill-c  (ineligible: missing bin `python3`)  │
└───────────────────────────────────────────────────┘
```

### 3.9 Progressive Disclosure — XML Injection

Ganti `buildOnDemandSkillHint()` output dari markdown list jadi structured XML:

```xml
<available_skills>
  <skill>
    <slug>deep-research</slug>
    <name>Deep Research</name>
    <description>Multi-source research workflow...</description>
    <tags>research, analysis</tags>
    <source>fs</source>
  </skill>
  <skill>
    <slug>pdf-reader</slug>
    <name>PDF Reader</name>
    <description>...</description>
    <source>plugin:jiku.docs</source>
  </skill>
</available_skills>

<!-- Instruction -->
Before answering a request matching any skill description, call `skill_activate`
with the matching slug first. Do not answer from general knowledge when a
relevant skill exists.
```

**Budget limits (config):**
- `max_skills_in_prompt` default 50
- `max_skills_prompt_chars` default 20000
- Overflow: rank by tag relevance to recent user messages → truncate tail

### 3.10 Import Feature

**UI dialog:**
```
┌─ Import Skill ────────────────────────────────────┐
│  Source:                                           │
│    (•) From GitHub / skills.sh                     │
│        Package: [owner/repo[/path]_______________] │
│                                                    │
│    ( ) From ZIP file                               │
│        [Choose file...]                            │
│                                                    │
│  [Cancel]  [Import]                                │
└────────────────────────────────────────────────────┘
```

**GitHub fetch flow:**
```
Input: "vercel-labs/agent-skills/pdf-reader"
  ↓
Parse: owner="vercel-labs", repo="agent-skills", subpath="pdf-reader"
  ↓
Fetch: https://api.github.com/repos/{owner}/{repo}/tarball (default branch)
  ↓
Stream tarball → extract to temp dir (Bun's tar)
  ↓
Navigate to subpath; verify SKILL.md exists
  ↓
Parse manifest, compute target slug (manifest.name kebab-case, or subpath basename)
  ↓
Check collision in project /skills/<slug>/ — if exists, prompt overwrite
  ↓
Copy all files to project FS /skills/<slug>/
  ↓
Cleanup temp dir
  ↓
Trigger SkillLoader.sync() → DB cache updated
  ↓
Return { slug, name, files_count }
  ↓
Audit: skill.import { source: 'github', package, slug }
```

**ZIP flow:**
```
Input: multipart upload → tmp zip
  ↓
Extract to temp dir
  ↓
Find single SKILL.md; if multiple folders with SKILL.md → prompt user which
  ↓
(rest same as GitHub flow)
```

**Version resolution (defer):** awalnya default branch only. Syntax `owner/repo@v1.2` bisa ditambah nanti (GitHub tarball by tag).

**Auth:** public repo only untuk MVP. Private → future work dengan GitHub PAT di credentials.

File:
- `apps/studio/server/src/skills/importer.ts` — GitHub + ZIP logic
- `apps/studio/server/src/routes/skills.ts` — `POST /api/projects/:pid/skills/import`
- `apps/studio/web/components/skills/import-dialog.tsx`

### 3.11 Runtime Tools (update)

Existing tools di-keep, update behavior:

| Tool | Change |
|------|--------|
| `skill_list` | Apply eligibility filter; include `source` in output; include ineligibility reasons |
| `skill_activate` | Load via SkillLoader (FS or plugin source); file tree now categorized |
| `skill_read_file` | Works for nested files across source types |
| `skill_list_files` | Returns categorized tree, not flat list |
| `skill_exec_file` | **DEFERRED** — will land with sandboxing system in later plan |

### 3.12 Skills Audit Integration

- `skill.activate` — `{ slug, source }`
- `skill.read_file` — `{ slug, path }`
- `skill.import` — `{ source, package, slug }`
- `skill.source_changed` — `{ plugin_id, action: 'add' | 'remove' }`
- `skill.assignment_changed` — `{ agent_id, access_mode, pinned: [...] }`

---

## 4. Implementation Checklist

### @jiku/types

- [ ] `MemoryType` union (`episodic | semantic | procedural | reflective`)
- [ ] `SourceType` union untuk memory (`tool | reflection | dream | flush`)
- [ ] Extend `AgentMemory` interface dengan `memory_type`, `score_health`, `source_type`
- [ ] `BackgroundJob`, `JobType`, `JobStatus` types
- [ ] `SkillManifest` (frontmatter shape dengan jiku extensions)
- [ ] `SkillFileTree`, `SkillFileCategory`
- [ ] `SkillSource` union (`'fs' | 'plugin:<id>'`)
- [ ] `SkillAccessMode` (`manual | all_on_demand`)
- [ ] `PluginSkillSpec` union (folder / inline)
- [ ] `DreamingConfig`, `ReflectionConfig` extensions

### @jiku/core

- [ ] `packages/core/src/memory/reflection.ts` — insight extraction + dedup
- [ ] `packages/core/src/memory/dreaming.ts` — 3 phase logic
- [ ] `packages/core/src/memory/health.ts` — decay + cleanup
- [ ] `packages/core/src/compaction.ts` — flush hook integration
- [ ] `packages/core/src/runner.ts` — reflection trigger post-stream-close
- [ ] `packages/core/src/skills/loader.ts` — SkillLoader class
- [ ] `packages/core/src/skills/manifest.ts` — YAML frontmatter parser
- [ ] `packages/core/src/skills/eligibility.ts`
- [ ] `packages/core/src/skills/registry.ts` — in-memory union registry

### @jiku/kit

- [ ] `PluginContext.registerSkill(spec)` — API
- [ ] Plugin lifecycle hook — auto-cleanup skill registrations on deactivate

### @jiku-studio/db

- [ ] Migration: `agent_memories` add `memory_type`, `score_health`, `source_type`
- [ ] Migration: `background_jobs` table + indexes
- [ ] Migration: `project_skills` add `manifest`, `manifest_hash`, `source`, `plugin_id`, `active`, `last_synced_at`
- [ ] Migration: `agents` add `skill_access_mode`
- [ ] Queries: `claimNextJob`, `markCompleted`, `markFailed`, `enqueueJob`
- [ ] Queries: `getMemoriesByType`, `updateHealthScore`, `bulkDecayHealth`, `deleteLowHealthDreamMemories`
- [ ] Queries: `upsertSkillCache`, `deactivateSkillsBySource`, `getActiveSkills`, `listAgentSkills` (union FS + plugin)

### apps/studio/server

- [ ] `jobs/worker.ts` — BackgroundWorker class + tick loop + boot wire
- [ ] `jobs/enqueue.ts` — enqueue helper dengan idempotency
- [ ] `jobs/handlers/reflection.ts`
- [ ] `jobs/handlers/dreaming.ts`
- [ ] `jobs/handlers/flush.ts`
- [ ] `jobs/scheduler.ts` — cron setup per-project dreaming
- [ ] `memory/reflection-trigger.ts` — trigger dari runner post-run
- [ ] `skills/loader-service.ts` — project-scoped SkillLoader instance
- [ ] `skills/importer.ts` — GitHub tarball + ZIP
- [ ] `skills/tools.ts` update — eligibility filter, categorized tree
- [ ] `skills/service.ts` update — delegate ke SkillLoader
- [ ] `plugin-runtime/context.ts` update — `registerSkill` implementation
- [ ] `plugin-runtime/lifecycle.ts` update — cleanup on deactivate
- [ ] `routes/memory.ts` update — dreaming config get/patch, manual trigger endpoints
- [ ] `routes/skills.ts` update — import endpoint, refresh endpoint
- [ ] `routes/jobs.ts` new — list jobs, cancel job, get job detail (debug UI)
- [ ] Audit integration untuk semua event types baru

### apps/studio/web

- [ ] Memory config page — Dreaming tab (enable, per-phase schedule, manual trigger buttons)
- [ ] Agent memory config — Reflection section (enable toggle, model, scope)
- [ ] Memory browser — tampilkan `memory_type` badge + `score_health` bar
- [ ] Agent page Skills tab — 2-state UI (manual vs all_on_demand), pin-to-always control, eligibility warnings
- [ ] Skills page — file tree view per skill, refresh button, import dialog
- [ ] Import dialog component — GitHub + ZIP
- [ ] Jobs debug page (opsional, di company settings) — recent jobs, status, failures
- [ ] `api.memory.dreaming.*`, `api.memory.reflection.*`, `api.skills.import`, `api.skills.refresh`, `api.jobs.*`

---

## 5. Non-Blocking UX Contract (HARD RULE)

Reflection, dreaming, flush **TIDAK BOLEH** menahan response user. Enforced via:

1. Runner wajib `stream.close()` atau `res.end()` **sebelum** enqueue apa pun.
2. `enqueue()` function hanya boleh `INSERT` ke `background_jobs` — no processing inline.
3. Worker loop jalan di interval terpisah, decoupled dari request lifecycle.
4. Loading indicator di web UI mengikuti stream state, bukan job status.
5. Test: integration test ukur `finalize()` latency — harus < 50ms (DB insert only).

Doc ini ditulis di `docs/feats/memory.md` sebagai section "Background Jobs Contract" saat implement.

---

## 6. Migration Strategy

**Backward compatibility:**
- `memory_type` default `'semantic'` — existing memory diperlakukan sama
- `score_health` default `1.0` — existing memory full health
- `skill_access_mode` default `'manual'` — existing agent tidak berubah
- `project_skills.source` default `'fs'` — existing skill di-treat sebagai FS-sourced
- First sync after migration: SkillLoader scan /skills/, parse manifests, populate `manifest`/`manifest_hash`

**Rollout order:**
1. Migrations + background_jobs + worker (infra)
2. Memory type classification + health score (passive — no behavior change yet)
3. Session flush hook (low risk, reuses compaction)
4. Reflection (default off, opt-in per agent)
5. Dreaming (default off, opt-in per project)
6. Skills loader rewrite + plugin API
7. Agent skill access mode
8. Import feature

Step 1-5 bisa ship tanpa step 6-8. Dua workstream independent.

---

## 7. Defer (Out of Scope)

- **`skill_exec_file` + sandboxing system** — separate plan untuk multi-language exec (JS/TS/Python/etc)
- **Skill versioning (`@v1.2` syntax)** — defer, default branch dulu
- **Private repo import** — butuh PAT di credentials, defer
- **GitLab / arbitrary git URL import** — GitHub dulu, extend kemudian
- **Memory export/import** — untuk share knowledge base antar project, nice-to-have
- **Dreaming result diffing UI** — "what did the dream generate" visual, defer
- **Distributed worker (multi-process)** — in-process worker cukup untuk single instance
- **Skill marketplace in-app browse** — discover & install dari skills.sh via katalog UI, defer

---

## 8. Success Criteria

**Memory:**
- Agent run dengan reflection enabled tidak menambah latency response user (P95 < +50ms)
- Dreaming deep cycle untuk 10k memories selesai < 5 menit pada cheap model
- Semantic dedup cegah 95% duplicate insertion untuk fakta sama (test dengan fixture)
- Health decay terlihat memory obsolete surut dari top-retrieval over time

**Skills:**
- User bisa `git clone` folder skill, klik Refresh, skill terdaftar otomatis
- Plugin activate → skill muncul di registry dalam < 1 detik
- Plugin deactivate → skill hilang, assignment preserved, re-activate restore
- Import dari `owner/repo` selesai < 10 detik untuk skill typical (< 5MB)
- Eligibility filter tepat: skill yang require `python3` tidak muncul saat bin absent

---

*Plan 19 — Memory Learning Loop + Skills Loader v2*
*Depends on: Plan 18, Plan 17, Plan 15*
*Generated: 2026-04-12*
