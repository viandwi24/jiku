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

## @jiku/types boleh deps ke `ai`

`@jiku/types` diizinkan depend ke `ai` karena dibutuhkan untuk `UIMessage`, `InferUIMessageChunk`, dll. Bukan zero-deps lagi sejak stream types diperkenalkan.

## JikuRunResult.stream adalah ReadableStream<JikuStreamChunk>

`runtime.run()` return `stream: ReadableStream<JikuStreamChunk>`. Consume dengan `.getReader()` atau pipe ke `createUIMessageStreamResponse()` untuk HTTP response.
