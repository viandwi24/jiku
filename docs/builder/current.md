## Phase (2026-04-13) — Plan 21: Agent Adapter System — SHIPPED

### Plan 21 — SHIPPED (2026-04-13)
- [x] Types: `AgentModeConfig`, `AgentDefinition.mode_configs`, new `jiku-harness-iteration` data event (`packages/types/src/index.ts`).
- [x] Core: `AgentAdapter` / `AgentRunContext` / `AgentAdapterRegistryLike` (`packages/core/src/adapter.ts`).
- [x] Built-in adapters: `DefaultAgentAdapter` (migrates the prior `streamText` path) and `HarnessAgentAdapter` (explicit iterative loop using `sdkWriter.merge()` across iterations). Exported from `@jiku/core`.
- [x] Runner refactor: `AgentRunner` now dispatches to the resolved adapter via `adapter.execute(ctx, params)`; shared `persistAssistantMessage` helper captures the old stream-close logic + finalize hook. Runner accepts an optional `AgentAdapterRegistryLike` (falls back to a default-only registry).
- [x] Runtime plumbing: `JikuRuntime` accepts `adapter_registry` and forwards it to every `AgentRunner`.
- [x] Studio registry: `apps/studio/server/src/agent/adapter-registry.ts` (singleton) + `agent/index.ts` side-effect registration of built-ins; imported from `apps/studio/server/src/index.ts`.
- [x] Runtime manager: `manager.ts` injects `agentAdapterRegistry` into `JikuRuntime`, and every `defineAgent()` call (wakeUp / syncProjectTools / syncAgent) forwards `a.mode_configs`.
- [x] DB: migration `0017_agent_mode_configs.sql` (`ALTER TABLE agents ADD COLUMN mode_configs jsonb NOT NULL DEFAULT '{}'`). Drizzle schema updated.
- [x] API: `GET /api/agents/adapters` returns `{ adapters: [{ id, displayName, description, configSchema }] }`. `PATCH /api/agents/:aid` now accepts `mode_configs`.
- [x] Web: `AgentConfigForm` adds per-mode Adapter dropdown + dynamic config form rendered from `configSchema` (number / string / boolean). `lib/api.ts` exposes `api.agents.listAdapters()` and `AgentAdapterInfo` type.

### Relevant Files
- `packages/types/src/index.ts`
- `packages/core/src/adapter.ts`, `packages/core/src/adapters/default.ts`, `packages/core/src/adapters/harness.ts`
- `packages/core/src/runner.ts`, `packages/core/src/runtime.ts`, `packages/core/src/index.ts`
- `apps/studio/server/src/agent/adapter-registry.ts`, `apps/studio/server/src/agent/index.ts`
- `apps/studio/server/src/index.ts`, `apps/studio/server/src/runtime/manager.ts`, `apps/studio/server/src/routes/agents.ts`
- `apps/studio/db/src/migrations/0017_agent_mode_configs.sql`, `apps/studio/db/src/schema/agents.ts`
- `apps/studio/web/components/agent/agent-config-form.tsx`, `apps/studio/web/lib/api.ts`

### Important Context
- Heartbeat is unaffected — it still runs `task` mode; whichever adapter is configured for `task` is what it will use.
- `max_tool_calls` at the top of `AgentDefinition` remains the legacy fallback; when `mode_configs[mode].config.max_tool_calls` is set it wins (for the default adapter).
- Plugin-contributed adapters (`ctx.agent.registerAdapter()`) are intentionally deferred — the registry already accepts them, but no plugin API surface was added in this plan.

### Next Up
- Expose `ctx.agent.registerAdapter` through the Studio plugin context extender when the first plugin-authored adapter lands.
