## Phase
Foundation — Complete

## Currently Working On
(idle — foundation selesai)

## Relevant Files
- `packages/types/src/index.ts` — semua core types
- `packages/kit/src/index.ts` — factory functions SDK
- `packages/core/src/` — runtime, runner, resolver, loader, storage
- `plugins/jiku.social/src/index.ts` — contoh plugin
- `apps/playground/index.ts` — demo usage

## Important Context / Temporary Decisions
- AI SDK v6: gunakan `tool()` + `zodSchema()` + `stopWhen: stepCountIs(N)`
- `@ai-sdk/anthropic` harus v3+ untuk LanguageModelV3 compatibility
- `tsconfig.json` sudah ada `"types": ["node"]` untuk process.env

## Next Up
- Implementasi `@jiku/db` (drizzle schema + query helpers)
- Implementasi adapter postgres untuk storage
- Buat lebih banyak built-in plugins
- Tambah API layer (HTTP server)
