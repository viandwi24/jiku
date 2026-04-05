# Senken Neo — Analysis

> Reference: `./refs-senken-neo` (excluding `prototype-senken-v1` subdirectory)

---

## 1. What Is It?

**SenkenNeo** is a V2 infrastructure rebuild of Senken — a production-grade, framework-agnostic agent runtime designed to power 24/7 autonomous financial agents.

**Tagline:** "Build your strategy. Let AI execute it."

**Core Value Proposition:**
- Enterprise-grade agent runtime with full auditability and step-by-step narration
- VS Code-style extensible plugin architecture
- Multi-tenant ready with isolated per-user runtimes
- Auto context compaction (80% threshold) with checkpoint persistence
- Interactive TUI for development, REST+SSE+Socket.IO for production

**Target Users:** Autonomous finance users, financial institutions building algorithmic trading, extension developers building AI-native tools.

---

## 2. Architecture

### 2.1 Tech Stack

| Layer | Technology | Reason |
|-------|-----------|--------|
| **Runtime** | Bun | Speed, built-in SQLite/Redis/Postgres support |
| **Language** | TypeScript 5 | Type safety, compile-time error catching |
| **AI SDK** | Vercel AI SDK v6 | Multi-provider abstraction, streaming with structured data parts |
| **Extension System** | Custom plugin architecture (VS Code style) | Lightweight, no framework overhead, topological dependency sorting |
| **Event Bus** | UnJS Hookable | Lightweight pub/sub for inter-extension communication |
| **Configuration** | JSON-based | Simple, self-describing, version control friendly |
| **Storage** | Pluggable drivers (File, Memory) | Abstraction allows swapping backends |
| **CLI/TUI** | Commander + Ink | Rich terminal UI, React component model |
| **Server** | Express + Socket.IO | Standard HTTP APIs, real-time bidirectional streaming |

### 2.2 Monorepo Structure

```
senken-neo/
├── packages/
│   ├── core/         # @senken/core — agent runtime kernel
│   ├── kit/          # @senken/kit — zero-dep extension SDK (public)
│   └── app/          # @senken/app — CLI/TUI/server applications
├── extensions/
│   ├── senken.cron           # Scheduled task execution
│   ├── senken.skills         # SOP/markdown-based knowledge injection
│   ├── senken.defi           # Mock DeFi tools for testing
│   ├── senken.finance        # Finance layer (wallet ops, DeFi calls)
│   └── senken.finance-dummy  # Dummy driver for testing
├── skills/           # Markdown skill files (SOPs)
└── docs/             # Architecture & builder documentation
```

### 2.3 Package Responsibilities

| Package | Purpose |
|---------|---------|
| `@senken/core` | Agent runtime kernel — provider abstraction, extension loader, storage drivers, runner orchestration |
| `@senken/kit` | Public zero-dependency SDK for extension authors (types, factories, decorators) |
| `@senken/app` | CLI commands (TUI, server), terminal UI using Ink+React |

---

## 3. Key Features

### 3.1 Extension System (VS Code-Style)

- Extensions are local directories discovered by `ExtensionLoader`
- Full extension lifecycle: `onActivated(runtimeId)` / `onDeactivated` / `onStop`
- **Dependency ordering** — declare `dependencies: ['senken.wdk']`, runtime topologically sorts boot order with cascade-disable on missing deps
- **Inter-extension event bus** — UnJS hookable with named events (`cron:fire`, `market:update`)
- **Namespaced storage** — `setSetting()` for encrypted API keys, `setData<T>()` for typed JSON, per-extension and per-runtime scope

### 3.2 Agent Runtime (Single Agentic Loop)

- One `streamText()` call with all tools + `stepCountIs(maxToolRounds)` stopping condition
- **Agent self-manages work** via built-in task tools: `task_create`, `task_update`, `task_list`
- **Narration enforced** — agent must write text before and after every tool call for full auditability
- **Auto-title generation** — after first message, uses both user + AI response for better titles

### 3.3 Context Providers

- **Deterministic context injection** — inject market data, SOPs, strategy rules into system prompt WITHOUT relying on LLM tool-calling
- **Scope filtering** — `modes?: string[]` restricts provider to specific execution modes
- **Skill system** — markdown-based SOPs auto-injected via keyword search

### 3.4 Context Compaction

- **Auto-compact at 80% threshold** — LLM-generated summary replaces old messages
- **Checkpoint persistence** — compaction persisted as special `senken-compact` data parts
- **Manual compaction** — explicit API and CLI command `/compact`
- **Token tracking** — `CompactionInfo` includes compacted count, tokens saved, current usage ratio
- **Smart boundary handling** — latest compaction checkpoint acts as bookmark

### 3.5 Typed Stream Events

**Persistent (saved in message history):**
- `senken-context` — resolved context providers
- `senken-usage` — token consumption
- `senken-tasks` — task snapshot for session restore
- `senken-compact` — compaction checkpoint metadata

**Transient (stream-only):**
- `senken-run-start`, `senken-run-end`
- `senken-conversation` — resolved conversation ID
- `senken-title` — auto-generated title
- `senken-step-usage` — per-step token breakdown

### 3.6 Multi-Runtime Manager

- **SenkenGlobalRuntime** — manages N isolated agent runtimes with shared extension loader
- **Built for multi-tenant SaaS** — each user gets isolated runtime, all share one extension pool
- **Per-runtime extension filtering** — `addRuntime(id, { extensions: ['ext-a'] })`

### 3.7 REST + SSE + Socket.IO Server

- **Project-scoped API** — auth, agent CRUD, conversation CRUD, provider config
- **SSE streaming** — agent run streams via Server-Sent Events
- **Socket.IO protocol** — `run` → `run-started` → `chunk`(repeated) → `done`
- **Provider config CRUD** — dynamic provider schemas, JSON schema API for frontend form generation

### 3.8 Interactive TUI

- **Full Ink-based terminal UI** — live token tracking, task progress, compaction monitoring
- **Real-time updates** — blocks rendered as stream produces chunks
- **Cost estimation** — `/preview` estimates tokens and costs before running
- **Settings page** — model/provider picker, configuration management
- **Fullscreen display mode** — Ctrl+O toggles between compact and full display

### 3.9 Cron Extension (senken.cron)

- **Scheduled jobs as agent tools** — `cron_create/list/update/delete`
- **Cron expression parser** — standard cron syntax + shorthand ("every 5m", "every 1h")
- **Per-runtime timer isolation** — each runtime gets independent job maps
- **Persistent across restarts** — jobs stored in extension storage

### 3.10 Skills System (senken.skills)

- **Markdown-based SOPs** in `skills/` with YAML frontmatter
- **Auto-injection via context provider** — keyword search on user message, top match injected
- **No LLM tool-calling required** — deterministic SOP inclusion
- **Hot-load compatible** — drop a .md file, agent learns the procedure

---

## 4. Technical Decisions

### 4.1 Single Agentic Loop (vs Multi-Phase)

> **Decision:** One `streamText()` call with all tools instead of separate PLAN/EXECUTE phases.

- Agent decides when to plan vs execute
- Lower latency, simpler reasoning path
- Agent uses `task_create/update/list` tools to self-manage work breakdown

### 4.2 Framework-Agnostic Handler Pattern

```typescript
const runtime = new SenkenRuntime({
  handlers: {
    createConversation: (conv) => { /* save to DB */ },
    getConversation: (id) => { /* load from DB */ },
    getMessages: (cid, limit, offset, orderBy) => { /* query DB */ },
    addMessage: (cid, message) => { /* insert to DB */ },
  }
})
```

If handlers are missing → graceful degradation (no `addMessage` → messages not persisted, etc.)

### 4.3 Storage Driver Abstraction

```typescript
abstract class StorageDriver {
  // Conversation CRUD (scoped by runtimeId)
  abstract getConversation(runtimeId, id)
  abstract createConversation(runtimeId, conv)
  abstract listConversations(runtimeId)
  
  // Message CRUD
  abstract getMessages(runtimeId, cid, limit, offset, orderBy)
  abstract addMessage(runtimeId, cid, message)
  
  // Extension data (with optional encryption)
  abstract getExtensionSetting(scope, key)
  abstract setExtensionSetting(scope, key, value, encrypt?)
  abstract getExtensionData(scope, key)
  abstract setExtensionData(scope, key, value)
  
  toHandlers()  // converts to agent runner handler shape
}
```

**Concrete implementations:**
- `FileDriver` — Bun.file()-based, AES-256-GCM encryption for settings, path traversal protection
- `MemoryDriver` — in-memory, used in TUI and tests

### 4.4 Extension Dependency System (Topological Sort)

```typescript
// Extension declares dependency
defineExtension({
  meta: { id: 'senken.finance', dependencies: ['senken.wdk'] },
  ...
})

// Runtime performs Kahn's algorithm sort
// Missing deps → cascade-disable dependents
```

### 4.5 Registry Pattern for Cross-Extension APIs

Extensions can store objects in `ctx.registry` during setup, other extensions can query:

```typescript
// senken.finance stores context in registry
ctx.registry.set('finance:setup', setupContext)

// senken.finance-dummy retrieves and registers dummy driver
const financeSetup = ctx.registry.get('finance:setup')
financeSetup.registerDriver(dummyDriver)
```

### 4.6 ctx.provide() for Per-Runtime Context Injection

```typescript
// Extension registers factory at setup time
ctx.provide('walletContext', (runtimeId) => createWalletContext(runtimeId))

// Each runtime gets isolated context
// Resolved values merged into ExtensionRuntimeContext
```

### 4.7 Three-Layer Context Model

1. **ExtensionSetupContext** (global, at boot): `tools`, `context`, `hooks`, `http`, `ws`, `storage`, `registry`, `provide`
2. **ExtensionRuntimeContext** (per-runtime, at activation): `runtimeId`, `storage` (scoped), `hooks`, + resolved provide() values
3. **AgentRunnerRunContext** (per-run, at tool execution): `agentId`, `conversationId`, `mode`, `isPreview`, `metadata`, `setMetadata`, `write`

---

## 5. Compaction System (Detailed)

### 5.1 Auto-Compact Trigger

```typescript
getCompactionInfo(messages, agentId?): CompactionInfo {
  const maxContextWindow = config.maxContextWindow   // e.g., 128k tokens
  const threshold = config.threshold                 // e.g., 0.8 (80%)
  const compactThreshold = maxContextWindow * threshold
  const currentTokens = estimateMessageTokens(messages)
  
  return {
    compactedCount,
    currentTokens,
    maxContextWindow,
    compactThreshold,
    tokensUntilCompact: Math.max(0, compactThreshold - currentTokens),
    usageRatio: currentTokens / compactThreshold,
  }
}
```

Before `AgentRunner.run()` fetches history: if `currentTokens > compactThreshold` → compact and append checkpoint message.

### 5.2 Compaction Implementation

```typescript
async compactMessages({
  messages,      // old messages to summarize
  keepRecent,    // e.g., 5 — keep last N messages
  model,
}): Promise<CompactResult> {
  // 1. Split: toCompact = messages[0:-keepRecent]
  // 2. Build conversation text from toCompact
  // 3. Call generateText() with system prompt + conversation
  // 4. Return: { summary, compactedCount, tokensSaved }
}
```

### 5.3 Checkpoint Format

```typescript
{
  type: 'data-senken-compact',
  data: {
    summary: string         // LLM-generated summary
    compactedCount: number  // how many times compacted
    compactedUpTo: string   // ID of last compacted message
    tokensSaved: number     // estimated tokens freed
    timestamp: string       // ISO 8601
  }
}
```

### 5.4 History Boundary Application

```typescript
function applyCompactBoundary(messages): messages {
  // Scan backward for latest senken-compact data part
  // Return only messages from checkpoint onward
  // No checkpoint found → return all messages
}
```

**Effect:** Old messages BEFORE the checkpoint are permanently removed from context, replaced by the summary.

### 5.5 Token Estimation

```typescript
estimateMessageTokens(messages): number
// Heuristic: text.length / 4 ≈ tokens
// Sums across all message parts (text, tools, data)

previewRun(params): PreviewRunResult
// Per-phase token breakdown with sources
// Returns { phases, totalTokens, estimatedCost }
```

---

## 6. Storage & Data Layer

### 6.1 Conversation Message Format

```typescript
interface AgentRunnerMessage {
  id: string
  createdAt: Date
  message: UIMessage<any, SenkenDataTypes>  // Vercel AI SDK
  metadata?: Record<string, unknown>
}
```

Messages include text parts, tool parts, and typed data parts.

### 6.2 Extension Storage Scopes

```
Global (shared across runtimes):
  ext:<extensionId>                    // raw key-value
  ext:<extensionId>:settings           // encrypted settings
  ext:<extensionId>:data               // typed JSON

Per-Runtime (isolated per user):
  ext:<extensionId>:rt:<runtimeId>
  ext:<extensionId>:rt:<runtimeId>:settings
  ext:<extensionId>:rt:<runtimeId>:data
```

### 6.3 FileDriver Storage Structure

```
<dataDir>/
  runtimes/<runtimeId>/
    conversations/<conversationId>.json
  extensions/<extensionId>/
    settings/<key>
    data/<key>
  .encryption-key
```

---

## 7. Runtime Architecture

### 7.1 SenkenRuntime (Single Runtime)

```typescript
class SenkenRuntime {
  async boot()           // init storage, load extensions, activate for this runtime
  async run(params)      // execute agent with auto-compact check
  async previewRun()     // estimate tokens without execution
  async compact(params)  // manual compaction
  async resetConversation(params)
}
```

### 7.2 SenkenGlobalRuntime (Multi-Tenant Manager)

```typescript
class SenkenGlobalRuntime {
  async start()               // init storage, boot extensions, boot queued runtimes
  async stop()                // deactivate all, cleanup
  async addRuntime(id, opts)  // create isolated runtime, activate extensions
  async removeRuntime(id)     // deactivate, remove
  getRuntime(id)              // retrieve by ID
}
```

### 7.3 AgentRunner Run Flow

```
AgentRunner.run(params)
  ├─ Auto-compact check: if tokens > threshold → summarize + checkpoint
  ├─ Fetch conversation: load from handler (or create new)
  ├─ Fetch message history: limit + offset + ordering
  ├─ Apply compact boundary: only messages after latest checkpoint
  ├─ buildPhaseExtensions: collect tools + prompts + context providers
  ├─ Resolve context providers: deterministic injection (async)
  ├─ buildSystemPrompt: base role + custom prompt + phase rules
  ├─ runAgent: one streamText() call
  │   └─ Tool execution: each tool call runs with AgentRunnerRunContext
  ├─ Auto-title generation: if first message, generate title
  ├─ Stream events: senken-conversation, senken-title, senken-tasks, senken-usage
  └─ Return: { stream }
```

---

## 8. Notable Patterns

### 8.1 Phase-Less Architecture

Unlike V1 which had multi-phase orchestration (Orchestrate → Execute → Verify):
- **V2 has single phase: 'agent'** — agent decides what to do
- Tools registered once, mode-based filtering only (not phase-based)
- `AgentRunner.runAgent()` is ONE `streamText()` call

### 8.2 Tool Building Pattern

```typescript
defineTool({
  meta: { id: 'my_tool', name: '...', category: '...', kind: 'write' },
  build: (runtimeCtx?: ExtensionRuntimeContext) => tool({
    description: '...',
    inputSchema: z.object({...}),
    execute: async (input, options) => {
      const runCtx = getSenkenContext(options)
      if (runCtx?.isPreview) return 'preview mode'
      // Real execution
    }
  }),
  scope: { modes: ['agent'] }  // only active in 'agent' mode
})
```

### 8.3 Activity & Narration Enforcement

Agent MUST write narration text before and after every tool call:
- Provides full auditability of reasoning
- Frontend can show step-by-step progress
- Unlike V1 where tool calls could be silent

### 8.4 Hookable Event Bus

```typescript
ctx.hooks.hook('cron:fire', async (data) => { /* handle */ })
await ctx.hooks.callHook('cron:fire', { jobId: '...' })
```

Cross-extension communication is event-driven, decoupled from direct imports.

---

## 9. Deployment Scenarios

### Development (TUI)

```bash
bun run packages/app/src/index.ts tui
```

- Interactive terminal UI, single runtime, in-memory storage
- Extension auto-discovery from `extensions/` directory

### Production (Server)

```bash
bun run packages/app/src/index.ts start \
  --host=0.0.0.0 --port=7835 \
  --storage=file --data-dir=./data
```

- Express + Socket.IO server, FileDriver for persistence
- Multi-tenant via `SenkenGlobalRuntime`

### Embedded (SDK)

```typescript
import { SenkenRuntime } from '@senken/core'
const runtime = new SenkenRuntime({ agents, extensions, handlers })
await runtime.boot()
const result = await runtime.run({ conversationId, messages })
```

---

## 10. Comparison to Senken V1

| Aspect | V1 (prototype-senken-v1) | Senken Neo (V2) |
|--------|--------------------------|-----------------|
| **Phase System** | 3-phase (Orchestrate → Execute → Verify) | Single "agent" phase, self-managed tasks |
| **Architecture** | Cloud-first (Encore.ts + Next.js) | Standalone + embeddable runtime |
| **Extension System** | Simple context injection, no lifecycle | VS Code-style with dependency management |
| **Storage** | PostgreSQL cloud-coupled | Pluggable drivers (File, Memory, custom) |
| **TUI** | CLI-only | Full Ink-based interactive TUI |
| **Runtime** | Node.js + Encore | Bun |
| **Compaction** | Manual / basic | Auto-compaction at 80% + checkpoint system |
| **Multi-Tenant** | Not designed for it | SenkenGlobalRuntime with isolated runtimes |
| **Finance Layer** | Baked into core (23 tool files) | Extension (`senken.finance`) with driver pattern |
| **Streaming** | Basic text | Typed stream events (senken-usage, senken-tasks, etc.) |
| **Server** | Encore Cloud API | Self-hosted Express + Socket.IO |
| **Vendor Lock-in** | High (Encore Cloud) | None (fully self-contained) |

---

## 11. Key Files Reference

| Path | Purpose |
|------|---------|
| `packages/core/src/runner.ts` | AgentRunner — main orchestration, runAgent, compaction logic |
| `packages/core/src/runtime.ts` | SenkenRuntime + SenkenGlobalRuntime — high-level API |
| `packages/core/src/extensions/loader.ts` | ExtensionLoader — scanning, booting, activation |
| `packages/core/src/extensions/dependency.ts` | Topological sort for dependencies |
| `packages/core/src/storage/driver.ts` | Abstract StorageDriver base class |
| `packages/core/src/storage/file.ts` | FileDriver implementation (Bun.file-based) |
| `packages/core/src/storage/memory.ts` | MemoryDriver implementation (in-memory) |
| `packages/core/src/compaction.ts` | compactMessages() — LLM-based summarization |
| `packages/core/src/providers.ts` | AgentProviders — OpenAI, Anthropic, Google support |
| `packages/kit/src/index.ts` | Public SDK — defineExtension, defineTool, etc. |
| `packages/app/src/server/http.ts` | Express server setup + built-in routes |
| `packages/app/src/server/ws.ts` | Socket.IO setup + run protocol |
| `extensions/senken.cron/index.ts` | Cron scheduler extension |
| `extensions/senken.skills/index.ts` | Skills system — markdown SOP loading |
| `docs/feats/agent-runtime.md` | Full feature specification |
| `docs/builder/decisions.md` | 51+ architectural decision records |

---

## 12. Planned Features (Roadmap)

- [ ] Confirmation gate — pause before write tools, emit `senken-confirmation-required`
- [ ] `senken.wdk` extension — on-chain execution (EVM, Solana, TON, TRON, BTC)
- [ ] `senken.market` extension — 8-exchange real-time data
- [ ] `senken.news` extension — RSS/Atom feeds for agent context
- [ ] Decision log tool — `log_decision(reasoning, confidence, urgency, params)`
- [ ] Heartbeat runner — periodic cron triggers with strategy context
- [ ] Middleware guards — write tool interception (max amount, daily limits, cooldown)
- [ ] Studio — web workspace (flow graph, finance dashboard, decision log viewer)

---

## 13. Summary

**SenkenNeo** is a **framework-agnostic, production-grade agent runtime** that prioritizes:

1. **Simplicity** — single agentic loop vs complex multi-phase orchestration
2. **Auditability** — every tool call narrated, all stream events typed and persistent
3. **Extensibility** — VS Code-style plugins with dependency management
4. **Scalability** — multi-tenant ready with isolated runtimes and pluggable storage
5. **Portability** — no vendor lock-in, fully self-hostable, embeddable as SDK

The key architectural innovation is the **compaction checkpoint system** (auto-compact at 80% threshold with LLM-generated summaries persisted as boundary markers) combined with **typed stream events** that make every aspect of agent execution observable and recoverable.
