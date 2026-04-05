# Plan 10 — Channels & Connector System

> Status: Planning Done  
> Depends on: Plan 7 (Plugin System V3), Plan 8 (Memory), Plan 9 (Persona)  
> Layer: App layer (core tables + routes) + Plugin layer (Telegram, dll sebagai plugin)  
> Includes carry-over: Pending items dari Plan 8 (MemoryPreviewSheet, integration tests) dan Plan 9 (extractPersonaPostRun, DB migration)

---

## 1. Overview & Goals

Connector System memungkinkan agent menerima input dan mengirim output dari/ke platform pihak ketiga (Telegram, Discord, WhatsApp, dll) secara unified. Semua tetap masuk via `runtime.run()` — tidak ada special path.

**Goals:**
- System bisa menangkap input dari connector pihak ketiga
- Binding: identity/session di connector → pipeline di Jiku (conversation/task)
- Trigger bisa dari message ATAU event (reaction, edit, pin, dll)
- Agent bisa query events dan metadata connector secara aktif
- Connector sebagai plugin — extensible, bukan hardcode
- UI lengkap: channels, bindings, events, inbound/outbound log
- User Identity Store — structured key-value per user per project

**Non-goals Plan 10:**
- Heartbeat mode (Plan 11)
- Mode system extensible (Plan 11)
- Multi-agent orchestration via channel (Plan 12)

---

## 2. Core Concepts

### 2.1 Connector
Plugin yang mengimplementasi interface `ConnectorAdapter`. Handle protocol pihak ketiga — terima event, kirim response. Contoh: `jiku.connector.telegram`, `jiku.connector.discord`.

### 2.2 Binding
Aturan routing: event dari source mana, dengan kondisi apa, diarahkan ke agent dan adapter type apa. Binding juga berlaku untuk events (bukan hanya message).

### 2.3 Adapter Type
Cara input diproses setelah masuk ke Jiku:
- `conversation` — masuk ke conversation, output balik ke connector
- `task` — trigger task mode, agent kerja mandiri
- `notify` — outbound only (untuk heartbeat, future)

### 2.4 Connector Identity
Identity eksternal (Telegram user_id, Discord user_id, dll) yang di-map ke user Jiku. Status: pending → approved → blocked.

### 2.5 User Identity Store
Structured key-value per user per project. Berbeda dari memory (natural language) — ini machine-readable, exact lookup. Diisi oleh user, agent, atau system (auto dari connector).

### 2.6 Flexible Ref Keys
Setiap platform punya key schema berbeda. Menggunakan jsonb `keys: Record<string, string>` agar extensible — tidak hardcode `message_id`, `thread_id`, `chat_id`.

```
Telegram: { message_id, chat_id }
Discord:  { message_id, channel_id, guild_id, thread_id? }
WhatsApp: { message_id, chat_id, wamid }
Platform baru: define sendiri
```

---

## 3. Architecture

```
Platform Pihak Ketiga
  ↓ webhook / polling
Connector Plugin (jiku.connector.telegram)
  → normalize ke ConnectorEvent
  ↓
Connector Event Router (app layer)
  → match binding rules
  → check trigger_source (message | event)
  → check trigger_mode & filter
  → check approval status
  → check rate limit
  ↓ pass / drop / pending
Adapter Executor
  → conversation adapter → runtime.run({ mode: 'chat' })
  → task adapter        → runtime.run({ mode: 'task' })
  ↓
Agent Response
  ↓
Connector Plugin (outbound)
  → send response ke platform
```

### Plugin sebagai Extension Point

Connector plugin implement `ConnectorAdapter` interface dari `@jiku/kit`:

```typescript
// @jiku/kit — defineConnector
export interface ConnectorAdapter {
  id: string
  displayName: string
  // Keys yang dipakai untuk ref (dokumentasi)
  refKeys: string[]
  // Supported event types
  supportedEvents: ConnectorEventType[]

  // Lifecycle
  onActivate(config: unknown, ctx: ConnectorContext): Promise<void>
  onDeactivate(): Promise<void>

  // Inbound: normalize raw platform event → ConnectorEvent
  parseEvent(raw: unknown): ConnectorEvent | null

  // Outbound: kirim response ke platform
  sendMessage(target: ConnectorTarget, content: ConnectorContent): Promise<ConnectorSendResult>
  sendReaction?(target: ConnectorTarget, emoji: string): Promise<void>
  deleteMessage?(target: ConnectorTarget): Promise<void>
  editMessage?(target: ConnectorTarget, content: ConnectorContent): Promise<void>
}

export function defineConnector(adapter: ConnectorAdapter): JikuPlugin {
  return definePlugin({
    meta: {
      id: adapter.id,
      project_scope: true,
    },
    setup(ctx) {
      // Register ke ConnectorRegistry (app layer, via ctx hook)
      ctx.hooks.hook('connector:register', () => adapter)
    },
    onProjectPluginActivated: async (projectId, ctx) => {
      await adapter.onActivate(ctx.pluginConfig, { projectId, ctx })
    },
    onProjectPluginDeactivated: async (projectId) => {
      await adapter.onDeactivate()
    },
  })
}
```

### Unified Event Type

```typescript
type ConnectorEventType = 
  | 'message'    // pesan masuk
  | 'reaction'   // user react ke message
  | 'unreaction' // user hapus reaction
  | 'edit'       // user edit message
  | 'delete'     // user hapus message
  | 'pin'        // message di-pin
  | 'join'       // user join group
  | 'leave'      // user leave group
  | 'custom'     // platform-specific, payload di metadata

interface ConnectorEvent {
  type: ConnectorEventType
  connector_id: string
  // Flexible keys — platform define sendiri
  ref_keys: Record<string, string>
  sender: {
    external_id: string
    display_name?: string
    username?: string
    is_bot?: boolean
  }
  // Untuk event reaction/edit/delete — ref ke message asli
  target_ref_keys?: Record<string, string>
  content?: {
    text?: string
    media?: { type: string; url?: string; data?: Buffer }
    raw?: unknown  // platform-specific payload
  }
  metadata?: Record<string, unknown>  // platform extras
  timestamp: Date
}
```

---

## 4. DB Schema

### 4.1 `connectors` — instance connector per project

```sql
CREATE TABLE connectors (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id   uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  plugin_id    text NOT NULL,               -- 'jiku.connector.telegram'
  display_name text NOT NULL,
  config       jsonb NOT NULL DEFAULT '{}', -- encrypted sensitive fields
  status       text NOT NULL DEFAULT 'inactive'
                 CHECK (status IN ('active', 'inactive', 'error')),
  error_message text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_connectors_project ON connectors(project_id);
```

### 4.2 `connector_bindings` — routing + trigger rules

```sql
CREATE TABLE connector_bindings (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  connector_id   uuid NOT NULL REFERENCES connectors(id) ON DELETE CASCADE,
  agent_id       uuid NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  display_name   text,

  -- Source filter
  source_type    text NOT NULL CHECK (source_type IN ('private', 'group', 'channel', 'any')),
  source_ref_keys jsonb,                    -- null = match all, { chat_id: '...' } = specific

  -- Trigger: message atau event
  trigger_source text NOT NULL DEFAULT 'message'
                   CHECK (trigger_source IN ('message', 'event')),
  trigger_mode   text NOT NULL DEFAULT 'always'
                   CHECK (trigger_mode IN ('always', 'mention', 'reply', 'command', 'keyword')),
  trigger_keywords text[],                  -- untuk trigger_mode = 'keyword'

  -- Event trigger config (kalau trigger_source = 'event')
  trigger_event_type text,                  -- 'reaction', 'edit', dll
  trigger_event_filter jsonb,               -- { emoji: '👍', sender_identity_key: 'telegram_user_id', sender_identity_value: '123' }

  -- Adapter
  adapter_type   text NOT NULL DEFAULT 'conversation'
                   CHECK (adapter_type IN ('conversation', 'task', 'notify')),

  -- Approval & security
  require_approval boolean NOT NULL DEFAULT false,
  rate_limit_rpm   int,                     -- null = unlimited

  -- Context config
  context_window   int NOT NULL DEFAULT 10, -- N pesan sebelumnya di-inject

  -- Include sender info di context
  include_sender_info boolean NOT NULL DEFAULT true,

  enabled        boolean NOT NULL DEFAULT true,
  created_at     timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_bindings_connector ON connector_bindings(connector_id);
CREATE INDEX idx_bindings_agent     ON connector_bindings(agent_id);
```

### 4.3 `connector_identities` — pairing external identity → Jiku user

```sql
CREATE TABLE connector_identities (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  binding_id      uuid NOT NULL REFERENCES connector_bindings(id) ON DELETE CASCADE,

  -- External identity (flexible keys)
  external_ref_keys jsonb NOT NULL,         -- { user_id: '123', username: '@john' }
  display_name      text,
  avatar_url        text,

  -- Approval
  status            text NOT NULL DEFAULT 'pending'
                      CHECK (status IN ('pending', 'approved', 'blocked')),
  approved_by       uuid REFERENCES users(id),
  approved_at       timestamptz,

  -- Mapping ke Jiku user (opsional)
  mapped_user_id    uuid REFERENCES users(id),

  -- Conversation yang aktif untuk identity ini
  conversation_id   uuid REFERENCES conversations(id),

  last_seen_at      timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX idx_identity_binding_ref 
  ON connector_identities(binding_id, (external_ref_keys->>'user_id'));
CREATE INDEX idx_identity_conversation ON connector_identities(conversation_id);
```

### 4.4 `connector_events` — raw event log

```sql
CREATE TABLE connector_events (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  connector_id    uuid NOT NULL REFERENCES connectors(id) ON DELETE CASCADE,
  binding_id      uuid REFERENCES connector_bindings(id),
  identity_id     uuid REFERENCES connector_identities(id),

  event_type      text NOT NULL,            -- 'message', 'reaction', 'edit', dll
  ref_keys        jsonb NOT NULL,           -- flexible platform keys
  target_ref_keys jsonb,                    -- untuk event yang target message lain

  payload         jsonb NOT NULL,           -- raw normalized event
  metadata        jsonb,                    -- platform-specific extras

  -- Processing status
  status          text NOT NULL DEFAULT 'received'
                    CHECK (status IN ('received', 'routed', 'dropped', 'pending_approval', 'rate_limited', 'error')),
  drop_reason     text,
  processing_ms   int,                      -- berapa lama diproses

  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_events_connector   ON connector_events(connector_id, created_at DESC);
CREATE INDEX idx_events_ref_keys    ON connector_events USING gin(ref_keys);
CREATE INDEX idx_events_target_keys ON connector_events USING gin(target_ref_keys);
```

### 4.5 `connector_messages` — pesan inbound/outbound yang terhubung ke conversation

```sql
CREATE TABLE connector_messages (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  connector_id    uuid NOT NULL REFERENCES connectors(id) ON DELETE CASCADE,
  conversation_id uuid REFERENCES conversations(id),
  message_id      uuid REFERENCES messages(id),  -- Jiku message

  direction       text NOT NULL CHECK (direction IN ('inbound', 'outbound')),
  ref_keys        jsonb NOT NULL,           -- platform message keys
  content_snapshot text,                   -- snapshot konten saat diterima/dikirim
  status          text NOT NULL DEFAULT 'sent'
                    CHECK (status IN ('pending', 'sent', 'delivered', 'failed')),

  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_conn_messages_conversation ON connector_messages(conversation_id);
CREATE INDEX idx_conn_messages_ref_keys     ON connector_messages USING gin(ref_keys);

-- Message events (reactions, edits, dll) per connector_message
CREATE TABLE connector_message_events (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  connector_message_id uuid NOT NULL REFERENCES connector_messages(id) ON DELETE CASCADE,
  connector_event_id   uuid REFERENCES connector_events(id),

  event_type           text NOT NULL,       -- 'reaction', 'unreaction', 'edit', 'delete'
  actor_ref_keys       jsonb,               -- siapa yang melakukan event
  actor_display_name   text,
  payload              jsonb,               -- { emoji: '👍' } atau { new_content: '...' }

  created_at           timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_msg_events_message ON connector_message_events(connector_message_id);
```

### 4.6 `user_identities` — structured key-value store per user per project

```sql
CREATE TABLE user_identities (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,

  key        text NOT NULL,                 -- 'telegram_user_id', 'discord_id', dll
  value      text NOT NULL,
  label      text,                          -- human readable: 'Telegram User ID'

  source     text NOT NULL DEFAULT 'user'
               CHECK (source IN ('user', 'agent', 'system')),
  visibility text NOT NULL DEFAULT 'project'
               CHECK (visibility IN ('private', 'project')), -- private = hanya user sendiri

  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),

  UNIQUE (user_id, project_id, key)
);

CREATE INDEX idx_user_identities_project ON user_identities(project_id, key, value);
```

---

## 5. Connector Plugin Interface di `@jiku/kit`

```typescript
// packages/kit/src/connector.ts

export interface ConnectorContext {
  projectId: string
  connectorId: string
  // Emit event ke core router
  emitEvent(event: ConnectorEvent): Promise<void>
  // Store config (untuk webhook secret, dll)
  getConfig<T>(): T
}

export interface ConnectorTarget {
  ref_keys: Record<string, string>
  reply_to_ref_keys?: Record<string, string>
}

export interface ConnectorContent {
  text?: string
  markdown?: boolean
  media?: { type: 'image' | 'video' | 'document'; url?: string; data?: Buffer }
  buttons?: Array<{ text: string; data: string }>  // inline keyboard
}

export interface ConnectorSendResult {
  success: boolean
  ref_keys?: Record<string, string>  // keys dari message yang dikirim
  error?: string
}

// Base class yang di-extend connector plugin
export abstract class ConnectorAdapter {
  abstract readonly id: string
  abstract readonly displayName: string
  abstract readonly refKeys: string[]
  abstract readonly supportedEvents: ConnectorEventType[]
  abstract readonly configSchema: z.ZodObject<any>

  abstract onActivate(ctx: ConnectorContext): Promise<void>
  abstract onDeactivate(): Promise<void>
  abstract parseEvent(raw: unknown): ConnectorEvent | null
  abstract sendMessage(target: ConnectorTarget, content: ConnectorContent): Promise<ConnectorSendResult>

  // Optional capabilities
  sendReaction?(target: ConnectorTarget, emoji: string): Promise<void>
  deleteMessage?(target: ConnectorTarget): Promise<void>
  editMessage?(target: ConnectorTarget, content: ConnectorContent): Promise<void>
  getHistory?(ref_keys: Record<string, string>, limit: number): Promise<ConnectorEvent[]>
}

export function defineConnector(AdapterClass: new () => ConnectorAdapter): JikuPlugin {
  const adapter = new AdapterClass()
  return definePlugin({
    meta: {
      id: adapter.id,
      project_scope: true,
      display_name: adapter.displayName,
    },
    configSchema: adapter.configSchema,
    setup(ctx) {
      ctx.hooks.hook('connector:register', () => adapter)
    },
    onProjectPluginActivated: async (projectId, pluginCtx) => {
      const connCtx = buildConnectorContext(projectId, pluginCtx)
      await adapter.onActivate(connCtx)
    },
    onProjectPluginDeactivated: async () => {
      await adapter.onDeactivate()
    },
  })
}
```

---

## 6. Telegram Plugin — Reference Implementation

```typescript
// plugins/jiku.connector.telegram/index.ts

import { defineConnector, ConnectorAdapter } from '@jiku/kit'
import { Telegraf } from 'telegraf'
import { z } from 'zod'

class TelegramConnector extends ConnectorAdapter {
  readonly id = 'jiku.connector.telegram'
  readonly displayName = 'Telegram'
  readonly refKeys = ['message_id', 'chat_id']
  readonly supportedEvents = ['message', 'reaction', 'edit', 'delete', 'pin'] as const
  readonly configSchema = z.object({
    bot_token: z.string().min(1),
    webhook_url: z.string().url().optional(),
    allowed_chat_ids: z.array(z.string()).optional(),
  })

  private bot: Telegraf | null = null

  async onActivate(ctx: ConnectorContext) {
    const config = ctx.getConfig<{ bot_token: string; webhook_url?: string }>()
    this.bot = new Telegraf(config.bot_token)

    this.bot.on('message', async (tgCtx) => {
      const event = this.parseEvent({ type: 'message', raw: tgCtx })
      if (event) await ctx.emitEvent(event)
    })

    this.bot.on('message_reaction', async (tgCtx) => {
      const event = this.parseEvent({ type: 'reaction', raw: tgCtx })
      if (event) await ctx.emitEvent(event)
    })

    // Edit, delete, pin handlers...

    if (config.webhook_url) {
      await this.bot.telegram.setWebhook(`${config.webhook_url}/connector/telegram/${ctx.connectorId}`)
    } else {
      this.bot.launch()
    }
  }

  async onDeactivate() {
    this.bot?.stop()
    this.bot = null
  }

  parseEvent(input: { type: string; raw: any }): ConnectorEvent | null {
    if (input.type === 'message') {
      const msg = input.raw.message
      return {
        type: 'message',
        connector_id: this.id,
        ref_keys: {
          message_id: String(msg.message_id),
          chat_id: String(msg.chat.id),
        },
        sender: {
          external_id: String(msg.from.id),
          display_name: [msg.from.first_name, msg.from.last_name].filter(Boolean).join(' '),
          username: msg.from.username,
          is_bot: msg.from.is_bot,
        },
        content: { text: msg.text },
        metadata: {
          chat_type: msg.chat.type,       // 'private' | 'group' | 'supergroup' | 'channel'
          reply_to_message_id: msg.reply_to_message?.message_id,
          forward_from: msg.forward_from?.id,
        },
        timestamp: new Date(msg.date * 1000),
      }
    }

    if (input.type === 'reaction') {
      const react = input.raw.messageReaction
      return {
        type: 'reaction',
        connector_id: this.id,
        ref_keys: {
          message_id: String(react.message_id) + '_reaction',
          chat_id: String(react.chat.id),
        },
        target_ref_keys: {
          message_id: String(react.message_id),
          chat_id: String(react.chat.id),
        },
        sender: {
          external_id: String(react.user.id),
          display_name: react.user.first_name,
          username: react.user.username,
        },
        content: {
          raw: {
            new_reaction: react.new_reaction,
            old_reaction: react.old_reaction,
          }
        },
        timestamp: new Date(react.date * 1000),
      }
    }

    return null
  }

  async sendMessage(target: ConnectorTarget, content: ConnectorContent): Promise<ConnectorSendResult> {
    if (!this.bot) return { success: false, error: 'Bot not initialized' }

    const chatId = target.ref_keys.chat_id
    const replyTo = target.reply_to_ref_keys?.message_id

    try {
      const sent = await this.bot.telegram.sendMessage(
        chatId,
        content.text || '',
        {
          parse_mode: content.markdown ? 'Markdown' : undefined,
          reply_to_message_id: replyTo ? Number(replyTo) : undefined,
        }
      )
      return {
        success: true,
        ref_keys: {
          message_id: String(sent.message_id),
          chat_id: String(sent.chat.id),
        }
      }
    } catch (e: any) {
      return { success: false, error: e.message }
    }
  }

  async sendReaction(target: ConnectorTarget, emoji: string) {
    await this.bot?.telegram.setMessageReaction(
      target.ref_keys.chat_id,
      Number(target.ref_keys.message_id),
      [{ type: 'emoji', emoji }]
    )
  }
}

export default defineConnector(TelegramConnector)
```

---

## 7. Connector Event Router (App Layer)

```typescript
// apps/studio/server/connectors/event-router.ts

export async function routeConnectorEvent(
  event: ConnectorEvent,
  projectId: string
): Promise<'routed' | 'dropped' | 'pending_approval' | 'rate_limited'> {

  // 1. Find matching bindings
  const bindings = await findMatchingBindings(event, projectId)
  if (!bindings.length) return 'dropped'

  for (const binding of bindings) {

    // 2. Check trigger match
    if (!matchesTrigger(event, binding)) continue

    // 3. Find or create identity
    const identity = await findOrCreateIdentity(event.sender, binding)

    // 4. Check approval
    if (identity.status === 'blocked') continue
    if (identity.status === 'pending') {
      await notifyAdminPendingApproval(identity, binding)
      return 'pending_approval'
    }

    // 5. Rate limit check
    if (binding.rate_limit_rpm) {
      const ok = await checkRateLimit(identity.id, binding.rate_limit_rpm)
      if (!ok) return 'rate_limited'
    }

    // 6. Log event
    const eventRecord = await logConnectorEvent(event, binding, identity, 'routed')

    // 7. Build caller context
    const caller = buildConnectorCaller(identity, binding, event)

    // 8. Execute adapter
    if (binding.adapter_type === 'conversation') {
      await executeConversationAdapter(event, binding, identity, caller, eventRecord)
    } else if (binding.adapter_type === 'task') {
      await executeTaskAdapter(event, binding, caller)
    }
  }

  return 'routed'
}

async function executeConversationAdapter(
  event: ConnectorEvent,
  binding: ConnectorBinding,
  identity: ConnectorIdentity,
  caller: CallerContext,
  eventRecord: ConnectorEventRecord,
) {
  // Get or create conversation untuk identity ini
  let conversationId = identity.conversation_id
  if (!conversationId) {
    conversationId = await createConversation(binding.agent_id, caller)
    await updateIdentityConversation(identity.id, conversationId)
  }

  // Build context injection (thread awareness)
  const contextInjection = await buildConnectorContext(event, binding, identity)

  // Log inbound message
  const connMessage = await logConnectorMessage({
    connector_id: event.connector_id,
    conversation_id: conversationId,
    direction: 'inbound',
    ref_keys: event.ref_keys,
    content_snapshot: event.content?.text,
  })

  // runtime.run()
  const runtime = RuntimeManager.getRuntime(binding.agent_id)
  const stream = await runtime.run({
    conversation_id: conversationId,
    caller,
    mode: 'chat',
    input: buildInput(event, contextInjection),
  })

  // Collect response
  const response = await collectStream(stream)

  // Send response via connector
  const connector = ConnectorRegistry.get(event.connector_id)
  const sendResult = await connector.sendMessage(
    { ref_keys: event.ref_keys, reply_to_ref_keys: event.ref_keys },
    { text: response.text, markdown: true }
  )

  // Log outbound message
  await logConnectorMessage({
    connector_id: event.connector_id,
    conversation_id: conversationId,
    direction: 'outbound',
    ref_keys: sendResult.ref_keys || {},
    content_snapshot: response.text,
    status: sendResult.success ? 'sent' : 'failed',
  })
}

function buildConnectorContext(
  event: ConnectorEvent,
  binding: ConnectorBinding,
  identity: ConnectorIdentity,
): string {
  const parts: string[] = []

  parts.push(`[Connector Context]`)
  parts.push(`Platform: ${event.connector_id.replace('jiku.connector.', '')}`)
  parts.push(`Source type: ${event.metadata?.chat_type || 'unknown'}`)

  if (binding.include_sender_info) {
    parts.push(`Sender: ${identity.display_name} (id: ${JSON.stringify(identity.external_ref_keys)})`)
  }

  // Kalau ada trigger event (reaction dll)
  if (event.type === 'reaction') {
    parts.push(`Event: User reacted to a message`)
    parts.push(`Reaction: ${JSON.stringify(event.content?.raw)}`)
  }

  return parts.join('\n')
}
```

---

## 8. Connector Tools untuk Agent

Tools ini selalu aktif kalau project punya active connector. Di-register di `RuntimeManager.wakeUp()`.

```typescript
// Built-in connector tools

connector_get_events: tool({
  description: "Query events (reactions, edits, etc.) on a specific message or in a chat",
  parameters: z.object({
    ref_keys: z.record(z.string()).describe("Platform message keys, e.g. { message_id, chat_id }"),
    event_types: z.array(z.string()).optional(),
    limit: z.number().default(20),
  }),
  execute: async ({ ref_keys, event_types, limit }) => {
    return queryConnectorMessageEvents({ ref_keys, event_types, limit })
  }
})

connector_get_thread: tool({
  description: "Get recent messages from a chat/thread for context",
  parameters: z.object({
    ref_keys: z.record(z.string()).describe("Chat keys, e.g. { chat_id }"),
    limit: z.number().default(10),
    before_ref_keys: z.record(z.string()).optional(),
  }),
  execute: async ({ ref_keys, limit, before_ref_keys }) => {
    return queryConnectorMessages({ ref_keys, limit, before_ref_keys })
  }
})

connector_send: tool({
  description: "Send a message to a platform chat via connector",
  parameters: z.object({
    connector_id: z.string(),
    target_ref_keys: z.record(z.string()),
    text: z.string(),
    reply_to_ref_keys: z.record(z.string()).optional(),
    markdown: z.boolean().default(true),
  }),
  execute: async (input) => {
    const connector = ConnectorRegistry.get(input.connector_id)
    return connector.sendMessage(
      { ref_keys: input.target_ref_keys, reply_to_ref_keys: input.reply_to_ref_keys },
      { text: input.text, markdown: input.markdown }
    )
  }
})

connector_react: tool({
  description: "React to a message with an emoji",
  parameters: z.object({
    connector_id: z.string(),
    target_ref_keys: z.record(z.string()),
    emoji: z.string(),
  }),
  execute: async ({ connector_id, target_ref_keys, emoji }) => {
    const connector = ConnectorRegistry.get(connector_id)
    await connector.sendReaction?.({ ref_keys: target_ref_keys }, emoji)
    return { success: true }
  }
})

// Binding management — agent bisa edit binding
connector_binding_update: tool({
  description: "Update a connector binding configuration",
  parameters: z.object({
    binding_id: z.string(),
    updates: z.object({
      trigger_mode: z.enum(['always', 'mention', 'reply', 'command', 'keyword']).optional(),
      trigger_keywords: z.array(z.string()).optional(),
      trigger_event_type: z.string().optional(),
      trigger_event_filter: z.record(z.unknown()).optional(),
      rate_limit_rpm: z.number().optional(),
      context_window: z.number().optional(),
    })
  }),
  execute: async ({ binding_id, updates }) => {
    return updateConnectorBinding(binding_id, updates)
  }
})

// User Identity tools
identity_get: tool({
  description: "Get identity attributes for a user",
  parameters: z.object({
    user_id: z.string().optional(),    // null = current caller
    keys: z.array(z.string()).optional(),
  }),
  execute: async ({ user_id, keys }, { caller }) => {
    const targetUserId = user_id || caller.user_id
    return getUserIdentities(targetUserId, projectId, keys)
  }
})

identity_set: tool({
  description: "Set an identity attribute for a user",
  parameters: z.object({
    user_id: z.string().optional(),
    key: z.string(),
    value: z.string(),
  }),
  execute: async ({ user_id, key, value }, { caller }) => {
    const targetUserId = user_id || caller.user_id
    return setUserIdentity(targetUserId, projectId, key, value, 'agent')
  }
})

identity_find: tool({
  description: "Find users by identity attribute — e.g. find who has telegram_user_id = 123",
  parameters: z.object({
    key: z.string(),
    value: z.string(),
  }),
  execute: async ({ key, value }) => {
    return findUserByIdentity(projectId, key, value)
  }
})
```

---

## 9. Routes

```
// Connector management
GET    /api/connectors                          → list project connectors
POST   /api/connectors                          → create connector (enable plugin)
GET    /api/connectors/:id                      → connector detail
PATCH  /api/connectors/:id                      → update config
DELETE /api/connectors/:id                      → deactivate + delete
POST   /api/connectors/:id/test                 → test connection

// Bindings
GET    /api/connectors/:id/bindings             → list bindings
POST   /api/connectors/:id/bindings             → create binding
PATCH  /api/connectors/:id/bindings/:bid        → update binding
DELETE /api/connectors/:id/bindings/:bid        → delete binding

// Identities
GET    /api/connectors/:id/bindings/:bid/identities         → list identities
PATCH  /api/connectors/:id/bindings/:bid/identities/:iid    → approve/block/map user

// Events (read only)
GET    /api/connectors/:id/events               → event log (filter: type, status, date)
GET    /api/connectors/:id/messages             → message log (inbound + outbound)
GET    /api/connectors/:id/messages/:mid/events → events per message

// Webhook inbound (public)
POST   /webhook/:project_id/connector/:connector_id → receive platform webhook

// User Identity
GET    /api/projects/:pid/users/:uid/identities → list user identities
PUT    /api/projects/:pid/users/:uid/identities → upsert identity
DELETE /api/projects/:pid/users/:uid/identities/:key → delete key

// SSE — live event stream
GET    /api/connectors/:id/events/stream        → SSE live events
```

---

## 10. UI

### Route Structure

```
/studio/companies/[company]/projects/[project]/
  channels/
    page.tsx                    → Channels overview (list connectors)
    new/page.tsx                → Add connector (select plugin)
    [connector]/
      page.tsx                  → Connector detail + status
      bindings/
        page.tsx                → List bindings
        [binding]/page.tsx      → Binding detail + identity list
      events/page.tsx           → Event log (live + historical)
      messages/page.tsx         → Inbound/outbound message log
  settings/
    users/page.tsx              → User list + identity per user
```

### Channels Overview Page

```
┌─ Channels ────────────────────────────────────────┐
│  [+ Add Connector]                                 │
│                                                    │
│  ┌─ Telegram Bot ──────────────── ● Active ──────┐ │
│  │  jiku.connector.telegram                       │ │
│  │  3 bindings · 1,240 events today              │ │
│  │  [Manage] [Events] [Messages]                  │ │
│  └────────────────────────────────────────────────┘ │
│                                                    │
│  ┌─ Discord ───────────────────── ○ Inactive ────┐ │
│  │  jiku.connector.discord                        │ │
│  │  [Configure]                                   │ │
│  └────────────────────────────────────────────────┘ │
└────────────────────────────────────────────────────┘
```

### Binding Detail Page

```
┌─ Binding: Dev Group → Aria ──────────────────────┐
│                                                    │
│  Connector: Telegram Bot                           │
│  Agent: Aria                                       │
│  Adapter: conversation                             │
│                                                    │
│  Source                                            │
│  Type: group                                       │
│  Chat ID: -100123456789  [Edit]                   │
│                                                    │
│  Trigger                                           │
│  Source: event                ← message / event   │
│  Event type: reaction                              │
│  Filter: emoji = 👍, sender = admin               │
│                                                    │
│  Settings                                          │
│  Require approval: ON                              │
│  Rate limit: 30 req/min                            │
│  Context window: 10 messages                       │
│                                                    │
│  Identities (12)                                   │
│  ┌──────────────────────────────────────────────┐ │
│  │ @johndoe   · approved · mapped: John (admin) │ │
│  │ @jane_     · pending  · [Approve] [Block]    │ │
│  │ @unknown   · blocked                         │ │
│  └──────────────────────────────────────────────┘ │
└────────────────────────────────────────────────────┘
```

### Events Page (Live Log)

```
┌─ Events ─────────────────── [● Live] [Filter ▼] ─┐
│                                                    │
│  14:32:01  message     @johndoe  → routed          │
│            "Hei Aria bisa bantu deploy?"           │
│                                                    │
│  14:32:05  reaction    @johndoe  → routed          │
│            👍 on message #1234                     │
│                                                    │
│  14:31:58  message     @spam_bot → rate_limited    │
│                                                    │
│  14:31:45  message     @new_user → pending_approval│
│                                         [Review]   │
└────────────────────────────────────────────────────┘
```

### User Identity Panel (di Project Settings → Users)

```
┌─ John Doe ───────────────────────────────────────┐
│  john@example.com · Admin                         │
│                                                    │
│  Identities                                        │
│  ┌──────────────────────────────────────────────┐ │
│  │ telegram_user_id   123456789   system  [del] │ │
│  │ telegram_username  @johndoe    system  [del] │ │
│  │ discord_id         987654321   user    [del] │ │
│  │ timezone           Asia/Jakarta user   [del] │ │
│  │ [+ Add identity]                             │ │
│  └──────────────────────────────────────────────┘ │
└────────────────────────────────────────────────────┘
```

---

## 11. Implementation Checklist

### Carry-over dari Plan 8 (Memory System)

> Items yang belum selesai di Plan 8, dikerjakan sekalian di Plan 10.

- [ ] `MemoryPreviewSheet` component (`components/chat/memory-preview-sheet.tsx`)
  - Button di conversation header: tampilkan count memory yang di-inject session ini
  - Sheet berisi breakdown memory per scope + token count
  - Route baru: `GET /api/conversations/:cid/memory-preview`
- [ ] Integration test checklist Plan 8:
  - [ ] `memory_core_append` → memory injected in next conversation
  - [ ] Access count increments setelah memory dipakai
  - [ ] Extended memory scored dan filtered by relevance
  - [ ] Post-run extraction creates memories in correct scope
  - [ ] Memory browser lists, filters, delete correctly
  - [ ] Project config PATCH deep-merges correctly
  - [ ] Agent config inherits from project when null
  - [ ] Memory tools absent when policy disabled
  - [ ] Multiple agents' memories isolated correctly

### Carry-over dari Plan 9 (Persona System)

> Items yang belum selesai di Plan 9, dikerjakan sekalian di Plan 10.

- [ ] DB migration Plan 9: `bun db:push` di `apps/studio/db`
  - Kolom `persona_seed jsonb` ke tabel `agents`
  - Kolom `persona_seeded_at timestamptz` ke tabel `agents`
- [ ] `extractPersonaPostRun()` — async, non-blocking
  - Analisis conversation setelah stream selesai
  - Detect persona signals (feedback style, correction, preference)
  - Auto-extract kalau confidence tinggi, suggest-only kalau implicit
  - Extend `extractMemoriesPostRun()` yang sudah ada di Plan 8

### @jiku/types

- [ ] `ConnectorEvent` interface + `ConnectorEventType` union
- [ ] `ConnectorAdapter` abstract class
- [ ] `ConnectorBinding`, `ConnectorIdentity` types
- [ ] `UserIdentity` type
- [ ] Extend `CallerContext` dengan `connector_context?` field

### @jiku/kit

- [ ] `defineConnector()` helper
- [ ] `ConnectorAdapter` base class export
- [ ] Re-export semua connector types

### @jiku/core

- [ ] `ConnectorRegistry` — register/get connector adapters
- [ ] Extend `runtime.run()` untuk terima `connector_context`
- [ ] Built-in connector tools (`connector_get_events`, `connector_get_thread`, `connector_send`, `connector_react`, `connector_binding_update`, `identity_get`, `identity_set`, `identity_find`)

### @jiku-studio/db

- [ ] Migration: `connectors` table
- [ ] Migration: `connector_bindings` table
- [ ] Migration: `connector_identities` table
- [ ] Migration: `connector_events` table
- [ ] Migration: `connector_messages` table
- [ ] Migration: `connector_message_events` table
- [ ] Migration: `user_identities` table
- [ ] GIN indexes untuk semua jsonb `ref_keys` columns
- [ ] Drizzle schema + queries untuk semua tabel

### apps/studio/server

- [ ] `ConnectorRegistry` singleton
- [ ] `ConnectorEventRouter` — routing + filtering logic
- [ ] `matchesTrigger()` — evaluate binding trigger rules
- [ ] `findOrCreateIdentity()` — pairing logic
- [ ] `checkRateLimit()` — per identity rate limiting
- [ ] `buildConnectorCaller()` — CallerContext dari identity
- [ ] `executeConversationAdapter()` — conversation flow
- [ ] `executeTaskAdapter()` — task flow
- [ ] `buildConnectorContext()` — context injection string
- [ ] Webhook route: `POST /webhook/:project_id/connector/:connector_id`
- [ ] SSE route: `GET /api/connectors/:id/events/stream`
- [ ] All CRUD routes (connectors, bindings, identities, messages, events)
- [ ] Register connector tools di `RuntimeManager.wakeUp()`
- [ ] Auto-populate `user_identities` dari connector event pertama

### plugins/jiku.connector.telegram

- [ ] `TelegramConnector` class (extends `ConnectorAdapter`)
- [ ] Parse: message, reaction, edit, delete, pin events
- [ ] Send: message, reaction, edit, delete
- [ ] Webhook setup + polling fallback
- [ ] Config schema: `bot_token`, `webhook_url?`, `allowed_chat_ids?`

### apps/studio/web

- [ ] Route: `/channels` — channels overview
- [ ] Route: `/channels/new` — add connector (plugin selector)
- [ ] Route: `/channels/[connector]` — connector detail
- [ ] Route: `/channels/[connector]/bindings` — binding list
- [ ] Route: `/channels/[connector]/bindings/[binding]` — binding detail + identities
- [ ] Route: `/channels/[connector]/events` — live event log (SSE)
- [ ] Route: `/channels/[connector]/messages` — message log
- [ ] `ConnectorCard` component
- [ ] `BindingForm` component (trigger config, event filter)
- [ ] `IdentityList` component dengan approve/block actions
- [ ] `EventStream` component (SSE, live)
- [ ] `MessageLog` component (inbound/outbound)
- [ ] User Identity panel di project settings → users
- [ ] Project sidebar: tambah "Channels" item

---

## 12. Carry-over dari Plan 8 & Plan 9

Item-item berikut belum selesai di plan sebelumnya dan **harus diselesaikan di Plan 10** sebelum memulai implementasi connector system.

### Dari Plan 9 — Persona System

**DB Migration (WAJIB sebelum apapun)**
- [ ] Jalankan `cd apps/studio/db && bun run db:push` untuk apply kolom `persona_seed` dan `persona_seeded_at` ke tabel `agents`
- [ ] Verifikasi migration berhasil: cek kolom ada di DB

**`extractPersonaPostRun()`**
- [ ] Implementasi di `apps/studio/server/src/memory/persona.ts`
- [ ] Setelah stream selesai (async, non-blocking), analisis 6 messages terakhir untuk persona signals
- [ ] Signals yang dicek: feedback tentang communication style, koreksi self-description, request adjust personality
- [ ] Auto-extract kalau ada explicit feedback user ("bisa lebih singkat?", "kamu terlalu formal")
- [ ] Suggest-only (tidak auto-extract) kalau implicit
- [ ] Hook ke `extractMemoriesPostRun()` yang sudah ada di `packages/core/src/memory/extraction.ts`
- [ ] Fire-and-forget pattern: `.catch(() => {})`

### Dari Plan 8 — Memory System

**Memory Preview Sheet (chat UI)**
- [ ] Buat `apps/studio/web/components/chat/memory-preview-sheet.tsx`
- [ ] Button "Memory" di chat header (sejajar dengan button "Context" yang sudah ada)
- [ ] Sheet menampilkan: memory yang di-inject di session ini, breakdown per scope, token count per scope
- [ ] Tambah route server: `GET /api/conversations/:cid/memory-preview`
  - Response: `{ agent_caller: Memory[], agent_global: Memory[], runtime_global: Memory[], agent_self: Memory[], total_tokens: number }`
- [ ] Tambah `api.memory.getConversationPreview(conversationId)` di `apps/studio/web/lib/api.ts`
- [ ] Integrate ke `context-bar.tsx` — tombol Memory dengan count badge
- [ ] Persona section juga tampil di sheet ini (agent_self memories yang di-inject)

---

## 13. Hal yang Defer ke Plan Berikutnya

- **Heartbeat mode** — outbound-only trigger (notify adapter type sudah ada di schema, implementasi defer)
- **Mode system extensible** — `mode: string` registry
- **Discord plugin** — schema sudah cover, implementasi setelah Telegram stable
- **WhatsApp plugin** — sama
- **`getHistory()` dari connector** — Telegram tidak support, Discord partial; defer
- **Multi-agent via channel** — satu binding ke multiple agents

---

*Plan 10 — Channels & Connector System*  
*Depends on: Plan 7 (Plugin System V3), Plan 8 (Memory), Plan 9 (Persona)*  
*Includes carry-over: Plan 8 Memory Preview Sheet, Plan 9 extractPersonaPostRun + DB migration*  
*Generated: 2026-04-05*