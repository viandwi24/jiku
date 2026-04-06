# Decisions

## ADR-025 — Chat attachments are ephemeral, separate from project_files

**Context:** Chat messages can include image uploads. Two options: store in the virtual filesystem (project_files) or a separate ephemeral table. Virtual disk files are persistent and addressable by agents via fs_* tools — not appropriate for transient chat images.

**Decision:** Separate `project_attachments` table. S3 key layout `jiku/attachments/{projectId}/{conversationId}/{uuid}.{ext}` allows bulk-delete by conversation. Schema includes `scope: 'per_user' | 'shared'` for future multi-user access control.

**Consequences:** Agents cannot see chat attachments via `fs_read` — only via image content in the AI message. Chat images don't pollute the virtual disk. Deletion can be done per-conversation (e.g. on conversation delete). Binary files (images) are explicitly allowed here, unlike virtual disk which is text-only.

---

## ADR-024 — Filesystem route is /disk, not /files

**Context:** Plan 14 originally named the UI route `/files`. Conflict: agent has an `/agents/[agent]/files` page (for future agent-scoped files). Also `/files` is ambiguous — does it mean project files or all files?

**Decision:** Route the virtual disk file manager at `/disk`. Settings at `/settings/filesystem`. Sidebar label "Disk". This makes it clearly refer to the project-level virtual storage, not a generic file concept.

**Consequences:** URL is `/projects/[project]/disk` — memorable and distinct. Settings lives at `/settings/filesystem` to match the DB config table name `project_filesystem_config`.

---

## ADR-023 — Browser engine as ported OpenClaw code, not plugin

**Context:** Browser automation requires deep Playwright integration (~80 files). Plugin system is designed for lightweight, composable capabilities. Porting as a plugin would require wrapping the entire browser server lifecycle in plugin hooks — forcing the plugin system to manage process lifecycle, which it was not designed for.

**Decision:** Browser engine lives in `apps/studio/server/src/browser/` as a server-layer feature, identical to how memory and filesystem are structured. Browser tools are injected as `built_in_tools` at `wakeUp()`. OpenClaw browser engine files are ported verbatim (only import paths changed).

**Consequences:** ~91% is ported code; only ~9% is new glue code. Browser feature cannot be enabled/disabled via plugin toggle — only via project settings. Per-project browser server isolation via unique port per project.

---

## ADR-022 — Filesystem content cache: files ≤ 50 KB stored in DB

**Context:** Reading a file requires an S3 round-trip on every `fs_read` call. For small text files (code, configs, markdown) this adds 50–200ms latency and unnecessary S3 API calls.

**Decision:** Files ≤ 50 KB have their content stored in `content_cache text` column on `project_files`. On `write()`, if `sizeBytes <= 50_000`, the content is cached. On `read()`, `content_cache` is returned directly if present; falls back to S3 download otherwise.

**Consequences:** Small files (the common case for code/text) are served from DB with zero S3 latency. Content_cache is always kept in sync with storage — updated on every write. Large files (>50 KB) never cache and always hit S3.

---

## ADR-021 — Tool group metadata lives in ToolMeta, not derived from ID

**Context:** The `context-preview-sheet.tsx` previously grouped tools by ID prefix (`__builtin__:` → "built-in", `pluginId:` → plugin name). This was fragile and leaky — UI logic was parsing internal ID conventions. Alternatives: dedicate a grouping layer in the runner, or carry it in the tool definition itself.

**Decision:** Add `group?: string` field to `ToolMeta` in `@jiku/types`. Tool authors declare their group when defining the tool. The runner passes it through unchanged to `PreviewRunResult.active_tools`. UI reads `t.group` directly, with fallback to ID-prefix heuristic when unset.

**Consequences:** Grouping is explicit and semantically meaningful (e.g. "memory", "persona", "social"). Tool ID format changes won't break the UI. Third-party plugin tools that don't set `group` fall back gracefully to ID-prefix grouping.

---

## ADR-020 — agent_self scope uses varchar(50), not ALTER ENUM

**Context:** Plan 9 adds a 4th memory scope `agent_self`. The original Plan 8 schema defined scope as a DB enum (`memory_scope`). `ALTER TYPE ... ADD VALUE` inside a transaction requires PostgreSQL 12+ and cannot be rolled back. The existing `memories.scope` column is actually `varchar(50)` (Plan 8 implemented it this way intentionally to avoid enum rigidity).

**Decision:** No schema migration needed for the `memories` table. `agent_self` is a new string value accepted by the varchar column. Only the `agents` table needs migration (adding `persona_seed` + `persona_seeded_at` columns).

**Consequences:** Scope values are not DB-enforced — only application-layer validated. This is acceptable; the set of scopes is small and well-controlled. New scopes can be added without touching the DB enum.

---

## ADR-019 — Persona seeding runs at studio server layer, not in @jiku/core

**Context:** `ensurePersonaSeeded()` needs to check `persona_seeded_at` on the agent record and write to the DB. This is a DB operation. Alternatives: put it in `AgentRunner` (core), or in `RuntimeManager` (studio server).

**Decision:** Lives in `apps/studio/server/src/memory/persona.ts`, called from `RuntimeManager.run()` before `runtime.run()`. `@jiku/core` is kept DB-free — it only calls `getMemories()` through the storage adapter interface.

**Consequences:** The seeding concern is co-located with the studio's DB layer. If jiku core is used standalone (without studio), consumers must implement their own seeding logic. This is acceptable — persona seeding is studio-specific behaviour.

---

## ADR-018 — MemoryPreviewSheet reuses previewRun() instead of a dedicated API route

**Context:** The Memory Preview Sheet needs to show memories injected into the current session. A dedicated `/api/conversations/:id/memory-preview` route was considered, but `previewRun()` already returns `ContextSegment[]` which includes a `source: 'memory'` segment containing the full injected memory text.

**Decision:** No new API route. `MemoryPreviewSheet` reads from the existing `['preview', agentId, conversationId]` TanStack Query cache (same key as `ContextBar`). The memory segment's `.content` is parsed client-side by `parseMemorySection()` which splits on markdown headings and bullet lines.

**Consequences:** Zero extra network requests; memory preview is always in sync with context preview. Downside: parsing is brittle if `formatMemorySection()` output format changes — both must be kept in sync manually.

---

## ADR-017 — getMemories agent_id is optional (runtime_global has no agent scope)

**Context:** `runtime_global` memories belong to the project, not to any specific agent. When the runner loads `runtime_global` scope, it does not pass an `agent_id`. The original `GetMemoriesParams` had `agent_id: string` (required), causing `WHERE agent_id = ''` which always returns empty results and errors on the DB side.

**Decision:** Make `agent_id` optional in `GetMemoriesParams`. The DB query only adds `WHERE agent_id = $n` when `agent_id` is truthy. Both the `JikuStorageAdapter` interface and `StudioStorageAdapter` implementation updated to match.

**Consequences:** Queries for `runtime_global` scope now correctly fetch all project-scoped memories without filtering by agent. Agent-scoped queries still pass `agent_id` and behave as before.

---

## ADR-016 — Memory config lives on /memory page, not /settings

**Context:** The initial implementation put memory config under `/settings/memory` (a settings tab). User feedback: the config belongs on the `/memory` page itself, alongside the memory browser — not buried in settings.

**Decision:** Move memory config to a "Config" tab on the `/memory` page (alongside the "Memories" browser tab). Remove the Memory tab from project settings layout. The `/settings/memory` page file remains but is not linked from navigation.

**Consequences:** Clearer UX — memory browser and its config are co-located. Settings stays focused on project-level general/credentials/permissions concerns. The `/settings/memory` route still exists as a dead page; it can be deleted in cleanup.

---

## ADR-015 — Memory is app-layer, not a plugin

**Context:** Memory could have been implemented as a plugin (e.g. `jiku.memory`) following the existing plugin system. However, memory requires deep integration with the runner lifecycle (before-run load, after-run extraction, system prompt injection) and config inheritance (project → agent), which the plugin system's `setup()` + `contributes()` pattern doesn't cleanly support.

**Decision:** Memory is a first-class feature of `@jiku/core` and `@jiku-studio/server`. Built-in memory tools are injected as `built_in_tools` on `AgentDefinition` (bypassing plugin system), and the runner has explicit memory lifecycle steps.

**Consequences:** Memory cannot be disabled via plugin toggle. The tradeoff is intentional — memory is a fundamental capability, not an optional extension. Future extensibility (custom memory backends) should be done via the `JikuStorageAdapter` interface, not via plugins.

---

## ADR-014 — Per-agent memory config: inherit/on/off override model

**Context:** Memory config has a 2-level hierarchy: project-level defaults and per-agent overrides. The agent level only needs to override specific fields (e.g. disable extraction for a specific agent), not redeclare the full config.

**Decision:** `AgentMemoryConfig` is a deeply partial version of `ResolvedMemoryConfig`. Agent config is stored as nullable jsonb on the `agents` table. `resolveMemoryConfig(projectConfig, agentConfig)` merges them — project defaults win where agent config is null/undefined. The web UI uses an `InheritToggle` (inherit/on/off) per field. "Inherit" = null in agent config (falls back to project). The `GET /api/agents/:aid/memory-config/resolved` endpoint exposes the final merged config.

**Consequences:** Clear semantics: inherit means project default, on/off means explicit override. The resolved config endpoint lets the UI show the effective value and its source (project vs agent).

---

## ADR-013 — EventSource auth via ?token= query param (not Authorization header)

**Context:** The SSE observer endpoint (`GET /conversations/:id/stream`) needs the auth token. `EventSource` is a browser native API and does not support custom request headers — there is no way to set `Authorization: Bearer <token>` on an `EventSource` connection.

**Decision:** Pass the JWT token as a `?token=` URL query parameter for the SSE observer endpoint only. The server reads `c.req.query('token')` and validates it the same way as the `Authorization` header.

**Consequences:** Token appears in server access logs for the SSE URL. Acceptable for a studio-internal tool. Do not apply this pattern to any non-SSE endpoint where header-based auth is possible.

## ADR-012 — SSE broadcast via stream.tee()

**Context:** When a chat run starts, the caller (who sent the POST) needs the stream. Other tabs or observers also need to see the output live (e.g. a second browser tab watching the same conversation). Buffering the full response before broadcasting would add latency and memory pressure.

**Decision:** Use `ReadableStream.tee()` to split the stream produced by `runtime.run()` into two branches: one piped to the HTTP response for the caller, and one registered in `StreamRegistry` for SSE observers. The `StreamRegistry` keeps an in-memory `Map<conversationId, { stream, controllers }>`. Each SSE observer tees the registered stream again to read it independently.

**Consequences:** `tee()` buffers the stream in memory until both readers have consumed each chunk — acceptable since LLM output is relatively small per turn. The registry must clean up on stream end and on observer disconnect to prevent memory leaks. Concurrent lock (409) prevents two POST callers from fighting over the same conversation stream.

## ADR-011 — Replace Radix ScrollArea with plain overflow-y-auto div in conversation list

**Context:** `@radix-ui/react-scroll-area` renders an inner viewport div with inline style `min-width: 100%; display: table`. This causes flex children inside the scroll area to expand to the content width instead of being clipped by the container, which breaks `text-overflow: ellipsis` on conversation preview text — the text never truncates regardless of `truncate` or `overflow-hidden` classes.

**Decision:** Remove `ScrollArea` from `conversation-list-panel.tsx` and replace with a plain `<div className="overflow-y-auto h-full">`. Custom scrollbar styling is handled via Tailwind's `scrollbar-thin` utilities or CSS if needed.

**Consequences:** Loses Radix's cross-browser custom scrollbar rendering. For this panel the native browser scrollbar is acceptable. Any future component that needs a custom scrollbar skin must avoid putting text-overflow children inside `ScrollArea` — use plain `overflow-y-auto` instead.

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
