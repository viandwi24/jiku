# Jiku — Technical Architecture Reference

> Reference document for developers building similar systems. Covers architecture patterns, design decisions, and implementation details that are reusable across AI agent platforms.

---

## 1. Monorepo Structure

Bun workspace monorepo. Four workspace roots:

```
jiku/
  packages/          # Shared libraries (zero app-specific logic)
    kit/             # Public plugin SDK — definePlugin(), ConnectorAdapter, UI types
    core/            # Agent runtime engine — runner, plugin loader, adapters, memory
    types/           # Shared TypeScript interfaces (ToolDefinition, AgentDefinition, etc.)
    ui/              # React component library (shadcn/ui wrapper)
    browser/         # Browser automation adapter (CDP bridge)
  apps/
    cli/             # Standalone CLI runner
    studio/          # Full IDE — three sub-packages:
      server/        #   Express.js API, runtime manager, connectors, MCP
      web/           #   Next.js frontend
      db/            #   Drizzle ORM schema, queries, migrations (PostgreSQL)
  plugins/           # First-party plugins (auto-discovered at boot)
    jiku.telegram/   #   Telegram bot + userbot adapter
    jiku.web-reader/ #   URL → reader-mode article extractor
    jiku.sheet/      #   CSV/spreadsheet parser
    jiku.analytics/  #   Event tracking
    jiku.code-runtime/ # Sandboxed JS/TS execution (QuickJS)
    jiku.camofox/    #   Firefox-based browser adapter
    jiku.studio/     #   Host anchor plugin (type bridge)
```

**Dependency direction**: `types` ← `core` ← `kit` ← plugins. Apps depend on all. No circular dependencies — `PluginLoaderInterface` in `types` breaks the core↔types cycle.

**Key decision**: Plugins are standalone workspace packages with their own `package.json`. Auto-discovered at boot via filesystem scan — no manual registration needed.

---

## 2. Plugin System

### 2.1 Plugin Definition

```typescript
// plugins/my-plugin/src/index.ts
import { definePlugin, defineTool } from '@jiku/kit'
import { z } from 'zod'

export default definePlugin({
  meta: {
    id: 'my.plugin',
    name: 'My Plugin',
    version: '1.0.0',
    icon: '🔧',
    project_scope: true,   // false = system-scoped (always active)
  },

  configSchema: z.object({
    api_key: z.string().describe('secret'),  // 'secret' → password input in UI
    timeout: z.number().default(5000),
  }),

  depends: [StudioPlugin],  // type-safe dependency injection

  setup(ctx) {
    // ctx.tools.register(...)     — system-scoped tools (all projects)
    // ctx.project.tools.register(...) — project-scoped tools
    // ctx.prompt.inject(...)      — system prompt segment
    // ctx.hooks.hook(...)         — lifecycle hooks
    // ctx.storage.get/set(...)    — per-plugin KV storage

    ctx.project.tools.register(
      defineTool({
        meta: { id: 'my_tool', name: 'My Tool', group: 'my_group' },
        permission: '*',
        modes: ['chat', 'task'],
        input: z.object({ query: z.string() }),
        execute: async (args, toolCtx) => {
          // toolCtx.runtime — agent context, LLM bridge, project_id
          // toolCtx.storage — per-plugin scoped KV
          // toolCtx.writer  — push streaming data to client
          return { result: 'done' }
        },
      })
    )
  },

  onProjectPluginActivated: async (projectId, ctx) => {
    // ctx.config is typed from configSchema
    console.log('Activated for project', projectId, ctx.config.api_key)
  },
})
```

### 2.2 Auto-Discovery

```
// core/src/plugins/discover.ts
discoverPluginsFromFolder(rootDir):
  1. readdir(rootDir) → filter directories
  2. For each dir: read package.json → get entry (module || main || 'src/index.ts')
  3. Dynamic import(entryFile) → extract default export
  4. Validate: must be PluginDefinition with meta.id
  5. Return DiscoveredPlugin[] { dir, packageName, entryFile, def }
```

**Boot sequence** (studio server):
```
const loader = new PluginLoader()
const discovered = await discoverPluginsFromFolder('plugins/')
for (const p of discovered) loader.register(p.def)
loader.boot()  // topological sort → setup() each in dependency order
```

### 2.3 Dependency Injection via `contributes`

Plugins can expose typed services to dependents:

```typescript
// Host plugin
export default definePlugin({
  meta: { id: 'host.plugin' },
  contributes: () => ({
    http: expressRouter,      // Typed service
    events: eventEmitter,
  }),
  setup(ctx) { /* ... */ },
})

// Consumer plugin
export default definePlugin({
  meta: { id: 'consumer.plugin' },
  depends: [HostPlugin],
  setup(ctx) {
    ctx.http.get('/api/test', ...)   // Type-safe access to host's contributes
    ctx.events.on('update', ...)
  },
})
```

**Resolution**: `PluginLoader.boot()` topologically sorts, resolves contributes, and merges into each plugin's setup context. Consumer sees contributed values on `ctx` with full TypeScript types.

### 2.4 Tool Registration & Resolution

```
Registration:
  ctx.tools.register(tool)                    → system scope (all projects)
  ctx.project.tools.register(tool)            → project scope (enabled projects only)

Resolution (per-run):
  PluginLoader.getResolvedTools(projectId?) → ResolvedTool[]
    - System tools: always included
    - Project tools: included only if plugin enabled for this project
    - Each tool gets: resolved_id='plugin_id:tool_id', tool_name='safe_snake'

Filtering:
  project_tool_states — per-project enable/disable
  agent_tool_states   — per-agent enable/disable
  PolicyRule[]        — RBAC allow/deny per caller
```

### 2.5 Plugin UI Isolation

Plugins declare UI entries that render in sandboxed contexts:

```typescript
ui: defineUI({
  assetsDir: join(__dirname, '..', 'dist', 'ui'),
  entries: [
    { slot: 'project.page', id: 'main', module: './MyPage.js',
      meta: { path: '', title: 'My Plugin', icon: 'Puzzle' } },
    { slot: 'project.settings.section', id: 'settings',
      module: './Settings.js', meta: { label: 'Config' } },
  ],
})
```

**Slot types**: `project.page` (full page), `project.settings.section` (settings tab), `sidebar.item` (nav entry). Studio discovers slots and renders them in isolated contexts with a bridge API for storage/fetch.

---

## 3. Agent Runtime

### 3.1 Execution Model

```
Per-project: JikuRuntime
  └── Map<agent_id, AgentRunner>
       └── AgentDefinition { meta, system_prompt, modes, built_in_tools }

Run flow:
  1. RuntimeManager.run(projectId, params: JikuRunParams)
  2. Resolve model (provider_id + model_id → LanguageModel via AI SDK)
  3. Build system prompt (base + persona + memory + plugin prompts + skill hints)
  4. Resolve tools (plugin + built-in + MCP + extra per-run)
  5. Build RuntimeContext { caller, agent, conversation_id, llm, project_id }
  6. Select adapter (default | harness) based on agent mode config
  7. Adapter.execute(AgentRunContext, params) → drives LLM loop
  8. Persist messages + emit stream to clients
```

### 3.2 Agent Adapters

Two built-in adapters — extensible via the adapter registry:

**Default** (`adapters/default.ts`): Single `streamText()` call with `tool_choice: auto`. Model natively decides text + tool_use. Simple, no watchdog.

**Harness** (`adapters/harness.ts`): Iterative loop (claude-code parity). Single `streamText` with `stopWhen(stepCountIs(N))`. Per-step stall watchdog (default 120s). Emits `jiku-harness-iteration` events. Extension point for per-step hooks (approval, model switching).

**Key decision**: Use AI SDK's `streamText` with `stopWhen` instead of a manual outer while-loop. Manual loops break the AI SDK UI message protocol (conflicting part IDs → blank tool UI until refresh).

### 3.3 LLM Bridge for Tools

Tools can call the agent's LLM via `RuntimeContext.llm`:

```typescript
execute: async (args, toolCtx) => {
  const code = await toolCtx.runtime.llm?.generate(
    'Write a function that sums an array',
    { system: 'Output raw JS only', temperature: 0, maxTokens: 1024 }
  )
  // Default: inherits agent's active provider/model
  // Override: { provider: 'openai', model: 'gpt-4o' }
}
```

**Why on RuntimeContext**: Tools stay decoupled from provider SDKs. Bridge uses AI SDK `generateText` under the hood. If providers change, only the runner bridge construction changes.

### 3.4 Tool Deduplication on Replay

When a conversation is replayed (regenerate / branch), side-effectful tools are deduplicated:

```
If tool.meta.side_effectful === true:
  On replay, check if prior assistant message has same tool_name + identical args
  → If match: return cached result (skip execution)
  → Prevents double-sending messages, double-writing files
```

---

## 4. Connector / Channel System

### 4.1 Adapter Interface

```typescript
interface ConnectorAdapter {
  id: string                    // 'jiku.telegram.bot'
  displayName: string
  refKeys: string[]             // ['message_id', 'chat_id', 'thread_id']
  supportedEvents: string[]     // ['message', 'reaction', 'edit']

  onActivate(ctx): Promise<void>   // Start bot polling, connect websocket
  onDeactivate(): Promise<void>    // Teardown

  sendMessage(target, content): Promise<ConnectorSendResult>
  runAction?(actionId, params, ctx): Promise<ActionResult>

  // Optional — streaming handoff
  handleResolvedEvent?(ctx: ResolvedEventContext): Promise<void>

  // Optional — scope computation for multi-chat routing
  computeScopeKey?(event): string | undefined  // 'group:-100123:topic:42'
  targetFromScopeKey?(scopeKey): ConnectorTarget | null
}
```

### 4.2 Event Routing Flow

```
Inbound message → Adapter.normalizeInbound(raw) → ConnectorEvent
  ↓
Event Router:
  1. Log arrival row (status=received)
  2. Find matching ConnectorBinding:
     - trigger_mode: always | mention | reply | command | keyword
     - source_ref_keys match (strict equality per key)
     - scope_key pattern match
  3. Resolve identity (external_id → internal user, approval check)
  4. Build [Connector Context] string (chat info, identity, platform params)
  5. Dispatch:
     a. If adapter.handleResolvedEvent exists → streaming handoff (adapter drives UX)
     b. Else → runtimeManager.run() + drain stream + sendMessage()
```

### 4.3 Scope Key Convention

Forum-topic-aware routing:

```
DM:           undefined (no scope)
Group chat:   'group:{chat_id}'
Forum topic:  'group:{chat_id}:topic:{thread_id}'
```

Bindings with `source_ref_keys: { chat_id, thread_id }` match only events with both keys. Auto-pairing creates draft bindings with the right scope.

### 4.4 Streaming Handoff

When `handleResolvedEvent` is implemented, the adapter owns the full UX:

```
1. Send placeholder ('⌛') as reply to user's message
2. Start agent run, tee stream (one for adapter, one for web observers)
3. Consume stream chunks: text-delta → tool-call → tool-result
4. Debounced edits: update placeholder with accumulated content
5. Blinking indicator (⚫/⚪) on interim edits
6. Final edit: clean content (no indicator), MarkdownV2 if supported
7. Log outbound + record usage
```

**Key pattern**: Interleaved segment model. Consecutive text-deltas merge into one text segment; consecutive tool-calls merge into one tool group. `---` separators between segment type transitions. Chronological order preserved.

---

## 5. Cron / Task System

### 5.1 Cron Composition

Cron tasks store a `prompt` (user instruction) and `context` JSONB:

```
context: {
  delivery?: { connector_id, target_name, chat_id, thread_id, scope_key, platform }
  origin?:   { platform, originator_display_name, connector_id, chat_id }
  subject?:  { user_id, display_name, identity_hints }
}
```

At fire time, `composeCronRunInput()` builds:

```
[Cron Trigger]         — always present (explains cron context to agent)
[Cron Origin]          — if origin set (who created this task)
[Cron Subject]         — if subject set (who the task concerns)
Instruction: <prompt>  — the actual task
[Cron Delivery]        — if delivery has addressable fields (tool hints for sending)
```

**Two preamble modes**:
- **Strict** (delivery configured): Agent MUST use delivery tools
- **Silent** (no delivery): Agent executes freely, no delivery obligation

### 5.2 Slash Command Integration

Cron prompts can be slash commands (`/marky-send only_content link`). Scheduler pre-dispatches before preamble composition:

```
1. dispatchSlashCommand(task.prompt, surface='cron')
2. If matched → resolvedInput = <active_command>SOP body</active_command>
3. composeCronRunInput(resolvedInput, context)
4. Agent sees full SOP body inside Instruction section
```

### 5.3 Auto-Populate Delivery

When an agent creates a cron via `cron_create` tool during a connector-initiated run, delivery is auto-filled from `RuntimeContext.connector_hint`:

```
RuntimeContext.connector_hint = {
  connector_id, chat_id, thread_id, scope_key, platform
}
→ If agent didn't supply delivery AND prompt implies user-facing output
→ Auto-copy connector_hint fields into context.delivery
```

---

## 6. MCP Integration

### 6.1 Architecture

```
mcp_servers table → MCPClientManager → ToolDefinition[] (wrapped)
  ↓                      ↓
Per-project        Connect via SSE / Streamable HTTP
  ↓                      ↓
Enabled servers    Fetch tool list → wrapMCPTool() → inject into agent
```

**Constraint**: No stdio transport in multi-tenant mode (stateless requirement). Only remote servers (SSE, Streamable HTTP).

### 6.2 Tool Wrapping

MCP tools are wrapped into standard `ToolDefinition`:

```typescript
function wrapMCPTool(serverId, serverName, mcpTool, client): ToolDefinition {
  return {
    meta: { id: mcpTool.name, name: mcpTool.name, group: 'mcp' },
    modes: ['chat', 'task'],
    permission: '*',
    input: mcpTool.inputSchema,  // JSON Schema passthrough
    execute: async (args) => {
      return client.callTool({ name: mcpTool.name, arguments: args })
    },
  }
}
```

---

## 7. Memory System

### 7.1 Extraction Pipeline

```
Post-run hook → extractMemoriesPostRun():
  1. Scan conversation turns for extractable content
  2. LLM call to extract structured memories
  3. Store with metadata:
     - tier: 'core' | 'extended'
     - importance: 'low' | 'medium' | 'high'
     - visibility: 'private' | 'agent_shared' | 'project_shared'
     - memory_type: 'episodic' | 'semantic' | 'procedural' | 'reflective'
     - score_health: decay score (decreases over time without access)
     - expires_at: optional TTL
```

### 7.2 Context Building

At run time, `buildMemoryContext()` retrieves relevant memories:
1. Core memories (always included, high-importance)
2. Semantic search via Qdrant (vector similarity)
3. Persona prompt (from `PersonaSeed`)
4. Formatted into system prompt sections

---

## 8. Auth & Permissions

### 8.1 Caller Resolution

Every run receives a `CallerContext`:

```typescript
interface CallerContext {
  user_id: string
  roles: string[]
  permissions: string[]         // ['agents:read', 'channels:write', ...]
  user_data: Record<string, unknown>
  attributes?: Record<string, string | string[]>  // For policy conditions
}
```

### 8.2 Policy Rules

Declarative RBAC with conditions:

```typescript
interface PolicyRule {
  resource_type: string    // 'agent' | 'tool' | custom
  resource_id: string      // '*' or specific ID
  subject_type: string     // 'role' | 'permission' | custom
  subject: string          // Role name or permission key
  effect: 'allow' | 'deny'
  priority?: number
  conditions?: PolicyCondition[]  // Dot-notation path checks
}
```

**Resolution**: `checkAccess(rules, caller, resource)` evaluates matching rules. Deny wins at same priority. Higher priority overrides. No matching rule → deny by default.

### 8.3 Four-Layer Permission Enforcement

Every feature requires:
1. Server `requirePermission('feature:read')` on routes
2. UI page `withPermissionGuard(Page, 'feature:read')`
3. Sidebar item gated by permission key
4. UI write buttons gated by `can('feature:write')`

---

## 9. Database Patterns

### 9.1 Stack

- **ORM**: Drizzle (type-safe, thin abstraction)
- **Database**: PostgreSQL 16
- **Migrations**: Hand-written SQL in `apps/studio/db/src/migrations/`
- **Schema**: TypeScript table definitions in `apps/studio/db/src/schema/`

### 9.2 Key Tables

| Table | Purpose |
|-------|---------|
| `agents` | Agent definitions (prompt, modes, model, memory config) |
| `conversations` | Chat/task/heartbeat history with branching support |
| `messages` | Per-message storage with parent_id for branching |
| `connectors` | Platform instances (Telegram bot, Discord guild) |
| `connector_bindings` | Trigger routes (agent + source + mode) |
| `connector_events` | Inbound/outbound event log |
| `connector_targets` | Named addressable endpoints (chat, topic, channel) |
| `connector_identities` | External user → internal user mapping |
| `memories` | Extracted agent memories (episodic, semantic, procedural) |
| `cron_tasks` | Scheduled jobs (recurring/once) |
| `project_commands` | Slash commands (filesystem + plugin sourced) |
| `mcp_servers` | MCP server configurations |
| `project_tool_states` | Per-project tool enable/disable |
| `agent_tool_states` | Per-agent tool enable/disable |
| `usage_logs` | Token usage tracking per-run |
| `credentials` | Encrypted API keys/tokens (AES-256) |
| `policies` | RBAC rules |
| `roles` | Named permission sets |

### 9.3 Patterns

**Encrypted credentials**: API keys stored AES-256 encrypted. Decrypted only at use time (connector activation, model provider init). Schema marks sensitive fields with `.describe('secret')`.

**JSONB for flexibility**: `context` on cron_tasks, `metadata` on conversations/events, `config` on connectors/plugins. Typed in application layer via interfaces; DB stores opaque JSON.

**Soft lifecycle**: `status: 'active' | 'archived'` on cron_tasks, `active: boolean` on commands. No hard deletes for audit trail.

---

## 10. Design Decisions Summary

| Decision | Rationale |
|----------|-----------|
| Plugin auto-discovery via filesystem | Zero config for new plugins — drop folder, restart, done |
| `contributes` for cross-plugin services | Type-safe DI without service locator pattern |
| AI SDK `streamText` (not manual loop) | Preserves UI message protocol; manual loops break part IDs |
| Harness adapter stall watchdog | Safety net for hung LLM steps; configurable per-agent |
| `RuntimeContext.llm` bridge | Tools call LLM without importing provider SDKs |
| Side-effectful tool deduplication | Safe conversation replay (regenerate/branch) |
| Scope key convention | Uniform multi-chat + forum-topic routing across adapters |
| Streaming handoff to adapters | Platform-native UX (Telegram edit-in-place, Discord embeds) |
| Cron preamble modes (strict/silent) | Same system handles reminders AND internal jobs |
| MCP remote-only (no stdio) | Stateless multi-tenant constraint |
| Per-project runtimes, shared plugin loader | Memory isolation per project; plugin code loaded once |
| Drizzle + hand-written SQL migrations | Type-safe queries + full control over DDL |
| Four-layer permission enforcement | No single point of failure for access control |
