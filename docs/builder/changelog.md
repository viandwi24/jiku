# Changelog

## 2026-04-04 — Stream Architecture, AbortController, Model Providers

- Tambah `createUIMessageStream` pattern dari AI SDK (inspired by SenkenNeo) ke `AgentRunner`
- `runtime.run()` sekarang return `JikuRunResult { run_id, conversation_id, stream }` — caller consume stream
- Tambah `AbortController` support via `JikuRunParams.abort_signal` → di-pass langsung ke `streamText()`
- Buat `ModelProviders` class di `packages/core/src/providers.ts` — multi-provider, lazy init
- Tambah `createProviderDef()` helper untuk wrap `@ai-sdk/*` providers
- `AgentDefinition` + `JikuRunParams` sekarang support `provider_id` + `model_id` override per-agent/run
- `JikuStreamWriter` + `ToolContext.writer` — tools bisa push custom typed data chunks ke stream
- Tambah `JikuDataTypes` (jiku-meta, jiku-usage, jiku-step-usage, jiku-tool-data) ke `@jiku/types`
- Tambah `isJikuDataChunk<K>()` type guard untuk narrowing stream chunks tanpa `any`
- `tsconfig.json` sekarang punya `include` eksplisit — tidak scan `../refs-senken-neo` lagi
- Files: `packages/types/src/index.ts`, `packages/core/src/types.ts`, `packages/core/src/runner.ts`, `packages/core/src/runtime.ts`, `packages/core/src/providers.ts`, `packages/core/src/index.ts`, `apps/playground/index.ts`, `tsconfig.json`


## 2026-04-04 — Foundation Implementation

- Implemented `@jiku/types` — all core interfaces: ToolDefinition, PluginDefinition, AgentDefinition, CallerContext, RuntimeContext, PolicyRule, JikuStorageAdapter, PluginLoaderInterface
- Implemented `@jiku/kit` — definePlugin, defineTool, defineAgent, getJikuContext factory functions
- Implemented `@jiku/core`:
  - `PluginLoader` — 3-phase boot with topological sort
  - `SharedRegistry` — tool/prompt/provider storage
  - `AgentRunner` — LLM loop with streamText, tool filtering by mode
  - `JikuRuntime` — container with updateRules() hot-swap
  - `resolveScope()` + `checkAccess()` — pure permission resolver
  - `buildSystemPrompt()` — mode-aware prompt builder
  - `MemoryStorageAdapter` — in-memory storage for testing
- Created `plugins/jiku.social` — built-in social media plugin with list_posts, create_post, delete_post tools
- Created `apps/playground` — step-by-step demo: admin vs member access, chat vs task mode, updateRules live
- Updated `docs/product_spec.md` and `docs/architecture.md`
- Added `@types/node`, `@ai-sdk/anthropic@3`, `ai@6`, `zod@4`, `hookable` dependencies
- Added `plugins/*` to workspace
- Files: `packages/types/src/index.ts`, `packages/kit/src/index.ts`, `packages/core/src/index.ts`, `packages/core/src/runtime.ts`, `packages/core/src/runner.ts`, `packages/core/src/resolver/scope.ts`, `packages/core/src/resolver/access.ts`, `packages/core/src/resolver/prompt.ts`, `packages/core/src/plugins/loader.ts`, `packages/core/src/plugins/registry.ts`, `packages/core/src/plugins/dependency.ts`, `packages/core/src/plugins/hooks.ts`, `packages/core/src/storage/memory.ts`, `plugins/jiku.social/src/index.ts`, `apps/playground/index.ts`

## 2026-04-04 — Bootstrap: Automated Docs Setup

- Created `CLAUDE.md` with full automated docs protocol
- Created `.claude/commands/docs-update.md` for `/docs-update` command
- Created stub files: `docs/product_spec.md`, `docs/architecture.md`
- Created builder docs: `current.md`, `tasks.md`, `changelog.md`, `decisions.md`, `memory.md`
- Created `docs/feats/` directory
- Files: `CLAUDE.md`, `.claude/commands/docs-update.md`, `docs/product_spec.md`, `docs/architecture.md`, `docs/builder/current.md`, `docs/builder/tasks.md`, `docs/builder/changelog.md`, `docs/builder/decisions.md`, `docs/builder/memory.md`
