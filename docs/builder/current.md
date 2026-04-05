## Phase
Plan 9 — Persona System — COMPLETE

## Currently Working On
- Nothing active.

## Relevant Files
- `packages/types/src/index.ts` — added `agent_self` to MemoryScope, added PersonaSeed interface
- `packages/core/src/memory/builder.ts` — added `formatPersonaSection()`
- `packages/core/src/memory/index.ts` — exported formatPersonaSection
- `packages/core/src/resolver/prompt.ts` — buildSystemPrompt now accepts `persona_section`
- `packages/core/src/runner.ts` — loads agent_self memories + injects persona_section into prompt + preview
- `packages/core/src/runtime.ts` — addAgent() accepts optional personaSeed param
- `apps/studio/db/src/schema/agents.ts` — added persona_seed + persona_seeded_at columns
- `apps/studio/db/src/queries/memory.ts` — added agent_self scope, updateAgentPersonaSeed, markAgentPersonaSeeded, resetAgentPersona, getAgentSelfMemories
- `apps/studio/server/src/memory/tools.ts` — added persona_read + persona_update tools
- `apps/studio/server/src/memory/persona.ts` — ensurePersonaSeeded() service
- `apps/studio/server/src/runtime/manager.ts` — passes persona_seed to addAgent, calls ensurePersonaSeeded on run()
- `apps/studio/server/src/routes/persona.ts` — GET/PATCH seed, POST reset, GET memories
- `apps/studio/server/src/index.ts` — registered personaRouter
- `apps/studio/web/lib/api.ts` — added persona API methods + PersonaSeed type
- `apps/studio/web/app/.../agents/[agent]/layout.tsx` — added "persona" nav item
- `apps/studio/web/app/.../agents/[agent]/persona/page.tsx` — Persona settings page
- `apps/studio/web/components/chat/context-preview-sheet.tsx` — added violet color for persona segment

## Important Context / Temporary Decisions
- `agent_self` scope is injected as `[Persona]` section in system prompt, before `[Memory]`
- `agent_self` memories are ALWAYS injected (no relevance scoring) — all core, tier is always 'core'
- `ensurePersonaSeeded` runs at studio server layer (manager.ts) before each run — no-op if already seeded
- persona_seeded_at tracks whether seed was applied; null = not yet seeded (will seed on next run)
- Reset persona: deletes all agent_self memories + sets persona_seeded_at = null → re-seeds on next run
- `formatPersonaSection` lives in @jiku/core (no DB dep needed — just takes AgentMemory[])
- DB schema change: agents table now has persona_seed (jsonb) + persona_seeded_at (timestamptz)

## Next Up
- DB migration to apply schema changes (persona_seed + persona_seeded_at columns)
- Test suite — unit tests for resolveScope, checkAccess, PluginLoader, resolveCaller
- Invite member feature
- Agent Tools tab (currently placeholder)
