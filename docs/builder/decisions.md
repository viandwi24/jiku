# Decisions

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
