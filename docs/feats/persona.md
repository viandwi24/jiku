# Feature: Persona System

## What It Does

Agents have a living identity stored as `agent_self` memories and injected into the system prompt as a `## Who I Am` section before `[Memory]`. The identity starts from a user-configured **seed** and evolves as the agent updates it via built-in persona tools.

## Key Principles

- Persona is memory, not config — stored as `agent_self` scope rows in `agent_memories`
- `agent_self` memories are **always injected** (no relevance scoring; all core tier)
- Agent manages its own persona via tools; user only provides the initial seed
- Reset: deletes all `agent_self` memories + sets `persona_seeded_at = null` → re-seeds on next run

## System Prompt Injection Order

```
[Base Prompt]
[Persona]        ← agent_self memories formatted as "## Who I Am"
[Memory]         ← agent_caller / agent_global / runtime_global
[Plugin Prompts]
[Tool Hints]
[Mode Instruction]
[User Context]
```

## Persona Seed

User configures an initial seed in Agent Settings → Persona tab. Stored as `agents.persona_seed jsonb`.

```typescript
interface PersonaSeed {
  name?: string
  role?: string
  personality?: string
  communication_style?: string
  background?: string
  initial_memories?: string[]
}
```

### Seeding behavior

- On first run (or after reset), `ensurePersonaSeeded()` converts seed fields into `agent_self` core memories
- `agents.persona_seeded_at` is set to `now()` — subsequent runs skip seeding
- Reset: deletes all `agent_self` memories + sets `persona_seeded_at = null`

## Built-in Persona Tools

Both always active (not policy-gated). Group: `persona`.

| Tool | Description |
|------|-------------|
| `persona_read` | Read all current `agent_self` memories |
| `persona_update` | Append / replace / remove an `agent_self` memory |

## `formatPersonaSection()`

Lives in `packages/core/src/memory/builder.ts`. Takes `agentName`, `selfMemories[]`, optional seed. Returns formatted string:

```
## Who I Am
**Name:** Aria
**Role:** Research Assistant

- I communicate in a concise, direct style
- I have deep expertise in DeFi protocols
- ...
```

Fallback when no memories + no seed: `I am {agentName}, an AI assistant. I'm still learning about myself.`

## API Routes

All under `/api/agents/:aid/persona/`:

| Method | Route | Description |
|--------|-------|-------------|
| GET | `/memories` | List all `agent_self` memories |
| GET | `/seed` | Read `persona_seed` config |
| PATCH | `/seed` | Update `persona_seed` config |
| POST | `/reset` | Delete all `agent_self` memories + reset `persona_seeded_at` |

## Web UI

**Agent Settings → Persona tab** (`/agents/[agent]/persona`):
- PersonaSeed form: name, role, personality, communication_style, background
- Initial Memories list (add / remove seed memories)
- Current Persona panel: live read-only view of `agent_self` memories from DB
- Reset to Seed AlertDialog: confirms before destructive reset

## Database

No new table. Uses `agent_memories` with `scope = 'agent_self'`.

New columns on `agents` table (requires `bun run db:push`):
- `persona_seed jsonb` — initial seed config (nullable)
- `persona_seeded_at timestamptz` — null = not yet seeded

## Related Files

- `packages/types/src/index.ts` — `PersonaSeed` interface, `agent_self` in MemoryScope
- `packages/core/src/memory/builder.ts` — `formatPersonaSection()`
- `packages/core/src/resolver/prompt.ts` — `buildSystemPrompt({ persona_section })`
- `packages/core/src/runner.ts` — loads agent_self + injects into run() and previewRun()
- `packages/core/src/runtime.ts` — `addAgent(..., personaSeed?)`
- `apps/studio/db/src/schema/agents.ts` — `persona_seed`, `persona_seeded_at` columns
- `apps/studio/db/src/queries/memory.ts` — `getAgentSelfMemories`, `markAgentPersonaSeeded`, `resetAgentPersona`
- `apps/studio/server/src/memory/persona.ts` — `ensurePersonaSeeded()`
- `apps/studio/server/src/memory/tools.ts` — `persona_read`, `persona_update` tools
- `apps/studio/server/src/runtime/manager.ts` — calls ensurePersonaSeeded before run()
- `apps/studio/server/src/routes/persona.ts` — API routes
- `apps/studio/web/app/.../agents/[agent]/persona/page.tsx` — settings page

## Known Limitations

- `extractPersonaPostRun()` not implemented — auto-extraction of persona signals after conversation is deferred
- Persona is agent-global only — no per-user persona variant (`agent_caller` persona) deferred
- No persona versioning or history
