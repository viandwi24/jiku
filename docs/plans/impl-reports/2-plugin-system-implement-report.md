# Plugin System V2 — Implementation Report

> Plan: `docs/plans/2-plugin-system.md`
> Status: **COMPLETE**
> Date: 2026-04-04

---

## Summary

Seluruh checklist dari plan telah diimplementasikan. Plugin system sekarang mendukung typed dependency injection via `contributes`, circular dependency detection, missing dependency handling, dan bridge/override pattern. Ada dua deviasi arsitektural dari plan yang diperlukan untuk membuat TypeScript type inference bekerja 100%.

---

## Checklist Status

### `@jiku/types`

| Item | Status | Notes |
|------|--------|-------|
| `MaybePromise<T>`, `ContributesValue` | ✅ partial | `MaybePromise<T>` tidak diperlukan — `Contributes<T>` langsung `() => T \| Promise<T>` |
| `Contributes<TValue>` — object \| sync fn \| async fn | ✅ deviasi | Hanya function form: `() => T \| Promise<T>` (lihat ADR-005) |
| `PluginDependency = string \| PluginDefinition<any>` | ✅ | Exact match |
| `PluginDefinition<TContributes>` generic | ✅ | Dengan phantom brand `_contributes_type` (lihat ADR-004) |
| `depends?` field (replace `dependencies`) | ✅ | `dependencies` di-deprecated, `depends` adalah field baru |
| `contributes?` field | ✅ | `Contributes<TContributes>` |
| `ExtractContributes`, `MergeContributes`, `UnionToIntersection` | ✅ | `ExtractContributes` via phantom brand, bukan `infer` dari generic param |

### `@jiku/kit`

| Item | Status | Notes |
|------|--------|-------|
| `definePlugin<Deps, TContributes>` — generic | ✅ | 2 overloads: with `depends` (typed ctx) + without (BasePluginContext) |
| setup ctx = `BasePluginContext & MergeContributes<Deps>` | ✅ | Di overload pertama |

### `@jiku/core` — `dependency.ts`

| Item | Status | Notes |
|------|--------|-------|
| `PluginNode` dengan `instanceDeps` | ✅ | Exact match |
| `PluginCircularDepError` — pesan dengan cycle path + fix hint | ✅ | Exact match |
| `detectCircular()` — DFS 3-color | ✅ | Exact match |
| `normalizeDeps()` — string \| instance | ✅ | Exact match |
| `getInstanceDeps()` — filter instance saja | ✅ | Exact match |
| `buildGraph()` → `Map<string, PluginNode>` | ✅ | Exact match, plus backward compat untuk `dependencies` field |
| `resolveContributes()` — object \| fn \| async fn | ✅ deviasi | Hanya function form — `await contributes()` |

### `@jiku/core` — `loader.ts`

| Item | Status | Notes |
|------|--------|-------|
| `_overrides: Map<string, Partial<PluginDefinition<any>>>` | ✅ | `overrides` (private) |
| `override()` method | ✅ | Exact match |
| `boot()` phase 2a — `detectCircular()` | ✅ | Throws `PluginCircularDepError` |
| `boot()` phase 2b — missing detection + warn | ✅ | Warn + `graph.delete(id)` |
| `boot()` phase 3 — resolve contributes → merge → setup | ✅ | `contributesCache` + `Object.assign(mergedFromDeps, ...)` |
| `buildSetupContext()` — merge contributes dari instanceDeps | ✅ | Inline di boot loop, bukan method terpisah |

### `apps/playground`

| Item | Status | Notes |
|------|--------|-------|
| Step 1 — contributes async | ✅ | `DatabasePlugin` in `plugins.ts` |
| Step 2 — depends instance (typed) | ✅ | `SocialPlugin` depends `DatabasePlugin` → `ctx.database` typed |
| Step 3 — depends string (sort only) | ✅ | `AnalyticsPlugin` depends `'jiku.social'` string |
| Step 4 — circular dep detection | ✅ | `PluginX/Y/Z` cycle in `checks.ts` |
| Step 5 — missing dep warning | ✅ | `OrphanPlugin` depends `'does.not.exist'` in `checks.ts` |
| Step 6 — override bridge pattern | ✅ | `MockServerPlugin` overridden in `index.ts` |
| Step 7 — full runtime flow | ✅ | Single chat run with all plugins in `index.ts` |

---

## Deviasi dari Plan

### ADR-004 — Phantom Brand Field (`_contributes_type`)

**Plan:** `ExtractContributes<T>` menggunakan `T extends PluginDefinition<infer C>` untuk extract `TContributes`.

**Implementasi:** `ExtractContributes<T>` menggunakan `T extends { readonly _contributes_type?: infer C }`.

**Alasan:** `PluginDefinition` interface punya `setup: (ctx: ...) => void` — function parameter ada di **contravariant position**. TypeScript tidak bisa `infer C` dari interface yang punya contravariant member karena `C` muncul di kedua posisi (covariant di `contributes`, contravariant di `setup`). Solusi: tambah phantom brand field `_contributes_type?: TContributes` yang murni covariant — `infer` bekerja sempurna dari sini. Field tidak pernah di-set di runtime.

**Konsekuensi:** `setup` di interface menjadi `(ctx: BasePluginContext) => void` — actual typed ctx di-enforce di `definePlugin()` overload, bukan di interface. Phantom field muncul di IntelliSense tapi tidak ada efek runtime.

### ADR-005 — Contributes Hanya Function

**Plan:** `Contributes<T> = T | (() => T) | (() => Promise<T>)` — 3 bentuk.

**Implementasi:** `Contributes<T> = () => T | Promise<T>` — hanya function.

**Alasan:** TypeScript tidak bisa infer generic type parameter dari 3-way union. Saat user tulis `contributes: async () => ({ database: ... })`, TypeScript gagal match ke branch `(() => Promise<T>)` dan fallback ke `ContributesValue` (base constraint). Dengan single function form, ada satu inference site (return type) yang TypeScript bisa resolve.

**Konsekuensi:** Plugin author harus wrap object dalam arrow function: `contributes: () => ({ server })`. Trade-off kecil — satu karakter lebih (`() =>`) — dibanding type inference yang 100% reliable.

### definePlugin — 2 Overloads

**Plan:** Satu signature generic `definePlugin<Deps, TContributes>`.

**Implementasi:** 2 overloads:
1. `depends: Deps` (required) → `setup(ctx: BasePluginContext & MergeContributes<Deps>)`
2. `depends?: never` → `setup(ctx: BasePluginContext)`

**Alasan:** Dengan satu signature, TypeScript selalu mencoba infer `Deps` bahkan ketika `depends` tidak ada. Ini menyebabkan `Deps = PluginDependency[]` yang menghasilkan `MergeContributes<PluginDependency[]>` = `unknown`. Dengan 2 overloads, plugin tanpa `depends` match overload kedua dan mendapat `BasePluginContext` yang bersih.

### Playground — Single Chat, Split Files

**Plan:** 7 step terpisah di satu file `index.ts`.

**Implementasi:** Split ke 3 file:
- `plugins.ts` — semua plugin definitions (DatabasePlugin, SocialPlugin, AnalyticsPlugin, MockServerPlugin, WebhookPlugin)
- `checks.ts` — edge case checks (circular dep, missing dep)
- `index.ts` — runtime setup + override bridge + single chat run

**Alasan:** User request: "cukup satu scenario aja yaitu normal chat" dan "kalau ada partial mending di split file". Semua fitur V2 tetap ter-cover di satu scenario:
- Boot menjalankan semua plugin (async contributes, typed depends, string depends)
- Override bridge diterapkan sebelum boot
- Checks dijalankan sebelum main flow
- Satu chat run yang menghit semua tools

---

## File Changes — Plan vs Actual

### Files yang Diubah

| File | Plan | Actual |
|------|------|--------|
| `packages/types/src/index.ts` | `Contributes`, `PluginDependency`, `PluginDefinition<T>`, `depends`, type utilities | ✅ + phantom brand `_contributes_type`, `BasePluginContext`, `PluginLoaderInterface` extended |
| `packages/kit/src/index.ts` | `definePlugin<Deps, TContributes>` generic | ✅ 2 overloads, implementation body |
| `packages/core/src/plugins/dependency.ts` | `PluginNode`, circular detection, normalize helpers, `resolveContributes` | ✅ full rewrite, `buildGraph`, `topoSort`, `detectMissing` semua ada |
| `packages/core/src/plugins/loader.ts` | `_overrides`, `override()`, boot V2 | ✅ + `isLoaded()`, `getLoadOrder()`, `register()` pakai `Map` |
| `packages/core/src/index.ts` | — | ✅ tambah export `PluginCircularDepError` |

### Files Tidak Berubah (sesuai plan)

| File | Status |
|------|--------|
| `packages/core/src/runtime.ts` | ✅ Tidak berubah |
| `packages/core/src/runner.ts` | ✅ Tidak berubah |
| `packages/core/src/resolver/*` | ✅ Tidak berubah |
| `packages/core/src/storage/memory.ts` | ✅ Tidak berubah |
| `packages/core/src/providers.ts` | ✅ Tidak berubah |

### Files Baru

| File | Plan | Actual |
|------|------|--------|
| `apps/playground/index.ts` | Replace dengan V2 demo (7 steps) | ✅ Replace — runtime + single chat |
| `apps/playground/plugins.ts` | Tidak ada di plan | ✅ Baru — semua plugin definitions |
| `apps/playground/checks.ts` | Tidak ada di plan | ✅ Baru — circular + missing dep checks |

### Files Update Minor

| File | Change |
|------|--------|
| `plugins/jiku.social/src/index.ts` | Version bump `2.0.0`, tambah `contributes: () => ({ social: ... })` |
| `apps/playground/package.json` | Tambah `zod` dependency |
| `CLAUDE.md` | Tambah "Bash Scope" rule |

---

## Type System Deep Dive

### Inference Flow

```
1. definePlugin({ contributes: async () => ({ database: { query } }) })
     ↓
   TContributes inferred from return type: { database: { query: ... } }
     ↓
   Return: PluginDefinition<{ database: { query: ... } }>
     ↓
   _contributes_type?: { database: { query: ... } }  ← phantom brand set

2. definePlugin({ depends: [DatabasePlugin], setup(ctx) { ... } })
     ↓
   Deps inferred as [PluginDefinition<{ database: ... }>]
     ↓
   MergeContributes<[PluginDefinition<{ database: ... }>]>
     ↓
   Extract<Deps[number], PluginDefinition<any>>
     = PluginDefinition<{ database: ... }>
     ↓
   ExtractContributes via _contributes_type
     = Exclude<{ database: ... } | undefined, undefined>
     = { database: ... }
     ↓
   UnionToIntersection<{ database: ... }> = { database: ... }
     ↓
   ctx: BasePluginContext & { database: { query: ... } }
     ↓
   ctx.database.query('posts')  ← ✅ fully typed
```

### Why `any` in PluginDependency

```
PluginDependency = string | PluginDefinition<any>
                                             ^^^
```

Kalau pakai `PluginDefinition<ContributesValue>`:
- `Deps = [PluginDefinition<ContributesValue>]` — TypeScript widen generic param ke constraint
- `_contributes_type?: ContributesValue` — brand kehilangan specific type
- `ctx.database` → `unknown`

Dengan `any`:
- TypeScript menjaga specific generic param di tuple element
- `_contributes_type?: { database: ... }` — brand tetap specific
- `ctx.database` → typed ✅

### Why `Exclude<C, undefined>` in ExtractContributes

```typescript
type ExtractContributes<T> = T extends { readonly _contributes_type?: infer C }
  ? Exclude<C, undefined>   // ← penting
  : never
```

`_contributes_type` adalah optional property (`?:`). TypeScript infer `C` sebagai `TContributes | undefined`. Tanpa `Exclude`:
- `UnionToIntersection<{ database } | undefined>` = `{ database } & undefined` = `never`
- `BasePluginContext & never` = `never` — ctx unusable

Dengan `Exclude`:
- `Exclude<{ database } | undefined, undefined>` = `{ database }`
- Works correctly

---

## Runtime Verification

```
$ bun run apps/playground

=== Plugin System V2 Checks ===

[ Check 1 ] Circular dependency detection
  ✓ Caught PluginCircularDepError
  Circular dependency detected: plugin.x → plugin.y → plugin.z → plugin.x

[ Check 2 ] Missing dependency warning
[jiku] ⚠ Plugin "jiku.orphan" disabled
  Reason: missing dependencies: does.not.exist
  ✓ Orphan disabled, load order: [empty]

=== Runtime Setup ===

[jiku] ✓ mock.database loaded — 0 tool(s) registered
[jiku] ✓ @jiku/plugin-server loaded — 0 tool(s) registered
[jiku] ✓ jiku.social loaded — 3 tool(s) registered
[jiku] ✓ jiku.webhook loaded — 1 tool(s) registered
[jiku] ✓ jiku.analytics loaded — 0 tool(s) registered
Load order: [ "mock.database", "@jiku/plugin-server", "jiku.social",
              "jiku.webhook", "jiku.analytics" ]
Registered routes: [ { method: "GET", path: "/webhook" } ]
Tools: [ "jiku.social:list_posts", "jiku.social:create_post",
         "jiku.social:delete_post", "jiku.webhook:trigger_webhook" ]

=== Chat Run ===

> List all posts

Here are the most recent posts:
1. **Twitter** — Hello world! (post-1)
2. **Instagram** — Check out our product! (post-2)

[usage] in=234 out=76
[run_id=... conv=...]
[done]
```

**Verified:**
- Circular dep → caught ✓
- Missing dep → warned + disabled ✓
- Load order → topological sort correct ✓
- Override bridge → `/webhook` route recorded ✓
- Tools → 4 from 2 plugins ✓
- Chat → LLM calls `list_posts` tool ✓
- TypeScript → zero errors (`bun tsc --noEmit`) ✓

---

## Architectural Decisions

| ADR | Title | Summary |
|-----|-------|---------|
| ADR-004 | Phantom brand field | `_contributes_type` untuk type extraction dari covariant position |
| ADR-005 | Contributes hanya function | `() => T \| Promise<T>` — single inference site |

---

## File Inventory

```
packages/types/src/index.ts              ~400 lines  — Core types + plugin generics
packages/kit/src/index.ts                 ~80 lines  — definePlugin overloads + helpers
packages/core/src/plugins/dependency.ts  ~175 lines  — Graph, circular detect, topo sort
packages/core/src/plugins/loader.ts      ~170 lines  — PluginLoader V2
packages/core/src/index.ts               ~10 lines  — Barrel exports
plugins/jiku.social/src/index.ts          ~70 lines  — Social plugin (V2 API)
apps/playground/plugins.ts               ~160 lines  — All playground plugin defs
apps/playground/checks.ts                 ~50 lines  — Edge case checks
apps/playground/index.ts                 ~130 lines  — Runtime + chat run
```
