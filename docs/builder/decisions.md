# Decisions

## ADR-010 — Message storage format: parts[] instead of content[]

**Context:** Messages were initially stored in DB as `content: MessageContent[]` (custom jiku type). AI SDK v6 uses `UIMessage.parts[]` as the canonical message format. Frontend tried `.map()` on the stored `content` field causing runtime error `m.content.map is not a function`.

**Decision:** Rename DB column `messages.content` → `messages.parts`. Update `MessagePart` type to align with AI SDK UIMessage parts shape. All layers (DB, server storage adapter, core runner, web API types) now use `parts` consistently.

**Consequences:** Breaking DB migration (requires `db:push`). All server-side code that read/wrote `content` had to be updated. Frontend no longer needs to remap — `m.parts` maps directly to `UIMessage['parts']`. `MessageContent` kept as deprecated alias in `@jiku/types` for potential backward compatibility.

## ADR-009 — Plugin KV store persisted in DB, not in-memory

**Context:** `StudioStorageAdapter.pluginGet/Set/Delete/Keys` was implemented with a `Map<string, unknown>` in-memory. Any server restart or runtime sleep would wipe plugin state.

**Decision:** Add `plugin_kv` table (`project_id`, `scope`, `key`, `value` text JSON-serialized, unique on composite) and route all plugin KV calls through DB queries.

**Consequences:** Plugin state survives server restarts. Slightly higher latency per KV call (DB round-trip vs in-memory). Upsert via `onConflictDoUpdate` avoids manual check-then-insert.

## ADR-008 — project = runtime (studio terminology follows @jiku/core)

**Context:** `@jiku/core` uses "runtime" as the top-level unit. Studio originally named the equivalent unit "project". Having two names for the same concept caused confusion when wiring the system together.

**Decision:** Studio terminology adopts `@jiku/core` terminology: one `JikuRuntime` per project. "Project" remains the user-facing name (URL slugs, UI labels), but internally the runtime is referred to as "the project's runtime". Comments and variable names reflect this alignment.

**Consequences:** Clearer code. `JikuRuntimeManager` maps `projectId → JikuRuntime` — the mapping is explicit and consistent.

## ADR-007 — Dynamic provider pattern for per-request credential resolution

**Context:** `JikuRuntime` initializes providers at boot time and does not support swapping a provider's model factory post-boot. Storing decrypted API keys in long-lived memory is a security risk.

**Decision:** Register a single sentinel provider (`__studio__`) at boot whose `getModel()` reads from a per-request `modelCache: Map<string, LanguageModel>`. Before each `runtime.run()`, `resolveAgentModel()` + `buildProvider()` are called; the result is cached under a unique key (`agentId:timestamp:random`). The stream is wrapped in a custom `ReadableStream` that deletes the cache key only after the stream is fully consumed or cancelled.

**Consequences:** Decrypted API keys exist in memory only for the duration of a single request. Concurrent requests don't collide (unique cache key). Minor overhead per request for credential lookup and provider construction.

## ADR-006 — shadcn + ai-elements live in @jiku/ui, not in app

**Context:** `apps/studio/web/components/ui/` and `apps/studio/web/components/ai-elements/` held 103 component files. These are general-purpose and should be reusable across any app in the monorepo.

**Decision:** Copy all files into `packages/ui/src/components/ui/` and `packages/ui/src/components/ai-elements/`. Fix all `@/` Next.js alias imports to relative paths. Export everything from `packages/ui/src/index.ts`. The web app's local copies remain untouched until a separate import-update pass.

**Consequences:** `@jiku/ui` is now the canonical source for all UI components. The web app temporarily has duplicate files — the import-update pass (separate task) will remove the local copies and switch to `@jiku/ui` imports.

## ADR-004 — Phantom brand field untuk PluginDefinition type extraction

**Context:** `MergeContributes<Deps>` perlu extract `TContributes` dari `PluginDefinition<T>`. Tapi `setup: (ctx: Base & T) => void` ada di contravariant position — TypeScript tidak bisa `infer C` dari interface yang punya function parameter contravariant.

**Decision:** Tambah phantom brand field `readonly _contributes_type?: TContributes` di interface — covariant position. `ExtractContributes` infer dari brand ini. `setup` type di interface jadi `(ctx: BasePluginContext) => void` — actual typed ctx di-enforce di `definePlugin()` call signature, bukan di interface.

**Consequences:** Phantom field muncul di IntelliSense tapi tidak pernah di-set runtime. `PluginDefinition<Specific>` sekarang assignable ke `PluginDefinition<ContributesValue>` tanpa contravariance issue.

## ADR-005 — Contributes harus function, bukan union

**Context:** `Contributes<T>` awalnya `T | (() => T) | (() => Promise<T>)` — 3-way union. TypeScript tidak bisa infer `TContributes` dari union type — saat user tulis `contributes: async () => ({db})`, TS gagal match ke branch mana.

**Decision:** `Contributes<T>` = `() => T | Promise<T>`. Always a function — single inference site via return type. Object form dihilangkan.

**Consequences:** Plugin author harus wrap object dalam arrow function: `contributes: () => ({ server })`. Tradeoff kecil dibanding type inference yang 100% reliable.

## ADR-001 — PluginLoaderInterface di @jiku/types

**Context:** `AgentRunner` di `@jiku/core` perlu tahu tentang `PluginLoader` untuk memanggil `getResolvedTools()` dan `resolveProviders()`. Tapi `PluginLoader` ada di `@jiku/core` sendiri — kalau import langsung akan circular.

**Decision:** Definisikan `PluginLoaderInterface` di `@jiku/types` dengan method-method yang dibutuhkan runner. `PluginLoader` concrete class mengimplementasi interface ini. `JikuRuntime` menerima `PluginLoader` concrete, tapi meneruskannya ke `AgentRunner` sebagai concrete type via dynamic import type.

**Consequences:** Sedikit lebih verbose, tapi tidak ada circular dependency. `@jiku/types` tetap zero-runtime-deps.

## ADR-002 — Tool permission wildcard bypass access check

**Context:** Tool dengan `permission: '*'` seharusnya accessible oleh siapapun tanpa perlu rule eksplisit.

**Decision:** Di `resolveScope()`, tool dengan `resolved_permission === '*'` langsung dimasukkan ke `active_tools` tanpa memanggil `checkAccess()`.

**Consequences:** Semantik jelas: `*` berarti "tidak ada restriction sama sekali". Tool tetap bisa di-deny lewat rule eksplisit di `resource_id` level.

## ADR-003 — Vercel AI SDK v6 sebagai LLM layer

**Context:** Butuh LLM loop yang mendukung multi-provider (Anthropic, OpenAI, dll) dan tool calling.

**Decision:** Gunakan Vercel AI SDK v6 (`ai@6`). Semua LLM interaction lewat `streamText()` + `tool()` dari SDK ini.

**Consequences:** API v6 berbeda dari v3/v4 — `inputSchema` bukan `parameters`, `stopWhen` bukan `maxSteps`. Provider SDK (`@ai-sdk/anthropic`) harus versi 3+ untuk kompatibilitas dengan `LanguageModelV3`.
