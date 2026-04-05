# Memory

## Radix ScrollArea breaks text-overflow ellipsis

`@radix-ui/react-scroll-area` injects `min-width: 100%; display: table` on the inner viewport div. This causes flex children to stretch to content width, preventing `text-overflow: ellipsis` from working no matter how many Tailwind truncation classes are applied. Use a plain `<div className="overflow-y-auto h-full">` instead whenever truncated text lives inside the scroll container.

## SSE observer pattern: stream.tee() + StreamRegistry

`apps/studio/server/src/runtime/stream-registry.ts` manages active chat runs. When `POST /conversations/:id/chat` starts a run, it tees the stream and registers one branch for SSE observers. `GET /conversations/:id/stream` is the SSE endpoint — each new observer tees the registered branch again. `GET /conversations/:id/status` returns `{ running: boolean }` for polling clients. Cleanup happens on stream end and on observer disconnect. Concurrent runs to the same conversation return 409.

## EventSource auth via query param

Browser `EventSource` does not support custom headers. For the SSE observer endpoint (`GET /conversations/:id/stream`), the JWT is passed as `?token=<jwt>` in the URL. The server reads it with `c.req.query('token')`. Only use this pattern for SSE — all other endpoints use the `Authorization: Bearer` header.

## SidebarFooter convention: always show user info dropdown

Both `company-sidebar.tsx` and `project-sidebar.tsx` (and the root sidebar) render user info in `SidebarFooter` using the same dropdown pattern. Settings link lives in the same menu group as the primary nav items — no separator between Settings and the other nav entries.

## AI SDK v6 Tool API

Vercel AI SDK v6 menggunakan `inputSchema` (bukan `parameters` seperti v3/v4) dan helper `zodSchema()` dari `ai`:
```ts
import { tool, zodSchema } from 'ai'
tool({ inputSchema: zodSchema(myZodSchema), execute: async (args) => ... })
```

## AI SDK v6 StepCount

`maxSteps` sudah tidak ada di v6. Gunakan `stopWhen: stepCountIs(N)` dari import `ai`.

## @ai-sdk/anthropic versi

Gunakan `@ai-sdk/anthropic@^3` — versi 1.x masih pakai `LanguageModelV1` yang tidak kompatibel dengan `ai@6` yang butuh `LanguageModelV2/V3`.

## process.env tidak dikenal oleh tsc

Untuk mengakses `process.env` dan globals Node/Bun, tambahkan `"types": ["node"]` di `tsconfig.json`. Jangan gunakan `bun-types` — tidak ada di devDependencies workspace root.

## PluginLoader harus setStorage() sebelum boot()

`PluginLoader.boot()` membutuhkan storage untuk membuat `PluginStorageAPI` per plugin. `JikuRuntime.boot()` otomatis call `setStorage()` sebelum `boot()`.

## Tool permission dengan wildcard

Tool dengan `permission: '*'` di-skip dari access check — langsung allow tanpa butuh rule atau permission di caller.

## Plugin tool naming convention

Tool ID di plugin adalah raw (contoh: `create_post`). Setelah di-load PluginLoader jadi `resolved_id: 'jiku.social:create_post'`. Semua rules menggunakan resolved ID.

## Stream architecture — createUIMessageStream

Runner pakai `createUIMessageStream<JikuUIMessage>` dari AI SDK + `writer.merge(result.toUIMessageStream(...))`. Jangan buat custom ReadableStream sendiri — pakai pattern ini agar kompatibel dengan AI SDK ecosystem (pipe ke Response, SSE, dll).

## JikuStreamChunk data narrowing

`JikuStreamChunk` adalah `InferUIMessageChunk<JikuUIMessage>`. Data chunk bertipe `{ type: 'data-jiku-usage', data: unknown }` — `data` tidak otomatis ter-narrow dari `type`. Gunakan type guard `isJikuDataChunk(chunk, 'jiku-usage')` dari `@jiku/types` untuk narrowing yang type-safe.

## Plugin contributes harus function

`Contributes<T>` = `() => T | Promise<T>`. Selalu function, sync atau async. Object form dihilangkan karena TypeScript tidak bisa infer `TContributes` dari union type 3-cabang. Arrow function wrapping: `contributes: () => ({ server: ... })`.

## Plugin type inference via phantom brand

`PluginDefinition` punya `readonly _contributes_type?: TContributes` — phantom field di covariant position. `MergeContributes` extract types dari field ini, bukan dari `setup` parameter (yang contravariant). Jangan hapus field ini.

## PluginDependency pakai `any`

`PluginDependency = string | PluginDefinition<any>` — harus `any`, bukan `ContributesValue`. Kalau pakai `ContributesValue`, TypeScript widen setiap element di `depends[]` ke `PluginDefinition<ContributesValue>` sehingga specific type hilang.

## definePlugin overloads

`definePlugin` punya 2 overloads:
1. Dengan `depends: Deps` (required) → `setup(ctx: BasePluginContext & MergeContributes<Deps>)`
2. Tanpa `depends` (`depends?: never`) → `setup(ctx: BasePluginContext)`

Overload pertama harus punya `depends` sebagai required field agar TypeScript pilih overload ini saat ada `depends` array.

## @jiku/types boleh deps ke `ai`

`@jiku/types` diizinkan depend ke `ai` karena dibutuhkan untuk `UIMessage`, `InferUIMessageChunk`, dll. Bukan zero-deps lagi sejak stream types diperkenalkan.

## JikuRunResult.stream adalah ReadableStream<JikuStreamChunk>

`runtime.run()` return `stream: ReadableStream<JikuStreamChunk>`. Consume dengan `.getReader()` atau pipe ke `createUIMessageStreamResponse()` untuk HTTP response.

## @jiku/ui import path conventions

Components di `packages/ui/src/components/ui/` gunakan:
- `../../lib/utils` untuk `cn()`
- `./other-ui-component` untuk sibling di ui/

Components di `packages/ui/src/components/ai-elements/` gunakan:
- `../../lib/utils` untuk `cn()`
- `../ui/component-name` untuk ui primitives
- `./sibling` untuk sibling ai-elements

Jangan pakai alias `@/` di dalam packages/ui — tidak ada Next.js tsconfig path alias di sini.

## apps/studio/web masih punya salinan lokal ui/ dan ai-elements/

Setelah migration ke @jiku/ui, `apps/studio/web/components/ui/` dan `ai-elements/` masih ada. Import di web belum diupdate. Task terpisah diperlukan untuk switch import ke `@jiku/ui` dan hapus lokal copies.

## @ai-sdk/react v3 useChat API (AI SDK v6 companion)

- Import: `import { useChat } from '@ai-sdk/react'` (bukan `ai/react`)
- Transport: `new DefaultChatTransport({ api, headers, prepareSendMessagesRequest })` dari `import { DefaultChatTransport } from 'ai'`
- `sendMessage({ text })` untuk kirim pesan (bukan `append`)
- `status`: `'ready' | 'submitted' | 'streaming' | 'error'`
- `message.parts[]` array (bukan `message.content` string) — render iterating parts
- `error` field ada saat request gagal — tampilkan ke user

## Dynamic provider pattern (studio)

Satu `__studio__` provider di-register saat `wakeUp()`. `getModel(cacheKey)` reads dari `modelCache: Map<string, LanguageModel>`. Sebelum `runtime.run()`, cache diisi; setelah stream habis/cancel, cache dihapus. Key format: `agentId:timestamp:random` untuk menghindari collision concurrent requests.

## Message storage: parts[] di DB (bukan content[])

Messages disimpan dengan kolom `parts: MessagePart[]` (jsonb array) — aligned dengan AI SDK v6 `UIMessage.parts`. Kolom ini di-rename dari `content` → requires `bun run db:push` saat pertama kali migrate.

`toJikuMessage()` di `StudioStorageAdapter` membaca `row.parts` dan return `Message` dengan `parts` field.

## AI SDK v6 useChat: option `messages` bukan `initialMessages`

`useChat({ messages: initialMessages, ... })` — option name di AI SDK v6 adalah `messages` (bukan `initialMessages` seperti di versi lama). Kalau salah nama option, history tidak load dan tidak ada error — silent bug.

## TanStack Query + historyData guard pattern

`historyData` bisa `undefined` saat `historyLoading === false` (initial state sebelum query pertama jalan). Guard yang benar:
```ts
if (convLoading || historyLoading || !historyData) return <Loading />
```
Tanpa `|| !historyData`, `ChatView` akan mount dengan `undefined` data.

## @openrouter/ai-sdk-provider (bukan @ai-sdk/openrouter)

Package npm yang benar adalah `@openrouter/ai-sdk-provider`, bukan `@ai-sdk/openrouter`. Yang terakhir tidak ada di npm.

## drizzle-orm import hanya dari @jiku-studio/db

`@jiku-studio/server` tidak punya `drizzle-orm` sebagai dependency. Semua query DB harus diimplementasi di `@jiku-studio/db` dan di-export dari `index.ts`. Server hanya import fungsi-fungsi query, tidak pernah import `drizzle-orm` atau schema langsung.

## Memory system: getMemories agent_id is optional

`getMemories()` in `@jiku-studio/db` has `agent_id` as optional. When loading `runtime_global` scope, the runner does NOT pass `agent_id` — those memories are project-wide, not agent-scoped. Always omit `agent_id` when querying `runtime_global`. Pass it when querying `agent_global` or `agent_caller`.

## Memory config location: /memory page, not /settings

Project memory config is on the `/memory` page via a "Config" tab (alongside the "Memories" browser tab). It is NOT in project settings. The settings layout only has: General, Credentials, Permissions.

## Memory in context preview

`previewRun()` in `packages/core/src/runner.ts` loads memories (read-only, no `touchMemories`) and injects a `memory` context segment. In the UI, the memory segment renders in teal. The `ContextSegment.source` union includes `'memory'` — update both `packages/types/src/index.ts` and `apps/studio/web/lib/api.ts` if adding new segment sources.

## Memory tools are built_in_tools, not plugin tools

Memory tools are injected via `built_in_tools` on `AgentDefinition` in `RuntimeManager.wakeUp()` / `syncAgent()`. They do NOT go through the plugin system. The `AgentRunner` merges `agent.built_in_tools` with plugin-resolved tools before building the AI SDK tool map.

## resolveMemoryConfig: always call before running

`resolveMemoryConfig(projectConfig, agentConfig)` from `@jiku/core` must be called in `wakeUp()` and `syncAgent()` to produce the `ResolvedMemoryConfig` passed to `runtime.addAgent()`. The agent config is partial — field-by-field merge, project defaults fill missing keys.

## zod is a direct dep of @jiku-studio/server

Added `zod@^4.3.6` to `apps/studio/server/package.json` — required by `memory/tools.ts` for tool input schemas. Server does not re-use core's zod; it needs its own declaration.

## Persona scope (agent_self) never enters memory queries

`agent_self` memories are always queried with explicit `scope: 'agent_self'`. Regular memory queries (`buildMemoryContext`, `findRelevantMemories`) never include `agent_self` — they only query `agent_caller`, `agent_global`, `runtime_global`. Persona and memory are injected into separate system prompt sections and can never collide.

## Tool group metadata — declare in ToolMeta

Each `defineTool()` call can include `meta.group?: string`. This is the canonical grouping for UI display. Convention: `'memory'` for memory CRUD tools, `'persona'` for persona tools, plugin tools use their plugin domain (e.g. `'social'`). If unset, UI falls back to ID-prefix parsing.

## previewRun() must mirror run() for built_in_tools

`AgentRunner.previewRun()` must merge `built_in_tools` the same way `run()` does, otherwise the active tools count will be 0. Pattern:
```ts
const builtInResolved = (this.agent.built_in_tools ?? []).map(t => ({
  ...t, plugin_id: '__builtin__', resolved_id: `__builtin__:${t.meta.id}`,
  tool_name: `builtin_${t.meta.id}`, resolved_permission: '*',
}))
const modeTools = [
  ...scope.active_tools.filter(t => t.modes.includes(mode)),
  ...builtInResolved.filter(t => t.modes.includes(mode)),
]
```

## shortToolId convention in UI

In `context-preview-sheet.tsx`, the displayed tool ID strips the `__builtin__:` prefix to save space: `memory_search` instead of `__builtin__:memory_search`. The full ID is still used internally for grouping logic.

## Wrap stream untuk cleanup after full consume

`modelCache.delete(cacheKey)` tidak bisa dilakukan di `finally` setelah `runtime.run()` karena stream di-consume setelah method return. Bungkus stream dalam custom `ReadableStream` yang delete cache key di: `done === true` (drain selesai) dan `cancel()` (client disconnect).
