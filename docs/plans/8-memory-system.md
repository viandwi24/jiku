# Plan 8 — Memory System

> Status: **PLANNING**
> Date: 2026-04-05
> Depends on: Plan 7 (Plugin System V3)

---

## Daftar Isi

1. [Vision & Goals](#1-vision--goals)
2. [Architecture Overview](#2-architecture-overview)
3. [Memory Scopes](#3-memory-scopes)
4. [Memory Tiers](#4-memory-tiers)
5. [Memory Config — 2-level Inheritance](#5-memory-config--2-level-inheritance)
6. [Core Layer Changes](#6-core-layer-changes)
7. [Studio App Layer — Built-in Tools](#7-studio-app-layer--built-in-tools)
8. [Studio App Layer — Server](#8-studio-app-layer--server)
9. [Relevance Scoring](#9-relevance-scoring)
10. [Post-run Extraction](#10-post-run-extraction)
11. [Studio Web — UI](#11-studio-web--ui)
12. [DB Schema](#12-db-schema)
13. [API Routes](#13-api-routes)
14. [File Changes](#14-file-changes)
15. [Implementation Checklist](#15-implementation-checklist)

---

## 1. Vision & Goals

### Vision

Agent punya persistent memory yang konsisten antar session. Agent bisa "ingat" user, preferensi, dan facts penting — seperti manusia yang ingat orang yang sering dia ajak bicara. Memory bukan hanya storage — tapi context engineering yang memastikan token yang paling relevan ada di context window saat inference.

**Memory adalah fitur core dari platform Jiku, bukan plugin.** Seperti compaction dan context preview — memory di-implement langsung di app layer (studio server), bukan via plugin system.

### Goals

| Goal | Description |
|------|-------------|
| Persistent memory | Agent ingat facts antar session |
| Scoped memory | Private per agent-user, general per agent, shared per runtime |
| Efficient injection | Core memory always inject, extended memory relevance-scored |
| Agent self-manage | Agent tulis memory via built-in tools (app layer) |
| Post-run extraction | Async LLM extraction setelah setiap run |
| 2-level config | Project default + Agent override (inheritance) |
| UI visibility | Memory browser (project), preview sheet (chat), policy settings (agent) |
| Clean architecture | Core layer generic, studio app layer konkret |

### Non-goals (MVP)

- Vector DB / embedding search — pakai relevance scoring dulu
- Memory sharing antar project
- Memory versioning / history
- User-initiated memory write (hanya agent yang tulis)
- jiku.memory plugin — memory adalah app layer, bukan plugin

---

## 2. Architecture Overview

### Layer Separation

```
@jiku/core (generic, reusable)
  → Types: AgentMemory, MemoryConfig, MemoryScope, MemoryTier
  → Interface: JikuStorageAdapter (tambah memory methods)
  → Algorithm: findRelevantMemories() — pure scoring function
  → Logic: buildMemoryContext() — inject ke system prompt
  → Logic: extractMemoriesPostRun() — LLM extraction
  → Logic: resolveMemoryConfig() — merge project + agent config

@jiku/studio — APP LAYER (konkret, tidak ada plugin untuk memory)
  → DB: agent_memories table
  → DB: memory_config di projects + agents table
  → StudioStorageAdapter: implement memory methods
  → Built-in tools: memory tools di-register langsung (bukan via plugin)
  → Server: HTTP routes /api/memories/*
  → Server: post-run extraction trigger di chat route
  → Web: Memory browser (project level)
  → Web: Memory preview sheet (chat level)
  → Web: Memory config settings (project + agent level)
```

### Kenapa Bukan Plugin?

```
Plugin system  → untuk fitur opsional yang bisa di-enable/disable per project
Memory         → fitur core yang selalu aktif, seperti:
                   - Conversation history
                   - Context compaction
                   - Context preview
                   Semua ini di app layer, bukan plugin
```

### Bridging — Generic ke Konkret

Core tidak mengenal `project_id` atau `user_id` sebagai DB entities:

```
Core term     ←→  Studio term
──────────────────────────────
runtime_id    ←→  project_id   (set saat wakeUp)
caller_id     ←→  user_id      (dari JWT/CallerContext)
agent_id      ←→  agent_id     (sama di kedua layer)
```

### Flow Lengkap per Run

```
runtime.run(params)
  ↓
1. resolveMemoryConfig(projectConfig, agentConfig)
   → merge 2-level inheritance → ResolvedMemoryConfig

2. loadMemories(runtime_id, caller_id, agent_id, resolvedConfig)
   → core memanggil storage.getMemories() via adapter

3. buildMemoryContext(memories, current_input, resolvedConfig)
   → inject core memories ke system prompt
   → score + filter extended memories (top N sesuai config)
   → format [Memory] section

4. run agent (streamText)
   → agent bisa panggil built-in memory tools saat dibutuhkan
   → tools di-register di app layer, bukan plugin

5. post-run (async, non-blocking)
   → extractMemoriesPostRun() — small LLM extract facts
   → save ke DB via storage adapter
   → update access_count pada memories yang dipakai
```

---

## 3. Memory Scopes

Tiga scope, naming generic di core, mapping konkret di studio:

```typescript
// @jiku/types
type MemoryScope =
  | 'agent_caller'    // private per agent+caller pair
  | 'agent_global'    // semua caller untuk agent ini
  | 'runtime_global'  // semua agent dalam runtime/project ini

// Studio mapping:
// agent_caller    → agent_id + user_id scope
// agent_global    → agent_id scope (semua user)
// runtime_global  → project_id scope (semua agent)
```

### Penjelasan per Scope

**`agent_caller` — Agent-User Memory**
```
Key: agent_id + caller_id
Siapa bisa baca: hanya agent ini saat chat dengan user ini
Siapa bisa tulis: hanya agent ini saat chat dengan user ini
Contoh:
  "User prefer jawaban singkat"
  "User tidak suka emoji"
  "User sering tanya XAUUSD analysis"
```

**`agent_global` — Agent General Memory**
```
Key: agent_id only
Siapa bisa baca: agent ini, siapapun callernya
Siapa bisa tulis: agent ini (jika write.agent_global = true)
Contoh:
  "Selalu jawab dalam Bahasa Indonesia"
  "Platform target market retail trader"
```

**`runtime_global` — Runtime/Project Memory**
```
Key: runtime_id (project_id)
Analoginya: papan pengumuman project
Siapa bisa baca: semua agent (jika read.runtime_global = true)
Siapa bisa tulis: semua agent (jika write.runtime_global = true)
Contoh:
  "Fee trading naik 0.1% mulai 2026-04-05"
  "User viandwi24 adalah admin platform"
```

### Cross-user Memory Access

```
Hanya bisa kalau: config.policy.read.cross_user = true
                  Memory punya visibility: 'agent_shared'

Tool: memory_user_lookup(caller_id: userB_id, query)
→ hanya return memories visibility: 'agent_shared'
→ tidak bisa akses private memories user lain
```

---

## 4. Memory Tiers

### Tier 1 — Core Memory

```
Selalu di-inject ke system prompt setiap run
Hard char limit dari config: default 2000 chars total
Agent edit langsung via built-in tools (append / replace / remove)
Kalau hampir penuh → agent push ke extended

Injection: langsung masuk [Memory] section system prompt
```

### Tier 2 — Extended Memory

```
Tidak selalu di-inject — relevance scored
Top N (dari config: default 5) yang paling relevan di-inject
Agent insert via built-in tool
Post-run extraction juga bisa push ke sini

Injection: hanya kalau score >= config.relevance.min_score
```

### Injection di System Prompt

```
[Base Prompt]
[Persona]

[Memory]
## What I Remember

### About This Project           ← runtime_global core
{project core memories}

### About Myself                 ← agent_global core
{agent general core memories}

### About {user.name}            ← agent_caller core
{agent-caller core memories}

### Relevant Context             ← extended memories (top N scored)
{scored extended memories, kalau ada yang relevan}

[Plugin Prompts]
[Tool Hints]
[Mode Instruction]
[User Context]
```

### Token Budget

```
Total memory section: config.core.token_budget (default: 600 tokens)

Prioritas kalau melebihi budget:
  1. agent_caller core   → dipertahankan (paling penting)
  2. agent_global core   → dipertahankan
  3. runtime_global core → di-truncate kalau perlu
  4. extended            → di-reduce jumlahnya
```

---

## 5. Memory Config — 2-level Inheritance

### Konsep

```
Project Memory Config  → default untuk semua agent dalam project
       ↓ inherit
Agent Memory Config    → partial override per agent
       ↓ merge
Resolved Memory Config → yang dipakai saat runtime.run()
```

Pattern ini seperti CSS cascade — agent hanya perlu set yang ingin di-override, sisanya inherit dari project.

### Type Definitions

```typescript
// @jiku/types

// Config lengkap yang dipakai saat runtime
export interface ResolvedMemoryConfig {
  policy: {
    read: {
      runtime_global: boolean     // baca runtime memory?
      cross_user: boolean         // baca memory tentang user lain?
    }
    write: {
      agent_global: boolean       // tulis ke agent general memory?
      runtime_global: boolean     // tulis ke runtime memory?
      cross_user: boolean         // tulis memory tentang user lain?
    }
  }
  relevance: {
    min_score: number             // threshold injection, default: 0.05
    max_extended: number          // max extended memories di-inject, default: 5
    weights: {
      keyword: number             // keyword overlap weight, default: 0.5
      recency: number             // recency decay weight, default: 0.3
      access: number              // access frequency weight, default: 0.2
    }
    recency_half_life_days: number  // half-life decay, default: 30
  }
  core: {
    max_chars: number             // hard char limit core memory, default: 2000
    token_budget: number          // total token budget memory section, default: 600
  }
  extraction: {
    enabled: boolean              // post-run extraction? default: true
    model: string                 // small model untuk extract, default: 'claude-haiku-4-5'
    target_scope: 'agent_caller' | 'agent_global' | 'both'  // default: 'agent_caller'
  }
}

// Project level — full config (semua required dengan defaults)
export type ProjectMemoryConfig = ResolvedMemoryConfig

// Agent level — semua optional (partial override)
export type AgentMemoryConfig = {
  policy?: {
    read?: Partial<ResolvedMemoryConfig['policy']['read']>
    write?: Partial<ResolvedMemoryConfig['policy']['write']>
  }
  relevance?: Partial<ResolvedMemoryConfig['relevance']> & {
    weights?: Partial<ResolvedMemoryConfig['relevance']['weights']>
  }
  core?: Partial<ResolvedMemoryConfig['core']>
  extraction?: Partial<ResolvedMemoryConfig['extraction']>
}
```

### Default Project Config

```typescript
// packages/core/src/memory/config.ts

export const DEFAULT_PROJECT_MEMORY_CONFIG: ProjectMemoryConfig = {
  policy: {
    read: {
      runtime_global: true,
      cross_user: false,
    },
    write: {
      agent_global: true,
      runtime_global: false,
      cross_user: false,
    },
  },
  relevance: {
    min_score: 0.05,
    max_extended: 5,
    weights: {
      keyword: 0.5,
      recency: 0.3,
      access: 0.2,
    },
    recency_half_life_days: 30,
  },
  core: {
    max_chars: 2000,
    token_budget: 600,
  },
  extraction: {
    enabled: true,
    model: 'claude-haiku-4-5',
    target_scope: 'agent_caller',
  },
}
```

### Merge Function

```typescript
// packages/core/src/memory/config.ts

export function resolveMemoryConfig(
  projectConfig: ProjectMemoryConfig,
  agentConfig: AgentMemoryConfig | null | undefined,
): ResolvedMemoryConfig {
  if (!agentConfig) return projectConfig

  return {
    policy: {
      read: {
        runtime_global: agentConfig.policy?.read?.runtime_global
          ?? projectConfig.policy.read.runtime_global,
        cross_user: agentConfig.policy?.read?.cross_user
          ?? projectConfig.policy.read.cross_user,
      },
      write: {
        agent_global: agentConfig.policy?.write?.agent_global
          ?? projectConfig.policy.write.agent_global,
        runtime_global: agentConfig.policy?.write?.runtime_global
          ?? projectConfig.policy.write.runtime_global,
        cross_user: agentConfig.policy?.write?.cross_user
          ?? projectConfig.policy.write.cross_user,
      },
    },
    relevance: {
      min_score: agentConfig.relevance?.min_score
        ?? projectConfig.relevance.min_score,
      max_extended: agentConfig.relevance?.max_extended
        ?? projectConfig.relevance.max_extended,
      weights: {
        keyword: agentConfig.relevance?.weights?.keyword
          ?? projectConfig.relevance.weights.keyword,
        recency: agentConfig.relevance?.weights?.recency
          ?? projectConfig.relevance.weights.recency,
        access: agentConfig.relevance?.weights?.access
          ?? projectConfig.relevance.weights.access,
      },
      recency_half_life_days: agentConfig.relevance?.recency_half_life_days
        ?? projectConfig.relevance.recency_half_life_days,
    },
    core: {
      max_chars: agentConfig.core?.max_chars
        ?? projectConfig.core.max_chars,
      token_budget: agentConfig.core?.token_budget
        ?? projectConfig.core.token_budget,
    },
    extraction: {
      enabled: agentConfig.extraction?.enabled
        ?? projectConfig.extraction.enabled,
      model: agentConfig.extraction?.model
        ?? projectConfig.extraction.model,
      target_scope: agentConfig.extraction?.target_scope
        ?? projectConfig.extraction.target_scope,
    },
  }
}
```

### Contoh Inheritance

```
Project default:
  extraction.enabled     = true
  extraction.model       = 'claude-haiku-4-5'
  relevance.max_extended = 5
  policy.read.runtime_global  = true
  policy.write.runtime_global = false

Agent "Admin Bot" override:
  policy.write.runtime_global = true   ← override
  relevance.max_extended      = 10     ← override
  (sisanya inherit dari project)

Agent "Private Assistant" override:
  policy.read.runtime_global  = false  ← override
  policy.read.cross_user      = false  ← override (redundant tapi explicit)
  extraction.target_scope     = 'agent_caller'  ← override

Agent "Social Manager":
  (tidak ada override → 100% inherit dari project)
```

---

## 6. Core Layer Changes

### `packages/types/src/index.ts`

```typescript
// Tambah types:
export type MemoryScope = 'agent_caller' | 'agent_global' | 'runtime_global'
export type MemoryTier = 'core' | 'extended'
export type MemoryImportance = 'low' | 'medium' | 'high'
export type MemoryVisibility = 'private' | 'agent_shared' | 'project_shared'

export interface AgentMemory {
  id: string
  runtime_id: string
  agent_id: string
  caller_id: string | null
  scope: MemoryScope
  tier: MemoryTier
  section?: string
  content: string
  importance: MemoryImportance
  visibility: MemoryVisibility
  source: 'agent' | 'extraction'
  access_count: number
  last_accessed: Date | null
  expires_at: Date | null
  created_at: Date
  updated_at: Date
}

export interface MemoryContext {
  runtime_global: AgentMemory[]
  agent_global: AgentMemory[]
  agent_caller: AgentMemory[]
  extended: AgentMemory[]
  total_tokens: number
}

// ResolvedMemoryConfig, ProjectMemoryConfig, AgentMemoryConfig
// → sudah didefinisikan di section 5

// Tambah ke JikuStorageAdapter:
export interface JikuStorageAdapter {
  // ... existing ...
  getMemories(params: {
    runtime_id: string
    agent_id: string
    caller_id?: string
    scope?: MemoryScope | MemoryScope[]
    tier?: MemoryTier
    visibility?: MemoryVisibility[]
  }): Promise<AgentMemory[]>

  saveMemory(memory: Omit<AgentMemory,
    'id' | 'created_at' | 'updated_at' | 'access_count' | 'last_accessed'
  >): Promise<AgentMemory>

  updateMemory(id: string, data: Partial<Pick<AgentMemory,
    'content' | 'importance' | 'visibility' | 'expires_at'
  >>): Promise<void>

  deleteMemory(id: string): Promise<void>
  touchMemories(ids: string[]): Promise<void>
}

// Tambah ke RuntimeAgent:
export interface RuntimeAgent {
  // ... existing ...
  memory_config: AgentMemoryConfig | null  // null = inherit semua dari project
}

// Tambah ke JikuRuntime constructor params:
export interface JikuRuntimeOptions {
  // ... existing ...
  project_memory_config: ProjectMemoryConfig
}
```

### `packages/core/src/memory/config.ts` — NEW

```typescript
export { DEFAULT_PROJECT_MEMORY_CONFIG } from './defaults'
export { resolveMemoryConfig } from './resolve'
```

### `packages/core/src/memory/relevance.ts` — NEW

```typescript
import type { AgentMemory } from '@jiku/types'

function tokenize(text: string): string[] {
  const stopwords = new Set([
    'the', 'a', 'an', 'is', 'are', 'was', 'i', 'you', 'we', 'they',
    'dan', 'yang', 'di', 'ke', 'dari', 'ini', 'itu', 'dengan', 'untuk',
  ])
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length > 2 && !stopwords.has(w))
}

export function scoreMemory(
  memory: AgentMemory,
  currentInput: string,
  weights = { keyword: 0.5, recency: 0.3, access: 0.2 },
  halfLifeDays = 30,
): number {
  // 1. Keyword overlap
  const inputWords = new Set(tokenize(currentInput))
  const memWords = tokenize(memory.content)
  const overlap = memWords.filter(w => inputWords.has(w)).length
  const keywordScore = overlap / Math.max(inputWords.size, 1)

  // 2. Recency decay
  const lastSeen = memory.last_accessed ?? memory.created_at
  const ageDays = (Date.now() - new Date(lastSeen).getTime()) / 86_400_000
  const recencyScore = Math.exp(-ageDays / halfLifeDays)

  // 3. Access frequency
  const accessScore = Math.min(memory.access_count / 10, 1)

  // 4. Importance multiplier
  const importanceWeight: Record<string, number> = {
    high: 1.5, medium: 1.0, low: 0.6,
  }

  return (
    keywordScore * weights.keyword +
    recencyScore * weights.recency +
    accessScore  * weights.access
  ) * (importanceWeight[memory.importance] ?? 1.0)
}

export function findRelevantMemories(
  memories: AgentMemory[],
  currentInput: string,
  config: {
    max_extended: number
    min_score: number
    weights: { keyword: number; recency: number; access: number }
    recency_half_life_days: number
  },
): AgentMemory[] {
  return memories
    .map(m => ({
      memory: m,
      score: scoreMemory(m, currentInput, config.weights, config.recency_half_life_days),
    }))
    .filter(({ score }) => score >= config.min_score)
    .sort((a, b) => b.score - a.score)
    .slice(0, config.max_extended)
    .map(({ memory }) => memory)
}
```

### `packages/core/src/memory/builder.ts` — NEW

```typescript
import type { AgentMemory, MemoryContext, ResolvedMemoryConfig } from '@jiku/types'
import { findRelevantMemories } from './relevance'
import { estimateTokens } from '../utils/tokens'

export async function buildMemoryContext(params: {
  memories: {
    runtime_global: AgentMemory[]
    agent_global: AgentMemory[]
    agent_caller: AgentMemory[]
    extended_pool: AgentMemory[]  // semua extended dari accessible scopes
  }
  current_input: string
  config: ResolvedMemoryConfig
}): Promise<MemoryContext> {
  const { memories, current_input, config } = params

  const runtimeCore = config.policy.read.runtime_global
    ? memories.runtime_global.filter(m => m.tier === 'core')
    : []

  const agentCore    = memories.agent_global.filter(m => m.tier === 'core')
  const callerCore   = memories.agent_caller.filter(m => m.tier === 'core')
  const extendedPool = memories.extended_pool.filter(m => m.tier === 'extended')

  const relevantExtended = findRelevantMemories(
    extendedPool,
    current_input,
    config.relevance,
  )

  const totalTokens = estimateTokens(
    [...runtimeCore, ...agentCore, ...callerCore, ...relevantExtended]
      .map(m => m.content).join('\n')
  )

  return {
    runtime_global: runtimeCore,
    agent_global: agentCore,
    agent_caller: callerCore,
    extended: relevantExtended,
    total_tokens: Math.min(totalTokens, config.core.token_budget),
  }
}

export function formatMemorySection(
  ctx: MemoryContext,
  userName?: string,
): string {
  const sections: string[] = []

  if (ctx.runtime_global.length > 0) {
    sections.push([
      '### About This Project',
      ...ctx.runtime_global.map(m => `- ${m.content}`),
    ].join('\n'))
  }

  if (ctx.agent_global.length > 0) {
    sections.push([
      '### General',
      ...ctx.agent_global.map(m => `- ${m.content}`),
    ].join('\n'))
  }

  if (ctx.agent_caller.length > 0) {
    sections.push([
      `### About ${userName ?? 'User'}`,
      ...ctx.agent_caller.map(m => `- ${m.content}`),
    ].join('\n'))
  }

  if (ctx.extended.length > 0) {
    sections.push([
      '### Relevant Context',
      ...ctx.extended.map(m => `- ${m.content}`),
    ].join('\n'))
  }

  if (sections.length === 0) return ''
  return `## What I Remember\n\n${sections.join('\n\n')}`
}
```

### `packages/core/src/memory/extraction.ts` — NEW

```typescript
import { generateObject } from 'ai'
import { z } from 'zod'
import type { AgentMemory, ResolvedMemoryConfig, JikuStorageAdapter } from '@jiku/types'

const ExtractionSchema = z.object({
  memories: z.array(z.object({
    content: z.string().describe('Concise fact, max 100 chars'),
    scope: z.enum(['agent_caller', 'agent_global']),
    tier: z.enum(['core', 'extended']),
    importance: z.enum(['low', 'medium', 'high']),
    visibility: z.enum(['private', 'agent_shared']),
  })),
  obsolete_ids: z.array(z.string()),
})

export async function extractMemoriesPostRun(params: {
  runtime_id: string
  agent_id: string
  caller_id: string
  messages: any[]
  existing_memories: AgentMemory[]
  config: ResolvedMemoryConfig
  model: any
  storage: JikuStorageAdapter
}): Promise<void> {
  if (!params.config.extraction.enabled) return

  const recentMessages = params.messages.slice(-6)
  const conversationText = recentMessages
    .map(m => `${m.role}: ${getTextContent(m)}`)
    .join('\n')

  if (!conversationText.trim()) return

  const existingSummary = params.existing_memories
    .filter(m => m.tier === 'core')
    .map(m => `[${m.id}] ${m.content}`)
    .join('\n')

  try {
    const { object } = await generateObject({
      model: params.model,
      schema: ExtractionSchema,
      system: `Extract worth-remembering facts from conversations.
Focus on: preferences, corrections, important facts, recurring patterns.
Skip: transient info, greetings, questions, anything already stored.
Each memory: single clear fact, max 100 chars.`,
      prompt: `Existing memories (avoid duplicates):
${existingSummary || '(none)'}

Recent conversation:
${conversationText}

Target scope: ${params.config.extraction.target_scope}`,
    })

    for (const mem of object.memories) {
      const targetScope = params.config.extraction.target_scope
      if (targetScope === 'agent_caller' && mem.scope !== 'agent_caller') continue
      if (targetScope === 'agent_global' && mem.scope !== 'agent_global') continue

      await params.storage.saveMemory({
        runtime_id: params.runtime_id,
        agent_id: params.agent_id,
        caller_id: mem.scope === 'agent_caller' ? params.caller_id : null,
        scope: mem.scope,
        tier: mem.tier,
        content: mem.content,
        importance: mem.importance,
        visibility: mem.visibility,
        source: 'extraction',
        expires_at: null,
      })
    }

    for (const id of object.obsolete_ids) {
      await params.storage.deleteMemory(id)
    }
  } catch (err) {
    console.warn('[memory] post-run extraction failed:', err)
  }
}
```

### `packages/core/src/runner.ts` — Modifikasi

```typescript
async run(params: JikuRunParams & { rules: PolicyRule[] }) {
  // ... existing setup ...

  // Resolve config — merge project + agent level
  const projectConfig = this.projectMemoryConfig   // dari JikuRuntime constructor
  const agentConfig   = this.agent.memory_config   // partial override atau null
  const config = resolveMemoryConfig(projectConfig, agentConfig)

  // Load memories
  const [runtimeMems, agentMems, callerMems, extendedMems] = await Promise.all([
    config.policy.read.runtime_global
      ? this.storage.getMemories({ runtime_id: this.runtimeId, agent_id: this.agent.id, scope: 'runtime_global' })
      : Promise.resolve([]),
    this.storage.getMemories({ runtime_id: this.runtimeId, agent_id: this.agent.id, scope: 'agent_global' }),
    this.storage.getMemories({ runtime_id: this.runtimeId, agent_id: this.agent.id, caller_id: params.caller.user_id, scope: 'agent_caller' }),
    this.storage.getMemories({ runtime_id: this.runtimeId, agent_id: this.agent.id, caller_id: params.caller.user_id, scope: ['agent_caller', 'agent_global'], tier: 'extended' }),
  ])

  // Build memory context + format
  const memoryCtx = await buildMemoryContext({
    memories: { runtime_global: runtimeMems, agent_global: agentMems, agent_caller: callerMems, extended_pool: extendedMems },
    current_input: params.input,
    config,
  })

  // Touch accessed memories
  const accessedIds = [...memoryCtx.runtime_global, ...memoryCtx.agent_global, ...memoryCtx.agent_caller, ...memoryCtx.extended].map(m => m.id)
  if (accessedIds.length > 0) {
    this.storage.touchMemories(accessedIds).catch(() => {})
  }

  // Build system prompt with memory section
  const memorySection = formatMemorySection(memoryCtx, params.caller.user_data?.name)
  const systemPrompt = buildSystemPrompt({
    base: this.agent.base_prompt,
    mode: params.mode,
    memory_section: memorySection,  // ← NEW param
    active_tools: scope.active_tools,
    caller: params.caller,
    plugin_segments: this.plugins.getPromptSegments(this.runtimeId),
  })

  // ... run agent ...

  // Post-run extraction (fire and forget)
  extractMemoriesPostRun({
    runtime_id: this.runtimeId,
    agent_id: this.agent.id,
    caller_id: params.caller.user_id,
    messages: newMessages,
    existing_memories: [...runtimeMems, ...agentMems, ...callerMems],
    config,
    model: buildModel(config.extraction.model),
    storage: this.storage,
  }).catch(() => {})
}
```

---

## 7. Studio App Layer — Built-in Tools

Memory tools di-register langsung di studio app layer, **bukan via plugin system**. Cara register sama dengan built-in tools lain yang selalu aktif.

```typescript
// apps/studio/server/src/memory/tools.ts
// Tools di-build di sini, di-inject ke runner saat wakeUp

import { defineTool } from '@jiku/kit'
import { z } from 'zod'
import { findRelevantMemories } from '@jiku/core/memory/relevance'

export function buildMemoryTools(config: ResolvedMemoryConfig) {
  const tools = [
    // ── Selalu tersedia ─────────────────────────────────

    defineTool({
      meta: { id: 'memory_core_append', name: 'Remember', category: 'memory', kind: 'write' },
      build: () => tool({
        description: 'Save an important fact to core memory. Always available in future conversations.',
        inputSchema: z.object({
          content: z.string().max(100).describe('Fact to remember'),
          scope: z.enum(['agent_caller', 'agent_global'])
            .describe('agent_caller = about current user, agent_global = applies to all users'),
          importance: z.enum(['low', 'medium', 'high']).default('medium'),
        }),
        execute: async (input, options) => {
          const runCtx = getJikuRunContext(options)
          await runCtx.storage.saveMemory({
            runtime_id: runCtx.runtimeId,
            agent_id: runCtx.agentId,
            caller_id: input.scope === 'agent_caller' ? runCtx.callerId : null,
            scope: input.scope,
            tier: 'core',
            content: input.content,
            importance: input.importance,
            visibility: 'private',
            source: 'agent',
            expires_at: null,
          })
          return `Remembered: "${input.content}"`
        }
      })
    }),

    defineTool({
      meta: { id: 'memory_core_replace', name: 'Update Memory', category: 'memory', kind: 'write' },
      build: () => tool({
        description: 'Update or correct an existing memory.',
        inputSchema: z.object({
          memory_id: z.string(),
          new_content: z.string().max(100),
        }),
        execute: async (input, options) => {
          const runCtx = getJikuRunContext(options)
          await runCtx.storage.updateMemory(input.memory_id, { content: input.new_content })
          return `Memory updated.`
        }
      })
    }),

    defineTool({
      meta: { id: 'memory_core_remove', name: 'Forget', category: 'memory', kind: 'write' },
      build: () => tool({
        description: 'Remove a memory that is no longer relevant.',
        inputSchema: z.object({ memory_id: z.string() }),
        execute: async (input, options) => {
          const runCtx = getJikuRunContext(options)
          await runCtx.storage.deleteMemory(input.memory_id)
          return `Memory removed.`
        }
      })
    }),

    defineTool({
      meta: { id: 'memory_extended_insert', name: 'Remember (Extended)', category: 'memory', kind: 'write' },
      build: () => tool({
        description: 'Save a fact to extended memory. Retrieved based on relevance, not always present.',
        inputSchema: z.object({
          content: z.string(),
          scope: z.enum(['agent_caller', 'agent_global']),
          importance: z.enum(['low', 'medium', 'high']).default('low'),
          visibility: z.enum(['private', 'agent_shared']).default('private'),
        }),
        execute: async (input, options) => {
          const runCtx = getJikuRunContext(options)
          await runCtx.storage.saveMemory({
            runtime_id: runCtx.runtimeId,
            agent_id: runCtx.agentId,
            caller_id: input.scope === 'agent_caller' ? runCtx.callerId : null,
            scope: input.scope,
            tier: 'extended',
            content: input.content,
            importance: input.importance,
            visibility: input.visibility,
            source: 'agent',
            expires_at: null,
          })
          return `Stored in extended memory: "${input.content}"`
        }
      })
    }),

    defineTool({
      meta: { id: 'memory_search', name: 'Search Memory', category: 'memory', kind: 'read' },
      build: () => tool({
        description: 'Search through memories to find relevant information.',
        inputSchema: z.object({
          query: z.string(),
          scope: z.enum(['agent_caller', 'agent_global', 'all']).default('all'),
        }),
        execute: async (input, options) => {
          const runCtx = getJikuRunContext(options)
          const memories = await runCtx.storage.getMemories({
            runtime_id: runCtx.runtimeId,
            agent_id: runCtx.agentId,
            caller_id: runCtx.callerId,
            scope: input.scope === 'all' ? ['agent_caller', 'agent_global'] : [input.scope],
          })
          const relevant = findRelevantMemories(memories, input.query, config.relevance)
          if (relevant.length === 0) return 'No relevant memories found.'
          return relevant.map(m => `[${m.id}] (${m.scope}, ${m.importance}) ${m.content}`).join('\n')
        }
      })
    }),
  ]

  // ── Policy-gated tools ────────────────────────────────

  if (config.policy.read.runtime_global) {
    tools.push(defineTool({
      meta: { id: 'memory_runtime_read', name: 'Read Project Memory', category: 'memory', kind: 'read' },
      build: () => tool({
        description: 'Search the shared project memory visible to all agents.',
        inputSchema: z.object({ query: z.string() }),
        execute: async (input, options) => {
          const runCtx = getJikuRunContext(options)
          const memories = await runCtx.storage.getMemories({
            runtime_id: runCtx.runtimeId,
            agent_id: runCtx.agentId,
            scope: 'runtime_global',
          })
          const relevant = findRelevantMemories(memories, input.query, config.relevance)
          if (relevant.length === 0) return 'No relevant project memories found.'
          return relevant.map(m => `[${m.id}] ${m.content}`).join('\n')
        }
      })
    }))
  }

  if (config.policy.write.runtime_global) {
    tools.push(defineTool({
      meta: { id: 'memory_runtime_write', name: 'Write Project Memory', category: 'memory', kind: 'write' },
      build: () => tool({
        description: 'Write to shared project memory. Visible to all agents in this project.',
        inputSchema: z.object({
          content: z.string(),
          importance: z.enum(['low', 'medium', 'high']).default('medium'),
        }),
        execute: async (input, options) => {
          const runCtx = getJikuRunContext(options)
          await runCtx.storage.saveMemory({
            runtime_id: runCtx.runtimeId,
            agent_id: runCtx.agentId,
            caller_id: null,
            scope: 'runtime_global',
            tier: 'extended',
            content: input.content,
            importance: input.importance,
            visibility: 'project_shared',
            source: 'agent',
            expires_at: null,
          })
          return `Written to project memory: "${input.content}"`
        }
      })
    }))
  }

  if (config.policy.read.cross_user) {
    tools.push(defineTool({
      meta: { id: 'memory_user_lookup', name: 'Lookup User Memory', category: 'memory', kind: 'read' },
      build: () => tool({
        description: 'Access memories about another user (only agent_shared visibility).',
        inputSchema: z.object({
          caller_id: z.string().describe('User ID to look up'),
          query: z.string(),
        }),
        execute: async (input, options) => {
          const runCtx = getJikuRunContext(options)
          const memories = await runCtx.storage.getMemories({
            runtime_id: runCtx.runtimeId,
            agent_id: runCtx.agentId,
            caller_id: input.caller_id,
            scope: 'agent_caller',
            visibility: ['agent_shared'],  // HANYA agent_shared, bukan private
          })
          const relevant = findRelevantMemories(memories, input.query, config.relevance)
          if (relevant.length === 0) return 'No shared memories found for this user.'
          return relevant.map(m => `[${m.id}] ${m.content}`).join('\n')
        }
      })
    }))
  }

  return tools
}
```

### Register di Runtime Manager

```typescript
// apps/studio/server/src/runtime/manager.ts

async wakeUp(projectId: string) {
  const project = await getProject(projectId)
  const projectMemoryConfig = project.memory_config ?? DEFAULT_PROJECT_MEMORY_CONFIG
  const agents = await getProjectAgents(projectId)

  const runtime = new JikuRuntime(projectId, {
    storage: new StudioStorageAdapter(projectId),
    project_memory_config: projectMemoryConfig,  // ← pass ke runtime
  })

  for (const agent of agents) {
    const resolvedConfig = resolveMemoryConfig(
      projectMemoryConfig,
      agent.memory_config ?? null,
    )

    // Build memory tools sesuai resolved config
    const memoryTools = buildMemoryTools(resolvedConfig)

    runtime.addAgent({
      id: agent.id,
      name: agent.name,
      base_prompt: agent.base_prompt,
      compaction_threshold: agent.compaction_threshold,
      memory_config: agent.memory_config,  // partial override, null = inherit
      built_in_tools: memoryTools,         // ← inject memory tools
    })
  }

  await runtime.boot()
  this._runtimes.set(projectId, runtime)
}
```

---

## 8. Studio App Layer — Server

### `StudioStorageAdapter` — Memory Methods

```typescript
// apps/studio/server/src/runtime/storage.ts

async getMemories(params): Promise<AgentMemory[]> {
  const conditions = [
    eq(agent_memories.project_id, params.runtime_id),
    eq(agent_memories.agent_id, params.agent_id),
  ]

  if (params.scope) {
    conditions.push(
      Array.isArray(params.scope)
        ? inArray(agent_memories.scope, params.scope)
        : eq(agent_memories.scope, params.scope)
    )
  }

  if (params.caller_id) {
    conditions.push(
      or(
        and(eq(agent_memories.scope, 'agent_caller'), eq(agent_memories.caller_id, params.caller_id)),
        ne(agent_memories.scope, 'agent_caller'),
      )
    )
  }

  if (params.tier) {
    conditions.push(eq(agent_memories.tier, params.tier))
  }

  if (params.visibility) {
    conditions.push(inArray(agent_memories.visibility, params.visibility))
  }

  return db.select().from(agent_memories)
    .where(and(...conditions))
    .orderBy(desc(agent_memories.importance), desc(agent_memories.last_accessed))
}

async saveMemory(data): Promise<AgentMemory> {
  const [result] = await db.insert(agent_memories).values({
    project_id: data.runtime_id,
    agent_id: data.agent_id,
    caller_id: data.caller_id,
    scope: data.scope,
    tier: data.tier,
    section: data.section,
    content: data.content,
    importance: data.importance,
    visibility: data.visibility,
    source: data.source,
    expires_at: data.expires_at,
  }).returning()
  return result
}

async updateMemory(id, data): Promise<void> {
  await db.update(agent_memories)
    .set({ ...data, updated_at: new Date() })
    .where(eq(agent_memories.id, id))
}

async deleteMemory(id): Promise<void> {
  await db.delete(agent_memories).where(eq(agent_memories.id, id))
}

async touchMemories(ids): Promise<void> {
  if (ids.length === 0) return
  await db.update(agent_memories)
    .set({
      access_count: sql`${agent_memories.access_count} + 1`,
      last_accessed: new Date(),
    })
    .where(inArray(agent_memories.id, ids))
}
```

### Post-run Extraction Trigger di Chat Route

```typescript
// apps/studio/server/src/routes/chat.ts

// Setelah stream selesai
stream.on('end', async () => {
  const resolvedConfig = resolveMemoryConfig(
    project.memory_config ?? DEFAULT_PROJECT_MEMORY_CONFIG,
    agent.memory_config ?? null,
  )

  if (resolvedConfig.extraction.enabled) {
    extractMemoriesPostRun({
      runtime_id: projectId,
      agent_id: agentId,
      caller_id: userId,
      messages: newMessages,
      existing_memories: loadedMemories,
      config: resolvedConfig,
      model: buildModel(resolvedConfig.extraction.model),
      storage: storageAdapter,
    }).catch(err => console.warn('[memory] extraction:', err))
  }
})
```

---

## 9. Relevance Scoring

Sudah dicover di section 6 (`packages/core/src/memory/relevance.ts`).

### Formula Summary

```
score = (
  keyword_overlap  * config.relevance.weights.keyword   +
  recency_decay    * config.relevance.weights.recency   +
  access_frequency * config.relevance.weights.access
) * importance_multiplier

keyword_overlap  = intersection(input_tokens, memory_tokens) / input_token_count
recency_decay    = exp(-age_days / config.relevance.recency_half_life_days)
access_frequency = min(access_count / 10, 1.0)
importance       = { high: 1.5, medium: 1.0, low: 0.6 }

Threshold: config.relevance.min_score   (default: 0.05)
Limit:     config.relevance.max_extended (default: 5)
```

---

## 10. Post-run Extraction

Sudah dicover di section 6 dan 8.

### Summary

```
Kapan: setelah setiap streaming run selesai (chat route)
Siapa yang trigger: chat route handler (app layer)
Async: fire and forget, tidak block response
Gagal: catch error, log warning, tidak crash

Input: 6 messages terakhir dari run ini
Model: config.extraction.model (default: claude-haiku-4-5)
Output:
  - New memories → saved ke DB
  - Obsolete IDs → deleted dari DB
```

---

## 11. Studio Web — UI

### A. Memory Browser (Project Level)

```
Route: /studio/companies/[company]/projects/[project]/memory
Sidebar: Dashboard | Agents | Chats | Memory | Plugins | Settings
```

```
┌──────────────────────────────────────────────────────────┐
│ Memory                                                   │
│                                                          │
│ [All Scopes ▾] [All Agents ▾] [All Users ▾] [All Tiers ▾]│
│ 🔍 Search memories...                                   │
│                                                          │
│ ┌──────────────────────────────────────────────────────┐ │
│ │ 🌐 Runtime Memory (2)                               │ │
│ │ ──────────────────────────────────────────────────  │ │
│ │ ● Platform for retail traders                       │ │
│ │   runtime_global · core · high · by Aria · 2h ago   │ │
│ │                                           [Delete]  │ │
│ ├──────────────────────────────────────────────────────┤ │
│ │ 🤖 Agent General — Aria (1)                         │ │
│ │ ──────────────────────────────────────────────────  │ │
│ │ ● Always respond in Indonesian                      │ │
│ │   agent_global · core · high · by Aria · 1d ago     │ │
│ │                                           [Delete]  │ │
│ ├──────────────────────────────────────────────────────┤ │
│ │ 👤 viandwi24 via Aria (3)                           │ │
│ │ ──────────────────────────────────────────────────  │ │
│ │ ● Prefers short answers                             │ │
│ │   agent_caller · core · high · 30m ago              │ │
│ │                                           [Delete]  │ │
│ └──────────────────────────────────────────────────────┘ │
└──────────────────────────────────────────────────────────┘
```

### B. Memory Preview Sheet (Chat Level)

Tombol di conversation header:

```
Social Manager  claude-sonnet  [Context] [Memory] [···]
```

Sheet dari kanan:

```
┌──────────────────────────────────────┐
│ Memory in this session        [×]    │
├──────────────────────────────────────┤
│ 💡 320 tokens · 6 memories          │
├──────────────────────────────────────┤
│ Runtime Memory (2)                   │
│  · Platform for retail traders       │
│  · Stack: PostgreSQL, Next.js        │
│                                      │
│ Agent General (1)                    │
│  · Always respond in Indonesian      │
│                                      │
│ About viandwi24 (3)                  │
│  · Prefers short answers             │
│  · Forex trader, focus XAUUSD       │
│  · Dislikes emojis                   │
│                                      │
│ Relevant Extended (2)      scored   │
│  · [0.87] Asked XAUUSD 2026-01-15   │
│  · [0.72] Mentioned 5-person team   │
│                                      │
│         [Open Memory Browser →]      │
└──────────────────────────────────────┘
```

### C. Project Memory Config (Project Settings)

```
Project Settings → [General] [Credentials] [Permissions] [Memory]

Memory Defaults
Berlaku untuk semua agent yang tidak override

RELEVANCE SCORING
  Min Score           [0.05]  ← slider 0.01–0.5
  Max Extended        [5]     ← slider 1–20
  Keyword Weight      [0.50]  ← slider 0–1
  Recency Weight      [0.30]  ← slider 0–1
  Access Weight       [0.20]  ← slider 0–1
  Half-life (days)    [30]    ← slider 7–180

CORE MEMORY
  Max Chars           [2000]  ← number input
  Token Budget        [600]   ← number input

EXTRACTION
  Enabled             [Toggle ON]
  Model               [claude-haiku-4-5 ▾]
  Target Scope        ◉ Agent-User only
                      ○ Agent General only
                      ○ Both

DEFAULT POLICY
  Read runtime memory         [Toggle ON]
  Write runtime memory        [Toggle OFF]
  Cross-user read             [Toggle OFF]
  Cross-user write            [Toggle OFF]
```

### D. Agent Memory Config (Agent Settings → Memory Tab)

```
Agent Settings
[Info] [LLM] [Prompt] [Tools] [Memory] [Permissions]

Memory Config
Inheriting from project defaults. Only set values you want to override.

POLICY OVERRIDE
  Read runtime memory    [inherit ▾]  ← dropdown: inherit / ON / OFF
  Write runtime memory   [inherit ▾]
  Cross-user read        [inherit ▾]
  Cross-user write       [inherit ▾]

RELEVANCE OVERRIDE
  Max Extended           [inherit ▾]  ← dropdown: inherit / custom number
  Min Score              [inherit ▾]

EXTRACTION OVERRIDE
  Enabled                [inherit ▾]
  Model                  [inherit ▾]
  Target Scope           [inherit ▾]

  "inherit" means use project default.
  Current effective config:
  ┌────────────────────────────────────────┐
  │ read.runtime_global  : true  (project) │
  │ write.runtime_global : false (project) │
  │ extraction.enabled   : true  (project) │
  │ relevance.max_extended: 5    (project) │
  └────────────────────────────────────────┘
```

**"Current effective config"** panel — show resolved config setelah merge, label mana yang dari project mana yang dari agent. Ini sangat membantu debugging.

---

## 12. DB Schema

```typescript
// apps/studio/db/src/schema/memories.ts

export const agent_memories = pgTable('agent_memories', {
  id:           uuid('id').primaryKey().defaultRandom(),
  project_id:   uuid('project_id').notNull().references(() => projects.id),
  agent_id:     uuid('agent_id').notNull().references(() => agents.id),
  caller_id:    uuid('caller_id').references(() => users.id),
  scope:        varchar('scope', { length: 50 }).notNull(),
  tier:         varchar('tier', { length: 20 }).notNull().default('extended'),
  section:      varchar('section', { length: 100 }),
  content:      text('content').notNull(),
  importance:   varchar('importance', { length: 20 }).notNull().default('medium'),
  visibility:   varchar('visibility', { length: 50 }).notNull().default('private'),
  source:       varchar('source', { length: 20 }).notNull().default('agent'),
  access_count: integer('access_count').notNull().default(0),
  last_accessed: timestamp('last_accessed'),
  expires_at:   timestamp('expires_at'),
  created_at:   timestamp('created_at').notNull().defaultNow(),
  updated_at:   timestamp('updated_at').notNull().defaultNow(),
})

// Migration:
// ALTER TABLE projects ADD COLUMN memory_config jsonb DEFAULT NULL;
// ALTER TABLE agents   ADD COLUMN memory_config jsonb DEFAULT NULL;
// NULL = use project default / platform default
```

---

## 13. API Routes

```
# Memory CRUD
GET    /api/projects/:pid/memories
       ?scope=&agent_id=&user_id=&tier=&search=
       → list semua memories di project (untuk browser)

GET    /api/conversations/:cid/memory-preview
       → memory yang akan di-inject di session ini
       → return MemoryContext + token count

DELETE /api/memories/:id
       → delete memory (user action via browser)

# Config
GET    /api/projects/:pid/memory-config
       → get project memory config

PATCH  /api/projects/:pid/memory-config
       → update project memory config

GET    /api/agents/:aid/memory-config
       → get agent memory config (partial override)

PATCH  /api/agents/:aid/memory-config
       → update agent memory config

GET    /api/agents/:aid/memory-config/resolved
       → get fully resolved config (project merged dengan agent)
       → untuk ditampilkan di "Current effective config" panel
```

---

## 14. File Changes

### New Files

```
packages/core/src/memory/
  config.ts          ← DEFAULT_PROJECT_MEMORY_CONFIG, resolveMemoryConfig
  relevance.ts       ← scoreMemory, findRelevantMemories
  builder.ts         ← buildMemoryContext, formatMemorySection
  extraction.ts      ← extractMemoriesPostRun
  index.ts           ← re-export semua

apps/studio/db/src/schema/
  memories.ts        ← agent_memories table

apps/studio/db/src/queries/
  memory.ts          ← getMemories, saveMemory, deleteMemory, touchMemories

apps/studio/server/src/memory/
  tools.ts           ← buildMemoryTools(config) — built-in tools, bukan plugin

apps/studio/server/src/routes/
  memory.ts          ← /api/memories/* dan /api/*memory-config routes

apps/studio/web/
  app/(app)/studio/.../memory/page.tsx
  components/memory/
    memory-browser.tsx
    memory-item.tsx
    memory-filters.tsx
  components/chat/
    memory-preview-sheet.tsx
  app/(app)/studio/.../agents/[agent]/memory/
    page.tsx           ← agent memory config tab
  app/(app)/studio/.../settings/memory/
    page.tsx           ← project memory config tab
```

### Modified Files

```
packages/types/src/index.ts
  → AgentMemory, MemoryContext, MemoryScope, MemoryTier, MemoryImportance, MemoryVisibility
  → ResolvedMemoryConfig, ProjectMemoryConfig, AgentMemoryConfig
  → JikuStorageAdapter: tambah memory methods
  → RuntimeAgent: tambah memory_config (partial, nullable)
  → JikuRuntimeOptions: tambah project_memory_config

packages/core/src/runner.ts
  → resolveMemoryConfig sebelum run
  → load memories, build context, inject ke system prompt
  → touch memories, post-run extraction

packages/core/src/resolver/prompt.ts
  → buildSystemPrompt: tambah memory_section param

apps/studio/db/src/schema/agents.ts
  → tambah memory_config jsonb (nullable)

apps/studio/db/src/schema/projects.ts
  → tambah memory_config jsonb (nullable)

apps/studio/db/src/schema/index.ts
  → export memories

apps/studio/server/src/runtime/storage.ts
  → implement semua memory methods di StudioStorageAdapter

apps/studio/server/src/runtime/manager.ts
  → wakeUp: load project memory_config
  → resolveMemoryConfig per agent
  → buildMemoryTools(resolvedConfig) dan inject ke agent

apps/studio/server/src/routes/chat.ts
  → trigger extractMemoriesPostRun setelah stream end

apps/studio/server/src/index.ts
  → mount memoryRouter
  → TIDAK register jiku.memory plugin

apps/studio/web/components/sidebar/project-sidebar.tsx
  → tambah Memory item antara Chats dan Plugins

apps/studio/web/app/(app)/studio/.../agents/[agent]/layout.tsx
  → tambah Memory tab

apps/studio/web/app/(app)/studio/.../settings/layout.tsx
  → tambah Memory tab di project settings

apps/studio/web/components/chat/chats/[conv]/page.tsx
  → tambah Memory button di conversation header
  → MemoryPreviewSheet integration

apps/studio/web/lib/api.ts
  → api.memory.* dan api.memoryConfig.*
```

---

## 15. Implementation Checklist

> ⚠️ ONGOING — implementasi bertahap, memory adalah app layer bukan plugin

### Core — Types

- [ ] `AgentMemory` interface
- [ ] `MemoryScope`, `MemoryTier`, `MemoryImportance`, `MemoryVisibility` types
- [ ] `MemoryContext` interface
- [ ] `ResolvedMemoryConfig` interface
- [ ] `ProjectMemoryConfig` type alias
- [ ] `AgentMemoryConfig` type (partial, optional fields)
- [ ] `JikuStorageAdapter` — tambah 5 memory methods
- [ ] `RuntimeAgent` — tambah `memory_config: AgentMemoryConfig | null`
- [ ] `JikuRuntimeOptions` — tambah `project_memory_config`

### Core — Memory Logic

- [ ] `memory/config.ts` — `DEFAULT_PROJECT_MEMORY_CONFIG`
- [ ] `memory/config.ts` — `resolveMemoryConfig(projectConfig, agentConfig)` — 2-level merge
- [ ] `memory/relevance.ts` — `scoreMemory()` — keyword + recency + access + importance
- [ ] `memory/relevance.ts` — `findRelevantMemories()` — filter + sort + slice
- [ ] `memory/builder.ts` — `buildMemoryContext()` — core + scored extended
- [ ] `memory/builder.ts` — `formatMemorySection()` — format ke string
- [ ] `memory/extraction.ts` — `extractMemoriesPostRun()` — async LLM extraction
- [ ] `resolver/prompt.ts` — tambah `memory_section` ke `buildSystemPrompt()`
- [ ] `runner.ts` — resolve config, load memories, inject, touch, extraction

### DB

- [ ] `agent_memories` table schema + migration
- [ ] `projects.memory_config` jsonb column + migration
- [ ] `agents.memory_config` jsonb column + migration
- [ ] Query: `getMemories()` dengan semua filter
- [ ] Query: `saveMemory()`
- [ ] Query: `updateMemory()`
- [ ] Query: `deleteMemory()`
- [ ] Query: `touchMemories()` — increment access_count + last_accessed

### Studio Server — App Layer (bukan plugin)

- [ ] `StudioStorageAdapter` — implement 5 memory methods
- [ ] `memory/tools.ts` — `buildMemoryTools(resolvedConfig)`:
  - [ ] `memory_core_append` — selalu aktif
  - [ ] `memory_core_replace` — selalu aktif
  - [ ] `memory_core_remove` — selalu aktif
  - [ ] `memory_extended_insert` — selalu aktif
  - [ ] `memory_search` — selalu aktif
  - [ ] `memory_runtime_read` — aktif kalau `policy.read.runtime_global`
  - [ ] `memory_runtime_write` — aktif kalau `policy.write.runtime_global`
  - [ ] `memory_user_lookup` — aktif kalau `policy.read.cross_user`
  - [ ] `memory_user_write` — aktif kalau `policy.write.cross_user`
- [ ] `RuntimeManager.wakeUp()` — load project config, resolve per agent, inject tools
- [ ] `chat.ts` — trigger extraction setelah stream end
- [ ] `GET /api/projects/:pid/memories`
- [ ] `GET /api/conversations/:cid/memory-preview`
- [ ] `DELETE /api/memories/:id`
- [ ] `GET/PATCH /api/projects/:pid/memory-config`
- [ ] `GET/PATCH /api/agents/:aid/memory-config`
- [ ] `GET /api/agents/:aid/memory-config/resolved`

### Studio Web

- [ ] Project sidebar: Memory item (antara Chats dan Plugins)
- [ ] Memory browser page (`/memory`)
- [ ] `MemoryBrowser` — filter bar + grouped list
- [ ] `MemoryItem` — content + badges + delete
- [ ] `MemoryFilters` — scope, agent, user, tier
- [ ] Memory preview sheet (`MemoryPreviewSheet`)
- [ ] Memory button di conversation header
- [ ] Agent Memory tab (`/agents/[agent]/memory`)
  - [ ] Policy override dropdowns (inherit / ON / OFF)
  - [ ] Relevance override fields
  - [ ] Extraction override fields
  - [ ] "Current effective config" panel (resolved config)
- [ ] Project Memory Config tab (`/settings/memory`)
  - [ ] Relevance sliders
  - [ ] Core memory limits
  - [ ] Extraction config
  - [ ] Default policy toggles
- [ ] `api.memory.*` + `api.memoryConfig.*` di `lib/api.ts`

---

*Generated: 2026-04-05 | Status: Planning — Ongoing Tasks*
*Note: Memory adalah app layer (studio), bukan plugin. Tidak ada jiku.memory plugin.*