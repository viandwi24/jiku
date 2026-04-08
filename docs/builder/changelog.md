# Changelog

## 2026-04-09 — Fix: Cron task conversation type should be 'task' not 'cron'

**Fixed:** `CronTaskScheduler.triggerTask()` was creating conversations with `type: 'cron'`, which is not a valid conversation type. Valid types are: `chat`, `task`, `heartbeat`.

**Changed:**
- `type: 'cron'` → `type: 'task'` in `scheduler.ts` line 66
- Trigger source still tracked via `metadata.trigger: 'cron'` and `metadata.cron_task_id` for audit trails

**Files touched:**
- `apps/studio/server/src/cron/scheduler.ts` — fixed conversation type in `triggerTask()`
- `docs/builder/memory.md` — documented conversation type convention

---

## 2026-04-08 — Add: connector_list tool for agent discovery

**Added:** Agent tool `connector_list` to discover connector IDs before calling connector tools.

**Context:** Connector tools (`connector_send`, `connector_run_action`, etc.) require a valid `connector_id` (UUID), not display_name. Agents could not easily map display_name → UUID.

**Solution:** New tool `builtin_connector_list` (no parameters) returns array of connectors with `{ id, plugin_id, display_name, status }`. Agent workflow:
1. Call `connector_list()` 
2. Find connector by matching `display_name` or `plugin_id`
3. Use returned `id` in subsequent connector tool calls

**Files touched:**
- `apps/studio/server/src/connectors/tools.ts` — added `connector_list` tool definition
- `docs/builder/memory.md` — added gotcha documentation

---

## 2026-04-08 — Fix: Credential inheritance for semantic memory embedding

**Changed:** Company-level credentials were invisible to the semantic memory embedding picker and runtime resolver. Two fixes applied:
1. `EmbeddingCredentialPicker` (frontend) now calls `api.credentials.available(projectId)` which hits `/api/projects/:pid/credentials/available` — returns both company-level and project-level credentials, instead of the old `api.credentials.listProject` which was project-only.
2. `resolveApiKey()` (backend, `embedding.ts`) fallback now uses `getAvailableCredentials(company_id, projectId)` instead of `getProjectCredentials(projectId)` — looks up `company_id` from project first, then calls the union query.

**Files touched:**
- `apps/studio/web/components/memory/memory-config.tsx` — `EmbeddingCredentialPicker` query key + fn changed
- `apps/studio/server/src/memory/embedding.ts` — `resolveApiKey()` fallback uses `getAvailableCredentials`

---

## 2026-04-08 — @jiku/browser: Browser Automation Package (replaces Plan 13)

**Changed:** Built `@jiku/browser` package from scratch — HTTP bridge to Vercel agent-browser CLI via CDP. Replaces failed Plan 13 OpenClaw port (~9000 lines) with clean ~600 line implementation.

- `packages/browser/` — new package with Express server, CLI spawner, parsed responses, AI error hints
- 30+ browser commands: navigation, interaction (click/fill/type/drag/upload), observation (snapshot/screenshot/pdf), tabs, cookies, storage, eval, batch
- Docker container: Chromium + Xvfb + noVNC + socat CDP proxy (non-root user, no `--no-sandbox`)
- Screenshot returns base64 (not file path) — client handles persistence
- `BrowserResult<T>` response with `hint` field for AI recovery suggestions (10 error patterns)
- `ensureConnected()` — auto-runs `agent-browser connect` once per CDP endpoint
- `resolveCdpEndpoint()` — converts `ws://` to `http://` format for agent-browser
- 52 unit tests (profile manager, spawner/buildArgs, parser/hints, server API)

**Files touched:**
- `packages/browser/src/types.ts`, `server.ts`, `spawner.ts`, `parser.ts`, `profile-manager.ts`, `main.ts`, `index.ts`
- `packages/browser/src/examples/cdp.ts`
- `packages/browser/src/tests/*.test.ts` (4 files)
- `packages/browser/docker/Dockerfile`, `docker/entrypoint.sh`, `docker-compose.yml`
- `packages/browser/README.md`, `SKILL.md`
- `docs/feats/browser.md` — rewritten for new architecture

## 2026-04-08 — Plan 15 Sprint 4: Inter-Agent + Tool Streaming + Progress

- **15.4 Enhanced Inter-Agent Calling:**
  - **Task Runner** (`apps/studio/server/src/task/runner.ts`): `RunTaskResult` now includes `tool_results` (structured tool call results) and `message_count`. `runTaskConversation()` extracts tool results from conversation messages after drain.
  - **run_task tool** (`apps/studio/server/src/task/tools.ts`): Response now includes `tool_results` + `message_count` for attach mode.
  - **agent_read_history tool** (new): Read recent conversation history of another agent. Returns text-only parts (strips tool internals). Supports specific conversation or latest.
  - **list_agents enhanced**: Now accepts `mode` (filter by chat/task) and `search` (filter by name/description). Returns `modes` field.
  - **Runtime Manager** (`apps/studio/server/src/runtime/manager.ts`): `agentReadHistoryTool` registered in all 3 agent registration paths.

- **15.1 Tool Streaming (Progressive Results):**
  - **Types** (`packages/types/src/index.ts`): Added `ToolStreamChunk` interface (`type: 'progress' | 'partial'`). Added `executeStream?` to `ToolDefinition` — optional async generator.
  - **Runner** (`packages/core/src/runner.ts`): When `executeStream` is defined on a tool, runner uses it and emits progress chunks via `jiku-tool-data` stream event. Non-streaming tools unchanged.

- **15.8 Progress Reporting Tool:**
  - **Progress Tool** (`apps/studio/server/src/task/progress-tool.ts`): New `report_progress` built-in tool. Agent calls it to report step/percentage/details. Appends to `conversation.metadata.progress_log` and emits via stream.
  - **Types** (`packages/types/src/index.ts`): Added `extra_built_in_tools` to `JikuRunParams` — enables per-run tool injection.
  - **Runner** (`packages/core/src/runner.ts`): Merges `extra_built_in_tools` with `agent.built_in_tools`.
  - **Task Runner** (`apps/studio/server/src/task/runner.ts`): Injects `buildProgressTool(conversationId)` via `extra_built_in_tools` for task mode runs.

- Files: `apps/studio/server/src/task/runner.ts`, `apps/studio/server/src/task/tools.ts`, `apps/studio/server/src/task/progress-tool.ts`, `apps/studio/server/src/runtime/manager.ts`, `packages/types/src/index.ts`, `packages/core/src/runner.ts`

## 2026-04-08 — Plan 15 Sprint 3: MCP Support + Tool On/Off + Semantic Memory

- **15.6 MCP Support + Tool On/Off Registry:**
  - **DB Schema** (`apps/studio/db/src/schema/mcp_servers.ts`): New `mcp_servers`, `project_tool_states`, `agent_tool_states` tables.
  - **Migration** (`apps/studio/db/src/migrations/0007_add_mcp_and_tool_states.sql`): 3 tables + indexes.
  - **DB Queries** (`apps/studio/db/src/queries/mcp_servers.ts`): Full CRUD for MCP servers + tool state get/set/delete.
  - **MCP Client** (`apps/studio/server/src/mcp/client.ts`): `MCPClientManager` class — connect/disconnect/getTools for stdio/sse/streamable-http transports. 5s connect timeout.
  - **MCP Wrapper** (`apps/studio/server/src/mcp/wrapper.ts`): `wrapMCPTool()` — converts MCP tool schema to Jiku `ToolDefinition`.
  - **Runner** (`packages/core/src/runner.ts`): Tool filtering by on/off state (agent override > project override > default enabled). Uses `tool_states` from `JikuRunParams`.
  - **Runtime Manager** (`apps/studio/server/src/runtime/manager.ts`): Loads tool states from DB before each run, passes to runner.
  - **API Routes** (`apps/studio/server/src/routes/mcp-servers.ts`, `tool-states.ts`): MCP server CRUD + test endpoint. Tool state get/set/reset per agent.
  - **Types** (`packages/types/src/index.ts`): Added `ToolStatesMap` type. Extended `JikuRunParams` with `tool_states`.
  - **Web API** (`apps/studio/web/lib/api.ts`): Added `McpServerItem` type. Added `api.mcpServers.*` and `api.toolStates.*` methods.
  - **UI** (`apps/studio/web/.../agents/[agent]/tools/page.tsx`): Tool list now shows toggle switches per tool (enabled/disabled). Loads + saves agent tool states.

- **15.2 Semantic Memory (Qdrant + Hybrid Scoring):**
  - **Docker Compose**: Added Qdrant v1.13.2 to both dev (`apps/studio/server/docker-compose.yml`) and prod (`infra/dokploy/docker-compose.yml`).
  - **Embedding Service** (`apps/studio/server/src/memory/embedding.ts`): `EmbeddingService` abstraction. Uses OpenAI `text-embedding-3-small` (1536 dim). Resolves API key from project credentials or env.
  - **Qdrant Client** (`apps/studio/server/src/memory/qdrant.ts`): `MemoryVectorStore` — upsert/delete/search/ensureCollection. Graceful fallback on connection errors.
  - **Relevance Scoring** (`packages/core/src/memory/relevance.ts`): `scoreMemory()` now supports 4-factor hybrid scoring (keyword + semantic + recency + access). `findRelevantMemories()` accepts optional `semanticScores` map.
  - **Types** (`packages/types/src/index.ts`): Added `semantic?` to `ResolvedMemoryConfig.relevance.weights`.

- Files: `apps/studio/db/src/schema/mcp_servers.ts`, `apps/studio/db/src/queries/mcp_servers.ts`, `apps/studio/db/src/migrations/0007_add_mcp_and_tool_states.sql`, `apps/studio/server/src/mcp/client.ts`, `apps/studio/server/src/mcp/wrapper.ts`, `packages/core/src/runner.ts`, `apps/studio/server/src/runtime/manager.ts`, `apps/studio/server/src/routes/mcp-servers.ts`, `apps/studio/server/src/routes/tool-states.ts`, `apps/studio/server/src/index.ts`, `packages/types/src/index.ts`, `apps/studio/web/lib/api.ts`, `apps/studio/web/.../tools/page.tsx`, `apps/studio/server/docker-compose.yml`, `infra/dokploy/docker-compose.yml`, `apps/studio/server/src/memory/embedding.ts`, `apps/studio/server/src/memory/qdrant.ts`, `packages/core/src/memory/relevance.ts`

## 2026-04-08 — Plan 15 Sprint 2: Channel Routing + Structured Persona

- **15.5 Channel Routing Rules:**
  - **DB Schema** (`apps/studio/db/src/schema/connectors.ts`): Added `priority`, `trigger_regex`, `schedule_filter` to `connector_bindings`. Added `match_mode`, `default_agent_id` to `connectors`.
  - **Migration** (`apps/studio/db/src/migrations/0006_add_channel_routing.sql`): 5 column additions.
  - **DB Queries** (`apps/studio/db/src/queries/connector.ts`): Updated `createBinding`, `updateBinding`, `updateConnector` to accept new fields.
  - **Event Router** (`apps/studio/server/src/connectors/event-router.ts`): `matchesTrigger()` now supports regex + schedule filter. `routeConnectorEvent()` sorts by priority (descending), supports `first` match mode, implements fallback default agent.
  - **Types** (`packages/types/src/index.ts`): Extended `ConnectorBinding` with `priority`, `trigger_regex`, `schedule_filter`. Extended `ConnectorRecord` with `match_mode`, `default_agent_id`.
  - **Web Types** (`apps/studio/web/lib/api.ts`): Updated `ConnectorBinding` and `ConnectorItem` interfaces.
  - **UI** (`apps/studio/web/.../bindings/[binding]/page.tsx`): Added "Routing" card with priority input and trigger regex field.

- **15.9 Structured Persona:**
  - **Types** (`packages/types/src/index.ts`): Added `PersonaTraits` interface (formality, verbosity, humor, empathy, expertise_display) with `DEFAULT_PERSONA_TRAITS`. Extended `PersonaSeed` with `traits` and `boundaries`.
  - **Builder** (`packages/core/src/memory/builder.ts`): `formatPersonaSection()` now injects "Communication Style" and "Boundaries" sections into system prompt when traits/boundaries are set.
  - **Web Types** (`apps/studio/web/lib/api.ts`): Added `PersonaTraits` interface, extended `PersonaSeed`.
  - **UI** (`apps/studio/web/.../agents/[agent]/persona/page.tsx`): Added "Communication Traits" section with toggle buttons for each trait dimension. Added "Boundaries" section with add/remove list. Saves to persona_seed via existing API.

- Files: `apps/studio/db/src/schema/connectors.ts`, `apps/studio/db/src/queries/connector.ts`, `apps/studio/db/src/migrations/0006_add_channel_routing.sql`, `apps/studio/server/src/connectors/event-router.ts`, `packages/types/src/index.ts`, `packages/core/src/memory/builder.ts`, `apps/studio/web/lib/api.ts`, `apps/studio/web/.../bindings/[binding]/page.tsx`, `apps/studio/web/.../persona/page.tsx`

## 2026-04-08 — Plan 15 Sprint 1: Conversation Queue + Auto-Reply (Backend)

- **Conversation Queue** (`apps/studio/server/src/runtime/conversation-queue.ts`): New `ConversationQueue` class with in-memory FIFO queue per conversation. Enqueues messages when agent is busy, processes them after current run completes. Max 10 per conversation, 5-minute timeout. Exported singleton `conversationQueue`.
- **Auto-Reply Evaluator** (`apps/studio/server/src/auto-reply/evaluator.ts`): Rule-based auto-reply before LLM invocation. Supports 4 trigger types: `exact`, `contains`, `regex`, `command`. Checks availability schedule first (offline message), then rules in order.
- **Schedule Utility** (`apps/studio/server/src/utils/schedule.ts`): `isWithinSchedule()` — timezone-aware availability checking using `Intl.DateTimeFormat`. Graceful fallback if timezone invalid.
- **Types** (`packages/types/src/index.ts`): Added `AgentQueueMode`, `AutoReplyRule`, `ScheduleHours`, `AvailabilitySchedule` types.
- **DB Schema** (`apps/studio/db/src/schema/agents.ts`): Added `queue_mode varchar(20) DEFAULT 'off'`, `auto_replies jsonb DEFAULT '[]'`, `availability_schedule jsonb DEFAULT NULL` columns.
- **Migration** (`apps/studio/db/src/migrations/0005_add_queue_and_auto_reply.sql`): Adds 3 columns to agents table.
- **Chat Route** (`apps/studio/server/src/routes/chat.ts`): Auto-reply intercept before LLM (returns SSE stream with auto-reply text). Queue mode intercept: returns 202 with queue position if running + queue enabled. Queue drain on run completion (recursive FIFO processing).
- **Event Router** (`apps/studio/server/src/connectors/event-router.ts`): Auto-reply intercept for connector messages (direct response, skip LLM). Queue mode: `ack_queue` sends acknowledgment, enqueues message. Queue drain via `drainConnectorQueue()` after run completion.
- **Agent API** (`apps/studio/server/src/routes/agents.ts`): PATCH endpoint accepts `queue_mode`, `auto_replies`, `availability_schedule`.
- **Web API** (`apps/studio/web/lib/api.ts`): Added `queue_mode`, `auto_replies`, `availability_schedule` to Agent interface. Added `AutoReplyRule`, `ScheduleHours`, `AvailabilitySchedule` types.
- **Agent Layout** (`apps/studio/web/.../agents/[agent]/layout.tsx`): Added "auto-reply" nav item with `MessageCircleReply` icon.
- **Auto-Reply Page** (`apps/studio/web/.../agents/[agent]/auto-reply/page.tsx`): Full settings page with 3 sections: Queue Mode selector (off/queue/ack_queue), Auto-Reply Rules editor (add/remove/toggle rules with trigger type, pattern, response), Availability Schedule editor (enable/disable, timezone, day/hour windows, offline message).
- Files: `apps/studio/server/src/runtime/conversation-queue.ts`, `apps/studio/server/src/auto-reply/evaluator.ts`, `apps/studio/server/src/utils/schedule.ts`, `packages/types/src/index.ts`, `apps/studio/db/src/schema/agents.ts`, `apps/studio/db/src/migrations/0005_add_queue_and_auto_reply.sql`, `apps/studio/server/src/routes/chat.ts`, `apps/studio/server/src/connectors/event-router.ts`, `apps/studio/server/src/routes/agents.ts`, `apps/studio/web/lib/api.ts`, `apps/studio/web/.../agents/[agent]/layout.tsx`, `apps/studio/web/.../agents/[agent]/auto-reply/page.tsx`

## 2026-04-07 — Cron Task System: Full End-to-End Implementation

- **DB schema** (`apps/studio/db/src/schema/cron_tasks.ts`): New `cron_tasks` table with `id, project_id, name, description, cron_expression, agent_id, prompt, caller_id, caller_role, caller_is_superadmin, run_count, last_run_at, created_at, updated_at` columns. Caller context snapshotted at creation time for permission checks.
- **Agent config** (`apps/studio/db/src/schema/agents.ts`): Added `cron_task_enabled: boolean DEFAULT true` column — when false, cron tools not injected into that agent.
- **Migration** (`apps/studio/db/src/migrations/0004_add_cron_tasks.sql`): Creates `cron_tasks` table + adds `cron_task_enabled` to `agents`.
- **CRUD queries** (`apps/studio/db/src/queries/cron_tasks.ts`): `createCronTask`, `getCronTaskById`, `getCronTasksByProject`, `getCronTasksByAgent`, `updateCronTask`, `deleteCronTask`, `incrementRunCount`, `getEnabledCronTasks` (for scheduler).
- **Cron scheduler** (`apps/studio/server/src/cron/scheduler.ts`): `CronTaskScheduler` class using `croner@10.0.1`. Methods: `scheduleTask` (parse cron expression + register), `triggerTask` (run conversation), `rescheduleTask`, `stopTask`, `stopAll`, `loadAndScheduleProject` (boot all active tasks). Integrated into `RuntimeManager.wakeUp()`/`syncAgent()`/`stopAll()`.
- **Cron tools** (`apps/studio/server/src/cron/tools.ts`): Four agent tools `buildCronCreateTool`, `buildCronListTool`, `buildCronUpdateTool`, `buildCronDeleteTool` — CRUD for cron tasks, security model enforces: superadmin can modify all, non-superadmin can only modify tasks they created + only if caller role unchanged.
- **REST API** (`apps/studio/server/src/routes/cron-tasks.ts`): 6 endpoints — `GET /api/projects/:pid/cron-tasks` (list), `POST /api/projects/:pid/cron-tasks` (create), `GET /api/cron-tasks/:id` (get), `PATCH /api/cron-tasks/:id` (update), `DELETE /api/cron-tasks/:id` (delete), `POST /api/cron-tasks/:id/trigger` (manual trigger). All guarded with permission checks.
- **Web API client** (`apps/studio/web/lib/api.ts`): Added `CronTask` type + `api.cronTasks.list/create/get/update/delete/trigger` methods. Added `cron_task_enabled` to `Agent` type.
- **CronExpressionInput component** (`apps/studio/web/components/cron/cron-expression-input.tsx`): New shared component with realtime validation using `cronstrue@3.14.0`. Shows green checkmark for valid expressions, red error text for invalid. Supports keyboard shortcuts (Ctrl+Space to explain).
- **Frontend pages**: List page (table with enable/edit/delete), Create page (form with CronExpressionInput), Edit/view page (form with task history preview).
- **Agent integration** (`agents/[agent]/task/page.tsx`): Added `cron_task_enabled` toggle to agent task settings page — allows selectively disabling cron execution per agent without deleting the tasks.
- **Sidebar nav** (`components/sidebar/project-sidebar.tsx`): Added "Cron Tasks" nav item with Clock icon above Browser, guarded by `cron_tasks:read` permission.
- **Conversation traceability**: Cron-triggered conversations get `metadata.cron_task_id` and `metadata.trigger: 'cron_task'`. Conversation type supports `'cron'` as valid type.
- **Permissions** (`packages/types/src/index.ts`): Added `CRON_TASKS_READ` and `CRON_TASKS_WRITE` to `PERMISSIONS` const.
- Files: `apps/studio/db/src/schema/cron_tasks.ts`, `apps/studio/db/src/schema/agents.ts`, `apps/studio/db/src/queries/cron_tasks.ts`, `apps/studio/db/src/migrations/0004_add_cron_tasks.sql`, `apps/studio/server/src/cron/scheduler.ts`, `apps/studio/server/src/cron/tools.ts`, `apps/studio/server/src/routes/cron-tasks.ts`, `apps/studio/server/src/runtime/manager.ts`, `apps/studio/web/lib/api.ts`, `apps/studio/web/components/cron/cron-expression-input.tsx`, `apps/studio/web/app/(app)/studio/companies/[company]/projects/[project]/cron-tasks/**`, `packages/types/src/index.ts`

## 2026-04-08 — Usage Monitor Charts: switched to raw ResponsiveContainer (recharts)

- **Chart rendering fix** (`apps/studio/web/components/usage/usage-charts.tsx`): Replaced shadcn `ChartContainer` wrapper with raw `recharts` `ResponsiveContainer` using explicit `height={180}` prop. `ChartContainer` wraps `ResponsiveContainer` with `aspect-video` which conflicts with CSS height classes — charts rendered blank even though data was present. Direct `height` prop on `ResponsiveContainer` is the reliable pattern.
- **Styling maintained**: Tooltip, Legend, axis ticks all styled to match theme via inline CSS vars (`hsl(var(--popover))`, `hsl(var(--border))`, `hsl(var(--muted-foreground))`). Hard-coded `CHART_COLORS` object replaces the `var(--color-*)` pattern (which only works via `ChartContainer` context).
- Files: `apps/studio/web/components/usage/usage-charts.tsx`

## 2026-04-08 — Theme toggle button in all sidebar footers

- **New component** (`apps/studio/web/components/theme-toggle.tsx`): `ThemeToggle` button using `next-themes` `useTheme`. Shows `Sun` icon in light mode, `Moon` in dark mode with CSS cross-fade transition (`rotate` + `scale`). Uses `Button` from `@jiku/ui` with `variant="ghost" size="icon"`.
- **All 3 sidebars updated** — footer now wraps the user dropdown + `ThemeToggle` in a `flex items-center gap-1` div. Toggle sits to the right of the user action button:
  - `apps/studio/web/components/sidebar/root-sidebar.tsx`
  - `apps/studio/web/components/sidebar/company-sidebar.tsx`
  - `apps/studio/web/components/sidebar/project-sidebar.tsx`
- `ThemeProvider` with `attribute="class"` already configured in `components/providers.tsx` — no additional setup needed.
- Files: `apps/studio/web/components/theme-toggle.tsx` *(new)*, `components/sidebar/root-sidebar.tsx`, `components/sidebar/company-sidebar.tsx`, `components/sidebar/project-sidebar.tsx`

## 2026-04-07 — Usage Monitor Enhancement: Charts + Total Tokens + Estimated Cost

- **`aggregateByDay(logs)`** added to `apps/studio/web/lib/usage.ts` — groups logs into daily time-series buckets for the area chart.
- **`aggregateByAgent(logs)`** added to `apps/studio/web/lib/usage.ts` — groups logs by agent for the project-level bar chart.
- **`estimateTotalCost(logs, pricingMap)`** added to `apps/studio/web/lib/usage.ts` — sums cost across all logs using model-specific pricing with the same fallback rates as `estimateCost`.
- **`TokenUsageAreaChart`** — new component in `apps/studio/web/components/usage/usage-charts.tsx`. Stacked area chart (input vs output tokens over time) using shadcn `ChartContainer` + recharts `AreaChart`.
- **`AgentUsageBarChart`** — new component in same file. Horizontal bar chart showing total tokens per agent (top 10), used on the project usage page.
- **Agent usage page** (`apps/studio/web/app/.../agents/[agent]/usage/page.tsx`) — stats grid expanded from 3 → 5 cards (added Total Tokens + Estimated Cost). `TokenUsageAreaChart` inserted between stats and table.
- **Project usage page** (`apps/studio/web/app/.../projects/[project]/usage/page.tsx`) — stats grid expanded from 3 → 5 cards (same additions, all filter-aware). Two-column chart grid added (area chart + agent bar chart), both react to active filters via `useMemo`.
- **Project dashboard** (`apps/studio/web/app/.../projects/[project]/page.tsx`) — "Activity" card now shows actual total token count from usage summary API instead of "---".
- Files: `apps/studio/web/lib/usage.ts`, `apps/studio/web/components/usage/usage-charts.tsx`, `apps/studio/web/app/(app)/studio/companies/[company]/projects/[project]/agents/[agent]/usage/page.tsx`, `apps/studio/web/app/(app)/studio/companies/[company]/projects/[project]/usage/page.tsx`, `apps/studio/web/app/(app)/studio/companies/[company]/projects/[project]/page.tsx`

## 2026-04-08 — Conversation Management: Title Generation, Manual Rename, Soft Delete

- **Title generation** (`apps/studio/server/src/title/generate.ts`): New service that auto-generates conversation titles using the agent's own configured LLM after the first user message. Max 50 chars. Fire-and-forget (non-blocking).
- **Auto-trigger on first message** (`apps/studio/server/src/routes/chat.ts`): After first message is stored, `generateTitle()` is called asynchronously if conversation title is null.
- **Manual title rename endpoint** (`apps/studio/server/src/routes/conversations.ts`): New `PATCH /conversations/:id/title` route accepts `{ title: string }` body, validates max length, updates conversation.
- **Soft delete** (`apps/studio/db/src/schema/conversations.ts`): Added `deleted_at timestamp` column to conversations table. Not hard-deleted, just filtered from query results.
- **Soft delete queries** (`apps/studio/db/src/queries/conversation.ts`): New `softDeleteConversation(id)` function. `getConversationsByProject()` now filters `WHERE deleted_at IS NULL`.
- **Delete endpoint** (`apps/studio/server/src/routes/conversations.ts`): New `DELETE /conversations/:id` route calls `softDeleteConversation()`.
- **Web API** (`apps/studio/web/lib/api.ts`): Added `api.conversations.rename(convId, title)` and `api.conversations.delete(convId)`.
- **Inline title editing** (`apps/studio/web/components/chat/conversation-viewer.tsx`): Click pencil icon on conversation title to edit inline. Enter or blur to save, Escape to cancel. Displays title as primary text with agent name as secondary.
- **Sidebar delete** (`apps/studio/web/components/chat/conversation-list-panel.tsx`): Trash icon appears on hover. Click opens `AlertDialog` confirm dialog. Confirmed delete removes from sidebar and navigates away if deleting current conversation. Sidebar now shows title (primary) + agent name (secondary) instead of last_message.
- **Avatar removal**: Removed Avatar/AvatarFallback from both header and sidebar — agent avatar feature not yet implemented.
- **AlertDialog for delete project** (`apps/studio/web/app/.../settings/general/page.tsx`): Replaced native `confirm()` with `AlertDialog` component from `@jiku/ui`.
- **Migration**: Created `0003_add_conversation_deleted_at.sql` (requires `bun run db:push`).
- Files: `apps/studio/server/src/title/generate.ts`, `apps/studio/server/src/routes/chat.ts`, `apps/studio/server/src/routes/conversations.ts`, `apps/studio/db/src/schema/conversations.ts`, `apps/studio/db/src/queries/conversation.ts`, `apps/studio/db/src/migrations/0003_add_conversation_deleted_at.sql`, `apps/studio/web/lib/api.ts`, `apps/studio/web/components/chat/conversation-viewer.tsx`, `apps/studio/web/components/chat/conversation-list-panel.tsx`, `apps/studio/web/app/(app)/studio/companies/[company]/projects/[project]/settings/general/page.tsx`

## 2026-04-07 — Browser automation marked failed + UI rendering fixes

- **Screenshot renders as image in chat UI** (`packages/ui/src/components/ai-elements/tool.tsx`): `ToolOutput` component now handles `content[]` arrays (Vercel AI SDK tool output format). Image parts (`type: 'image'`) render as `<img>` with base64 src. Text parts render as CodeBlock. Single-image case renders without wrapper div.
- **Server path removed from screenshot result** (`apps/studio/server/src/browser/execute.ts`): `screenshot` case no longer returns `{ type: 'text', text: 'Screenshot saved: /path...' }` — only the image data part is returned. Prevents server filesystem paths from being exposed to end users.
- **Browser tool prompt improved** (`apps/studio/server/src/browser/tool.ts`): Added explicit WORKFLOW steps and COMMON MISTAKES section to tool description. AI no longer claims it cannot browse the web.
- **Browser automation marked FAILED** (`docs/`): ADR-026 added. `current.md`, `tasks.md`, `decisions.md`, `feats/browser.md` all updated to reflect that Plan 13 does not meet requirements and will be removed before MVP.
- Files: `packages/ui/src/components/ai-elements/tool.tsx`, `apps/studio/server/src/browser/execute.ts`, `apps/studio/server/src/browser/tool.ts`, `docs/builder/decisions.md`, `docs/builder/current.md`, `docs/builder/tasks.md`, `docs/feats/browser.md`

## 2026-04-07 — Plan 15: On-Demand Skills System

- **DB schema** (`apps/studio/db/src/schema/skills.ts`): New `project_skills`, `project_skill_files`, `agent_skills` tables. Skills are folder-like structures (multiple markdown files with an entrypoint) assigned to agents per-project.
- **CRUD queries** (`apps/studio/db/src/queries/skills.ts`): Full CRUD for skills, files, and agent assignments. `getAgentAlwaysSkills` / `getAgentOnDemandSkills` for runtime injection.
- **Skill service** (`apps/studio/server/src/skills/service.ts`): `SkillService` — loads entrypoints, nested files, builds "always" system prompt section + on-demand hint. Enforces 50 KB/file, 200 KB/skill limits.
- **Skill tools** (`apps/studio/server/src/skills/tools.ts`): `buildSkillTools(agentId)` → 3 built-in tools: `skill_list`, `skill_activate`, `skill_read_file`. Agent calls these to discover and load knowledge on-demand.
- **API routes** (`apps/studio/server/src/routes/skills.ts`): Full REST API: project skills CRUD, file tree CRUD, agent skill assignment CRUD. Calls `syncAgent()` after every mutation.
- **Core integration**: `buildSystemPrompt` now accepts `skill_section` + `skill_hint`. `AgentRunner` + `JikuRuntime.addAgent` forward skill context. `previewRun` includes `skill` segment. `ContextSegment.source` union extended with `'skill'`.
- **Runtime manager**: All 3 agent registration paths (`wakeUp`, `syncProjectTools`, `syncAgent`) now load skill tools + sections per-agent.
- **Web UI**: Project skills page (skill editor with file tree + markdown editor) + agent skills page (assign/remove skills, toggle always/on-demand mode). Skills nav added to project sidebar and agent layout.
- **Migration**: `apps/studio/db/src/migrations/0001_unique_wong.sql` generated.

## 2026-04-07 — Plan 12: Route Security Audit Completion + Agent Visibility Feature

- **`loadPerms` exported** (`apps/studio/server/src/middleware/permission.ts`): Changed from private to `export async function loadPerms(...)`. Enables route handlers to call it inline after manually injecting `res.locals['project_id']` — needed for routes where the entity param is not `:pid`/`:aid`.
- **Memory route guarded** (`apps/studio/server/src/routes/memory.ts`): `DELETE /memories/:id` — looks up memory, sets `res.locals['project_id'] = memory.project_id`, calls inline `loadPerms`, checks `memory:delete`.
- **Connector routes guarded** (`apps/studio/server/src/routes/connectors.ts`): Added `requireConnectorPermission(permission)` factory middleware — resolves connector → `project_id`, then calls `loadPerms`. Applied to all 16 `/connectors/:id*` routes (read/write/activate/bindings/identities/events/messages/stream).
- **Credential routes guarded** (`apps/studio/server/src/routes/credentials.ts`): Added `checkCredentialPermission` async helper. Only enforces ACL for `scope === 'project'` credentials; company-scoped credentials are accessible to any authenticated user. Applied to PATCH/DELETE/test routes.
- **Preview routes guarded** (`apps/studio/server/src/routes/preview.ts`): `POST /agents/:aid/preview` → `requirePermission('agents:read')`. `POST /conversations/:id/preview` → inline `loadPerms` after resolving agent, requires `chats:read`.
- **Conversation routes guarded** (`apps/studio/server/src/routes/conversations.ts`): `GET /conversations/:id` and `GET /conversations/:id/messages` → inline `loadPerms` after resolving agent, requires `chats:read`.
- **Run routes guarded** (`apps/studio/server/src/routes/runs.ts`): `GET /conversations/:id` and `POST /conversations/:id/cancel` → inline `loadPerms` after resolving agent, requires `runs:read`.
- **Attachment routes guarded** (`apps/studio/server/src/routes/attachments.ts`): All 4 attachment endpoints guarded with `requirePermission` (upload/list/delete → `chats:create`; token → `chats:read`).
- **Project routes guarded** (`apps/studio/server/src/routes/projects.ts`): `PATCH /projects/:pid` → `requirePermission('settings:write')`. `GET /projects/:pid/usage` → `requirePermission('settings:read')`.
- **Policy routes guarded** (`apps/studio/server/src/routes/policies.ts`): Added `requireCompanyMember` (caller is member of `:cid` company) and `requirePolicyCompanyMember` (looks up policy → company, checks membership). Applied to all 8 company policy routes.
- **Agent visibility filtering** (`apps/studio/server/src/routes/agents.ts`): `GET /projects/:pid/agents` now filters agents by `agentRestrictions` for non-superadmin, non-`agents:write` users. Superadmins and users with `agents:write` see all agents. Agent-to-agent calls via runtime engine are unaffected.
- **`AgentVisibilityConfig` component** (`apps/studio/web/components/permissions/agent-visibility-config.tsx`): New reusable component. Props: `{ agentId, projectId }`. Shows per-member Switch toggles. Superadmin and `agents:write` role members shown as "Always visible" (read-only). `canManage` gate: only renders interactive Switch if caller has `members:write` or is superadmin. Uses `api.acl.setAgentRestrictions` mutation.
- **Agent Access tab in project settings** (`apps/studio/web/app/.../settings/permissions/page.tsx`): Added third "Agent Access" tab. View by member — shows which agents each member can see, with per-agent Switch toggles and "Hide all" / "Show all" buttons.
- **Agent permissions tab** (`apps/studio/web/app/.../agents/[agent]/permissions/page.tsx`): Added `AgentVisibilityConfig` at top (Member Visibility section) above `AgentPolicyConfig`. View by agent — shows which members can see this specific agent.
- Files: `middleware/permission.ts`, `routes/memory.ts`, `routes/connectors.ts`, `routes/credentials.ts`, `routes/preview.ts`, `routes/conversations.ts`, `routes/runs.ts`, `routes/attachments.ts`, `routes/projects.ts`, `routes/policies.ts`, `routes/agents.ts`, `components/permissions/agent-visibility-config.tsx` *(new)*, `settings/permissions/page.tsx`, `agents/[agent]/permissions/page.tsx`

## 2026-04-07 — Task System Enhancements

- **`task_allowed_agents` column** (`apps/studio/db/src/schema/agents.ts`): New `text[]|null` column on `agents` table. `null` = allow all, `[]` = deny all, `[id…]` = specific agents. Migration generated.
- **`list_agents` tool** (`apps/studio/server/src/task/tools.ts`): New built-in tool exposed in `chat` and `task` modes. Returns all agents in the project (id, name, slug, description) — lets agents discover delegation targets.
- **`run_task` delegation guard** (`apps/studio/server/src/task/tools.ts`): When `agent_id` differs from the caller agent, `checkTaskDelegationPermission()` enforces `task_allowed_agents`. Returns `{ status: 'error', message }` if denied.
- **Heartbeat task-mode guard** (`apps/studio/server/src/task/heartbeat.ts`): `scheduleAgent()` skips scheduling if `task` not in `allowed_modes`. `triggerHeartbeat()` throws if task mode not enabled. Reschedule after run also checks task mode.
- **`serializeToolSchema()`** (`packages/core/src/runner.ts`): Converts Zod schema to plain JSON Schema via `zodToJsonSchema` before sending in preview API response. Fixes "No parameters" in context preview Tools tab.
- **Agent nav: "task" tab** (`apps/studio/web/app/.../agents/[agent]/layout.tsx` + `task/page.tsx`): New dedicated page for task delegation config (allow all / deny all / specific agents with toggle switches per agent).
- **Tools page** (`apps/studio/web/app/.../agents/[agent]/tools/page.tsx`): Now shows available tools list only (delegation section removed — moved to task tab).
- **Memory config desync fix** (`apps/studio/web/app/.../agents/[agent]/memory/page.tsx`): Replaced `initialized` flag + if-in-render pattern with `useEffect` synced to `resolvedData`. Selector buttons now correctly reflect saved values after save.
- Files: `schema/agents.ts`, `task/tools.ts`, `task/heartbeat.ts`, `runtime/manager.ts`, `packages/core/src/runner.ts`, `web/lib/api.ts`, `agents/[agent]/layout.tsx`, `agents/[agent]/task/page.tsx`, `agents/[agent]/tools/page.tsx`, `agents/[agent]/memory/page.tsx`


## 2026-04-07 — Plan 12: Permission Guard System + Policy Config Component

- **`useProjectPermission` hook** (`apps/studio/web/lib/permissions.ts`): Core hook wrapping `api.acl.getMyPermissions`. Returns `{ can(permission), isSuperadmin, isMember, isLoading }`. `can()` is optimistic (true while loading). Slug variant `useProjectPermissionBySlugs` resolves projectId from slugs.
- **Guard components** (`apps/studio/web/components/permissions/permission-guard.tsx`): `PermissionGuard` (inline, hide/show), `ProjectPageGuard` (page-level 403 UI), `withPermissionGuard` HOC (wraps page components automatically).
- **All project pages guarded** via `withPermissionGuard`: chats, runs, memory, agents, plugins, channels, usage, disk, browser.
- **Backend routes guarded**: agents, conversations, runs, memory, plugins, connectors, credentials — all with `requirePermission()`.
- **`requirePermission` refactored** (`apps/studio/server/src/middleware/permission.ts`): Added `resolveProjectId()` helper (handles `:pid`, `:aid`→agent lookup, `res.locals`). Unified `loadPerms()` with caching.
- **`AgentPolicyConfig` component** (`apps/studio/web/components/permissions/agent-policy-config.tsx`): Reusable policy editor for a single agent. Used in agent settings page (full) and project settings policies page (compact/accordion).
- **Project settings Policies tab** (`apps/studio/web/app/.../settings/policies/page.tsx`): Shows all agents with accordion to edit their policies without navigating to each agent.
- **Docs updated**: `docs/plans/12-acl.md` — added Section 13 (guard system notes). `docs/feats/permission-policy.md` — rewritten to cover both layers (roles+permissions and policies+rules).
- Files: `lib/permissions.ts`, `components/permissions/permission-guard.tsx`, `components/permissions/agent-policy-config.tsx`, `settings/policies/page.tsx`, `middleware/permission.ts`, 9 project page files

## 2026-04-07 — Plan 12: ACL Frontend (permissions settings page)

- **API client** (`apps/studio/web/lib/api.ts`): Added `api.acl.*` — listRoles, createRole, updateRole, deleteRole, listMembers, getMyPermissions, assignRole, setSuperadmin, removeMember, listMyInvitations, acceptInvitation, declineInvitation, listCompanyInvitations, sendInvitation, cancelInvitation.
- **ACL types** (`apps/studio/web/lib/api.ts`): Added `ProjectRole`, `ProjectMembership`, `ProjectMember`, `ResolvedProjectPermissions`, `InvitationItem`.
- **Permissions page** (`apps/studio/web/app/.../settings/permissions/page.tsx`): Replaced "Coming Soon" stub with full Members + Roles management UI. Members tab: list with role dropdown, superadmin star, remove button. Roles tab: list with permission counts, role editor dialog with permission checkboxes grouped by resource, preset import buttons.
- **`@jiku/types` dependency**: Added to `apps/studio/web/package.json` — needed for `PERMISSIONS` const and `ROLE_PRESETS`.
- Files: `apps/studio/web/lib/api.ts`, `apps/studio/web/app/.../settings/permissions/page.tsx`, `apps/studio/web/package.json`

## 2026-04-07 — Plan 12: ACL System (project roles, memberships, invitations)

- **DB schema** (`apps/studio/db/src/schema/acl.ts`): 4 new tables — `project_roles` (custom roles per project with `permissions text[]`), `project_memberships` (user in project with `is_superadmin`, `agent_restrictions` jsonb, `tool_restrictions` jsonb), `invitations` (email invite with `project_grants` jsonb, status, 7-day expiry), `superadmin_transfers` (audit log).
- **Relations** (`apps/studio/db/src/schema/relations.ts`): Added relations for all 4 new tables. Updated `projectsRelations`, `usersRelations`, `companiesRelations`.
- **DB queries** (`apps/studio/db/src/queries/acl.ts`): Full CRUD for project roles, memberships, invitations. `resolveProjectPermissions()` resolves isSuperadmin + permissions + restrictions for a user in a project.
- **`@jiku/types` permissions** (`packages/types/src/index.ts`): Added `PERMISSIONS` const (18 action strings), `Permission` type, `ROLE_PRESETS` (admin/manager/member/viewer), `ResolvedPermissions` interface, `ProjectGrant` interface.
- **Permission middleware** (`apps/studio/server/src/middleware/permission.ts`): `requirePermission(permission)` and `requireSuperadmin()` middleware. Resolves permissions from DB, caches in `res.locals`. Superadmin bypasses all permission checks.
- **Project roles routes** (`apps/studio/server/src/routes/acl-roles.ts`): CRUD for `/api/projects/:pid/roles` + `/roles/presets` endpoint.
- **Project members routes** (`apps/studio/server/src/routes/acl-members.ts`): List members, `me/permissions`, assign role, grant/revoke superadmin, agent/tool restrictions, remove member. Prevents removal of last superadmin.
- **Invitation routes** (`apps/studio/server/src/routes/acl-invitations.ts`): User-side: list pending invites, accept (creates memberships from project_grants), decline. Admin-side: send invite, cancel invite, list company invitations.
- **Auto-create superadmin** (`apps/studio/server/src/routes/projects.ts`): When creating a project, creator gets `is_superadmin: true` membership automatically.
- Files: `apps/studio/db/src/schema/acl.ts` *(new)*, `apps/studio/db/src/schema/index.ts`, `apps/studio/db/src/schema/relations.ts`, `apps/studio/db/src/queries/acl.ts` *(new)*, `apps/studio/db/src/index.ts`, `packages/types/src/index.ts`, `apps/studio/server/src/middleware/permission.ts` *(new)*, `apps/studio/server/src/routes/acl-roles.ts` *(new)*, `apps/studio/server/src/routes/acl-members.ts` *(new)*, `apps/studio/server/src/routes/acl-invitations.ts` *(new)*, `apps/studio/server/src/index.ts`, `apps/studio/server/src/routes/projects.ts`

## 2026-04-06 — Chat Image Attachments + ImageGallery preview component

- **`project_attachments` table** (`apps/studio/db/src/schema/attachments.ts`): New DB table for ephemeral chat attachments. Separate from `project_files` (virtual disk). Stores S3 key, filename, mime_type, size_bytes, scope (per_user/shared). S3 key layout: `jiku/attachments/{projectId}/{conversationId}/{uuid}.{ext}`.
- **Attachment upload/serve routes** (`apps/studio/server/src/routes/chat.ts`): `POST /api/attachments` — multipart upload, validates mime + size, stores in S3. `GET /api/attachments/:id` — proxy serve from S3 with auth check.
- **Image rendering in conversation** (`apps/studio/web/components/chat/conversation-viewer.tsx`): Attachment images rendered inline in chat messages. Each image is clickable to open fullscreen gallery.
- **`ImageGallery` component** (`apps/studio/web/components/ui/image-gallery.tsx`): Fullscreen overlay gallery. Features: fit-to-screen image display, prev/next navigation (arrow keys + buttons), minimap thumbnail strip at bottom for multi-image navigation, click outside / backdrop click to close. Supports multiple images in one message.
- **Duplicate image fix**: `conversation-viewer.tsx` had optimistic-update double-render bug — images appeared doubled until refresh. Fixed by deduplicating message parts before rendering.
- Files: `apps/studio/db/src/schema/attachments.ts` *(new)*, `apps/studio/db/src/schema/index.ts`, `apps/studio/db/src/schema/relations.ts`, `apps/studio/server/src/routes/chat.ts`, `apps/studio/web/components/ui/image-gallery.tsx` *(new)*, `apps/studio/web/components/chat/conversation-viewer.tsx`, `apps/studio/web/components/agent/chat/chat-interface.tsx`

## 2026-04-06 — Plan 14: Filesystem (S3/RustFS virtual disk)

- **DB schema** (`apps/studio/db/src/schema/filesystem.ts`): `project_filesystem_config` (one row per project: adapter_id, credential_id, enabled, total_files, total_size_bytes) + `project_files` (virtual path entries: path, name, folder_path, extension, storage_key, size_bytes, mime_type, content_cache). Content cache for files ≤ 50 KB avoids S3 round-trips.
- **S3 adapter** (`apps/studio/server/src/filesystem/adapter.ts`): `S3FilesystemAdapter` using `@aws-sdk/client-s3`. `forcePathStyle: true` for RustFS/MinIO compatibility. `buildS3Adapter()` factory resolves from decrypted credential fields.
- **FilesystemService** (`apps/studio/server/src/filesystem/service.ts`): Full CRUD — `list()`, `read()`, `write()`, `move()`, `delete()`, `deleteFolder()`, `search()`. Validates extension + size via `isAllowedFile()`. `normalizePath()` prevents path traversal. Virtual subfolder extraction via `extractImmediateSubfolders()`.
- **Filesystem tools** (`apps/studio/server/src/filesystem/tools.ts`): 6 built-in tools: `fs_list`, `fs_read`, `fs_write`, `fs_move`, `fs_delete`, `fs_search`. Tagged `group: 'filesystem'`. Injected at `wakeUp()` when filesystem enabled.
- **API routes** (`apps/studio/server/src/routes/filesystem.ts`): GET/PATCH config, POST test-connection, GET list, GET content, POST write, PATCH move, DELETE file, DELETE folder, GET search, POST upload (multipart).
- **File manager UI** (`apps/studio/web/app/.../disk/page.tsx`): File tree with breadcrumb navigation. Folder list + file list. CodeMirror editor panel (split view). `apps/studio/web/app/.../disk/code-editor.tsx` — syntax-highlighted editor.
- **Settings page** (`apps/studio/web/app/.../settings/filesystem/page.tsx`): Enable toggle, adapter selector (S3/RustFS), credential picker, storage stats, test connection button.
- **Sidebar**: "Disk" nav item added to project sidebar.
- Files: `apps/studio/db/src/schema/filesystem.ts`, `apps/studio/db/src/queries/filesystem.ts`, `apps/studio/server/src/filesystem/adapter.ts`, `apps/studio/server/src/filesystem/service.ts`, `apps/studio/server/src/filesystem/tools.ts`, `apps/studio/server/src/filesystem/utils.ts`, `apps/studio/server/src/routes/filesystem.ts`, `apps/studio/web/app/.../disk/page.tsx`, `apps/studio/web/app/.../disk/code-editor.tsx`, `apps/studio/web/app/.../settings/filesystem/page.tsx`, `apps/studio/web/components/sidebar/project-sidebar.tsx`

## 2026-04-06 — Plan 13: Browser Automation

- **OpenClaw browser engine ported** (`apps/studio/server/src/browser/`): ~80 files ported from OpenClaw. Entry: `browser/browser/server.ts` (`startBrowserControlServer(resolved)`). Config via `browser/config/config.ts`. All external OpenClaw config dependencies replaced with parameter-based config.
- **Browser server lifecycle** (`apps/studio/server/src/browser/index.ts` / `node-server-entry.ts`): `startBrowserServer(projectId, config)` / `stopBrowserServer()` / `stopAllBrowserServers()`. Each project gets its own browser server on a unique port.
- **Browser tool** (`apps/studio/server/src/browser/tool-schema.ts`): Single `browser` tool with `action` enum (status/start/stop/profiles/tabs/open/focus/close/navigate/snapshot/screenshot/console/pdf/upload/dialog/act). Zod schema. Tagged `group: 'browser'`, `permission: '*'`.
- **Manager integration** (`apps/studio/server/src/runtime/manager.ts`): `wakeUp()` checks `browser_enabled` on project, starts browser server, injects `browserTools` into all agent `built_in_tools`. `sleep()` stops browser server. `stopAll()` stops all browser servers.
- **API routes** (`apps/studio/server/src/routes/browser.ts`): GET config+status, PATCH enabled (triggers runtime restart), PATCH config.
- **Browser settings UI** (`apps/studio/web/app/.../browser/page.tsx`): Enable toggle + server status badge + config form (headless, port, timeout, sandbox, evaluate).
- Files: `apps/studio/server/src/browser/**` *(~80 new files)*, `apps/studio/server/src/routes/browser.ts`, `apps/studio/server/src/runtime/manager.ts`, `apps/studio/db/src/schema/projects.ts` (browser_enabled + browser_config columns), `apps/studio/web/app/.../browser/page.tsx`

## 2026-04-06 — Tool parts rendering bug fix (DB → UI format conversion)

- **`dbMessageToUIMessage` helper** (`apps/studio/web/lib/messages.ts` *(new)*): Converts DB-stored tool parts to AI SDK v6 UI format on load. DB stores `{ type: 'tool-invocation', toolInvocationId, args, state: 'result', result }` but AI SDK v6 expects `{ type: 'dynamic-tool', toolCallId, state: 'output-available', input, output }`. Without this conversion tools rendered as empty card with name "invocation".
- Both message pages now use `dbMessageToUIMessage` instead of raw cast: `chats/[conv]/page.tsx` and `runs/[conv]/page.tsx`.
- Files: `apps/studio/web/lib/messages.ts` *(new)*, `apps/studio/web/app/.../chats/[conv]/page.tsx`, `apps/studio/web/app/.../runs/[conv]/page.tsx`

## 2026-04-06 — Tool parts persistence, real-time streaming, get_datetime, Telegram context

- **Tool parts persisted to DB** (`packages/core/src/runner.ts`): Runner now saves ALL parts per assistant message — tool invocations (call + result) and text — not just text. Uses `result.steps` from AI SDK to collect every step's `toolCalls`+`toolResults` and builds `tool-invocation` parts with `state: 'result'`. History loading updated to reconstruct full `assistant` + `tool` model messages from saved parts so multi-step tool context survives page refresh.
- **Real-time streaming for connector conversations** (`server/src/connectors/event-router.ts`): `executeConversationAdapter` now registers to `streamRegistry` and tees the run stream. Observer tab (watching same conversation) and run detail page both receive live updates via polling.
- **`useLiveConversation` hook** (`apps/studio/web/hooks/use-live-conversation.ts`): Polls `/live-parts` at 400ms during active run. `autoDetect` mode polls `/status` every 2s to begin polling when a run starts (handles tabs opened before streaming begins). Reconstructs partial `UIMessage` from buffered chunks.
- **`streamRegistry` buffer** (`server/src/runtime/stream-registry.ts`): Added `buffer: StreamChunk[]` per active run. `bufferChunk()` accumulates chunks. `GET /conversations/:id/live-parts` exposes snapshot (returns `{running: false}` when idle).
- **`get_datetime` system tool** (`apps/studio/server/src/system/tools.ts`): Built-in tool returning `{ iso, timezone, local, unix }` — server timezone + formatted local time. Injected as first tool in all agents via `systemTools` array in `RuntimeManager.wakeUp/syncAgent`.
- **Telegram user context injection** (`server/src/connectors/event-router.ts`): `buildConnectorContextString` injects server timestamp, `language_code`, and estimated user timezone (35+ locale map) so AI can convert times correctly without asking. Telegram plugin now sends `metadata.language_code` and `metadata.client_timestamp` on message events.
- **ConversationViewer real-time** (`apps/studio/web/components/chat/conversation-viewer.tsx`): Uses `useLiveConversation` in readonly mode. Shows "streaming" badge during live run. `displayMessages` merges DB messages + live partial message.
- Files: `packages/core/src/runner.ts`, `apps/studio/server/src/runtime/stream-registry.ts`, `apps/studio/server/src/routes/chat.ts`, `apps/studio/server/src/connectors/event-router.ts`, `apps/studio/server/src/system/tools.ts` *(new)*, `apps/studio/server/src/runtime/manager.ts`, `plugins/jiku.telegram/src/index.ts`, `apps/studio/web/hooks/use-live-conversation.ts` *(new)*, `apps/studio/web/components/chat/conversation-viewer.tsx`, `apps/studio/web/lib/api.ts`

## 2026-04-06 — Connector System: Plugin architecture, Telegram polish, Zod fix

- **`@jiku/plugin-connector`** *(new — `plugins/jiku.connector/`)* : Core connector plugin. Contributes `ctx.connector.register(adapter)` to dependent plugins via module-level mutable ref pattern (safe across `contributes()` → `setup()` boundary). Server registers this before TelegramPlugin.
- **Telegram plugin refactor** (`plugins/jiku.telegram/src/index.ts`): Now `depends: [ConnectorPlugin]` and calls `ctx.connector.register(telegramAdapter)` instead of raw `ctx.hooks.callHook(...)`. Added `telegramify-markdown` for MarkdownV2-safe escaping. Added `splitMessage()` — splits responses at newlines near 4000-char boundary, sends as sequential messages (reply_parameters only on first chunk). Switched parse_mode `Markdown` → `MarkdownV2`.
- **Typing indicator** (`server/src/connectors/event-router.ts`): `sendTyping()` called immediately + repeated via `setInterval` every 4s while agent processes. Cleared in `finally` block.
- **Zod cross-instance fix**: All workspace packages (`core`, all plugins) standardized on `zod: 3.25.76`. Root `package.json` hoists single Zod instance. Removed `zodToJsonSchema` unused import from `packages/core/src/runner.ts`.
- **Binding architecture** (`output_adapter + output_config`): `ConnectorBinding` no longer has `agent_id` at root — uses `output_adapter: string` + `output_config: jsonb`. `ConversationOutputConfig { agent_id, conversation_mode? }` and `TaskOutputConfig { agent_id }` inside config. Pairing approve route, API types (`web/lib/api.ts`), and event-router all updated.
- Files: `plugins/jiku.connector/` *(new)*, `plugins/jiku.telegram/src/index.ts`, `plugins/jiku.telegram/package.json`, `apps/studio/server/src/index.ts`, `apps/studio/server/package.json`, `apps/studio/server/src/connectors/event-router.ts`, `apps/studio/server/src/routes/connectors.ts`, `apps/studio/web/lib/api.ts`, `packages/core/src/runner.ts`, root `package.json`

## 2026-04-06 — UX polish: Run Detail, Memory table, Persona refactor

- **ConversationViewer** (`apps/studio/web/components/chat/conversation-viewer.tsx`): Extracted shared component from chat page. Accepts `mode: 'edit' | 'readonly'`. In readonly mode: no PromptInput, same ContextBar + MemoryPreviewSheet. Both chat and run detail now use this component.
- **Run Detail page** (`runs/[conv]/page.tsx`): Replaced simple message list with `ConversationViewer mode="readonly"` — now has context bar, token count, tools preview, memory preview identical to chat page. Compact metadata bar (type/status/duration/goal/error/output) shown above.
- **Run list scroll fix**: Removed `runs/layout.tsx` that was blocking scroll on the list page. Run detail sets its own `height: calc(100svh - 3rem)` directly.
- **Memory browser** (`apps/studio/web/components/memory/memory-browser.tsx`): Converted card grid to compact table. Added **Agent** column (name resolved from agents list, fallback to UUID). Added **filter by agent** dropdown. Columns: Scope, Agent, Tier, Priority, Section, Content (truncated + tooltip), Hits, Created, Delete.
- **Persona refactor**: New `persona_prompt text` column on `agents` table (run `bun run db:push`). `persona_prompt` is injected directly into system prompt, bypassing memory-based persona. `AgentRunner` and `JikuRuntime.addAgent()` accept `personaPrompt` param. Old memory-seeding path still works when `persona_prompt` is null. Persona page replaced with single textarea. New routes: `GET/PATCH /api/agents/:aid/persona/prompt`.
- Files: `apps/studio/db/src/schema/agents.ts`, `apps/studio/db/src/queries/memory.ts`, `apps/studio/server/src/routes/persona.ts`, `packages/core/src/runner.ts`, `packages/core/src/runtime.ts`, `apps/studio/server/src/runtime/manager.ts`, `apps/studio/web/lib/api.ts`, `apps/studio/web/components/chat/conversation-viewer.tsx`, `apps/studio/web/components/memory/memory-browser.tsx`, `apps/studio/web/app/.../runs/[conv]/page.tsx`, `apps/studio/web/app/.../chats/[conv]/page.tsx`, `apps/studio/web/app/.../agents/[agent]/persona/page.tsx`

## 2026-04-05 — Plan 11 Task Mode, Heartbeat & Run History

- **DB schema**: Extended `conversations` table with `type`, `metadata`, `run_status`, `caller_id`, `parent_conversation_id`, `started_at`, `finished_at`, `error_message` (nullable `user_id`). Extended `agents` with `heartbeat_enabled`, `heartbeat_cron`, `heartbeat_prompt`, `heartbeat_last_run_at`, `heartbeat_next_run_at`.
- **DB queries**: `createTaskConversation`, `listRunsByProject` (server-side paginated with agent join + message count).
- **Types** (`@jiku/types`): `ConversationType`, `ConversationRunStatus`, `TaskMetadata`, `HeartbeatMetadata`, `ConversationRow`, `ListConversationsResult`.
- **Server task runner** (`apps/studio/server/src/task/runner.ts`): `runTaskConversation`, `spawnTask`, `buildCaller`.
- **Task tools** (`apps/studio/server/src/task/tools.ts`): `buildRunTaskTool` (run_task — always active in chat+task), `buildTaskLifecycleTools` (task_complete, task_fail).
- **HeartbeatScheduler** (`apps/studio/server/src/task/heartbeat.ts`): setTimeout-based scheduler, `scheduleAgent`, `triggerHeartbeat`, `rescheduleAgent`, `stopAll`. Integrated into `RuntimeManager` wakeUp/syncAgent/stopAll.
- **Server routes**: `GET /api/projects/:pid/runs`, `POST /api/conversations/:id/cancel`, `GET/PATCH /api/agents/:aid/heartbeat`, `POST /api/agents/:aid/heartbeat/trigger`.
- **Web**: Run History page (`/runs`) with type/status filters and pagination. Run Detail page (`/runs/[conv]`). Heartbeat settings tab in agent layout. "Runs" added to project sidebar. `api.runs` and `api.heartbeat` API client namespaces.
- Files: `apps/studio/server/src/task/runner.ts`, `tools.ts`, `heartbeat.ts`, `routes/runs.ts`, `routes/heartbeat.ts`. Web: `runs/page.tsx`, `runs/[conv]/page.tsx`, `agents/[agent]/heartbeat/page.tsx`.

## 2026-04-05 — Plan 10 Channels & Connector System

**Changed:** Full implementation of the Channels & Connector System (Plan 10).

- **Types** (`@jiku/types`): `ConnectorEventType`, `ConnectorEvent`, `ConnectorTarget`, `ConnectorContent`, `ConnectorSendResult`, `ConnectorContext`, `ConnectorBinding`, `ConnectorIdentity`, `UserIdentity`, `ConnectorRecord`, `ConnectorCallerContext`. Extended `CallerContext` with `connector_context?`.
- **Kit** (`@jiku/kit`): `ConnectorAdapter` abstract base class + `defineConnector()` factory that wraps a connector class as a JikuPlugin with `connector:register/activate/deactivate` hooks.
- **DB schema**: 7 new tables — `connectors`, `connector_bindings`, `connector_identities`, `connector_events`, `connector_messages`, `connector_message_events`, `user_identities`. GIN indexes on jsonb `ref_keys` columns. (Migration pending: `bun run db:push`)
- **DB queries** (`@jiku-studio/db`): Full CRUD for connectors, bindings, identities, events, messages, user_identities. `findIdentityByExternalId` via SQL jsonb query. `upsertUserIdentity` with `onConflictDoUpdate`.
- **ConnectorRegistry** (`server/src/connectors/registry.ts`): Singleton tracking registered adapters + active connector instances per project.
- **ConnectorEventRouter** (`server/src/connectors/event-router.ts`): `routeConnectorEvent()` — matches bindings, creates/updates identities, approval/rate-limit checks, logs events, executes conversation/task adapters via `runtimeManager.run()`, drains stream, sends response back via adapter.
- **Connector Routes** (`server/src/routes/connectors.ts`): Full CRUD API, binding CRUD, identity management, event/message read endpoints, SSE live event stream, inbound webhook route (`POST /webhook/:project_id/connector/:connector_id`), `GET /connector-plugins` listing.
- **Connector Tools** (`server/src/connectors/tools.ts`): 8 built-in tools: `connector_get_events`, `connector_get_thread`, `connector_send`, `connector_react`, `connector_binding_update`, `identity_get`, `identity_set`, `identity_find`. All tagged `group: 'connector'`.
- **RuntimeManager** updated to load connector tools alongside memory tools at wakeUp().
- **Telegram Plugin** (`plugins/jiku.connector.telegram`): `TelegramConnector` extends `ConnectorAdapter`. Supports message/reaction/edit events via Telegraf. Handles polling + webhook modes. `sendMessage`, `sendReaction`, `deleteMessage`, `editMessage`.
- **Server bootstrap** (`server/src/index.ts`): Registers `telegramConnectorAdapter` in `connectorRegistry` + `TelegramConnectorPlugin` in shared plugin loader.
- **Web UI** — 6 new pages under `/channels`:
  - `channels/page.tsx` — connector overview cards with status badge
  - `channels/new/page.tsx` — 2-step add connector (select plugin → configure)
  - `channels/[connector]/page.tsx` — detail: status, quick nav, bindings list, config display
  - `channels/[connector]/bindings/[binding]/page.tsx` — binding settings + identity approval workflow
  - `channels/[connector]/events/page.tsx` — event log + SSE live stream
  - `channels/[connector]/messages/page.tsx` — inbound/outbound message log with auto-refresh
- **Sidebar**: Channels nav item already present with `Webhook` icon.
- **API client** (`web/lib/api.ts`): `api.connectors` namespace with all CRUD + events/messages/plugins endpoints.
- **Carry-over Plan 9**: `extractPersonaPostRun()` in `packages/core/src/memory/persona-extraction.ts` — fire-and-forget LLM persona signal extraction, keyword-gated, saves as `agent_self` scope memories.

**Files touched:** `packages/types/src/index.ts`, `packages/kit/src/index.ts`, `apps/studio/db/src/schema/connectors.ts` *(new)*, `apps/studio/db/src/queries/connector.ts` *(new)*, `apps/studio/server/src/connectors/registry.ts` *(new)*, `apps/studio/server/src/connectors/event-router.ts` *(new)*, `apps/studio/server/src/connectors/tools.ts` *(new)*, `apps/studio/server/src/routes/connectors.ts` *(new)*, `apps/studio/server/src/runtime/manager.ts`, `apps/studio/server/src/index.ts`, `apps/studio/server/package.json`, `plugins/jiku.connector.telegram/` *(new)*, `apps/studio/web/lib/api.ts`, `apps/studio/web/app/.../channels/**` *(6 new pages)*, `packages/core/src/memory/persona-extraction.ts` *(new)*

---

## 2026-04-05 — Plan 9 Persona System + Active Tools UI + Tool Groups

**Changed:** Implemented the complete Persona System (Plan 9) plus two enhancements: Active Tools debug UI and tool group metadata.

- **Persona System core**: `agent_self` scope added to MemoryScope. `PersonaSeed` interface. `formatPersonaSection()` in `@jiku/core` formats `## Who I Am` block. `buildSystemPrompt()` accepts `persona_section` injected before memory. `AgentRunner.run()` and `previewRun()` both load `agent_self` memories and build persona section.
- **`ensurePersonaSeeded()`** (`apps/studio/server/src/memory/persona.ts`): new file. Bootstraps `agent_self` memories from `persona_seed` config on first run. No-op if `persona_seeded_at` is set.
- **DB schema**: `agents` table gets `persona_seed jsonb` + `persona_seeded_at timestamptz` columns. (Migration pending: `bun run db:push`)
- **Built-in persona tools**: `persona_read` + `persona_update` (append/replace/remove) always registered on agents. Both carry `group: 'persona'` in meta. All existing memory tools carry `group: 'memory'`.
- **API routes** (`apps/studio/server/src/routes/persona.ts`): `GET /persona/memories`, `GET+PATCH /persona/seed`, `POST /persona/reset`.
- **Persona settings page** (`agents/[agent]/persona/page.tsx`): PersonaSeed form, initial memories list, live Current Persona panel (agent_self memories), Reset to Seed AlertDialog.
- **Bug fix**: `previewRun()` was missing `built_in_tools` merge — tools count was always 0. Fixed to match `run()` merge logic.
- **Active Tools UI**: `ToolRow` in `context-preview-sheet.tsx` fully rewritten — expandable detail showing description, short tool ID (`memory_search` not `__builtin__:memory_search`), permission, parameters with type + required badges. `schemaToParams()` parses JSON schema properties.
- **Tool group metadata**: `ToolMeta.group?: string` added to `@jiku/types`. Runner mapper passes `group`. UI groups tools by `meta.group` (memory / persona / plugin) in `ActiveToolsList`.
- **Context preview sheet layout**: system prompt moved below usage bar (above tabs). Context tab groups segments by source with token total per group (`SegmentGroupList`). Category badge removed from tool row header.
- **ContextBar enhancement**: Tools button shows count. UsagePopover shows tool summary with built-in/plugin breakdown. `persona` added to SOURCE_LABELS/COLORS (violet).

**Files touched:** `packages/types/src/index.ts`, `packages/core/src/memory/builder.ts`, `packages/core/src/memory/index.ts`, `packages/core/src/resolver/prompt.ts`, `packages/core/src/runner.ts`, `packages/core/src/runtime.ts`, `apps/studio/db/src/schema/agents.ts`, `apps/studio/db/src/queries/memory.ts`, `apps/studio/server/src/memory/tools.ts`, `apps/studio/server/src/memory/persona.ts` *(new)*, `apps/studio/server/src/runtime/manager.ts`, `apps/studio/server/src/routes/persona.ts` *(new)*, `apps/studio/server/src/index.ts`, `apps/studio/web/lib/api.ts`, `apps/studio/web/app/.../agents/[agent]/layout.tsx`, `apps/studio/web/app/.../agents/[agent]/persona/page.tsx` *(new)*, `apps/studio/web/components/chat/context-bar.tsx`, `apps/studio/web/components/chat/context-preview-sheet.tsx`

---

## 2026-04-05 — Memory Preview Sheet + Post-test Bug Fixes + Backlog Completion

**Changed:** Resolved all remaining items from memory system backlog and automated test findings.

- **`memory_user_write` tool** (`apps/studio/server/src/memory/tools.ts`): 9th built-in memory tool added. Policy-gated by `config.policy.write.cross_user`. Writes `scope: agent_caller, visibility: agent_shared` for a target `caller_id`.
- **Memory expiration cleanup** (`apps/studio/db/src/queries/memory.ts`, `apps/studio/server/src/index.ts`): Added `deleteExpiredMemories()` DB function (delete where `expires_at < now()`). Registered as cleanup job in server bootstrap — runs immediately at boot and every 24h via `setInterval`.
- **`MemoryPreviewSheet`** (`apps/studio/web/components/chat/memory-preview-sheet.tsx`): New component. Reads memory segment from `previewRun()` (no separate API route). Parses raw markdown memory section into scoped blocks. Shows token count, grouped collapsible sections per scope (Project-Global / Agent-Global / User-Scoped), tier + importance badges, raw content toggle.
- **`ContextBar` Memory button** (`apps/studio/web/components/chat/context-bar.tsx`): Added `onMemoryClick?: () => void` prop. When provided, renders `[Memory]` button between model info and `[Context]` button. Footer layout: `[model · provider] ··· [Memory] [Context]`.
- **Chat page wire-up** (`chats/[conv]/page.tsx`): `memorySheetOpen` state + `MemoryPreviewSheet` render. Passes `onMemoryClick` to `ContextBar`.
- **Dashboard live counts**: Studio page now shows live Projects + Agents via cascading `useQueries`. Company page shows live Agents. Project page shows live Chats count via `conversations.listProject()`.
- **Bug fixes from automated test**: `MemoryItem.source` union added `'agent'`; `MemoryItem.project_id` field rename (was `runtime_id`); `staleTime: 0` on memory browser; `touchMemories` `.catch()` now logs warning instead of silently swallowing.
- **Implementation report updated** (`docs/plans/impl-reports/8-memory-system-implement-report.md`): Status 90% → 98%. All completed items marked done. Errors table extended with 4 new bug fixes.

**Files touched:** `apps/studio/server/src/memory/tools.ts`, `apps/studio/db/src/queries/memory.ts`, `apps/studio/server/src/index.ts`, `apps/studio/web/components/chat/memory-preview-sheet.tsx`, `apps/studio/web/components/chat/context-bar.tsx`, `apps/studio/web/app/(app)/studio/.../chats/[conv]/page.tsx`, `apps/studio/web/app/(app)/studio/page.tsx`, `apps/studio/web/app/(app)/studio/companies/[company]/page.tsx`, `apps/studio/web/app/(app)/studio/companies/[company]/projects/[project]/page.tsx`, `apps/studio/web/lib/api.ts`, `apps/studio/web/components/memory/memory-browser.tsx`, `docs/plans/impl-reports/8-memory-system-implement-report.md`

---

## 2026-04-05 — Memory System (Plan 8): Full Implementation

**Changed:** Implemented the complete memory system across all layers.

- **Core types** (`packages/types/src/index.ts`): Added `MemoryScope`, `MemoryTier`, `MemoryImportance`, `MemoryVisibility`, `AgentMemory`, `MemoryContext`, `ResolvedMemoryConfig`, `ProjectMemoryConfig`, `AgentMemoryConfig`. Extended `JikuStorageAdapter` with 5 optional memory methods (`agent_id` now optional in `getMemories`). Updated `ContextSegment.source` to include `'memory'`.
- **Core memory logic** (`packages/core/src/memory/`): `config.ts` — `DEFAULT_PROJECT_MEMORY_CONFIG` + `resolveMemoryConfig()` 2-level merge. `relevance.ts` — `tokenize()` with EN+ID stopwords, `scoreMemory()` (keyword+recency+access+importance), `findRelevantMemories()`. `builder.ts` — `buildMemoryContext()` + `formatMemorySection()`. `extraction.ts` — `extractMemoriesPostRun()` Zod-based LLM extraction, fire-and-forget.
- **Runner integration** (`packages/core/src/runner.ts`): Memory loaded before prompt, injected into system prompt, `touchMemories()` called after, post-run extraction triggered. `previewRun()` now also loads memories and includes a `memory` segment with token estimate.
- **DB schema**: `agent_memories` table (16 columns). `agents.memory_config` + `projects.memory_config` jsonb columns.
- **DB queries** (`apps/studio/db/src/queries/memory.ts`): 9 functions — `getMemories` (agent_id now optional), `saveMemory`, `updateMemory`, `deleteMemory`, `touchMemories`, `listProjectMemories`, `getMemoryById`, `updateProjectMemoryConfig`, `updateAgentMemoryConfig`.
- **Storage adapter** (`apps/studio/server/src/runtime/storage.ts`): All 5 memory methods implemented.
- **Memory tools** (`apps/studio/server/src/memory/tools.ts`): 8 built-in tools — core CRUD (append/replace/remove), extended insert, search, runtime read/write (policy-gated), user lookup (policy-gated).
- **Runtime manager** (`apps/studio/server/src/runtime/manager.ts`): `wakeUp()` loads project memory config, resolves per-agent config, builds and injects memory tools as `built_in_tools`.
- **API routes** (`apps/studio/server/src/routes/memory.ts`): 7 routes — memories list/delete, project config get/patch, agent config get/patch/resolved.
- **Web API** (`apps/studio/web/lib/api.ts`): `api.memory.list/delete`, `api.memoryConfig.getProject/updateProject/getAgent/updateAgent/getAgentResolved`. Added `'memory'` to `ContextSegment.source` union.
- **Web components**: `MemoryBrowser` (scope/tier filters, cards with badges, delete with confirm). `MemoryConfig` (Default Policy, Relevance Scoring, Core Memory, Extraction sections with sliders/switches).
- **Web pages**: `/memory` — tabs: Memories + Config (project-level). `/agents/[agent]/memory` — per-agent override with InheritToggle pattern (inherit/on/off), effective config panel.
- **Sidebar navigation**: Memory item (Brain icon) between Chats and Plugins. Plugins moved above Settings. Memory tab removed from settings layout.
- **Context preview**: Memory segment (teal color) now appears in context bar popover and context preview sheet when memories are loaded.
- **Bug fix**: `getMemories()` — `agent_id` was incorrectly required, causing `WHERE agent_id = ''` on `runtime_global` queries. Made optional, only added to WHERE when present.

**Files touched:** `packages/types/src/index.ts`, `packages/core/src/memory/*`, `packages/core/src/runner.ts`, `packages/core/src/resolver/prompt.ts`, `apps/studio/db/src/schema/memories.ts`, `apps/studio/db/src/schema/agents.ts`, `apps/studio/db/src/schema/projects.ts`, `apps/studio/db/src/queries/memory.ts`, `apps/studio/server/src/runtime/storage.ts`, `apps/studio/server/src/memory/tools.ts`, `apps/studio/server/src/runtime/manager.ts`, `apps/studio/server/src/routes/memory.ts`, `apps/studio/server/src/index.ts`, `apps/studio/web/lib/api.ts`, `apps/studio/web/components/memory/memory-browser.tsx`, `apps/studio/web/components/memory/memory-config.tsx`, `apps/studio/web/app/(app)/studio/.../memory/page.tsx`, `apps/studio/web/app/(app)/studio/.../agents/[agent]/memory/page.tsx`, `apps/studio/web/app/(app)/studio/.../agents/[agent]/layout.tsx`, `apps/studio/web/app/(app)/studio/.../settings/layout.tsx`, `apps/studio/web/components/sidebar/project-sidebar.tsx`, `apps/studio/web/components/chat/context-bar.tsx`, `apps/studio/web/components/chat/context-preview-sheet.tsx`

---

## 2026-04-05 — Chat UX Polish: Conversation list, Context bar, SSE observer, Sidebar footer

- **Conversation list panel** (`components/chat/conversation-list-panel.tsx`): Full rewrite. Replaced Radix `ScrollArea` with plain `overflow-y-auto` div (ScrollArea injected `min-width:100%; display:table` which broke `text-overflow: ellipsis`). Added date-based grouping (Today/Yesterday/This week/This month/Last 3 months/Older) as accordion sections — Today auto-expanded, rest collapsed. Load-more pagination (PAGE_SIZE=10). Proper ellipsis truncation on last message preview.
- **Context bar** (`components/chat/context-bar.tsx`): Added `isStreaming` prop to trigger preview refresh after each chat turn. Left side shows model_id + provider; right side shows token count. Popover shows model info, usage bar, segment breakdown, compaction count.
- **Context preview sheet** (`components/chat/context-preview-sheet.tsx`): Model info card moved above context usage bar; shows provider + model rows.
- **Stream registry** (`apps/studio/server/src/runtime/stream-registry.ts`): New file — in-memory Map tracking active runs per conversation. Concurrent lock (409 if already running). SSE broadcast to observer clients via `stream.tee()`.
- **Chat routes** (`apps/studio/server/src/routes/chat.ts`): `POST /conversations/:id/chat` returns 409 if already running; tees stream (one branch to caller, one to SSE broadcast). New `GET /conversations/:id/stream` SSE observer endpoint. New `GET /conversations/:id/status` returns `{ running: boolean }`.
- **Observer hook** (`apps/studio/web/hooks/use-conversation-observer.ts`): New file — EventSource to SSE stream, token passed as `?token=` query param. On `done` event, fetches fresh messages.
- **API types** (`apps/studio/web/lib/api.ts`): Added `compaction_count: number` and `model_info?` to `PreviewRunResult`. Added `api.conversations.status()`.
- **Project sidebar** (`components/sidebar/project-sidebar.tsx`): Settings moved into same menu group as Dashboard/Agents/Chats (no separator). User info dropdown added to `SidebarFooter`.
- **Company sidebar** (`components/sidebar/company-sidebar.tsx`): Same pattern — Settings in same menu group, user info in `SidebarFooter`.
- Files: `apps/studio/server/src/runtime/stream-registry.ts`, `apps/studio/server/src/routes/chat.ts`, `apps/studio/web/hooks/use-conversation-observer.ts`, `apps/studio/web/components/chat/conversation-list-panel.tsx`, `apps/studio/web/components/chat/context-bar.tsx`, `apps/studio/web/components/chat/context-preview-sheet.tsx`, `apps/studio/web/lib/api.ts`, `apps/studio/web/components/sidebar/project-sidebar.tsx`, `apps/studio/web/components/sidebar/company-sidebar.tsx`

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
