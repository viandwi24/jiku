## Phase
Plugin System V2 — Complete

## Currently Working On
(idle — Plugin System V2 selesai)

## Relevant Files
- `packages/types/src/index.ts` — PluginDefinition generic, Contributes, MergeContributes, phantom brand
- `packages/kit/src/index.ts` — definePlugin overloads
- `packages/core/src/plugins/dependency.ts` — PluginNode, circular detection, resolveContributes
- `packages/core/src/plugins/loader.ts` — override(), boot V2
- `apps/playground/plugins.ts` — all plugin definitions
- `apps/playground/checks.ts` — edge case tests
- `apps/playground/index.ts` — runtime + chat run

## Important Context / Temporary Decisions
- `Contributes<T>` = `() => T | Promise<T>` — always function, no object form (ADR-005)
- `_contributes_type` phantom brand for type extraction (ADR-004)
- `PluginDependency` uses `PluginDefinition<any>` to preserve specific generic params

## Next Up
- `@jiku/db` (drizzle schema + query helpers)
- Adapter postgres
- API layer (HTTP server)
