# Analisis Teknikal: Memory & Skills System — refs-openclaw

> Referensi: `/workspace/refs-openclaw`  
> Codebase: TypeScript/Node.js fullstack (monorepo dengan `packages/` dan `src/`)  
> Fokus: Implementasi Memory dan Skills

---

## Ringkasan

OpenClaw adalah sistem yang jauh lebih kompleks dari clawcode. Memory system-nya menggunakan **vektor embedding + semantic search + scheduled dreaming cycles**, sedangkan Skills system-nya menggunakan **markdown-first dengan progressive disclosure + token-budget management**.

---

## 1. MEMORY SYSTEM

### 1.1 Lokasi File

```
src/memory-host-sdk/                   # SDK utama memory system
  ├── dreaming.ts                      # Konfigurasi dreaming phases
  ├── engine.ts                        # Barrel export engine
  ├── engine-embeddings.ts             # Embedding engine config
  ├── engine-foundation.ts             # Foundation memory engine
  ├── engine-qmd.ts                    # QMD (query model) integration
  ├── engine-storage.ts                # Storage configuration
  ├── events.ts                        # Memory events
  ├── multimodal.ts                    # Multimodal memory support
  ├── query.ts                         # Query interface
  ├── runtime-cli.ts                   # Runtime CLI helpers
  ├── runtime-core.ts                  # Runtime core
  ├── runtime-files.ts                 # Runtime file handling
  ├── status.ts                        # Status reporting
  └── host/
      ├── memory-schema.ts             # Schema definitions
      ├── embedding-voyage.ts          # Voyage AI provider
      ├── embedding-mistral.ts         # Mistral provider
      ├── embedding-bedrock.ts         # AWS Bedrock provider
      ├── embedding-gemini.ts          # Google Gemini provider
      ├── embedding-ollama.ts          # Ollama local provider
      ├── batch-*.ts                   # Batch processing utils
      └── qmd-*.ts                     # QMD query processing

src/plugins/memory-state.ts            # State dan plugin contract memory
src/plugins/memory-runtime.test.ts     # Testing runtime
src/commands/doctor-memory-search.ts   # Debug command
src/context-engine/delegate.ts         # Memory injection ke context
src/auto-reply/reply/memory-flush.ts   # Auto-flush logic
src/config/plugin-auto-enable.ts       # Auto-enable logic
```

---

### 1.2 Format Penyimpanan Memory

Memory disimpan dalam direktori agent-specific:

```
~/.openclaw/agents/{agentId}/
├── memory/
│   ├── index/         # Embedding vector indexes
│   ├── corpus/        # Text corpus (JSONL)
│   └── logs/          # Memory operation logs
└── sessions/          # Session data
```

**Format File:**
- **JSONL** untuk logs dan corpus entries
- **JSON** untuk structured memory metadata
- **Binary vectors** untuk embedding indexes

**Naming Convention:**
```
{agentId}/{sessionKey}/{timestamp}.jsonl
```

---

### 1.3 Memory Flow (Baca, Tulis, Trigger)

#### Write Triggers

**1. Session Memory Flush** (`src/auto-reply/reply/memory-flush.ts`)
```
Model response diterima
         |
         v
shouldRunMemoryFlush()
  - check token count approaching limit
  - check reserve_tokens_floor
  - check soft_threshold_tokens
         |
    YES  |   NO
         v
runMemoryFlush()
  - serialize conversation context
  - store ke corpus
  - update embedding index
```

**2. Scheduled Dreaming** (via cron)
- Light: setiap 6 jam
- Deep: setiap hari jam 3 pagi
- REM: setiap Minggu jam 5 pagi

**3. Manual via commands**
- `openclaw memory add <content>`

#### Read Triggers

**1. Context Injection per Prompt** (`src/context-engine/delegate.ts`)
```
Build system prompt
         |
         v
buildMemorySystemPromptAddition()
  - query memory corpus (semantic search)
  - score + rank results
  - inject sebagai XML section
```

**2. On-Demand via Memory Search Command**
```
src/plugins/memory-state.ts
  → MemoryCorpusSupplement::search()
```

---

### 1.4 Dreaming System: Tiga Fase

File: `src/memory-host-sdk/dreaming.ts`

Dreaming adalah proses background yang **mensintesis, merapikan, dan memperkuat** memory dari raw session data.

#### Light Dreaming
```
Cron: 0 */6 * * *  (setiap 6 jam)
Lookback: 2 hari
Sources: daily, sessions, recall
Limit: 100 items
Dedupe similarity: 0.9

Execution:
  speed: "fast"
  thinking: "low"
  budget: "cheap"
```

#### Deep Dreaming
```
Cron: 0 3 * * *  (setiap hari jam 3 pagi)
Sources: daily, memory, sessions, logs, recall
Limit: 10 items
Min score: 0.8
Include recovery: health < 0.35

Execution:
  speed: "balanced"
  thinking: "high"
  budget: "expensive"
```

#### REM Dreaming (Pattern Recognition)
```
Cron: 0 5 * * 0  (Minggu jam 5 pagi)
Lookback: 7 hari
Min pattern strength: 0.75
Sources: memory, daily, deep

Execution:
  speed: "slow"
  thinking: "high"
  budget: "expensive"
```

**Execution Config Type:**
```typescript
type MemoryDreamingExecutionConfig = {
  speed: "fast" | "balanced" | "slow";
  thinking: "low" | "medium" | "high";
  budget: "cheap" | "medium" | "expensive";
  model?: string;
  maxOutputTokens?: number;
  temperature?: number;
  timeoutMs?: number;
};
```

---

### 1.5 Mekanisme Indexing dan Retrieval

#### Embedding Providers

```typescript
// Dikonfigurasi di memory config
type EmbeddingProvider =
  | { provider: "voyage"; model: string; apiKey: string }
  | { provider: "mistral"; model: string; apiKey: string }
  | { provider: "bedrock"; model: string; region: string }
  | { provider: "gemini"; model: string; apiKey: string }
  | { provider: "ollama"; model: string; baseUrl: string };
```

#### Search Interface (dari `memory-state.ts`)
```typescript
type MemoryCorpusSupplement = {
  search(params: {
    query: string;
    maxResults?: number;
    agentSessionKey?: string;
  }): Promise<MemoryCorpusSearchResult[]>;

  get(params: {
    lookup: string;
    fromLine?: number;
    lineCount?: number;
    agentSessionKey?: string;
  }): Promise<MemoryCorpusGetResult | null>;
};
```

#### Scoring
```
Final Score = similarity_score * recency_weight

Recency weight:
  - Half-life: 14 hari (default)
  - Max age: 30 hari (default)
  - Score 0-1 range

Filter:
  - Min score threshold (dikonfigurasi)
  - Max results limit
```

---

### 1.6 Memory Injection ke System Prompt

File: `src/context-engine/delegate.ts`

```typescript
function buildMemorySystemPromptAddition(params: {
  availableTools: Set<string>;
  citationsMode?: MemoryCitationsMode;
}): string[]
```

**Format dalam System Prompt:**
```xml
<memory_context>
  <search_results>
    <result>
      <corpus>daily</corpus>
      <snippet>User prefers TypeScript strict mode...</snippet>
      <score>0.95</score>
    </result>
    <result>
      <corpus>sessions</corpus>
      <snippet>Last worked on auth module refactor...</snippet>
      <score>0.88</score>
    </result>
  </search_results>
</memory_context>
```

Memory di-inject sebagai **XML section** dalam system prompt, berbeda dengan clawcode yang menggunakan Markdown section.

---

### 1.7 Memory SDK API (memory-host-sdk)

**Public API:**
```typescript
// src/memory-host-sdk/engine.ts
export {
  resolveMemoryEngine,
  getMemorySearchManager,
  resolveActiveMemoryBackendConfig,
  closeActiveMemorySearchManagers,
}
```

**Backend Configs:**
```typescript
type MemoryRuntimeBackendConfig =
  | { backend: "builtin" }
  | { backend: "qmd"; qmd?: MemoryRuntimeQmdConfig };
```

#### Plugin-Level Memory API (dari `src/plugin-sdk/`)
```typescript
export type MemoryPluginCapability = {
  // Plugin dapat register custom corpus
  registerCorpusSupplement(): MemoryCorpusSupplementRegistration;

  // Plugin dapat extend memory prompt
  registerPromptSupplement(): MemoryPromptSupplementRegistration;
};
```

---

### 1.8 Auto-Enable Memory

File: `src/config/plugin-auto-enable.ts`

```typescript
function applyPluginAutoEnable(config: OpenClawConfig): OpenClawConfig {
  // Jika memory channel enabled di config
  if (config.channels?.memory?.enabled) {
    // Auto-activate memory plugin
    return enablePlugin(config, "memory");
  }
  return config;
}
```

Config:
```json
{
  "channels": {
    "memory": { "enabled": true }
  },
  "plugins": {
    "entries": {
      "memory": { "enabled": true }
    }
  }
}
```

---

## 2. SKILLS SYSTEM

### 2.1 Lokasi Skills

```
skills/                                # 70+ bundled skills
  ├── github/                          # GitHub via gh CLI
  ├── coding-agent/                    # Code generation
  ├── model-usage/                     # Model cost tracking
  ├── 1password/                       # 1Password vault
  ├── discord/                         # Discord messaging
  ├── notion/                          # Notion integration
  ├── obsidian/                        # Obsidian vault
  ├── skill-creator/                   # Meta-skill creator
  └── ... (70+ total)

src/agents/skills/                     # Skills runtime di src
  ├── frontmatter.ts                   # Frontmatter parser
  ├── workspace.ts                     # Skill workspace loading
  ├── local-loader.ts                  # Local skill loader
  ├── skill-contract.ts                # Format output/prompt
  └── config.ts                        # Skill configuration types

src/agents/cli-runner/prepare.ts       # Inject skills ke system prompt
```

---

### 2.2 Format Skill: SKILL.md + Frontmatter

Setiap skill adalah **folder** dengan `SKILL.md` sebagai entrypoint:

```
skills/github/
├── SKILL.md              # REQUIRED: main definition
├── scripts/              # OPTIONAL: executable scripts
│   └── helper.sh
├── references/           # OPTIONAL: dokumentasi tambahan
│   └── api-docs.md
└── assets/               # OPTIONAL: templates, configs
    └── template.json
```

**Format Lengkap Frontmatter `SKILL.md`:**
```yaml
---
name: "skill-id"
description: "Deskripsi panjang: apa yang skill ini lakukan dan kapan digunakan"
metadata:
  openclaw:
    emoji: "🔧"
    homepage: "https://example.com"
    os: ["darwin", "linux"]       # Platform support

    requires:
      bins: ["command-name"]       # Binary yang harus tersedia
      anyBins: ["opt1", "opt2"]    # Salah satu binary yang tersedia
      env: ["API_KEY"]             # Environment variables
      config: ["config.key.path"] # Config keys yang diperlukan

    install:
      - id: "brew"
        kind: "brew"
        formula: "formula-name"
        bins: ["command"]
        label: "Install via Homebrew"
        os: ["darwin"]

      - id: "node"
        kind: "node"
        package: "@scope/package"
        bins: ["command"]

      - id: "apt"
        kind: "apt"
        package: "package-name"
        os: ["linux"]

      - id: "download"
        kind: "download"
        url: "https://example.com/file.tar.gz"
        archive: "tar"
        stripComponents: 1
---

# Isi Skill

Instruksi step-by-step, contoh command, dll.
```

**Contoh Nyata — GitHub Skill:**
```yaml
---
name: github
description: "GitHub operations via `gh` CLI: issues, PRs, CI runs, code review, API queries..."
metadata:
  openclaw:
    emoji: "🐙"
    requires:
      bins: ["gh"]
    install:
      - id: "brew"
        kind: "brew"
        formula: "gh"
        bins: ["gh"]
        label: "Install GitHub CLI (brew)"
      - id: "apt"
        kind: "apt"
        package: "gh"
        bins: ["gh"]
        label: "Install GitHub CLI (apt)"
---

# GitHub Skill

Use `gh` CLI to interact with GitHub...

## Common Commands

### Pull Requests
```bash
gh pr list --repo owner/repo
gh pr view 55
```
```

---

### 2.3 Skill Loading: Progressive Disclosure

Skills di-load dalam **3 fase** berdasarkan kebutuhan:

```
Fase 1: DISCOVERY (cold path)
  - Parse frontmatter saja (~100 kata metadata)
  - Tujuan: list available skills
  - Dikerjakan saat build skill index

Fase 2: METADATA (warm path)
  - Include skill name + description ke system prompt
  - Tujuan: model tahu skill apa yang tersedia
  - Format: XML <available_skills>

Fase 3: FULL CONTENT (hot path)
  - Load isi lengkap SKILL.md
  - Tujuan: model membaca instruksi detail
  - Triggered: model call read_file() pada skill path
```

**Token Efficiency:**
- Hanya metadata di prompt: ~100 kata per skill × 150 skills = ~15,000 kata
- Full content hanya untuk skill yang relevan

---

### 2.4 On-Demand Skill Loading Mechanism

File: `src/agents/skills/workspace.ts`

```typescript
// Step 1: Load semua skill entries (metadata only)
const entries = loadWorkspaceSkillEntries(workspaceDir, config);

// Step 2: Filter eligible skills
const filtered = filterWorkspaceSkillEntries(entries, config, eligibility);

// Step 3: Build prompt dengan metadata
const skillsPrompt = buildWorkspaceSkillsPrompt(workspaceDir, {
  entries: filtered,
  config: config,
});

// Step 4: Inject ke system prompt
// Output: <available_skills>...</available_skills>
```

**Limits:**
```typescript
DEFAULT_MAX_CANDIDATES_PER_ROOT = 300
DEFAULT_MAX_SKILLS_IN_PROMPT = 150
DEFAULT_MAX_SKILLS_PROMPT_CHARS = 30_000
DEFAULT_MAX_SKILL_FILE_BYTES = 256_000  // 256 KB per skill
```

**Loader Implementation:**
```typescript
// src/agents/skills/local-loader.ts
export function loadSkillsFromDirSafe(params: {
  dir: string;
  source: string;
  maxBytes?: number;
}): { skills: Skill[] }
```

---

### 2.5 Skill Invocation: Full Flow

```
USER: "Check status of PR #55"
         |
         v
[1] DISCOVERY
loadWorkspaceSkillEntries()
  → scan skills/ dan ~/.openclaw/skills/
  → parse SKILL.md frontmatter
  → collect [{ name, description, location, requires }]
         |
         v
[2] ELIGIBILITY CHECK
filterWorkspaceSkillEntries()
  → shouldIncludeSkill() per skill:
    ✓ OS match? (darwin/linux)
    ✓ Required bins tersedia? (gh, etc.)
    ✓ Required env vars ada?
    ✓ Required config keys set?
    ✓ Not in denylist?
         |
         v
[3] BUILD SYSTEM PROMPT SECTION
buildWorkspaceSkillsPrompt()
  → formatSkillsForPrompt()
  → Output XML:
    <available_skills>
      <skill>
        <name>github</name>
        <description>GitHub operations via `gh` CLI...</description>
        <location>~/.openclaw/skills/github/SKILL.md</location>
      </skill>
      ...
    </available_skills>
         |
         v
[4] MODEL INFERENCE
Model sees available_skills XML
Model determines: "github skill is relevant"
Model invokes: read_file("~/.openclaw/skills/github/SKILL.md")
         |
         v
[5] FULL SKILL CONTENT LOADED
SKILL.md body → masuk ke context
Model reads: "Use gh pr view 55 --repo owner/repo"
         |
         v
[6] EXECUTION
Model runs: gh pr view 55
Output returned → user
```

**File yang terlibat:**
```
src/agents/skills/skill-contract.ts   # formatSkillsForPrompt()
src/agents/skills/workspace.ts        # buildWorkspaceSkillsPrompt()
src/agents/cli-runner/prepare.ts      # resolveSkillsPromptForRun()
```

---

### 2.6 Eligibility Checking

File: `src/agents/skills/workspace.ts`

```typescript
function shouldIncludeSkill(params: {
  entry: SkillEntry;
  config?: OpenClawConfig;
  eligibility?: SkillEligibilityContext;
}): boolean {
  // 1. OS requirements
  if (entry.metadata?.openclaw?.os) {
    if (!entry.metadata.openclaw.os.includes(process.platform)) {
      return false;
    }
  }

  // 2. Required binaries
  const { bins, anyBins } = entry.metadata?.openclaw?.requires ?? {};
  if (bins?.some(bin => !isBinAvailable(bin))) return false;
  if (anyBins?.length && !anyBins.some(bin => isBinAvailable(bin))) return false;

  // 3. Environment variables
  const { env } = entry.metadata?.openclaw?.requires ?? {};
  if (env?.some(key => !process.env[key])) return false;

  // 4. Config keys
  const { config: configKeys } = entry.metadata?.openclaw?.requires ?? {};
  if (configKeys?.some(key => !getNestedConfig(config, key))) return false;

  // 5. Bundled allowlist/denylist
  if (isBundledSkill(entry)) {
    if (isInDenylist(config, entry.name)) return false;
    if (hasAllowlist(config) && !isInAllowlist(config, entry.name)) return false;
  }

  return true;
}
```

---

### 2.7 Contoh: model-usage Skill (Multiple Files)

```
skills/model-usage/
├── SKILL.md                  # Main instructions
├── scripts/
│   ├── model_usage.py        # Data processing script
│   └── test_model_usage.py   # Tests
└── references/
    └── codexbar-cli.md       # API docs reference
```

**Dalam SKILL.md:**
```markdown
# Model Usage Skill

Track model usage and costs via CodexBar CLI.

## Usage

Run the analysis:
```bash
python {baseDir}/scripts/model_usage.py --provider codex --days 7
```

For CLI flags, see: references/codexbar-cli.md
```

**Path Resolution:**
- `{baseDir}` resolve ke direktori skill
- Relative paths resolved terhadap skill dir
- Scripts dapat dieksekusi langsung (tidak perlu load ke context)

---

### 2.8 Built-in vs User-Defined Skills

**Built-in (Bundled) Skills:**
- Lokasi: `/workspace/refs-openclaw/skills/`
- 70+ skills tersedia
- Permission: `isBundledSkillAllowed()` cek config
- Config: `skills.bundled.allowlist` atau `skills.bundled.denylist`

**User-Defined Skills:**
- Lokasi: `~/.openclaw/skills/` (default)
- Atau via `skills.sources` array dalam config
- Di-merge dengan bundled skills saat discovery

**Skill Configuration** (`src/agents/skills/config.ts`):
```typescript
type SkillConfig = {
  bundled?: {
    enabled?: boolean;
    allowlist?: string[];  // Whitelist specific skills
    denylist?: string[];   // Blacklist specific skills
  };
  sources?: string[];      // Custom skill directories
  install?: {
    preferBrew?: boolean;
    nodeManager?: "npm" | "pnpm" | "yarn" | "bun";
  };
  limits?: {
    maxCandidatesPerRoot?: number;
    maxSkillsLoadedPerSource?: number;
    maxSkillsInPrompt?: number;
    maxSkillsPromptChars?: number;
    maxSkillFileBytes?: number;
  };
};
```

---

### 2.9 Plugin SDK vs Skills

Perbedaan penting yang sering membingungkan:

| | Skills | Plugins |
|--|--------|---------|
| **Format** | Markdown (SKILL.md) | TypeScript code |
| **Lokasi** | `skills/` dir | `packages/` atau `src/plugins/` |
| **Definisi** | Deklaratif | Programatik |
| **Runtime** | Digunakan oleh model sebagai instruksi | Dieksekusi sebagai kode |
| **Ekstensibilitas** | Tulis SKILL.md baru | Implementasi interface plugin |
| **Tujuan** | Workflow guidance | Capability extension |

**Plugin SDK** (`src/plugin-sdk/`):
- Public contract untuk code-based plugins
- Export: `OpenClawPluginDefinition`, `OpenClawPluginToolFactory`, dll
- Plugins BISA menyediakan tools yang digunakan skills

**Interaksi Skills ↔ Plugins:**
```
Plugin mendaftarkan tool: "search_notion"
                    ↓
Skill (notion/SKILL.md) menggunakan tool:
  "Use the search_notion tool to find pages"
                    ↓
Model calls tool → Plugin handles execution
```

---

## 3. INTEGRATION: MEMORY + SKILLS DALAM SYSTEM PROMPT

```
System Prompt:
├── [1] Base instructions (static)
├── [2] Environment context (cwd, date, platform)
├── [3] <available_skills> XML section
│       ← 150 skills max, 30K chars, metadata only
├── [4] <memory_context> XML section
│       ← Top-N semantic results, scored + ranked
├── [5] Bootstrap context (agent-specific)
└── [6] Model-specific instructions
```

**Token Budget Management:**
```
Total budget: dikonfigurasi via model.maxTokens

Skills budget:
  - Max 30,000 chars untuk skills section
  - Overflow: truncate least-relevant skills

Memory budget:
  - Max dikonfigurasi via memory.context.maxTokens
  - Overflow: lower scored results dibuang

Balance:
  - Skills + Memory harus fit dalam context window
  - Strategy dikonfigurasi (prioritize memory vs skills)
```

---

## 4. CONTOH KONKRET FLOW END-TO-END

### Skenario: User minta "check PR #55 status"

```
1. STARTUP
   ├── loadWorkspaceSkillEntries() → 70 entries
   ├── filterWorkspaceSkillEntries() → 45 eligible (bin checks)
   └── buildWorkspaceSkillsPrompt() → XML 8,200 chars

2. SESSION CONTEXT INJECTION
   ├── Semantic search memory: "GitHub PR check status"
   ├── Top results: [past PR workflows, gh CLI usage]
   └── buildMemorySystemPromptAddition() → XML 2,100 chars

3. MODEL RECEIVES SYSTEM PROMPT
   ├── <available_skills> (45 skills listed)
   └── <memory_context> (3 past memory snippets)

4. USER MESSAGE
   "Check PR #55 status in this repo"

5. MODEL RESPONSE
   ├── Identifies: github skill is relevant
   ├── Calls: read_file("~/.openclaw/skills/github/SKILL.md")
   └── Reads full skill content (2,400 chars)

6. EXECUTION
   └── Runs: gh pr view 55 --repo current/repo

7. MEMORY FLUSH (jika context approaching limit)
   ├── Session summary tersimpan ke corpus
   └── Embedding index updated

8. NEXT DREAMING CYCLE (light, 6 jam kemudian)
   └── Synthesize session → long-term memory entry
```

---

## 5. PERBANDINGAN DENGAN CLAWCODE

| Aspek | clawcode | openclaw |
|-------|----------|---------|
| **Memory format** | Markdown files (CLAUDE.md) | JSONL + vector index |
| **Memory retrieval** | Linear file read | Semantic embedding search |
| **Memory schedule** | None (on startup) | Dreaming cycles (light/deep/rem) |
| **Memory injection** | `# Instruction Files` Markdown | `<memory_context>` XML |
| **Memory write** | Manual only | Auto-flush + dreaming |
| **Skill format** | SKILL.md (single file) | SKILL.md + multi-file support |
| **Skill loading** | Lazy per lookup | Progressive (metadata → full) |
| **Skill location** | `.claw/skills/` priority | `skills/` + `~/.openclaw/skills/` |
| **Skill eligibility** | OS check only | OS + bins + env + config |
| **Skill injection** | Via Skill tool return | Via `<available_skills>` XML |
| **Plugin integration** | None | Full plugin SDK |
| **Bundled skills** | ~14 (archived) | 70+ (active) |
| **Install specs** | Not in skill | Frontmatter install specs |
| **Scale** | Simpler, portable | Enterprise-grade |
