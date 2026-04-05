# Senken V1 — Analysis

> Reference: `./refs-senken-neo/prototype-senken-v1` (symlink → `../senken`)

---

## 1. What Is It?

**Senken** is an AI-native DeFi automation workspace designed for users who want to design and run autonomous trading strategies 24/7 with real on-chain execution via Tether WDK.

**Tagline:** "Your strategy, not ours."

**Core Value Proposition:**
- Users define strategy logic in plain language; AI executes it without override
- Every autonomous decision is logged with full reasoning, confidence level, urgency, and transaction hash
- Agents run 24/7 without maintenance; strategies run autonomously or with explicit approval gates
- Open extension architecture — custom tools, data sources, and UI panels

**Target Users:** DeFi traders who want AI-assisted analysis, autonomous execution, and full auditability of every agent decision.

---

## 2. Architecture

### 2.1 Tech Stack

| Layer | Technology | Reason |
|-------|-----------|--------|
| **Backend** | Encore.ts (Encore Cloud) | Cloud-native, native serverless scaling, WebSocket, object storage |
| **Frontend** | Next.js 16.1 (Vercel) | Server components for auth, TanStack Query for caching |
| **Database** | PostgreSQL + Drizzle ORM | Type-safe schema, 35+ tables, complex relationships |
| **Scheduling** | node-cron + Encore scheduled tasks | Heartbeat runner (1-min tick), cron jobs, price alert monitor |
| **AI Runtime** | Vercel AI SDK v6 | Multi-model support (OpenAI, Anthropic, Google), streaming |
| **Wallet/Finance** | Tether WDK | EVM, Solana, BTC, TON, TRON, Spark L2; Aave V3; Velora DEX |
| **Extension System** | Custom TypeScript SDK + plugin architecture | System + custom extensions |
| **MCP Server** | @modelcontextprotocol/sdk v1.27+ | Stateless endpoint for Claude Desktop, OpenClaw, Cursor |
| **Monorepo** | Bun workspaces + TypeScript | Fast local dev |

### 2.2 Monorepo Structure

```
packages/
  ├── api/          # Encore backend
  ├── web/          # Next.js frontend
  ├── sdk/          # @senken/sdk — public extension types
  └── ui/           # @senken/ui — shadcn/ui component library

extensions/
  ├── system/       # Always-active (WDK, 8 market providers, templates, etc.)
  └── custom/       # Per-project opt-in (Telegram, MCP debug, etc.)
```

### 2.3 Three Core Architectural Layers

1. **Execution Layer** (WDK + Finance Bridge) — all on-chain actions funneled through a unified `FinanceBridge`, never expose raw private keys
2. **Agent Runtime** (Vercel AI SDK + Tools) — central `runAgent()` orchestrates the loop, 23 tool files (~5,200 lines)
3. **Extension System** (Registry + Context Bridge) — `SenkenGlobalContext` injected at startup, `SenkenProjectContext` at runtime

---

## 3. Key Features

### 3.1 Core Agent Capabilities

| Feature | Implementation |
|---------|----------------|
| **Multi-agent per project** | Parent/child agent hierarchy; sub-agents via `spawnTask()` |
| **Persistent memory** | Agent Memory table (K/V with category, importance, expiry) |
| **Strategy Rules** | Project-scoped IF/THEN rules injected into system prompt; manually or AI-generated |
| **Decision Log** | Audit trail of every autonomous decision (reasoning, confidence, urgency, action params, tx hash) |
| **Middleware Pipeline** | Execution guards (max amount, daily limits, cooldown, custom approval agent) intercept finance tools |
| **Heartbeat** | Autonomous monitoring mode — configurable interval 1–60 min, active-hour windows |
| **Cron Jobs** | User-defined scheduled tasks; price alerts with cross-up/down events |
| **Action Requests** | Human-in-the-loop: agent escalates high-stakes decisions for user approval |

### 3.2 Finance Capabilities

| Capability | Details |
|-----------|---------|
| **Self-Custodial Wallets** | EVM (BIP-39 HD), ERC-4337 (gasless), Solana, Bitcoin, TON, TRON, Spark L2 |
| **Lending (Aave V3)** | Supply, borrow, withdraw, repay; health factor monitoring; APY discovery |
| **DEX Swaps (Velora)** | 160+ protocols aggregated; quote + execute with slippage awareness |
| **Equity Snapshots** | 30-min periodic portfolio snapshots for PnL tracking |
| **Real-time Market Data** | 8 exchanges via WebSocket (Binance, Bybit, OKX, KuCoin, Kraken, HTX, Gate.io, Bitget) |

### 3.3 Data & Intelligence

| Feature | Details |
|---------|---------|
| **Virtual File System (VFS)** | Per-project file storage; agents can read/write analysis reports, trade logs |
| **News Collector** | RSS/Atom feeds; agent tools to search/cite news in analysis |
| **Token Registry** | Built-in token list; dynamic price fetching (CoinGecko priority, DeFiLlama fallback) |
| **Chart Sessions** | Per-pair workspace state; agents can create indicators, labels, lines |

### 3.4 Workspace & UI

| Component | Details |
|-----------|---------|
| **Unified Workspace** | Chart, finance, news, files, activities, agent interaction in one app |
| **Flow Graph Visualization** | Agentic map of agents, memory, crons, rules, middleware via ReactFlow |
| **Chart Engine** | Lightweight Charts (TradingView) with real-time data and overlays |
| **Activities Stream** | Live event log + decision logs with reasoning, confidence, tx hash |
| **Extensions UI** | Per-project settings UI; UI panels via iframes (Vite + postMessage event bus) |

---

## 4. Technical Decisions

### 4.1 Run Mode System

Three modes, each declares its own tool set, memory injection, extension availability:

```typescript
type AgentRunMode = "chat" | "task" | "template_builder"
```

- **Chat** — interactive, full tools, memory + strategy injected
- **Task** — autonomous background, must not ask user, reports via decision log
- **Template Builder** — AI architect mode, specialized for designing multi-agent templates

### 4.2 System Prompt Composition

System prompt is a modular composition of sections, each tracked by token count:

```
Base Agent Prompt
  + Automation Mode (full_auto | semi_auto | confirmation)
  + Agent Memory (injected facts and preferences)
  + Active Strategies (IF/THEN rules per project)
  + Tools Prompt (registry of available tools)
  + Extension Prompt Sections (injected by extensions)
  + Mode-specific Addons (Task Mode instructions, Heartbeat context)
```

### 4.3 Middleware Pattern (Pre-Execution)

```
Agent calls financeSwapExecute(...)
  ↓
runMiddlewareGuard(projectId, agentId, "financeSwapExecute", toolArgs)
  ↓
For each enabled middleware (ordered by priority):
  ├── Check if appliesTo pattern matches tool name
  ├── Resolve guard agent + prompt
  ├── Run guard agent with templated prompt
  └── Return: pass | block | confirm
  ↓
If block → throw MiddlewareBlockedError
If confirm → create action request, wait for user
```

### 4.4 Extension Lifecycle

```
Setup Time (boot):
  ├── Load extension index.ts
  ├── Call setup(ctx: SenkenGlobalContext)
  │   ├── ctx.tools.register(tools)
  │   ├── ctx.market.registerProvider(provider)
  │   ├── ctx.prompt.inject(sectionId, content)
  │   └── ctx.settings.schema(fields)
  └── Store registered tools, settings, prompt sections in-memory

Runtime (per request):
  ├── Build SenkenProjectContext for this project
  ├── Resolve tools for this mode
  └── Pass ctx to tool handlers
```

### 4.5 Security & Custody

| Aspect | Implementation |
|--------|----------------|
| **Private Keys** | Encrypted in DB (AES-256-GCM); never exported; WDK holds originals |
| **API Keys** | User AI settings encrypted; MCP keys use SHA-256 hash (raw shown once) |
| **Auth** | JWT tokens, httpOnly cookies for web; Encore auth gate on protected endpoints |
| **Sandbox Wallets** | Backtest projects are ephemeral clones; original project untouched |

### 4.6 Token Budgeting

```typescript
estimateTokens(text): number  // ~4 chars per token (conservative)
TokenUsageInfo {
  inputTokens, outputTokens, totalTokens,
  cumulativeTokens, contextLimit,
  compactThreshold, compactCount
}
```

Compaction strategy: if cumulative tokens exceed threshold, summarize conversation history.

### 4.7 Manager + Specialist Multi-Agent Pattern

Template Builder enforces this hierarchy:

```
mainAgent (Manager / Financial Advisor)
  ├── Coordinates specialists via spawnTask()
  └── Makes final decisions

Sub-agents (Specialists)
  ├── Risk Monitor (health factor, liquidation risk)
  ├── Yield Optimizer (APY discovery, supply decisions)
  ├── Protocol Scout (new opportunities)
  └── Market Analyst (chart analysis, signals)
```

---

## 5. Storage & Data Layer

### 5.1 PostgreSQL Schema (35+ tables)

**User & Auth:** `users`, `user_ai_settings`

**Projects & Config:** `projects`, `project_pairs`, `project_extensions`, `extension_settings`, `extension_storage`

**Agent & Memory:** `agents`, `agent_memory`, `agent_strategy`, `agent_rule`

**Conversations & Tasks:** `conversations`, `conversation_messages`, `decision_logs`

**Scheduling & Triggers:** `cron_jobs`, `price_alerts`, `action_requests`, `webhooks`

**Finance & Wallets:** `finance_seeds`, `finance_wallets`, `finance_transactions`, `finance_snapshots`

**Channels & Connectors:** `channel_accounts`, `channel_bindings`, `channel_logs`

**VFS & News:** `vfs_files`, `news_sources`, `news_items`

**Backtest & Templates:** `templates`, `backtest_runs`

### 5.2 Data Flow

```
User → Next.js → Encore API → PostgreSQL
                          ↓
                    Agent Runtime (AI SDK)
                          ↓
                    WDK (wallet/lending/swap)
                          ↓
                    On-chain (EVM, Solana, etc.)
```

---

## 6. Runtime

### 6.1 Agent Execution Loop

```
runAgent(agentId, conversationId, message, mode="chat")
  ↓
1. Fetch agent config (model, systemPrompt, persona, toolsConfig)
2. Build System Prompt (modular sections)
3. Resolve tools with extensions:
   ├── Built-in tools (23 files)
   └── Extension tools (registered at boot)
4. Streaming loop (Vercel AI SDK streamText):
   ├── Tool calls intercepted → handled
   ├── Middleware guards on finance tools
   └── Emit activity events
5. Log conversation → return final text
```

### 6.2 Heartbeat Mode

```
Global cron every 1 minute
  ↓
For each agent with heartbeatEnabled=true:
  ├── Check if lastTick + intervalMinutes has passed
  ├── Inject recent decision history (last 10 logs)
  ├── Run agent in "task" mode
  └── Agent must call reportHeartbeatStatus() at end
```

### 6.3 Tool Registry

**23 Tool Files (~5,200 lines):**
- `finance-tools.ts` (1,219 lines) — swap, lending, wallet, gas, discovery
- `context.ts` (1,097 lines) — full bridge infrastructure
- `backtest-tools.ts` (672 lines) — sandbox testing
- `runtime-tools.ts` (300 lines) — think, report, etc.
- Plus 19 more: chart, decision, memory, middleware, schedule, action, news, vfs, heartbeat, template-builder, etc.

---

## 7. Architectural Tradeoffs

| Tradeoff | Chosen Path | Shadow |
|----------|------------|--------|
| **Unified wallet layer via WDK** | Consistency, simplified agent APIs | Execution ceiling bounded by WDK support |
| **Layered system prompts** | Modular, testable, transparent token usage | Complexity in composition order |
| **Extension context injection** | Full foundation access, no coupling to core | Easy to misuse bridges |
| **Middleware pre-execution** | Prevents risky actions before they happen | Cannot inspect actual tx cost/impact |
| **Heartbeat as agent property** | Always-on monitoring without user management | Global 1-min tick may be overkill at scale |
| **Encore.ts backend** | Auto-scaling, managed DB, WebSocket built-in | Vendor lock-in; harder to self-host |

---

## 8. Integration Points

| Interface | Details |
|-----------|---------|
| **MCP Server** | Stateless `POST /mcp`; 50+ tools; bearer token auth |
| **Extension SDK (@senken/sdk)** | Public TypeScript API; register tools, market providers, UI panels |
| **Webhook Triggers** | Inbound webhooks spawn agent tasks with HMAC validation |
| **Channel Connectors** | Telegram alerts via grammy; per-project account + rule binding |

---

## 9. Deployment

| Component | Platform |
|-----------|----------|
| **API** | Encore Cloud (Bun runtime, managed PostgreSQL) |
| **Web** | Vercel (Next.js 16.1, auto-scaling) |
| **Object Storage** | Encore bucket |
| **Scheduled Jobs** | Encore + node-cron |
| **DB Migrations** | Drizzle Kit |

---

## 10. Summary

Senken V1 is a **cloud-first, production-grade autonomous finance platform** with an extension architecture. It prioritizes **safety** (middleware guards, decision logs, sandbox testing) and **composability** (multi-agent templates, extensions). The codebase is tightly coupled to Encore Cloud and PostgreSQL, making it powerful but less portable. The key innovation is the **layered system prompt + middleware pattern** that makes every autonomous decision transparent and interruptible.
