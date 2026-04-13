# OpenClaw — Channels & Telegram: Analisis Mendalam

> Dokumen ini adalah hasil analisis mendalam terhadap codebase `refs-openclaw`, khusus bagian `src/channels/` dan `extensions/telegram/`. Tujuannya sebagai referensi arsitektur untuk membangun sistem serupa.

---

## Daftar Isi

1. [Overview Arsitektur Channels System](#1-overview-arsitektur-channels-system)
2. [Channel Types dan Lifecycle](#2-channel-types-dan-lifecycle)
3. [Binding System](#3-binding-system--mekanisme-routing-pesan-ke-agent)
4. [Plugin System](#4-plugin-system--bagaimana-channel-diextend)
5. [Telegram Extension Deep-Dive](#5-telegram-extension-deep-dive)
   - [Setup & Configuration Flow](#setup--configuration-flow)
   - [Bot Initialization](#bot-initialization-bottsts)
   - [Inbound Message Flow](#inbound-message-flow-telegram-update--processing)
   - [Session & Conversation Context](#session--conversation-context)
   - [Outbound Dispatch](#outbound-dispatch-ai-response--telegram-message)
   - [Threading & Topics System](#threading--topics-system)
   - [Native Commands](#native-commands-bot-native-commandsts)
   - [Approval System](#approval-system)
   - [Account Management](#account-management-accountsts)
   - [Audit System](#audit-system-auditts)
6. [Key Design Patterns](#6-key-design-patterns)
7. [Interesting Implementation Details](#7-interesting-implementation-details)
8. [Struktur File Telegram (Quick Reference)](#8-struktur-file-telegram-quick-reference)
9. [Diagram Arsitektur Terintegrasi](#9-diagram-arsitektur-terintegrasi)

---

## 1. Overview Arsitektur Channels System

### Konsep Inti

Channels system adalah abstraksi yang memungkinkan OpenClaw berkomunikasi dengan berbagai platform messaging (Telegram, Discord, Slack, WhatsApp, dll). Setiap channel adalah **plugin** yang terintegrasi dengan core routing, session management, dan delivery pipeline.

**Key insight:** Channels = platform abstractions, bukan chat rooms/channels. Routing bersifat **deterministic**: reply selalu kembali ke channel asal, bukan dipilih oleh model.

### Struktur Direktori Utama

```
src/channels/
  - Core contracts dan plugin infrastructure
  - Routing, binding, allowlist, mention/command gating logic
  - Session management, draft-stream controls
  - Shared channel utilities (ids.ts, targets.ts, conversation-binding-context.ts)

extensions/telegram/
  - Bundled Telegram channel plugin (production-ready)
  - Bot implementation via grammY
  - Message ingestion, dispatch, approval systems
  - Threading, topics, accounts, audit systems
```

---

## 2. Channel Types dan Lifecycle

### Chat Types

Dari `chat-type.ts`:

```typescript
type ChatType = "direct" | "group" | "channel"
```

- **direct** — DM antara user dan bot (1-to-1)
- **group** — Group chat (Telegram groups, Discord servers, dll)
- **channel** — Broadcast channel (Discord channels, Slack channels)

### Channel IDs dan Aliases

Dari `ids.ts`:
- Channels didaftarkan via plugin catalog dengan `id` dan optional `aliases`
- Lookup mencari `CHAT_CHANNEL_ORDER` (sorted list dari catalog entries)
- Normalisasi case-insensitive dan alias-aware
- Contoh: `telegram` atau `tg` keduanya resolve ke `telegram`

### Conversation Binding Context

Dari `conversation-binding-context.ts`, struktur pembawa informasi routing:

```typescript
type ConversationBindingContext = {
  channel: string;                // "telegram", "discord", dll
  accountId: string;              // account instance ID
  conversationId: string;         // group/DM ID di platform
  parentConversationId?: string;  // thread parent (jika nested)
  threadId?: string;              // forum topic atau thread ID
}
```

**Resolution logic:**
1. Try plugin's `resolveCommandConversation()` hook (if defined)
2. Try plugin's `resolveFocusedBinding()` hook untuk threading
3. Fallback ke target parsing dan conversation ID resolution

---

## 3. Binding System — Mekanisme Routing Pesan ke Agent

### Hierarchy Routing Rules

Dari `docs/channels/channel-routing.md`, routing mencari agent dalam order:

1. **Exact peer match** — `bindings` dengan `peer.kind` + `peer.id`
2. **Parent peer match** — thread inheritance dari parent conversation
3. **Guild + roles match** — Discord-specific
4. **Guild match**
5. **Team match** — Slack-specific
6. **Account match** — `accountId` pada channel
7. **Channel match** — any account pada channel
8. **Default agent** — fallback ke main agent

### Binding Provider dan Registry

Dari `binding-provider.ts` dan `binding-routing.ts`:

**ChannelConfiguredBindingProvider** = plugin-owned binding capability:

```typescript
type ChannelConfiguredBindingProvider = {
  resolveBindingForConversation?: (params) => ConfiguredBindingResolution;
}
```

**Binding Resolution Process:**
1. Core memanggil `resolveConfiguredBinding()` dengan conversation ref
2. Plugin mengembalikan stateful target (sessionKey, agentId)
3. Core updates route dengan binding target info
4. `matchedBy: "binding.channel"` sebagai audit trail

### Session Key Shapes

```
DM (main session):           agent:main:main
Group:                       agent:main:telegram:group:-1001234567890
Telegram forum topic:        agent:main:telegram:group:-1001234567890:topic:42
Discord thread:              agent:main:discord:channel:123456:thread:987654
```

Format: `agent:<agentId>:<channel>:<kind>:<id>[:<threadKind>:<threadId>]`

---

## 4. Plugin System — Bagaimana Channel Diextend

### ChannelPlugin Type

Dari `types.plugin.ts`, ChannelPlugin adalah facade lengkap dengan 20+ optional adapter:

```typescript
type ChannelPlugin<ResolvedAccount = any> = {
  id: ChannelId;
  meta: ChannelMeta;
  capabilities: ChannelCapabilities;

  // Lifecycle & setup
  setupWizard?: ChannelSetupWizard;
  setup?: ChannelSetupAdapter;
  pairing?: ChannelPairingAdapter;

  // Config & validation
  config: ChannelConfigAdapter;
  configSchema?: ChannelConfigSchema;

  // Core messaging
  outbound?: ChannelOutboundAdapter;
  messaging?: ChannelMessagingAdapter;
  mentions?: ChannelMentionAdapter;
  streaming?: ChannelStreamingAdapter;

  // Threading & groups
  threading?: ChannelThreadingAdapter;
  commands?: ChannelCommandAdapter;
  groups?: ChannelGroupAdapter;

  // Advanced features
  bindings?: ChannelConfiguredBindingProvider;
  conversationBindings?: ChannelConversationBindingSupport;
  approval?: ChannelApprovalCapability;
  actions?: ChannelMessageActionAdapter;

  // Operations
  gateway?: ChannelGatewayAdapter;
  auth?: ChannelAuthAdapter;
  status?: ChannelStatusAdapter;
  doctor?: ChannelDoctorAdapter;
  allowlist?: ChannelAllowlistAdapter;
  security?: ChannelSecurityAdapter;
  // ... 10+ more adapters
}
```

Plugin implement hanya adapter yang mereka butuhkan. Core check `if (plugin.adapter)` sebelum call.

### Plugin Lifecycle

1. **Discovery phase** — Load `openclaw.plugin.json`, validate manifest
2. **Registration phase** — Plugin registry calls entry points, populates adapters
3. **Setup phase** — Optional setup wizard untuk onboarding/auth
4. **Runtime phase** — Channel handles inbound/outbound via adapters
5. **Lifecycle hooks** — Optional heartbeat, doctor, status checks

### Bundled Plugin Entry Pattern

Dari `extensions/telegram/index.ts`:

```typescript
export default defineBundledChannelEntry({
  id: "telegram",
  name: "Telegram",
  plugin: { specifier: "./channel-plugin-api.js", exportName: "telegramPlugin" },
  secrets: { specifier: "./secret-contract-api.js", ... },
  runtime: { specifier: "./runtime-api.ts", exportName: "setTelegramRuntime" },
})
```

Separation of concerns:
- `channel-plugin-api.js` = static manifest + adapter registrations (loaded at startup)
- `secret-contract-api.js` = credential handling
- `runtime-api.ts` = dynamic runtime injection (lazy-loaded on demand)

---

## 5. Telegram Extension Deep-Dive

### Setup & Configuration Flow

**Configuration Sources** (priority order dari `accounts.ts`):

1. `channels.telegram.accounts[accountId].botToken` — config file
2. `TELEGRAM_BOT_TOKEN` env var — default account only
3. `~/.openclaw/credentials/telegram-<accountId>.token` — token file
4. Per-account token file loading

**Resolved Account Shape:**

```typescript
type ResolvedTelegramAccount = {
  accountId: string;
  enabled: boolean;
  name?: string;
  token: string;
  tokenSource: "env" | "tokenFile" | "config" | "none";
  config: TelegramAccountConfig;
}
```

Multi-account setup: `channels.telegram.accounts` = `Map<accountId, config>`, dengan fallback ke default account untuk legacy single-account setups.

**Config Schema Lengkap:**

```json5
{
  "channels": {
    "telegram": {
      "enabled": true,
      "defaultAccount": "default",
      "accounts": {
        "default": {
          "botToken": "...",
          "dmPolicy": "pairing" | "allowlist" | "open" | "disabled",
          "allowFrom": ["123456", "*"],
          "groupPolicy": "open" | "allowlist" | "disabled",
          "groups": {
            "-100...": {
              "requireMention": true,
              "allowFrom": ["..."],
              "topics": {
                "42": { "allowFrom": ["..."] }
              }
            }
          }
        }
      },
      "streaming": "off" | "partial" | "block" | "progress",
      "approvals": {
        "exec": {
          "enabled": true,
          "recipient": "-100..."
        }
      }
    }
  }
}
```

---

### Bot Initialization (bot.ts)

**Factory: `createTelegramBot(opts: TelegramBotOptions)`**

Key dependencies:
- `TelegramBotRuntime` = injectable Bot, sequentialize, apiThrottler
- `defaultTelegramBotDeps` = default implementations (lazy-loaded)
- Thread binding manager untuk forum topics / threaded conversations
- Account resolution + token validation

**Init Flow:**

```
createTelegramBot()
  → resolveTelegramAccount(cfg, accountId)       [token resolution]
  → createTelegramThreadBindingManager()          [jika threading enabled]
  → resolveTelegramTransport()                    [custom fetch atau default]
  → return Bot instance (grammY)
```

---

### Inbound Message Flow (Telegram update → processing)

#### Step 1: Update Ingestion (`bot-updates.ts`)

- Telegram updates via **polling** atau **webhook**
- Deduplication key: `buildTelegramUpdateKey()` = unique per update
- Media groups (carousel): batch dengan timeout `MEDIA_GROUP_TIMEOUT_MS = 100ms`

#### Step 2: Update Routing (`bot-handlers.runtime.ts`)

Entrypoint: `registerTelegramHandlers(bot, cfg, ...)`

Handlers per update type:
- `message` — text, media, replies, forwards
- `callback_query` — inline button clicks
- `my_chat_member` — bot join/leave events
- `channel_post` — broadcast channel messages
- `edited_message` — message edits
- `poll_answer` — poll votes
- `reaction` — emoji reactions

#### Step 3: Message Context Construction (`bot-message-context.ts`)

Core function: `buildTelegramMessageContext(params)`

Returns: `TelegramMessageContext | null`

```typescript
type TelegramMessageContext = {
  ctxPayload: TelegramMessageContextPayload;
  primaryCtx: grammY.Context;
  msg: Message;
  chatId: number;
  isGroup: boolean;
  groupConfig?: TelegramGroupConfig;
  topicConfig?: TelegramTopicConfig;
  resolvedThreadId?: number;      // forum topic ID
  threadSpec: {
    scope: "dm" | "group" | "forum";
    id: number;
  };
  route: ResolvedAgentRoute;
  skillFilter: SkillFilter;
  sendTyping: () => Promise<void>;
  reactionApi: TelegramReactionApi | null;
  statusReactionController: StatusReactionController | null;
  accountId: string;
}
```

**Resolution Steps (sequential):**

1. Extract basic message metadata (chatId, senderId, threadId)
2. Resolve forum flag via `getChat()` API call (cached per chat)
3. Determine thread spec (DM, group, forum topic)
4. Load group/topic config via `resolveTelegramGroupConfig()`
5. Enforce DM access via `enforceTelegramDmAccess()`
6. Evaluate group access via `evaluateTelegramGroupBaseAccess()` + `evaluateTelegramGroupPolicyAccess()`
7. Resolve conversation route via `resolveTelegramConversationRoute()`
8. Build inbound body + media via `resolveTelegramInboundBody()`
9. Construct session + delivery context
10. Setup typing/voice recording handlers
11. Configure reaction API + ack reactions

#### Step 4: Access Control Gates

**DM Policy:**
- `pairing` — require approval dari pairing store
- `allowlist` — require numeric user ID dalam `allowFrom`
- `open` — allow all (requires `allowFrom: ["*"]`)
- `disabled` — reject all DMs

**Group Policy:**
- Base access: group harus dalam `groups` allowlist config
- Sender access: user ID harus dalam `allowFrom` / `groupAllowFrom`
- Per-topic overrides: `groups[-100...].topics[topicId].allowFrom`

#### Step 5: Mention & Command Gating

**InboundMentionDecision** (dari `mention-gating.ts`):

```typescript
type InboundMentionDecision = {
  effectiveWasMentioned: boolean;
  shouldSkip: boolean;          // skip processing jika tidak mentioned
  implicitMention: boolean;
  matchedImplicitMentionKinds: InboundImplicitMentionKind[];
  shouldBypassMention: boolean; // allow tanpa mention untuk text commands
}
```

Implicit mention kinds yang dikenali:
- `reply_to_bot` — balasan ke pesan bot
- `quoted_bot` — mention via quote
- `bot_thread_participant` — bot adalah thread participant
- `native` — explicit @mention

---

### Session & Conversation Context

Dari `bot-message-context.session.ts`:

```typescript
type TelegramMessageContextPayload = {
  ctxPayload: {
    sessionKey: string;
    sessionMeta: { ... };
    lastRoute: { ... };
    boundSessionKey?: string;
    boundAgentId?: string;
  }
}
```

**Session key construction rules:**

| Scenario | Session Key |
|----------|-------------|
| DM tanpa thread | `agent:main:main` |
| DM dengan thread | `agent:main:telegram:dm:<userId>:thread:<threadId>` |
| Group | `agent:main:telegram:group:<chatId>` |
| Forum topic | `agent:main:telegram:group:<chatId>:topic:<topicId>` |

**Session Pinning Problem & Solution:**

Problem: DM sessions shared across users dapat corrupt `lastRoute`.

Solution:
- Detect "main DM owner" dari single `allowFrom` entry
- Skip `lastRoute` update jika sender ≠ pinned owner
- Preserve cross-channel main session context

---

### Outbound Dispatch (AI response → Telegram message)

#### Step 1: Dispatch Entry (`bot-message-dispatch.ts`)

Function: `dispatchTelegramPluginInteractiveHandler(ctx, interactive, ...)`

Handles:
- Text replies
- Media payloads (document, photo, video, audio, voice)
- Inline buttons (model-generated interactive content)
- Reactions (ack, status)
- Message edits (draft streaming)
- Message deletions (cleanup)

#### Step 2: Send Pipeline (`send.ts`)

Core: `sendMessageTelegram(to: string, text: string, options?: TelegramSendOptions)`

**`to` parameter formats:**
- Direct user ID: `"123456789"` (positive)
- Group/supergroup: `"-1001234567890"` (negative)
- Forum topic: `"-1001234567890:42"` (group:topicId)

```typescript
type TelegramSendOptions = {
  verbose?: boolean;
  cfg: OpenClawConfig;
  messageThreadId?: number;
  replyToMessageId?: number;
  accountId?: string;
  silent?: boolean;
  forceDocument?: boolean;
  mediaUrl?: string;
  mediaLocalRoots?: readonly string[];
  gatewayClientScopes?: readonly string[];
}
```

#### Step 3: Lane Delivery (`lane-delivery.ts`)

- **Concurrency control per conversation** — sequential delivery untuk preserve ordering
- Retry logic untuk transient network errors
- Prevents interleaving replies dalam concurrent scenarios

#### Step 4: Draft Streaming (`draft-stream.ts`)

Live preview updates saat model sedang generate:
- DM + groups: send preview message, edit in-place dengan `editMessageText`
- Cleanup preview jika response akhir berupa complex payload (media, buttons)

State machine:
```typescript
state = { stopped: false, final: false }

// Loop berjalan selama !stopped && !final
// stop() → sets final, prevents new updates
// stopForClear() → sets stopped, waits inflight, clears
```

Default throttle: ~500ms antara preview updates.

---

### Threading & Topics System

Dari `thread-bindings.ts` dan `action-threading.ts`:

**TelegramThreadBindingRecord:**

```typescript
type TelegramThreadBindingRecord = {
  accountId: string;
  conversationId: string;   // "chatId:topicId" format
  targetKind: "subagent" | "acp";
  targetSessionKey: string;
  agentId?: string;
  boundAt: number;
  lastActivityAt: number;
  idleTimeoutMs?: number;
  maxAgeMs?: number;
}
```

**Thread binding purposes:**
- Auto-spawn subagent untuk forum topic baru
- Maintain separate session per Telegram topic
- Idle timeout + max age cleanup untuk stale bindings

**Usage scenarios:**
- Forum topics dalam supergroup → auto-spawn topic-specific subagent
- DM threads (jika platform support) → thread-specific session
- Custom binding untuk routing ke agent tertentu per topic

**Auto Topic Labeling (`auto-topic-label.ts`):**
- Strategies untuk auto-name topics berdasarkan message content
- Configurable naming patterns

---

### Native Commands (`bot-native-commands.ts`)

**Command menu** dibuild dinamis dari slash commands + subscribed skills.

Built-in commands:
- `/start` — onboarding flow
- `/help` — list semua commands
- `/activation` — toggle mention requirement per session
- `/skill <name>` — skill discovery
- `/model` — model selection dengan keyboard pagination

**Pagination pattern:**
- Keyboard-based paging untuk long lists (models, skill list)
- Inline buttons untuk Previous/Next navigation
- State preservation saat navigating pages

---

### Approval System

#### Native Approval (`approval-native.ts`)

Handles approval requests untuk execution permissions, plugin actions.

Flow:
1. Approval request dengan action descriptors diterima
2. Build inline buttons dari available actions
3. User clicks button → `callback_query` event
4. Parse callback data → resolve approve/reject decision
5. Execute action, clear buttons

**Callback data format** (dari `approval-callback-data.ts`):

```
__approval:<approvalId>:<actionIndex>
```

#### Execution Approval Handler (`approval-handler.runtime.ts`)

Runtime adapter untuk approval requests:

```typescript
export const telegramApprovalNativeRuntime = createChannelApprovalNativeRuntimeAdapter({
  eventKinds: ["exec", "plugin"],
  availability: { isConfigured, shouldHandle },
  presentation: { buildPendingPayload, ... },
  transport: { prepareTarget, deliverPending, ... }
})
```

**Delivery sequence:**
1. Send typing indicator
2. Send approval message dengan inline keyboard
3. Wait untuk `callback_query`
4. Execute approval action
5. Clear inline keyboard atau send result message

---

### Account Management (`accounts.ts`)

**Multi-account support:**
- Each account = separate bot instance dengan independent token
- Config key: `channels.telegram.accounts[accountId]`
- Default account fallback untuk legacy single-account setups
- Binding-aware: accounts dapat dipilih per agent via bindings

**Account validation:**
- Token source detection (config, env, tokenFile)
- Duplicate token detection via `findTelegramTokenOwnerAccountId()`
- Per-account group config isolation (prevent cross-account failures)

**Account Inspection (`account-inspect.ts`):**
- Validate bot token via `getMe()` API call
- Check permissions dalam configured groups
- Detect missing forum flags
- Surface config mismatches sebagai diagnostic issues

---

### Audit System (`audit.ts`)

**Unmentioned group detection:**

```typescript
collectTelegramUnmentionedGroupIds({
  cfg: OpenClawConfig,
  accountId: string,
  botMe: BotMe
}): UnmentionedGroup[]
```

Lists groups bot is member of tapi belum configured. Berguna untuk config discovery wizard.

**Security Audit (`security-audit.ts`):**
- Token exposure checks
- Permission validation
- Config consistency checks

**State Migrations (`state-migrations.ts`):**
- `@username` → numeric ID conversion
- Old pairing store → new allowlist config
- Forum flag detection dan normalization
- Group config normalization untuk backward compat

---

## 6. Key Design Patterns

### 1. Adapter Pattern (Plugin Contract)

Setiap capability adalah optional adapter — plugins implement hanya yang mereka butuhkan:

```typescript
config?: ChannelConfigAdapter<ResolvedAccount>
outbound?: ChannelOutboundAdapter
mentions?: ChannelMentionAdapter
// ...
```

Core check `if (plugin.adapter)` sebelum call. Zero-cost untuk unimplemented capabilities.

### 2. Lazy Loading + Runtime Injection

Separation antara static manifest dan heavy runtime code:

```typescript
let telegramSendModulePromise: Promise<typeof import("./send.js")> | undefined;

async function loadTelegramSendModule() {
  telegramSendModulePromise ??= import("./send.js");
  return await telegramSendModulePromise;
}
```

Heavy modules (`send.ts` ~58k LOC, `bot-message-context.runtime.ts`) loaded on demand. Menjaga startup fast.

### 3. Dependency Injection (DI) untuk Testability

Functions accept `deps` parameters:

```typescript
createTelegramBot({
  config?: OpenClawConfig,
  runtime?: RuntimeEnv,
  telegramDeps?: TelegramBotDeps,       // injected
  telegramTransport?: TelegramTransport, // injected
})
```

Default implementations untuk production, mocks untuk testing. Pattern ini dipakai extensively di seluruh Telegram codebase.

### 4. Context Passing / Enrichment Chain

Multi-level context threading melalui call stack, setiap layer enrich konteks:

```
buildTelegramMessageContext(params)
  → resolveTelegramConversationRoute(cfg, primaryCtx, ...)
    → enforceTelegramDmAccess(cfg, ...)
    → evaluateTelegramGroupBaseAccess(cfg, ...)
      → evaluateTelegramGroupPolicyAccess(cfg, ...)
```

### 5. State Machine untuk Draft Streaming

Ensures clean shutdown tanpa race conditions:

```
stopped=false, final=false → running (updates allowed)
stopped=false, final=true  → finalized (no more updates)
stopped=true, final=*      → stopped (waiting for inflight, then clear)
```

### 6. Allowlist Resolution dengan Match Source Tracking

Dari `allowlist-match.ts`:

```typescript
type AllowlistMatch<TSource> = {
  allowed: boolean;
  matchKey?: string;
  matchSource?: TSource;  // "id" | "name" | "wildcard" | ...
}
```

Generic resolution dengan pluggable candidate sources. Match source tracking untuk audit + debugging siapa yang match.

### 7. Nested Allowlist Cascading (Authorization Layers)

```typescript
resolveNestedAllowlistDecision({
  outerConfigured: true,   // channel-level configured
  outerMatched: true,       // outer matched sender
  innerConfigured: true,    // group-level configured
  innerMatched: false       // group-level did NOT match
}): boolean  // → false (outer ok, inner failed = deny)
```

Allows per-group override tanpa repeating full allowlist.

### 8. Channel Entry Match dengan Fallback

Dari `channel-config.ts`:

```typescript
resolveChannelEntryMatchWithFallback({
  entries: { "telegram": config, "tg": config },
  keys: ["telegram"],
  parentKeys: ["*"],        // wildcard fallback
  wildcardKey: "default",
  normalizeKey: (k) => normalizeChannelSlug(k)
})
```

Returns `ChannelEntryMatch` dengan `matchSource: "direct" | "parent" | "wildcard"` untuk audit trail.

---

## 7. Interesting Implementation Details

### 1. Media Group Batching

Telegram mengirim carousel (multiple photos) sebagai beberapa update terpisah dengan `media_group_id` yang sama:

```typescript
MEDIA_GROUP_TIMEOUT_MS = 100

// Batch semua updates dengan same media_group_id
// sampai 100ms silence, lalu process sebagai satu message
```

Ensures carousel attachments diproses sebagai atomic unit.

### 2. Sequential Key Isolation

```typescript
getTelegramSequentialKey({
  chatId: number,
  topicId?: number,
  messageThreadId?: number
}): string
// Returns "123456:-100..." atau "123456:-100...:42"
```

Concurrency control per conversation, prevent interleaving replies.

### 3. Thread Binding Versioning

```typescript
type StoredTelegramBindingState = {
  version: number,  // = 1 (for future migrations)
  bindings: TelegramThreadBindingRecord[]
}
```

Atomic writes via `writeJsonFileAtomically()` + in-memory sync. Prevents race conditions antara live updates dan persistence.

### 4. Runtime Injection untuk Tests

```typescript
let telegramBotRuntimeForTest: TelegramBotRuntime | undefined;

export function setTelegramBotRuntimeForTest(runtime?: TelegramBotRuntime): void {
  telegramBotRuntimeForTest = runtime;
}
```

Pattern ini dipakai di banyak tempat untuk inject test doubles tanpa mengubah production code path.

### 5. Forum Flag Caching

```typescript
isForum = await resolveTelegramForumFlag({
  chatId, chatType, isGroup, isForum,
  getChat: bot.api.getChat.bind(bot.api) // cached API call
})
```

Avoids repeated `getChat()` API calls per message dalam same chat. Forum flag di-cache per chatId.

### 6. Account Action Gating

```typescript
createAccountActionGate({
  accountIds: ["default", "backup"],
  blocked: ["someAccountId"],
  defaultBehavior: "allow"
})
```

Per-account enablement/disablement untuk safety. Prevent misconfigured account dari disrupting others.

### 7. Target ID Parsing Utilities

Dari `targets.ts`, generic parsing utilities untuk channel-specific mention formats:

```typescript
parseTargetMention({ raw: "@botname", mentionPattern, kind: "user" })
parseTargetPrefix({ raw: "user:123", prefix: "user:", kind: "user" })
parseAtUserTarget({ raw: "@123", atUserPattern: /^\d+$/, ... })
parseMentionPrefixOrAtUserTarget({ ... })  // try all patterns
```

Setiap channel implements own mention/prefix patterns di atas generic core helpers.

### 8. Reaction Type Detection

```typescript
type TelegramReactionEmoji = ReactionTypeEmoji["emoji"]
isTelegramSupportedReactionEmoji(emoji: string): boolean
resolveTelegramStatusReactionEmojis(cfg): Set<string>
```

Reactions harus emoji yang didukung Telegram API. Config allows override per channel. Status reactions (thinking, done, error) dipetakan ke emoji tertentu.

### 9. Group Chat ID Normalization

```typescript
buildTelegramGroupPeerId(chatId: number): string
// chatId: -1001234567890 (supergroup, negative)
// chatId: 123456789 (private chat, positive)
```

Negative IDs untuk groups/supergroups, positive untuk private chats — penting untuk routing dan session key construction.

---

## 8. Struktur File Telegram (Quick Reference)

```
extensions/telegram/src/

── Core Bot ──────────────────────────────────────────────────
bot.ts (~20k)                  Factory, initialization, handler wiring
bot-deps.ts                    Default dependencies (injected in production)
bot-access.ts                  DM/group allowlist checking
bot-handlers.runtime.ts (~66k) Update handlers (message, callback, etc)
bot-updates.ts                 Update keying, dedup, media group batching
bot.runtime.ts                 Bot class wrapper, sequencing, throttling
bot.types.ts                   TypeScript definitions

── Message Context & Processing ──────────────────────────────
bot-message-context.ts (~18k)         Message context construction (main entry)
bot-message-context.body.ts           Extract text + media from update
bot-message-context.session.ts        Session key construction
bot-message-context.session.runtime.ts Session runtime loading
bot-message-context.dm-threads.ts     DM thread handling
bot-message-context.implicit-mention.ts Implicit mention detection
bot-message-context.silent-ingest.ts  Silent message ingestion
bot-message-context.types.ts          Context type definitions
bot-message.ts                        Message model

── Dispatch & Sending ────────────────────────────────────────
bot-message-dispatch.ts (~36k) Dispatch: text, media, buttons, reactions
send.ts (~58k)                 Send pipeline, media handling, retry logic
lane-delivery.ts (~21k)        Concurrency-aware message delivery
draft-stream.ts (~17k)         Live streaming + message edits

── Conversation Routing ──────────────────────────────────────
conversation-route.ts          Conversation ID → agent routing
                               (resolveTelegramConversationRoute)

── Access Control ────────────────────────────────────────────
dm-access.ts                   DM pairing/allowlist enforcement
group-access.ts                Group allowlist + policy checking
group-policy.ts                Per-group config resolution

── Mentions & Commands ───────────────────────────────────────
bot-message-context.implicit-mention.ts  Implicit mention logic
bot-native-commands.ts (~41k)            Slash commands, menus, pagination
bot-native-command-menu.ts               Command menu construction
bot-native-commands.delivery.runtime.ts  Command delivery

── Threading & Bindings ──────────────────────────────────────
thread-bindings.ts (~29k)      Thread binding manager, forum topics
action-threading.ts            ACP binding + threading support
auto-topic-label.ts            Topic naming strategies

── Approval System ───────────────────────────────────────────
approval-native.ts (~7k)               Approval UI (buttons, callbacks)
approval-handler.runtime.ts (~7k)      Approval request handling
approval-callback-data.ts              Callback data parsing

── Accounts & Auth ───────────────────────────────────────────
accounts.ts (~8k)              Multi-account setup, token resolution
account-inspect.ts (~7k)       Account validation, diagnostics
token.ts (~4k)                 Token loading (env/config/file)
setup-core.ts (~5k)            Setup adapter
setup-surface.ts (~4k)         Setup wizard UI

── Media & Stickers ──────────────────────────────────────────
bot-handlers.media.ts          Media extraction from updates
sticker-cache.ts (~4k)         Sticker caching
media-understanding.runtime.ts Media vision integration

── Monitoring & Health ───────────────────────────────────────
monitor.ts (~9k)               Polling/webhook health checks
probe.ts (~7k)                 Bot connectivity probe
status-issues.ts (~5k)         Config validation issues
audit.ts (~3k)                 Unmentioned group detection
security-audit.ts (~7k)        Security findings

── Utilities ─────────────────────────────────────────────────
config-ui-hints.ts (~9k)       UI hints untuk Telegram config
format.ts (~14k)               Message formatting (HTML, markdown escape)
normalize.ts                   Target ID normalization
targets.ts (~3k)               Target parsing utilities
button-types.ts (~2k)          Button/keyboard type definitions
inline-buttons.ts (~3k)        Inline button builders
shared.ts (~9k)                Shared utilities (token duplication check, dll)

── Testing Support ───────────────────────────────────────────
bot.test.ts (~85k)                      Bot integration tests
bot-message-dispatch.test.ts (~102k)    Dispatch tests
send.test.ts (~75k)                     Send pipeline tests
... (100+ test files)
```

---

## 9. Diagram Arsitektur Terintegrasi

```
┌──────────────────────────────────────────────────────────────────┐
│ OpenClaw Core                                                    │
├──────────────────────────────────────────────────────────────────┤
│                                                                  │
│  Routing Layer                                                   │
│    ↓ Determine which agent handles message                      │
│      (peer → guild → team → account → channel → default)       │
│                                                                  │
│  Channels Registry + Plugin System                              │
│    ↓ Load channel adapters (Telegram, Discord, Slack, ...)      │
│                                                                  │
│  Session Management                                             │
│    ↓ Map conversation → session key → agent state              │
│                                                                  │
│  Outbound Dispatch                                              │
│    ↓ Route AI response back to originating channel            │
│                                                                  │
└──────────────────────────────────────────────────────────────────┘
         ↑ inbound                          ↓ outbound
         │                                  │
┌──────────────────────────────────────────────────────────────────┐
│ Telegram Channel Plugin (extensions/telegram/)                  │
├──────────────────────────────────────────────────────────────────┤
│                                                                  │
│  Transport Layer                                                │
│    Long Polling │ Webhook → update deduplication               │
│    Media group batching (100ms timeout)                        │
│                                                                  │
│  Update Router (bot-handlers.runtime.ts)                       │
│    message │ callback_query │ chat_member │ channel_post        │
│    edited_message │ poll_answer │ reaction                     │
│                                                                  │
│  Message Context Builder (bot-message-context.ts)             │
│    ├─ Extract sender, group, topic metadata                    │
│    ├─ Resolve forum flag (cached getChat API)                  │
│    ├─ DM access enforcement (pairing/allowlist/open)          │
│    ├─ Group access evaluation (base + policy)                  │
│    ├─ Conversation → agent routing                             │
│    ├─ Inbound body + media extraction                         │
│    └─ Session key construction                                │
│                                                                  │
│  Gating Layer                                                  │
│    Mention gating (explicit + implicit)                        │
│    Command gating (text commands, access groups)               │
│    Allowlist enforcement (per-chat, per-topic)                │
│                                                                  │
│  Outbound Dispatch (bot-message-dispatch.ts)                  │
│    ├─ Text + media sending (send.ts)                          │
│    ├─ Lane delivery (per-conversation sequential)             │
│    ├─ Draft streaming (live edits, throttled)                 │
│    ├─ Reactions + inline buttons                              │
│    └─ Thread/topic routing                                    │
│                                                                  │
│  Advanced Subsystems                                           │
│    ├─ Thread binding manager (forum topics, auto-spawn)       │
│    ├─ Native approval system (inline buttons, callbacks)      │
│    ├─ Account management (multi-bot, token sources)           │
│    ├─ Native commands (slash menu, pagination)                │
│    ├─ Audit & security checks                                 │
│    └─ State migrations (backward compat)                      │
│                                                                  │
└──────────────────────────────────────────────────────────────────┘
         ↑ updates                          ↓ API calls
         │                                  │
    ┌────────────────────────────────────────┐
    │           Telegram API                 │
    │    (grammY + polling/webhook)          │
    └────────────────────────────────────────┘
```

---

## Catatan Penting untuk Implementasi Ulang

1. **Plugin SDK Boundary** — Telegram production code imports hanya dari `openclaw/plugin-sdk/*` + local barrels (`./api.ts`, `./runtime-api.ts`), bukan core `src/**` internals. Pastikan batas ini jelas.

2. **Lazy Loading Strategy** — Heavy modules (`send.ts`, `bot-message-context.runtime.ts`) harus di-load on demand untuk menjaga startup speed. Jangan eagerly load semua.

3. **State Isolation** — Thread binding state disimpan dalam `globalThis` Symbol untuk shared visibility across bundled chunks tanpa circular dependency.

4. **Testing Pattern** — Dependency injection + runtime mocks memungkinkan extensive unit testing tanpa real Telegram API calls. Semua IO-heavy operations harus injectable.

5. **Extensibility** — Plugin contract yang comprehensive; channel dapat opt-in ke features yang mereka support tanpa implementing full interface. Ini memungkinkan incremental implementation.

6. **Session Key as Identity** — Session key adalah satu-satunya identifier yang persistent untuk conversation state. Format-nya harus stable dan tidak berubah antar versions.

7. **Ordering Guarantees** — Lane delivery dengan sequential key sangat penting untuk UX. Tanpa ini, responses dari concurrent requests bisa terinversi.
