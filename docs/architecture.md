# Architecture — Jiku

## Overview

Jiku menggunakan arsitektur monorepo dengan pemisahan yang ketat antara types, SDK, runtime core, dan aplikasi. Core tidak punya IO langsung — semua storage dan external calls lewat adapter yang di-inject.

## Monorepo Structure

```
jiku/
├── packages/
│   ├── types/              @jiku/types   — shared types, zero deps
│   ├── kit/                @jiku/kit     — plugin SDK untuk plugin author
│   └── core/               @jiku/core    — agent runtime, resolver, plugin loader
│
├── apps/
│   └── playground/         @jiku/playground — testing & example
│
└── plugins/
    └── jiku.social/        @jiku/plugin-social — contoh built-in plugin
```

## Dependency Graph

```
@jiku/types          (zero deps)
    ↑
    ├── @jiku/kit    (deps: @jiku/types)
    └── @jiku/core   (deps: @jiku/types, @jiku/kit, ai, zod, hookable)
         ↑
    plugins/*        (deps: @jiku/kit)
         ↑
    apps/playground  (deps: semua packages + plugins + @ai-sdk/anthropic)
```

## Key Packages

| Package | Tanggung Jawab | Deps |
|---------|---------------|------|
| `@jiku/types` | Interface, type, enum. Zero logic. | — |
| `@jiku/kit` | `definePlugin`, `defineTool`, `defineAgent`. SDK untuk plugin author. | `@jiku/types` |
| `@jiku/core` | `JikuRuntime`, `AgentRunner`, `PluginLoader`, `resolveScope`. Zero DB. | `@jiku/types`, `@jiku/kit`, `ai`, `zod`, `hookable` |
| `@jiku/plugin-social` | Contoh built-in plugin: social media manager. | `@jiku/kit` |
| `@jiku/playground` | Wire semua, contoh step-by-step init dan run. | semua |

## Core Internals (`@jiku/core/src/`)

```
packages/core/src/
├── index.ts
├── runtime.ts          JikuRuntime — container utama
├── runner.ts           AgentRunner — satu per conversation run
├── resolver/
│   ├── scope.ts        resolveScope() — pure function
│   ├── access.ts       checkAccess() — pure function
│   └── prompt.ts       buildSystemPrompt()
├── plugins/
│   ├── loader.ts       PluginLoader — 3-phase boot
│   ├── registry.ts     SharedRegistry — tool + prompt + provider storage
│   ├── dependency.ts   topological sort (Kahn's algorithm)
│   └── hooks.ts        HookAPI wrapper (hookable)
└── storage/
    └── memory.ts       MemoryStorageAdapter — untuk testing
```

## Permission & Policy System

- Setiap tool mendefinisikan permission-nya sendiri (raw, tanpa prefix)
- PluginLoader otomatis prefix saat load: `post:write` → `jiku.social:post:write`
- Rules adalah data (`PolicyRule[]`), bukan code — bisa diubah runtime via `updateRules()`
- Default: tidak ada rules = allow semua
- Rules hanya untuk restrict/deny sesuatu yang otherwise diizinkan

## Tech Stack

- **Runtime:** Bun
- **Language:** TypeScript
- **LLM:** Vercel AI SDK v6 (`streamText`, `tool`, `zodSchema`)
- **Schema validation:** Zod v4
- **Plugin hooks:** hookable (UnJS)
- **AI Provider:** Anthropic (`@ai-sdk/anthropic` v3)
