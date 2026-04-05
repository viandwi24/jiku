# Feature: Memory System

## What It Does

Persistent memory for agents across conversations. Agents can read and write memories (facts, context, user preferences) that survive across sessions. Memory is injected into the system prompt on every run and extracted post-run by a small LLM call.

## Memory Scopes

| Scope | Who writes | Who reads | Description |
|-------|-----------|----------|-------------|
| `agent_caller` | Agent (for this user) | Agent + same user | Per-user memories (preferences, history) |
| `agent_global` | Agent | All users of same agent | Agent-wide knowledge base |
| `runtime_global` | Agent (if policy allows) | All agents in project | Project-wide shared facts |

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
6. **Extract** — `extractMemoriesPostRun()` runs as fire-and-forget after stream completes

## Built-in Memory Tools (8 of 9)

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

Missing (not yet implemented):
- `memory_user_write` — write `agent_shared` (`policy.write.cross_user`)

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

## Known Limitations

- No vector/embedding search — uses keyword + recency scoring only
- `memory_user_write` tool not yet implemented
- Memory preview sheet in chat UI not yet built
- No memory expiration cleanup job (expires_at field exists but no scheduled deletion)
- DB migration for `agent_memories` requires `bun run db:push`
