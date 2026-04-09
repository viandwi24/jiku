# Memory

## Credential inheritance: always use getAvailableCredentials, not getProjectCredentials

`getProjectCredentials(projectId)` returns only project-scoped credentials. When you need to resolve credentials that may live at company level (e.g. a shared OpenAI key defined once for all projects), always use `getAvailableCredentials(companyId, projectId)` — it returns a union. You need to look up `companyId` from the project first (`getProjectById`).

Frontend: `api.credentials.available(projectId)` hits `/api/projects/:pid/credentials/available` which already calls `getAvailableCredentials` internally.

This gotcha affects any feature that resolves credentials at runtime — e.g. embedding, LLM provider selection.

## Semantic memory embedding config

Embedding config lives in `projects.memory_config.embedding` (JSONB). Fields: `enabled`, `provider`, `model`, `credential_id`, `dimensions`. The `embedding.ts` service reads this at runtime and caches per-project for 5 minutes. Clear cache with `clearEmbeddingCache(projectId)` — called automatically on `PATCH /memory-config`.

If `embedding.enabled = false` (default), `createEmbeddingService()` returns `null` and semantic search is silently skipped. Enable via Memory → Config → Semantic Search tab.

## LLM extraction removed (Plan 15 decision)

`extractMemoriesPostRun()` and `extractPersonaPostRun()` were removed from the run lifecycle. Reason: caused duplicate memories when tool-saved memories hadn't yet committed before extraction read stale data. The agent's built-in memory tools (`memory_core_append`, `memory_extended_insert`, etc.) are sufficient — explicit tool calls are more controllable than auto-extraction. The `extraction` block in `ResolvedMemoryConfig` still exists in types but is no longer used.

## Connector tools: always call connector_list first

Connector tools (`connector_send`, `connector_list_actions`, `connector_run_action`) require a valid `connector_id` (UUID). **Never hardcode display_name into agent prompts.** Instead:

1. Agent calls `connector_list()` (no params needed) → returns all connectors with IDs
2. Agent finds the connector by `display_name` or `plugin_id`
3. Agent uses the returned UUID in subsequent connector tool calls

Example flow:
```
builtin_connector_list
→ { connectors: [{ id: "uuid-123", display_name: "Telegram Jiku Agent", plugin_id: "jiku.telegram", status: "active" }] }
→ Use id: "uuid-123" in connector_send({ connector_id: "uuid-123", ... })
```

This pattern works because `connector_list` is stateless and returns fresh data each time.

## Cron Task System conventions

**Conversation type & trigger tracking:**
- Cron task conversations have `type: 'task'` (not a separate 'cron' type — only 3 types exist: chat, task, heartbeat)
- Trigger source tracked via `metadata.trigger: 'cron'` and `metadata.cron_task_id`
- `mode: 'task'` is passed to runtime; agent gets access to task-only tools (run_task, progress_report, etc.)

## Cron Task System conventions

**Cron expression library split:**
- Server (scheduling): `croner@10.0.1` — parses and schedules CRON syntax, no UI needed
- Frontend (display): `cronstrue@3.14.0` — converts expressions to English phrases (e.g. "Every Monday at 9 AM")

**CronExpressionInput component:** Provides real-time validation with visual feedback (green checkmark for valid, red error for invalid). Located at `apps/studio/web/components/cron/cron-expression-input.tsx`. Reusable for any form that needs cron input.

**Cron task permissions:** Caller context (`caller_id`, `caller_role`, `caller_is_superadmin`) is snapshotted at task creation time and stored in the DB. Permission checks during scheduled execution use the snapshot, not current user state. This ensures predictable permissions regardless of later role changes.

**Cron task enablement:** `agents.cron_task_enabled` column (default true) allows disabling cron execution per agent without deleting the tasks. When false, cron tools are not injected into the agent's runtime.

**Cron conversation metadata:** Conversations triggered by a cron task have:
- `metadata.cron_task_id: string` — the task that triggered it
- `metadata.trigger: 'cron_task'` — indicates the trigger source
- `type: 'cron'` — conversation type classification

**Scheduler integration:** `CronTaskScheduler` is instantiated once per project in `RuntimeManager.wakeUp()`. `loadAndScheduleProject()` is called at boot to register all enabled tasks. `scheduleAgent()` is called during `syncAgent()` to update individual agent task schedules. All tasks are unscheduled during `stopAll()`.

## ChartContainer (shadcn) conflicts with explicit height — use ResponsiveContainer directly

`ChartContainer` from `@jiku/ui` wraps Recharts' `ResponsiveContainer` and adds `aspect-video` to the container class. This conflicts with any explicit CSS height class (`h-45`, `h-[180px]`, etc.) — the `aspect-video` ratio wins and the chart renders blank. When you need a fixed pixel height for a Recharts chart, bypass `ChartContainer` and use `<ResponsiveContainer width="100%" height={180}>` directly. Style tooltips manually via `contentStyle={{ background: 'hsl(var(--popover))', ... }}`.

## Theme toggle: next-themes is already configured

`ThemeProvider attribute="class"` is set up in `apps/studio/web/components/providers.tsx` with `defaultTheme="system" enableSystem`. To add theme toggle anywhere: import `useTheme` from `next-themes`, call `setTheme('dark' | 'light')`. No additional provider setup needed.

## Sidebar footer convention: user dropdown + ThemeToggle side by side

All three sidebars (root, company, project) use the same footer pattern: a `flex items-center gap-1` wrapper containing the `DropdownMenu`-wrapped `SidebarMenuButton` (with `flex-1`) and a `ThemeToggle` button to its right. When adding new footer actions, follow this pattern.

## Conversation title generation is fire-and-forget

`generateTitle()` in `apps/studio/server/src/title/generate.ts` is called asynchronously after the first message in a conversation is stored. It does NOT block the HTTP response. The title may not appear immediately in the UI — a brief poll/refresh may be needed. This is intentional to keep the chat UX responsive.

## AlertDialog import from @jiku/ui

The `AlertDialog` component is imported directly from `@jiku/ui/components/ui/alert-dialog.tsx`, not re-exported from the `@jiku/ui` index. This is temporary until the index is updated.

## Conversation soft delete: deleted_at column

Conversations are soft-deleted via `deleted_at IS NOT NULL`. `getConversationsByProject()` query automatically filters `WHERE deleted_at IS NULL`, so deleted conversations never appear in the UI. Hard delete is not used to preserve conversation history for audit purposes.

## Sidebar conversation list now shows title + agent name

The sidebar was updated to show `<title> · <agent_name>` instead of showing the last message preview. This makes conversations easier to find by their title. Agent name is secondary context (smaller, gray text).

## ACL: project_memberships vs company_members

Two separate membership systems:
- `company_members` (existing) — user in a company, has a company-level `role_id` (old roles table with `role_permissions`)
- `project_memberships` (Plan 12) — user in a project, has `is_superadmin` + `role_id` (project_roles table with `permissions text[]`)

Never confuse them. `resolveProjectPermissions()` reads from `project_memberships + project_roles`. `getMember()` reads from `company_members`.

## ACL: requirePermission middleware caches in res.locals

`requirePermission()` and `requireSuperadmin()` store resolved permissions in `res.locals['resolved_permissions']`. If multiple middleware run on the same request, DB is only hit once. The `project_id` is read from `req.params['pid']` (cast to string).

## ACL: PERMISSIONS const location

`PERMISSIONS`, `Permission`, `ROLE_PRESETS`, `ResolvedPermissions`, `ProjectGrant` are all in `packages/types/src/index.ts`. Import from `@jiku/types`.

## ACL: invitation accept creates project_memberships from project_grants

`project_grants` in `invitations` is `[{ project_id, role_id }]`. On accept: create `company_member` (if not exists) + create `project_membership` per grant. Superadmin on created membership is always `false` — must be granted separately.

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

## Filesystem route is /disk not /files

The virtual disk file manager page lives at `/disk` (not `/files`). The settings page is at `/settings/filesystem`. The DB config table is `project_filesystem_config`. "Files" was avoided because `/agents/[agent]/files` already exists for a different purpose.

## S3 adapter: forcePathStyle required for RustFS/MinIO

`S3FilesystemAdapter` sets `forcePathStyle: true` on the S3Client. This is required for MinIO-compatible servers (RustFS) — they don't support virtual-hosted-style bucket URLs. Without this, requests fail with 404/403.

## Filesystem content cache threshold: 50 KB

Files ≤ 50,000 bytes store content in `project_files.content_cache`. This avoids S3 round-trips for small text files. `fs_read` returns `content_cache` if set, otherwise downloads from S3. Always sync cache on write.

## Attachments vs project_files: different concepts

- `project_attachments` — ephemeral chat images uploaded alongside messages. Accessible via `/api/attachments/:id`. Agents see them as image parts in message history.
- `project_files` — persistent virtual disk. Accessible via `fs_*` tools and the /disk UI. Text files only (≤5MB, allowed extensions only).

Do not confuse these or use one for the other's purpose.

## ImageGallery component: click outside closes

`ImageGallery` (`apps/studio/web/components/ui/image-gallery.tsx`) is a fullscreen overlay. Click the backdrop (not the image itself) closes it. Arrow keys navigate. Minimap strip at bottom shows thumbnails for multi-image messages. `open/onClose` props control visibility.

## DB tool part format vs UI format

DB stores tool calls as `{ type: 'tool-invocation', toolInvocationId, toolName, args, state: 'result', result }`. AI SDK v6 expects `{ type: 'dynamic-tool', toolCallId, state: 'output-available', input, output }`. Always convert via `dbPartsToUIParts()` in `apps/studio/web/lib/messages.ts` when loading messages for display.

## task_allowed_agents: null vs [] vs [id…]

`agents.task_allowed_agents` column controls delegation in `run_task`:
- `null` (default) = unrestricted, can delegate to any agent
- `[]` = delegation fully disabled
- `[id1, id2]` = only the listed agent IDs are allowed as targets

Check is enforced server-side in `checkTaskDelegationPermission()` in `apps/studio/server/src/task/tools.ts`. Self-delegation (same agent ID) always bypasses the check.

## Heartbeat requires task mode

`heartbeatScheduler.scheduleAgent()` silently returns if `task` is not in `agent.allowed_modes`. `triggerHeartbeat()` throws if task mode absent. This prevents heartbeat runs from spawning conversations in agents that have task mode disabled. Always check `allowed_modes` before scheduling.

## serializeToolSchema: Zod → JSON Schema for preview

`previewRun()` in `packages/core/src/runner.ts` uses `serializeToolSchema(t.input)` to convert each tool's Zod input schema to a plain JSON Schema object before serializing to the API response. This is needed because Zod objects are not JSON-serializable. Uses `zodToJsonSchema` from `zod-to-json-schema` (already a dep of `@jiku/core`).

## Agent memory config: useEffect not initialized flag

`apps/studio/web/app/.../agents/[agent]/memory/page.tsx` uses `useEffect(() => { ... }, [resolvedData])` to sync form state from server data. Do NOT use the `initialized` flag + if-inside-render pattern — it causes desync because `invalidateQueries` is async and stale data triggers a premature re-init before fresh data arrives.

## Browser automation: @jiku/browser (replaces Plan 13)

Plan 13 (OpenClaw port) is replaced by `packages/browser/`. Key conventions:

**Pre-connect pattern:** `agent-browser connect <endpoint>` must run once before `--cdp` flag works. `ensureConnected()` in `spawner.ts` handles this with an in-memory `Set<string>` cache.

**ws:// → http:// conversion:** `resolveCdpEndpoint()` converts `ws://localhost:9222` to `http://localhost:9222`. agent-browser `--cdp` accepts `http://` URLs or port numbers, NOT `ws://` URLs (except full `wss://` paths for remote services).

**Docker CDP proxy:** Chrome HTTP `/json/version` API is not accessible from outside the container natively. `socat` in the container forwards `0.0.0.0:9222 → 127.0.0.1:19222` (Chrome's internal port). Both HTTP and WebSocket traffic go through socat.

**Screenshot returns base64:** `execBrowserCommand` for screenshot: CLI saves to temp file → read → base64 encode → delete temp file. Response: `{ base64: "...", format: "png" }`. Client handles saving if needed.

**Non-root Chromium:** Docker container runs Chromium as user `browser` (not root). No `--no-sandbox` flag needed, no warning banner in noVNC.

**Tool definition in studio, not in package:** `@jiku/browser` is a library. Tool definitions for AI agents go in `apps/studio/server`, using `execBrowserCommand()` directly. The package does NOT define AI tools.

## ToolOutput renders content[] arrays with image support

`packages/ui/src/components/ai-elements/tool.tsx` `ToolOutput` component handles tool output that is `{ content: ContentPart[] }`. Image parts (`type: 'image'`, `data`, `mimeType`) render as `<img src="data:...">`. Text parts render as CodeBlock. Single-image-only responses render without wrapper div. This pattern is used by the browser screenshot tool.

Never return `{ type: 'text', text: 'Screenshot saved: /path...' }` from server tool handlers — it exposes server filesystem paths to end users. Return only the image data part.

## Wrap stream untuk cleanup after full consume

`modelCache.delete(cacheKey)` tidak bisa dilakukan di `finally` setelah `runtime.run()` karena stream di-consume setelah method return. Bungkus stream dalam custom `ReadableStream` yang delete cache key di: `done === true` (drain selesai) dan `cancel()` (client disconnect).

## Content attachment persistence pattern (Plan 33)

Tool outputs (screenshots, exported data) should be persisted as attachments, not returned as base64 inline. Pattern:

1. **Tool execution** (e.g. `executeBrowserAction` for screenshot):
   - Call `persistContentToAttachment({ projectId, data: buffer, mimeType, sourceType, metadata })`
   - Returns `{ attachmentId, storageKey, mimeType }` (no URL — only storage references)
   - Upload to S3 via filesystem adapter; DB record created automatically

2. **Tool output format**: Return `ToolContentPart` array:
   ```typescript
   { content: [{ type: 'image', attachment_id, storage_key, mime_type }] }
   ```
   NOT: `{ content: [{ type: 'image', data: 'base64...', mimeType }] }`

3. **URL generation** happens at TWO layers:
   - **UI rendering**: `useAttachmentUrl()` hook generates `/api/attachments/:id/inline?token=JWT` with token injection
   - **LLM delivery**: Chat route converts `attachment://id` to proxy_url or base64 per agent's `file_delivery` setting

4. **Why storage_key + attachment_id, not URL**:
   - Decouples storage from URLs (domain changes don't break data)
   - Single source of truth in DB; URLs are derived on-demand
   - Enables URL generation in multiple contexts (UI proxy, LLM delivery, etc.)

Never store URLs in the database. Always resolve attachments via ID at the edge (UI or API).
