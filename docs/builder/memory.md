# Memory

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

## Wrap stream untuk cleanup after full consume

`modelCache.delete(cacheKey)` tidak bisa dilakukan di `finally` setelah `runtime.run()` karena stream di-consume setelah method return. Bungkus stream dalam custom `ReadableStream` yang delete cache key di: `done === true` (drain selesai) dan `cancel()` (client disconnect).
