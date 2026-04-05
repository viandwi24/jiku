# Changelog

## 2026-04-05 — Chat History: content → parts migration + AI SDK v6 fixes

- **DB schema**: Renamed `messages.content` jsonb column → `messages.parts` to align with AI SDK v6 `UIMessage.parts` format. Requires `bun run db:push` (interactive TTY).
- **@jiku/types**: Added `MessagePart` type aligned with AI SDK UIMessage parts shape. `Message.content: MessageContent[]` → `Message.parts: MessagePart[]`. `MessageContent` kept as deprecated alias.
- **StudioStorageAdapter**: Updated `toJikuMessage()` and `addMessage()` to read/write `parts` field.
- **@jiku/core runner.ts**: History loading now reads `m.parts` instead of `m.content`.
- **DB queries**: `extractLastMessageText` reads `msg.parts`.
- **lib/api.ts**: `messages` endpoint response type updated to `parts: { type: string; [key: string]: unknown }[]`.
- **Chat history fix — 3 bugs resolved**: (1) `!historyData` guard added — TanStack Query initial state is undefined even when loading=false; (2) `messages: initialMessages` in `useChat` (AI SDK v6 renamed from `initialMessages`); (3) `key={convId}` on `<ChatView>` forces remount on conversation change.
- Files: `apps/studio/db/src/schema/conversations.ts`, `packages/types/src/index.ts`, `apps/studio/server/src/runtime/storage.ts`, `packages/core/src/runner.ts`, `packages/core/src/storage/memory.ts`, `apps/studio/db/src/queries/conversation.ts`, `apps/studio/web/lib/api.ts`, `apps/studio/web/app/(app)/studio/.../chats/[conv]/page.tsx`

## 2026-04-05 — Plan 5 Polish: Empty states + Toast + shadcn Empty component

- **Empty states**: All pages migrated from manual `div`+icon+text to `shadcn Empty` (`Empty`/`EmptyMedia`/`EmptyTitle`/`EmptyDescription`/`EmptyContent`). Pages: companies/page, company/projects/page, project/agents/page, project/chats/page, conv/page, conversation-list-panel.
- **Toast coverage**: `toast.success/error` added to all mutation paths. `Toaster` wired in `providers.tsx`. `conversation-list-panel.tsx` added toast import.
- **CLAUDE.md**: Added "Environment Files" rule — never read `.env` files, use `.env.example` only.
- Files: `apps/studio/web/app/(app)/studio/companies/page.tsx`, `apps/studio/web/app/(app)/studio/companies/[company]/projects/page.tsx`, `apps/studio/web/app/(app)/studio/.../agents/page.tsx`, `apps/studio/web/app/(app)/studio/.../chats/page.tsx`, `apps/studio/web/components/chat/conversation-list-panel.tsx`, `CLAUDE.md`

## 2026-04-05 — Studio UI/UX Overhaul (Plan 5) — Server Endpoints

- **DB queries**: Added `getConversationsByProject(projectId, userId)` — returns conversations filtered by project with agent info + last_message text (extracted from jsonb content). Added `getConversationWithAgent(convId)` — conversation with agent info.
- **Server routes**: Added `GET /api/projects/:pid/conversations` and `GET /api/conversations/:id` to `conversations.ts` router.
- Files: `apps/studio/db/src/queries/conversation.ts`, `apps/studio/server/src/routes/conversations.ts`

## 2026-04-05 — Studio UI/UX Overhaul (Plan 5) — Phase 4 Polish

- **Error boundaries**: Added Next.js `error.tsx` files for `[company]`, `[project]`, and `[agent]` route segments. Added reusable `ErrorBoundary` React class component in `components/error-boundary.tsx`.
- **AgentCard**: Redesigned with Avatar (initials), description, Chat button (→ `/chats?agent=slug`), Overview button.
- **Empty states**: Project page shows FolderKanban icon + "No projects yet" with CreateProjectDialog. Agent list page shows Bot icon + "No agents yet" with CreateAgentDialog. Both have proper Card skeleton loaders.
- **Cleanup**: Deleted unused `lib/store/sidebar.store.ts`.
- Files: `apps/studio/web/app/(app)/[company]/error.tsx`, `apps/studio/web/app/(app)/[company]/[project]/error.tsx`, `apps/studio/web/app/(app)/[company]/[project]/agents/[agent]/error.tsx`, `apps/studio/web/components/error-boundary.tsx`, `apps/studio/web/components/agent/agent-card.tsx`, `apps/studio/web/app/(app)/[company]/page.tsx`, `apps/studio/web/app/(app)/[company]/[project]/page.tsx`

## 2026-04-05 — Studio UI/UX Overhaul (Plan 5) — Phase 2 + 3

- **3-Level Sidebar**: `RootSidebar`, `CompanySidebar`, `ProjectSidebar` using shadcn Sidebar components. Each layout level (`home/layout`, `[company]/layout`, `[project]/layout`) has its own `SidebarProvider` shell.
- **AppHeader + Breadcrumb**: `AppHeader` with `SidebarTrigger`. `AppBreadcrumb` resolves company/project/agent names from TanStack Query cache.
- **Agent Tabs**: `[agent]/layout.tsx` with URL-based tabs (Overview, Settings, Permissions). Settings has sub-tabs (General, Model & Provider). Agent overview page replaced chat with summary view.
- **Chat System**: `[project]/chats/layout.tsx` with `ResizablePanelGroup` split (orientation=horizontal). `ConversationListPanel` with search + active highlight. New chat page with agent selector (Popover+Command). Active conversation page using ai-elements: `Conversation`/`ConversationContent`, `Message`/`MessageResponse`, `PromptInput`/`PromptInputSubmit`.
- **Settings Tabs**: Company settings (`general`, `credentials`) and project settings (`general`, `credentials`, `permissions`) with URL-based tab layouts and redirect pages.
- **packages/ui exports**: Fixed shadcn export conflicts — renamed legacy `Sidebar*` and `Header`/`Breadcrumb` exports.
- **lib/api.ts**: Added `conversations.listProject(projectId)` and `conversations.get(convId)`. Added `ConversationItemWithAgent` type.
- Files: `apps/studio/web/app/(app)/[company]/[project]/chats/**`, `apps/studio/web/components/chat/conversation-list-panel.tsx`, `apps/studio/web/app/(app)/[company]/settings/**`, `apps/studio/web/app/(app)/[company]/[project]/settings/**`, `apps/studio/web/lib/api.ts`, `packages/ui/src/index.ts`

## 2026-04-05 — JikuRuntime Integration + Plugin KV Store + StudioStorageAdapter

- **Runtime Manager**: Rewrote `JikuRuntimeManager` — one `JikuRuntime` per project (project = runtime). Dynamic provider pattern: single `__studio__` provider registered at boot; `getModel()` reads from per-request `modelCache` Map. Decrypted keys never live in long-lived memory.
- **Chat route**: New `POST /api/conversations/:id/chat` in `routes/chat.ts` calls `runtimeManager.run()` → `JikuRuntime.run()` → `AgentRunner` → `streamText()`. All policy enforcement, tool filtering, and plugin system active through runtime.
- **StudioStorageAdapter**: Full `JikuStorageAdapter` implementation backed by PostgreSQL via `@jiku-studio/db`. `toJikuMessage()` handles both legacy plain-string content and new `MessageContent[]` jsonb arrays.
- **Plugin KV Store**: New `plugin_kv` DB table (`project_id`, `scope`, `key`, `value` jsonb, unique on `(project_id, scope, key)`). `pluginKvGet/Set/Delete/Keys` queries with `onConflictDoUpdate` upsert. `StudioStorageAdapter.pluginGet/Set/Delete/Keys` now persist to DB instead of in-memory.
- **DB queries**: Added `updateConversation`, `listConversationsByAgent`, `deleteMessagesByIds` to conversation queries.
- Files: `apps/studio/server/src/runtime/manager.ts`, `apps/studio/server/src/runtime/storage.ts`, `apps/studio/server/src/routes/chat.ts`, `apps/studio/db/src/schema/plugin_kv.ts`, `apps/studio/db/src/queries/plugin_kv.ts`, `apps/studio/db/src/queries/conversation.ts`, `apps/studio/db/src/index.ts`, `apps/studio/db/src/migrations/0001_lumpy_ezekiel.sql`

## 2026-04-05 — Chat Migration: WebSocket → Vercel AI SDK HTTP Streaming

- **Server**: Installed `ai`, `@ai-sdk/openai`, `@ai-sdk/anthropic`, `@openrouter/ai-sdk-provider` in `@jiku-studio/server`. Removed `ws` and `@anthropic-ai/sdk` from dependencies.
- **Server**: Added `buildProvider()` to `credentials/service.ts` — creates a Vercel AI SDK `LanguageModel` from resolved credential info (supports openai, anthropic, openrouter, ollama via OpenAI-compat).
- **Server**: New route `POST /api/conversations/:id/chat` in `routes/chat.ts` — uses `streamText()` + `toUIMessageStreamResponse()`, calls `resolveAgentModel()` + `buildProvider()`, persists messages to DB.
- **Server**: Removed `ws/chat.ts` and `ws/server.ts`. `index.ts` no longer attaches WebSocket server.
- **Web**: Installed `@ai-sdk/react`. Rewrote `components/agent/chat/chat-interface.tsx` to use `useChat` from `@ai-sdk/react` with `DefaultChatTransport` pointing to new HTTP endpoint. Custom auth headers + extra body fields (agent_id, project_id, company_id) via `prepareSendMessagesRequest`.
- **Web**: `lib/ws.ts` simplified to re-export `useChat` from `@ai-sdk/react` (backward-compat shim).
- Files: `apps/studio/server/src/credentials/service.ts`, `apps/studio/server/src/routes/chat.ts`, `apps/studio/server/src/index.ts`, `apps/studio/server/package.json`, `apps/studio/web/components/agent/chat/chat-interface.tsx`, `apps/studio/web/lib/ws.ts`, `apps/studio/web/package.json`

## 2026-04-05 — Credentials System (Plan 4)

- **DB**: New `credentials` table (AES-256-GCM encrypted fields, scope company/project, adapter_id, group_id, metadata JSONB). New `agent_credentials` join table (one-to-one agent→credential with model_id + metadata_override). Revised `agents` schema: removed `provider_id`/`model_id`, added `slug` with unique constraint per project. Updated `relations.ts` with credentials relations.
- **DB queries**: `getCompanyCredentials`, `getProjectCredentials`, `getAvailableCredentials` (union), `createCredential`, `updateCredential`, `deleteCredential`, `getAgentCredential`, `assignAgentCredential`, `updateAgentCredential`, `unassignAgentCredential`. Added `getAgentBySlug` to agent queries.
- **Server**: `credentials/encryption.ts` — AES-256-GCM encrypt/decrypt/mask. `credentials/adapters.ts` — registry with 5 built-in adapters (openai, anthropic, openrouter, ollama, telegram). `credentials/service.ts` — `formatCredential`, `testCredential` (live HTTP test), `resolveAgentModel`. `utils/slug.ts` — `generateSlug`, `uniqueSlug`.
- **Server routes**: `GET /api/credentials/adapters`, company/project credential CRUD, `GET /api/projects/:id/credentials/available`, `POST /api/credentials/:id/test`, agent credential assign/update/delete. Updated agents/projects/companies routes to auto-generate slugs.
- **Runtime manager**: Removed `provider_id`/`model_id` from `RuntimeAgent`, added `slug`.
- **Web api.ts**: Added `credentials.*` endpoints, updated `Agent` type (removed model_id/provider_id, added slug), updated company/project create to omit required slug.
- **packages/ui**: New credentials components — `CredentialCard`, `CredentialList`, `CredentialForm`, `CredentialSelector`, `ModelSelector`, `MetadataOverrideForm`. Exported from `index.ts`.
- **Web pages**: `[company]/settings/page.tsx`, `[company]/settings/credentials/page.tsx`, `[company]/[project]/settings/page.tsx`, `[company]/[project]/settings/credentials/page.tsx`, `[company]/[project]/settings/permissions/page.tsx` (placeholder). Settings button in company + project list pages.
- **Agent settings**: Revised settings page — added "Model & Provider" tab with `CredentialSelector` + `ModelSelector` + `MetadataOverrideForm`. Removed legacy model_id field from `AgentConfigForm`.
- **env**: Added `CREDENTIALS_ENCRYPTION_KEY` to `env.ts`.
- Files: `apps/studio/db/src/schema/credentials.ts`, `apps/studio/db/src/schema/agents.ts`, `apps/studio/db/src/schema/relations.ts`, `apps/studio/db/src/schema/index.ts`, `apps/studio/db/src/queries/credentials.ts`, `apps/studio/db/src/queries/agent.ts`, `apps/studio/db/src/index.ts`, `apps/studio/server/src/credentials/*`, `apps/studio/server/src/utils/slug.ts`, `apps/studio/server/src/routes/credentials.ts`, `apps/studio/server/src/routes/agents.ts`, `apps/studio/server/src/routes/projects.ts`, `apps/studio/server/src/routes/companies.ts`, `apps/studio/server/src/runtime/manager.ts`, `apps/studio/server/src/env.ts`, `apps/studio/server/src/index.ts`, `apps/studio/web/lib/api.ts`, `apps/studio/web/components/agent/agent-config-form.tsx`, `apps/studio/web/app/(app)/[company]/page.tsx`, `apps/studio/web/app/(app)/[company]/[project]/page.tsx`, `apps/studio/web/app/(app)/[company]/settings/**`, `apps/studio/web/app/(app)/[company]/[project]/settings/**`, `packages/ui/src/components/credentials/*`, `packages/ui/src/index.ts`

## 2026-04-04 — @jiku/ui: shadcn + ai-elements migration (Plan 4)

**Changed:** Copied all shadcn UI primitives (55 files) and AI-specific elements (48 files) from `apps/studio/web/components/` into `packages/ui/src/components/` so they can be shared via `@jiku/ui`. Fixed all `@/` alias imports to relative paths. Also copied `use-mobile` hook to `packages/ui/src/hooks/`. Updated `packages/ui/src/index.ts` to barrel-export all new components alongside existing layout/data/agent exports.
**Files touched:** `packages/ui/src/components/ui/*.tsx` (55 files), `packages/ui/src/components/ai-elements/*.tsx` (48 files), `packages/ui/src/hooks/use-mobile.ts`, `packages/ui/src/index.ts`

## 2026-04-04 — Policy System Revision (Plan 3.5)

- `@jiku/types`: Added `PolicyCondition`, `SubjectMatcher`, open-string `PolicyRule` (no more enums), `CallerContext.attributes`, `JikuRuntimeOptions.subject_matcher`
- `@jiku/core`: Rewrote `checkAccess()` + `evaluateConditions()` with `defaultSubjectMatcher` (role/permission/user/*/attributes); updated `resolveScope()` + `JikuRuntime` to propagate `subject_matcher`; exported `defaultSubjectMatcher`, `evaluateConditions`
- `@jiku-studio/db`: Rewrote `schema/policies.ts` — `policies` table (reusable entity), `policy_rules.policy_id` FK (was `agent_id`), new `agent_policies` join table; updated `relations.ts`; rewrote `queries/policy.ts` with `getPolicies`, `createPolicy`, `getAgentPolicies`, `attachPolicy`, `detachPolicy`, `loadProjectPolicyRules`; added `getAllProjects`, `deleteProject` to project queries; added `@jiku/types` as dependency
- `@jiku-studio/server`: Rewrote `JikuRuntimeManager` with `wakeUp/sleep/syncRules/syncAgent` pattern; `resolveCaller` now returns `attributes: { company_id }`; rewrote `routes/policies.ts` for company-level policy CRUD + attach/detach; `routes/projects.ts` triggers `wakeUp`/`sleep`; `routes/agents.ts` uses `syncAgent`; `ws/chat.ts` no longer queries policy rules per-request; `index.ts` boots all project runtimes on startup
- `apps/studio/web`: Updated `lib/api.ts` with Policy, PolicyCondition, AgentPolicyItem types and attach/detach APIs; rewrote permissions page to policy-entity model (attach existing / create+attach / detach, expandable rule view); `PolicyRulesTable` now takes `policyId`
- Files: `packages/types/src/index.ts`, `packages/core/src/resolver/access.ts`, `packages/core/src/resolver/scope.ts`, `packages/core/src/runtime.ts`, `packages/core/src/runner.ts`, `packages/core/src/index.ts`, `apps/studio/db/src/schema/policies.ts`, `apps/studio/db/src/schema/relations.ts`, `apps/studio/db/src/queries/policy.ts`, `apps/studio/db/src/queries/project.ts`, `apps/studio/db/package.json`, `apps/studio/server/src/runtime/manager.ts`, `apps/studio/server/src/runtime/caller.ts`, `apps/studio/server/src/routes/policies.ts`, `apps/studio/server/src/routes/projects.ts`, `apps/studio/server/src/routes/agents.ts`, `apps/studio/server/src/ws/chat.ts`, `apps/studio/server/src/index.ts`, `apps/studio/web/lib/api.ts`, `apps/studio/web/app/.../permissions/page.tsx`, `apps/studio/web/components/permissions/policy-rules-table.tsx`

## 2026-04-04 — Studio Base (Plan 3)

- Created `@jiku-studio/db` — Drizzle ORM schema (11 tables: users, companies, roles, permissions, role_permissions, company_members, projects, agents, policy_rules, agent_user_policies, conversations, messages), typed query helpers, Drizzle relations, client factory, seed (system permissions + per-company roles)
- Created `@jiku-studio/server` — Hono HTTP + Bun WebSocket server; JWT auth (jose); REST routes for auth/companies/projects/agents/policies/conversations; `JikuRuntimeManager` (in-memory runtime per project); `StudioStorageAdapter`; `resolveCaller()` (actual permissions + self-restriction intersection); streaming chat via Anthropic SDK
- Created `@jiku/ui` — shared React component library: layout (Sidebar, Header, PageHeader, EmptyState), data (DataTable, StatCard, PermissionBadge), agent (ChatBubble, ChatInput, ThinkingIndicator, ToolCallView)
- Created `apps/studio/web` pages: auth (login/register), app layout with sidebar, company selector, company→projects, project→agents, agent chat (WebSocket streaming), agent settings, agent permissions (policy rules table + user policy list + self-restriction modal)
- Added `apps/studio/*` to workspace entries in root `package.json`
- All packages type-check clean (`tsc --noEmit`)
- Files: `apps/studio/db/**`, `apps/studio/server/**`, `packages/ui/**`, `apps/studio/web/app/**`, `apps/studio/web/components/**`, `apps/studio/web/lib/**`

## 2026-04-04 — Plugin System V2

- `PluginDefinition` sekarang generic `<TContributes>` — plugin bisa `contributes` context ke dependents
- `Contributes<T>` = `() => T | Promise<T>` — always a factory, sync or async
- `depends: PluginDependency[]` replace `dependencies: string[]` — support string (sort only) dan instance (typed ctx)
- `MergeContributes<Deps>` extracts contributed types dari instance deps via phantom brand field `_contributes_type`
- `definePlugin<Deps, TContributes>()` — overloaded: with `depends` → typed ctx, without → `BasePluginContext`
- `PluginCircularDepError` — DFS 3-color detection, throws before boot with clear cycle path
- Missing dep detection — warning + plugin disabled, no throw
- `PluginLoader.override()` — partial override for bridge pattern
- `PluginLoader.isLoaded()` + `getLoadOrder()` — introspection
- Boot V2: circular check → missing warn → topo sort → resolve contributes → merge ctx → setup
- Playground split: `plugins.ts` (all plugin defs), `checks.ts` (edge case tests), `index.ts` (runtime + chat)
- Files: `packages/types/src/index.ts`, `packages/kit/src/index.ts`, `packages/core/src/plugins/dependency.ts`, `packages/core/src/plugins/loader.ts`, `packages/core/src/index.ts`, `plugins/jiku.social/src/index.ts`, `apps/playground/index.ts`, `apps/playground/plugins.ts`, `apps/playground/checks.ts`

## 2026-04-04 — Stream Architecture, AbortController, Model Providers

- Tambah `createUIMessageStream` pattern dari AI SDK (inspired by SenkenNeo) ke `AgentRunner`
- `runtime.run()` sekarang return `JikuRunResult { run_id, conversation_id, stream }` — caller consume stream
- Tambah `AbortController` support via `JikuRunParams.abort_signal` → di-pass langsung ke `streamText()`
- Buat `ModelProviders` class di `packages/core/src/providers.ts` — multi-provider, lazy init
- Tambah `createProviderDef()` helper untuk wrap `@ai-sdk/*` providers
- `AgentDefinition` + `JikuRunParams` sekarang support `provider_id` + `model_id` override per-agent/run
- `JikuStreamWriter` + `ToolContext.writer` — tools bisa push custom typed data chunks ke stream
- Tambah `JikuDataTypes` (jiku-meta, jiku-usage, jiku-step-usage, jiku-tool-data) ke `@jiku/types`
- Tambah `isJikuDataChunk<K>()` type guard untuk narrowing stream chunks tanpa `any`
- `tsconfig.json` sekarang punya `include` eksplisit — tidak scan `../refs-senken-neo` lagi
- Files: `packages/types/src/index.ts`, `packages/core/src/types.ts`, `packages/core/src/runner.ts`, `packages/core/src/runtime.ts`, `packages/core/src/providers.ts`, `packages/core/src/index.ts`, `apps/playground/index.ts`, `tsconfig.json`


## 2026-04-04 — Foundation Implementation

- Implemented `@jiku/types` — all core interfaces: ToolDefinition, PluginDefinition, AgentDefinition, CallerContext, RuntimeContext, PolicyRule, JikuStorageAdapter, PluginLoaderInterface
- Implemented `@jiku/kit` — definePlugin, defineTool, defineAgent, getJikuContext factory functions
- Implemented `@jiku/core`:
  - `PluginLoader` — 3-phase boot with topological sort
  - `SharedRegistry` — tool/prompt/provider storage
  - `AgentRunner` — LLM loop with streamText, tool filtering by mode
  - `JikuRuntime` — container with updateRules() hot-swap
  - `resolveScope()` + `checkAccess()` — pure permission resolver
  - `buildSystemPrompt()` — mode-aware prompt builder
  - `MemoryStorageAdapter` — in-memory storage for testing
- Created `plugins/jiku.social` — built-in social media plugin with list_posts, create_post, delete_post tools
- Created `apps/playground` — step-by-step demo: admin vs member access, chat vs task mode, updateRules live
- Updated `docs/product_spec.md` and `docs/architecture.md`
- Added `@types/node`, `@ai-sdk/anthropic@3`, `ai@6`, `zod@4`, `hookable` dependencies
- Added `plugins/*` to workspace
- Files: `packages/types/src/index.ts`, `packages/kit/src/index.ts`, `packages/core/src/index.ts`, `packages/core/src/runtime.ts`, `packages/core/src/runner.ts`, `packages/core/src/resolver/scope.ts`, `packages/core/src/resolver/access.ts`, `packages/core/src/resolver/prompt.ts`, `packages/core/src/plugins/loader.ts`, `packages/core/src/plugins/registry.ts`, `packages/core/src/plugins/dependency.ts`, `packages/core/src/plugins/hooks.ts`, `packages/core/src/storage/memory.ts`, `plugins/jiku.social/src/index.ts`, `apps/playground/index.ts`

## 2026-04-04 — Bootstrap: Automated Docs Setup

- Created `CLAUDE.md` with full automated docs protocol
- Created `.claude/commands/docs-update.md` for `/docs-update` command
- Created stub files: `docs/product_spec.md`, `docs/architecture.md`
- Created builder docs: `current.md`, `tasks.md`, `changelog.md`, `decisions.md`, `memory.md`
- Created `docs/feats/` directory
- Files: `CLAUDE.md`, `.claude/commands/docs-update.md`, `docs/product_spec.md`, `docs/architecture.md`, `docs/builder/current.md`, `docs/builder/tasks.md`, `docs/builder/changelog.md`, `docs/builder/decisions.md`, `docs/builder/memory.md`
