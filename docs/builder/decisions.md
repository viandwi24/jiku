# Decisions

## ADR-036 — Browser concurrency: per-project mutex + per-agent tab affinity

**Context:** With Plan 33 shipped, the browser tool became usable end-to-end
— but a project can have many agents, and agent-browser only operates on a
single "active tab" per CDP endpoint. Two agents calling the browser tool
concurrently would race on shared state with no warning: element refs from
a snapshot would go stale, fills would overwrite each other, navigations
would interleave. There was no lock, no queue, no isolation.

We considered three approaches:

- **A) Per-project queue + shared single tab.** Cheap. Single shared session.
  Acceptable for collaborative agents but bad for "Agent A on Tokopedia,
  Agent B on Shopee" — they tab-collide on every navigation.
- **B) Per-project queue + per-agent tab affinity.** Each agent gets its own
  chromium tab; the queue only serializes commands at the chromium level.
  Same isolation a real multi-tab session gives, no throughput parallelism.
- **C) Container pool — N chromium containers per project, agent assigned
  to a container.** True parallelism. ~500 LoC pool manager + ~300MB RAM
  per container. Overkill at current scale.

**Decision:** Option B. Implementation in
`apps/studio/server/src/browser/{concurrency,tab-manager}.ts`:

1. **`KeyedAsyncMutex`** (~50 LoC, no dependencies) keyed by `projectId`.
   Every browser command acquires the lock before talking to chromium;
   different projects don't block each other. The `/preview` endpoint
   acquires the same lock so it can't race with agent commands.
2. **`BrowserTabManager`** tracks one tab per agent as an ordered list per
   project (index 0 = system tab from container startup, index 1..N = agent
   tabs). The mutex guarantees indexes stay coherent. Capacity hard-cap of
   10 tabs per project; LRU eviction on overflow.
3. **`tab_*` and `close` actions are reserved.** The dispatcher rejects
   them so the LLM can't desync our index tracking. The actions still exist
   in `BROWSER_ACTIONS` for parity with `BrowserCommand` but throw a clear
   error at runtime.
4. **Idle eviction.** `startBrowserTabCleanup()` runs every 60s and closes
   tabs idle > 10 minutes inside the per-project mutex. The interval is
   `unref()`'d so it doesn't pin the event loop.
5. **Lifecycle hooks.** `runtimeManager.sleep(projectId)` and the browser
   config PATCH routes call `browserTabManager.dropProject(projectId)` to
   invalidate stale indexes when state could have changed underneath us.
6. **Diagnostic endpoint.** `GET /browser/status` returns the mutex busy
   flag, the tab table, and the capacity counters. The Browser settings
   page renders a Debug panel that polls it every 2 seconds.

**Consequences:**
- Multiple agents in one project can use the browser tool without colliding,
  even when their commands interleave. Element refs are guaranteed valid
  for the next command in the same agent's sequence.
- No throughput parallelism within a project — commands run one at a time.
  Acceptable: most browser commands are I/O-bound (200ms-2s) and the
  realistic concurrency level on a single project is low.
- Two agents in different projects don't block each other (mutex is per-key).
- In-memory mutex doesn't coordinate across multiple Studio server
  instances. Current deployment is single-server, so not an issue.
- Cookies are still shared at the chromium profile level (chromium
  constraint, not Studio's). Two agents logging into different gmail
  accounts on the same project will collide; workaround is to put them in
  separate projects.
- Migration path to container pool (Option C) is straightforward later: the
  pool manager just owns N CDP endpoints + N mutex keys, the rest of the
  logic is unchanged.

---

## ADR-035 — Browser automation rebuilt as @jiku/browser CLI bridge (Plan 33)

**Context:** Plan 13 (ADR-026) failed: ~80 files of OpenClaw engine code ported into `apps/studio/server`, headless-only, untestable, schema enum drift. Needed a clean replacement that's actually visible in noVNC, has tests, and is decoupled from Studio internals.

**Decision:** Build a standalone `packages/browser/` package as a CLI bridge to Vercel `agent-browser` (Rust binary) over CDP. Studio integration lives in `apps/studio/server/src/browser/` and only contains the tool definition + dispatch + screenshot persistence — no engine code. The Docker container is owned by the package, not by Studio. Three rules locked in by experience:

1. **CDP-only project config.** A single `cdp_url` per project. No managed mode, no headless toggle, no executable path. Plan 13's config sprawl is gone.
2. **Tool input schema is a flat `z.object`.** OpenAI's function calling API rejects schemas without `type: "object"` at the JSON Schema root. A `z.discriminatedUnion` serializes to `anyOf` and breaks this. Per-action requirements are validated at runtime by a `need()` helper, with a `never`-typed default branch for compile-time exhaustiveness over `BrowserAction`.
3. **Chromium in Docker uses `--no-sandbox`.** Docker Desktop on macOS/Windows doesn't expose unprivileged user namespaces, so the zygote dies without it. The container itself is the isolation boundary, so this is safe and standard.

Screenshots are persisted via the unified `persistContentToAttachment()` from ADR-034 and returned as `{ type: 'image', attachment_id, storage_key, mime_type }`. The settings page has a Live Preview box (one-shot screenshot, optional 3s auto-refresh) so users get visual confirmation without opening noVNC separately.

**Consequences:**
- Browser feature is genuinely production-grade end-to-end: backend, API, UI, container, docs.
- ~9000 lines of OpenClaw port replaced by ~600 lines of package + ~400 lines of Studio integration. 52 tests in `packages/browser/src/tests`.
- Future tool authors must use a flat `z.object` for OpenAI compatibility — documented in `docs/builder/memory.md` to prevent regression.
- Single active tab limitation remains. True multi-user requires a container per user; deferred.

---

## ADR-034 — Content references use attachment_id + storage_key, never URLs

**Context:** Binary content (screenshots, generated files, tool outputs) were stored as inline base64 in tool output parts or as URLs in database records. URLs are fragile (domain changes, proxy endpoint changes break data). Inline base64 wastes 33% space and bloats LLM context window.

**Decision:** All binary content references in DB (conversation_messages.parts, tool outputs) use the shape `{ type: 'image', attachment_id, storage_key, mime_type }`. No URL, no base64 data is stored. URL generation happens exclusively at two points: (1) UI rendering layer builds `<img src>` URLs on-demand from `attachment_id`, (2) LLM delivery resolves attachment references to base64 or proxy URL based on `agent.file_delivery` config. Storage key format is standardized: `jiku/attachments/{projectId}/{scope}/{uuid}.{ext}`.

**Consequences:** Data is portable — export conversation, change domains, import, all references remain valid. Single source of truth for content format across stream, DB, and UI. Slight complexity increase: rendering layer must resolve references on-demand, and LLM delivery must resolve before API calls. Trade-off is worth it for data integrity and context efficiency.

---

## ADR-033 — Credential resolution always uses getAvailableCredentials (company + project union)

**Context:** Features that resolve credentials at runtime (embedding API key, LLM provider, etc.) were using `getProjectCredentials(projectId)` which only returns credentials scoped to the project. Users creating credentials at company level (a common pattern for shared API keys like OpenAI) got "no credential found" errors.

**Decision:** Any runtime credential resolution must use `getAvailableCredentials(companyId, projectId)` which returns a union of company-level and project-level credentials. `companyId` is looked up from the project row. Frontend pickers must use `api.credentials.available(projectId)` (hits `/api/projects/:pid/credentials/available`) instead of `api.credentials.listProject`.

**Consequences:** Company credentials (defined once per company) are now visible to all their projects. No more "add credential to every project" workaround. This is the correct inheritance model — applies to embedding, future LLM key resolution, and any other credential-dependent feature.

---

## ADR-032 — LLM memory extraction removed; explicit tool calls only

**Context:** `extractMemoriesPostRun()` ran a small LLM call after each conversation to auto-extract facts into memory. It caused duplicate memories because the extraction ran before tool-saved memories from the same run had committed in the DB (stale read window). Also: OpenClaw doesn't use auto-extraction; explicit tool calls are the correct model.

**Decision:** Remove `extractMemoriesPostRun()` and `extractPersonaPostRun()` from the run lifecycle entirely. Agents must explicitly call `memory_core_append`, `memory_extended_insert`, etc. to persist facts. The `extraction` block in `ResolvedMemoryConfig` is kept in types for future opt-in use but is not evaluated.

**Consequences:** No more silent duplicate memories. Agent behavior is fully deterministic and auditable via tool calls. Agents need to be prompted explicitly to use memory tools when persistence matters.

---

## ADR-031 — Browser automation: CLI bridge to agent-browser instead of OpenClaw port

**Context:** Plan 13 ported OpenClaw browser engine (~9000 lines, ~80 files) directly into `apps/studio/server`. It failed because Playwright spawned a headless process instead of connecting to the visible Chromium in the Docker container. CDP attach mode silently fell back to headless, so users saw no browser activity in noVNC.

**Decision:** Replace with `@jiku/browser` package — a thin CLI bridge to [Vercel agent-browser](https://github.com/vercel-labs/agent-browser) (Rust binary). Each command spawns `agent-browser --cdp <endpoint> --json <action>`. CDP connection goes through a socat proxy in Docker to make Chrome's HTTP `/json/version` API accessible from outside the container. Pre-connect pattern used (`agent-browser connect <endpoint>` once per endpoint) because `--cdp` alone fails on first use. Screenshots return base64 instead of file paths — client handles persistence.

**Consequences:**
- ~600 lines vs ~9000 — massively simpler, testable (52 tests)
- Stateless per command — no persistent page state between calls (console logs, network requests lost)
- Depends on agent-browser binary (Rust, installed via npm)
- Single active tab constraint — concurrent users on same profile will conflict
- Tool definition lives in `apps/studio/server`, not in the package (clean separation)

---

## ADR-030 — Cron task permissions: caller context snapshotted at creation

**Context:** Cron tasks run periodically on behalf of the original creator. If the creator's role later changes (e.g. demoted from superadmin to member), should the cron task still have access to previous permissions?

**Decision:** Snapshot the caller context (`caller_id`, `caller_role`, `caller_is_superadmin`) at creation time and store in the `cron_tasks` table. Permission checks use the snapshotted context, not the current user state. This ensures:
- Cron tasks execute with predictable permissions regardless of later role changes
- Simplified permission model: superadmin can modify all tasks; non-superadmin can only modify their own tasks, but only if role unchanged (security gate)

**Consequences:** Cron task permissions are immutable after creation. If a user loses superadmin status, their snapshotted tasks retain their original privilege level during scheduled execution. This is acceptable for a studio-internal tool where users are trusted. For public APIs, a role-change hook could re-validate task permissions before execution.

---

## ADR-029 — Cron Task System architecture: croner for scheduling, cronstrue for display

**Context:** Need to schedule recurring tasks and display cron expressions in human-readable form.

**Decision:** 
- Server uses `croner@10.0.1` for parsing and scheduling cron expressions (CRON syntax) in `CronTaskScheduler` class
- Web frontend uses `cronstrue@3.14.0` for displaying expressions in English (e.g., "Every Monday at 9:00 AM")
- Two separate libraries for different purposes: scheduling vs display

**Consequences:** Cron expression validation happens server-side when tasks are created/updated. Frontend displays human-readable descriptions via `CronExpressionInput` component (real-time feedback, green/red validation). If cron expression syntax changes, only the server needs updating; frontend cronstrue will adapt on next parse.

---

## ADR-027 — Conversation title generation is fire-and-forget, non-blocking

**Context:** Conversations need human-readable titles instead of generic labels. Options: generate title synchronously (blocks chat response), or asynchronously (responsive but title may appear with a delay).

**Decision:** Title generation runs asynchronously after the first message is stored. The HTTP response is not blocked. The title is generated using the agent's own configured LLM via the same `buildProvider()` and `resolveAgentModel()` dynamic provider pattern used by chat runs. Max 50 characters.

**Consequences:** Chat UX remains fast (first message response is not delayed). Titles appear after a brief moment (50–500ms depending on LLM response time). If generation fails (credential not assigned, LLM error), the title remains null — no error is exposed to the user. This is acceptable because the conversation is still usable even without a title.

---

## ADR-028 — Conversation soft delete via deleted_at column

**Context:** Conversations can be deleted from the UI. Hard delete loses history permanently. Soft delete preserves data for audit/analytics while removing conversations from the user-facing list.

**Decision:** Add `deleted_at timestamptz | null` column. `DELETE /conversations/:id` sets `deleted_at = now()`. All query operations (`getConversationsByProject`, etc.) filter `WHERE deleted_at IS NULL`. Frontend displays a delete confirmation (`AlertDialog`) before triggering the delete.

**Consequences:** Deleted conversations remain in the DB but never appear in the conversation list or UI. Soft delete is permanent from the user's perspective (no undelete button in the current UI). If needed in the future, undelete is easy to implement (clear the `deleted_at` column).

---

## ADR-026 — Browser automation (Plan 13) abandoned — to be removed at MVP

> **STATUS: RESOLVED 2026-04-09 by Plan 33.** OpenClaw port was deleted, replaced
> by `@jiku/browser` (CLI bridge to Vercel agent-browser) + hardened Docker
> container + flat Zod tool schema. See ADR-035 for the design of the
> replacement and `docs/plans/impl-reports/13-browser-implement-report.md`
> for the full arc.

**Context:** Plan 13 implemented browser automation using the ported OpenClaw engine. The goal was to let the AI control the visible Chromium browser running in the LinuxServer/noVNC container (visible at localhost:4000) so users can watch the AI browse in real time.

**Decision:** Feature is marked FAILED and will be removed before MVP release. The implementation does not meet planning requirements:
- The browser tool launches a headless Playwright-managed Chromium (new process), not the visible one at localhost:4000.
- CDP remote attach mode (`BROWSER_CDP_URL=http://browser:9223`) fails silently — the `chromium-cdp.sh` init script does not execute inside the LinuxServer container, so no CDP endpoint is exposed on port 9222. The system falls back to headless mode without warning.
- Users see no browser activity in the noVNC viewer; AI automation happens invisibly in a headless process.

**Consequences:** All browser-related code (`apps/studio/server/src/browser/`, browser tool injection in `manager.ts`, browser settings page) must be deleted before MVP. Corresponding DB config columns and routes should also be removed in the cleanup pass.

---

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
