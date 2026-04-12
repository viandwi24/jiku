# Feature: Memory System

## What It Does

Persistent memory for agents across conversations. Agents can read and write memories (facts, context, user preferences) that survive across sessions. Memory is injected into the system prompt on every run and extracted post-run by a small LLM call.

## Memory Scopes

| Scope | Who writes | Who reads | Description |
|-------|-----------|----------|-------------|
| `agent_caller` | Agent (for this user) | Agent + same user | Per-user memories (preferences, history) |
| `agent_global` | Agent | All users of same agent | Agent-wide knowledge base |
| `runtime_global` | Agent (if policy allows) | All agents in project | Project-wide shared facts |
| `agent_self` | Agent (via persona tools) | Agent only | Agent's own identity / persona — see `docs/feats/persona.md` |

> `agent_self` is injected into `[Persona]` section (before `[Memory]`), not the memory section. Queries to `agent_self` are always scope-explicit and never bleed into regular memory queries.

## Memory Tiers

| Tier | Behavior |
|------|----------|
| `core` | Always injected (subject to `max_chars` + `token_budget` limits) |
| `extended` | Scored by relevance against current input; top N injected |

## Config Inheritance

Two-level hierarchy: project config → agent override → resolved config.

```
resolveMemoryConfig(projectConfig, agentConfig?) → ResolvedMemoryConfig
```

- `projectConfig` sets project-wide defaults
- `agentConfig` (partial) overrides specific fields per agent
- `resolveMemoryConfig()` merges them; project defaults fill missing agent keys

## Run Lifecycle

1. **Load** — before prompt build, all scopes loaded in parallel from DB
2. **Score** — extended memories ranked by relevance (keyword + recency + access + importance)
3. **Format** — `formatMemorySection()` renders markdown grouped by scope
4. **Inject** — memory section added to system prompt via `buildSystemPrompt({ memory_section })`
5. **Touch** — `touchMemories(ids)` increments `access_count` + sets `last_accessed`
6. ~~**Extract**~~ — LLM extraction removed (Plan 15). Agent must explicitly call memory tools.

## Built-in Memory Tools (9 of 9)

Always available:
- `memory_core_append` — save to core memory
- `memory_core_replace` — update existing core memory
- `memory_core_remove` — delete a memory
- `memory_extended_insert` — save to extended memory
- `memory_search` — relevance search

Policy-gated:
- `memory_runtime_read` — read `runtime_global` (`policy.read.runtime_global`)
- `memory_runtime_write` — write `runtime_global` (`policy.write.runtime_global`)
- `memory_user_lookup` — read other users' `agent_shared` memories (`policy.read.cross_user`)
- `memory_user_write` — write `agent_shared` for a target `caller_id` (`policy.write.cross_user`); saves with `scope: agent_caller, visibility: agent_shared`

## API Routes

| Method | Route | Description |
|--------|-------|-------------|
| GET | `/api/projects/:pid/memories` | List project memories (filterable) |
| DELETE | `/api/memories/:id` | Delete a memory |
| GET | `/api/projects/:pid/memory-config` | Get project config |
| PATCH | `/api/projects/:pid/memory-config` | Update project config (deep merge) |
| GET | `/api/agents/:aid/memory-config` | Get agent override config |
| PATCH | `/api/agents/:aid/memory-config` | Update agent override (null = reset) |
| GET | `/api/agents/:aid/memory-config/resolved` | Get fully resolved config |

## Web UI

**`/memory` page** — two tabs:
- **Memories** — `MemoryBrowser`: filters by scope/tier, memory cards with badges, delete with confirmation, access stats
- **Config** — `MemoryConfig`: project-level config (Default Policy, Relevance Scoring, Core Memory, Extraction)

**`/agents/[agent]/memory` page** — per-agent config override:
- `InheritToggle` per policy field (inherit / on / off)
- "Inherit" = null in DB → falls back to project default
- Effective Config panel shows resolved values with source badges (project / agent)
- Save + Reset to project defaults buttons

**Context Preview Sheet** — memory segment (teal) shown in context segments list with token count and content.

**Memory Preview Sheet** — `components/chat/memory-preview-sheet.tsx` — dedicated sheet accessible via Memory button in chat footer. Reuses the `['preview', agentId, conversationId]` TanStack Query cache (no extra API request). Parses the raw injected memory text by markdown headings (## Project Memory → runtime_global, ## About You → agent_caller, etc.) and renders collapsible sections grouped by scope with tier + importance badges. Shows token count from `memorySeg.token_estimate`. Includes a raw text debug view.

## Config Shape

```typescript
interface ResolvedMemoryConfig {
  policy: {
    read: { runtime_global: boolean; cross_user: boolean }
    write: { agent_global: boolean; runtime_global: boolean; cross_user: boolean }
  }
  relevance: {
    min_score: number           // default 0.1
    max_extended: number        // default 5
    weights: {
      keyword: number           // default 0.5
      recency: number           // default 0.3
      access: number            // default 0.2
    }
    recency_half_life_days: number  // default 30
  }
  core: {
    max_chars: number           // default 4000
    token_budget: number        // default 500
  }
  extraction: {
    enabled: boolean
    model: string               // model ID for extraction LLM call
    target_scope: 'agent_caller' | 'agent_global' | 'both'
  }
}
```

## Database

- `agent_memories` table — all memory rows. Key columns: `project_id`, `agent_id`, `caller_id` (nullable), `scope`, `tier`, `content`, `importance`, `visibility`, `access_count`, `last_accessed`, `expires_at`.
- `projects.memory_config` jsonb — project-level config (nullable = use defaults)
- `agents.memory_config` jsonb — agent-level override (nullable = full inherit from project)

## Related Files

- `packages/types/src/index.ts` — all memory types
- `packages/core/src/memory/config.ts` — defaults + resolve function
- `packages/core/src/memory/relevance.ts` — scoring
- `packages/core/src/memory/builder.ts` — context build + format
- `packages/core/src/memory/extraction.ts` — post-run LLM extraction
- `packages/core/src/runner.ts` — memory lifecycle (load/inject/touch/extract + previewRun)
- `apps/studio/db/src/schema/memories.ts` — DB schema
- `apps/studio/db/src/queries/memory.ts` — all queries
- `apps/studio/server/src/memory/tools.ts` — built-in tools
- `apps/studio/server/src/runtime/storage.ts` — memory methods in StudioStorageAdapter
- `apps/studio/server/src/runtime/manager.ts` — config load + tool injection
- `apps/studio/server/src/routes/memory.ts` — API routes
- `apps/studio/web/components/memory/memory-browser.tsx`
- `apps/studio/web/components/memory/memory-config.tsx`
- `apps/studio/web/app/(app)/studio/.../memory/page.tsx`
- `apps/studio/web/app/(app)/studio/.../agents/[agent]/memory/page.tsx`

## Memory Expiration Cleanup

`deleteExpiredMemories()` in `apps/studio/db/src/queries/memory.ts` — deletes rows where `expires_at IS NOT NULL AND expires_at < NOW()`. Called at server boot and every 24h via `setInterval` in `apps/studio/server/src/index.ts`.

## Semantic Search (Plan 15.7)

Vector embedding search via Qdrant. When enabled, memories are embedded on save and scored by cosine similarity at retrieval time.

**Config** (`projects.memory_config.embedding`):
- `enabled: boolean` — default false; enable via Memory → Config → Semantic Search tab
- `provider: 'openai' | 'openrouter'`
- `model: string` — e.g. `text-embedding-3-small`
- `credential_id: string | null` — specific credential; fallback: auto-find by provider
- `dimensions: number` — default 1536

**Credential resolution:** Uses `getAvailableCredentials(companyId, projectId)` — includes both company-level and project-level credentials. Company credentials (defined once) are visible to all projects.

**Runtime flow:**
1. `saveMemory()` in `storage.ts` → fire-and-forget `upsertEmbedding()`
2. `deleteMemory()` → fire-and-forget Qdrant delete
3. `manager.run()` → queries Qdrant for semantic scores → merged into relevance scoring

**Qdrant collection:** Named `memories_<projectId>`. Created automatically on first embed. Vectors are `1536`-dim (or configured `dimensions`).

**Credential picker:** `EmbeddingCredentialPicker` in `memory-config.tsx` uses `api.credentials.available(projectId)` to show both company and project credentials.

## Related Files (updated for Plan 15)

- `apps/studio/server/src/memory/embedding.ts` — `createEmbeddingService()`, `clearEmbeddingCache()`
- `apps/studio/server/src/memory/qdrant.ts` — `QdrantVectorStore` class
- `apps/studio/server/src/runtime/storage.ts` — `upsertEmbedding()`, wired in `saveMemory()`/`deleteMemory()`
- `apps/studio/server/src/runtime/manager.ts` — semantic scores passed to runner in `run()`
- `apps/studio/server/src/routes/memory.ts` — `clearEmbeddingCache()` called after config save
- `packages/core/src/memory/builder.ts` — accepts `semanticScores?: Map<string, number>` parameter
- `apps/studio/web/components/memory/memory-config.tsx` — 4-tab config UI with Semantic Search tab + method cards

## Known Limitations

- Qdrant must be running (`docker compose up qdrant`) — semantic search silently disabled if down
- Embedding is fire-and-forget; new memories may not be immediately searchable
- DB migration for `agent_memories` requires `bun run db:push`
- LLM auto-extraction removed — agents must explicitly call memory tools to persist facts

---

## Plan 19 — Memory Learning Loop (2026-04-12)

### Memory types
Each memory row now carries:
- `memory_type`: `episodic | semantic | procedural | reflective` (default `semantic`, backward compat)
- `score_health`: 0..1 float, boosted by retrieval (+0.05, capped), decayed by deep dreaming (*0.98)
- `source_type`: `tool | reflection | dream | flush` — tracks how the row was produced

Low-health dream-origin rows are purged; user-written `tool` rows are preserved.

### Background Jobs Contract (HARD RULE)

Reflection / dreaming / flush work runs out-of-band via `background_jobs` — it must **never** block the user response stream.

1. Runner MUST close its stream before enqueue is called.
2. `enqueueAsync()` only `INSERT`s a row to `background_jobs`; handlers run in the worker loop (tick 5s).
3. `BackgroundWorker` claims jobs with `SELECT ... FOR UPDATE SKIP LOCKED` — safe under multiple ticks.
4. Idempotency keys prevent duplicates: `flush:<conversation>:<hash>`, `reflection:<conversation>:<turns>`.
5. Worker failures retry up to `max_attempts` with 30s delay; terminal failures leave `status='failed'` with error text.

### Flush hook (compaction)
`AgentRunner` fires `CompactionHook` whenever `compactMessages()` produces a summary. Studio's hook enqueues `memory.flush` → handler embeds, dedups (cosine ≥ 0.9), inserts episodic memory scoped to the conversation caller.

### Reflection hook (finalize)
After stream close, `FinalizeHook` fires → enqueues `memory.reflection` (only when the agent opts in via `AgentMemoryConfig.reflection.enabled`). Handler runs a small LLM that extracts at most one insight ("NONE" is honored), dedups against existing reflective memories, then inserts a `reflective / reflection` memory.

### Dreaming engine
Per-project cron (`croner`) schedules 3 phases:
- **Light (every 6h):** cluster last-2d `tool`/`flush` memories by embedding similarity ≥ 0.85, consolidate each cluster into one `semantic / dream` memory.
- **Deep (daily):** synthesize last-7d episodic + top-health semantic into `procedural` / `semantic` via `PROC:`/`FACT:` prefixes. Then `bulkDecayHealth(* 0.98)` and `deleteLowHealthDreamMemories(< 0.1)`.
- **REM (weekly, opt-in):** cross-topic patterns from `semantic` + `procedural` over 30d; emits `reflective / dream` only above `min_pattern_strength`.

Manual trigger: `POST /api/projects/:pid/memory/dream { phase }`.

### Config (project-level)
`ResolvedMemoryConfig.dreaming` — master toggle + per-phase `{ enabled, cron, model_tier }`; REM also has `min_pattern_strength`. Editing config calls `dreamScheduler.reschedule(projectId)`.

### Config (agent-level)
`AgentMemoryConfig.reflection` — `{ enabled, model, scope, min_conversation_turns }`. Default off. Scope picks `agent_caller` (per-user) vs `agent_global`.

### Audit events
`memory.write`, `memory.flush`, `memory.reflection_run`, `memory.dream_run` — all via `audit.*` helpers, routed through `audit_logs` (Plan 18).

### Key files

- `apps/studio/db/src/schema/memories.ts` — added `memory_type`, `score_health`, `source_type`
- `apps/studio/db/src/schema/background_jobs.ts` — durable queue
- `apps/studio/db/src/queries/memory.ts` — `bulkDecayHealth`, `deleteLowHealthDreamMemories`, `getMemoriesByType`; `touchMemories` now bumps health
- `apps/studio/db/src/queries/background_jobs.ts` — `enqueueJob` (idempotent), `claimNextJob` (SKIP LOCKED), lifecycle queries
- `apps/studio/db/src/migrations/0012_plan19_memory_jobs.sql`
- `apps/studio/server/src/jobs/worker.ts` — tick loop
- `apps/studio/server/src/jobs/enqueue.ts` — non-blocking helper
- `apps/studio/server/src/jobs/handlers/{flush,reflection,dreaming}.ts`
- `apps/studio/server/src/jobs/dream-scheduler.ts` — croner-based per-project cron
- `apps/studio/server/src/memory/hooks.ts` — `CompactionHook`/`FinalizeHook` → enqueue
- `packages/core/src/runner.ts` — `setCompactionHook`, `setFinalizeHook`
- `packages/core/src/runtime.ts` — propagates hooks to all agent runners
- `apps/studio/web/components/memory/memory-config.tsx` — Dreaming sub-tab (project `/memory` page → Config tab) with CredentialSelector + ModelSelector + per-phase `CronExpressionInput`
- `apps/studio/web/components/memory/memory-browser.tsx` — Type + Health columns, clickable detail/edit dialog
- `apps/studio/web/app/.../agents/[agent]/memory/page.tsx` — Reflection section
