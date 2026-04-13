# Plan 22 — Channel System v2: Scope, Targets, Media & Group Management

## Goals

Enable dua real case utama secara penuh:

1. **User chat via Telegram** — user bisa chat dengan AI langsung dari Telegram (atau platform lain), tanpa harus buka web UI Jiku. AI menerima dan membalas, termasuk media (gambar, file), dengan session yang terisolasi per group/topic.

2. **AI manages channels** — AI bisa mengirim pesan ke channel/group/topic secara proaktif (dari cron task, task adapter, atau inisiasi agent), tanpa harus ada pesan masuk dari user. Bisa kirim teks, gambar, file, manage chat (pin, react, invite).

### Non-Goals

- Live draft streaming (edit pesan secara incremental) — nice-to-have, bukan blocker
- Approval system dengan inline buttons — deferred ke plan berikutnya
- Support platform lain selain Telegram di plan ini (arsitektur harus generik, tapi implementasi hanya untuk Telegram)

---

## Architecture Decisions

### ADR-056 — Scope Key sebagai Unit Isolasi Percakapan

**Context:** Saat ini `connector_identities.conversation_id` adalah satu-satunya mapping identity → conversation. Ini hanya bekerja untuk DM (1-to-1). Di group chat, semua user berbagi satu "ruang" tetapi masing-masing masih punya identity berbeda.

**Decision:** Tambah konsep `scope_key` — string yang merepresentasikan "ruang percakapan" dari sisi platform:

```
DM:                   null               → gunakan identity.conversation_id (backward compat)
Telegram group:       "group:-1001234"   → shared group conversation
Telegram forum topic: "group:-1001234:topic:42" → per-topic conversation
Telegram DM thread:   "dm:123:thread:5"  → DM dengan thread isolation
```

Untuk menyimpan mapping `scope_key → conversation_id`, tambah tabel `connector_scope_conversations`. `connector_identities.conversation_id` tetap untuk DM (scope_key = null), tidak diubah.

**Consequences:** Backward compat terjaga. Group participants berbagi satu conversation history, bukan masing-masing punya sendiri. AI bisa "ingat" konteks group. Scope isolation tetap bisa di-override per-binding.

---

### ADR-057 — Channel Targets sebagai Named Outbound Destinations

**Context:** `connector_send` tool dan `connector_run_action` sudah ada, tapi AI harus tahu `connector_id` + `ref_keys` (`chat_id`) untuk kirim pesan. Dari cron task atau task agent yang tidak triggered dari conversation, tidak ada cara natural untuk tahu tujuan ini.

**Decision:** Tambah tabel `connector_targets` — named destinations per connector. AI berinteraksi via nama (`"morning-briefing"`) bukan via raw `chat_id`. Dua tools baru: `connector_list_targets` dan `connector_send_to_target`.

**Consequences:** Cron task prompt bisa natural: "kirim summary harian ke target `briefing`". Targets bisa di-manage via web UI. Connector_send lama tetap ada untuk advanced use cases.

---

### ADR-058 — Media Pipeline: Event Carries URL, Router Downloads

**Context:** `ConnectorEvent.content.media` dan `ConnectorContent.media` sudah ada di type system tapi tidak dipakai. Adapter tidak populate, event-router tidak handle.

**Decision:** TelegramAdapter populate `content.media.url` (file URL dari Telegram CDN) saat message berisi photo/document/voice. Event-router mendeteksi media di event, download ke filesystem project, inject ke conversation sebagai attachment text context (karena AI SDK menerima image sebagai message content). TelegramAdapter `sendMessage()` handle `content.media` dengan `sendPhoto`/`sendDocument`.

**Consequences:** Media tetap lewat event contract yang sudah ada, tidak perlu API baru. Download terjadi di server side, aman. Filesystem harus configured (tidak block jika tidak).

---

### ADR-059 — Scope Filter di Bindings (Tidak Ganti source_ref_keys)

**Context:** `source_ref_keys` sudah bisa filter by exact `chat_id`. Tapi untuk pola "hanya di group manapun kecuali DM" atau "hanya di topic ini" perlu mekanisme lebih ekspresif.

**Decision:** Tambah field `scope_key_pattern` ke `connector_bindings`. Nilainya bisa:
- `null` — match all scopes (behavior sekarang)
- Exact: `"group:-1001234:topic:42"` — hanya topic tertentu
- Wildcard prefix: `"group:*"` — semua group, tidak termasuk DM
- `"dm:*"` — hanya DM

Pattern matching sederhana: prefix wildcard saja (tidak full regex, cukup untuk use case nyata).

**Consequences:** `source_ref_keys` tetap untuk filter by specific chat_id. `scope_key_pattern` untuk filter by conversation type/scope. Keduanya bisa dikombinasikan (AND).

---

## Database Changes

### Tabel Baru: `connector_scope_conversations`

```sql
CREATE TABLE connector_scope_conversations (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  connector_id   UUID NOT NULL REFERENCES connectors(id) ON DELETE CASCADE,
  scope_key      TEXT NOT NULL,
  agent_id       UUID REFERENCES agents(id) ON DELETE SET NULL,
  conversation_id UUID REFERENCES conversations(id) ON DELETE SET NULL,
  last_activity_at TIMESTAMP NOT NULL DEFAULT NOW(),
  created_at     TIMESTAMP NOT NULL DEFAULT NOW(),
  UNIQUE(connector_id, scope_key, agent_id)
);

CREATE INDEX idx_scope_conv_connector ON connector_scope_conversations(connector_id, scope_key);
```

Satu row per (connector, scope_key, agent_id) — karena binding yang berbeda bisa route ke agent berbeda dalam scope yang sama.

### Tabel Baru: `connector_targets`

```sql
CREATE TABLE connector_targets (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  connector_id   UUID NOT NULL REFERENCES connectors(id) ON DELETE CASCADE,
  name           TEXT NOT NULL,          -- slug: "morning-briefing", "alerts"
  display_name   TEXT,
  description    TEXT,
  ref_keys       JSONB NOT NULL,         -- { "chat_id": "-1001234567890" }
  scope_key      TEXT,                   -- optional: untuk scope-aware send
  metadata       JSONB NOT NULL DEFAULT '{}',
  created_at     TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMP NOT NULL DEFAULT NOW(),
  UNIQUE(connector_id, name)
);

CREATE INDEX idx_targets_connector ON connector_targets(connector_id);
```

### Alter: `connector_bindings`

```sql
ALTER TABLE connector_bindings
  ADD COLUMN scope_key_pattern TEXT;   -- null = all, "group:*" = groups only, exact = specific scope
```

---

## Type System Changes (`@jiku/types`)

### `ConnectorEvent` — tambah `scope_key`

```typescript
export interface ConnectorEvent {
  type: ConnectorEventType
  connector_id: string
  ref_keys: Record<string, string>
  /** Computed conversation scope. null = DM/default. Non-null = group/topic/thread. */
  scope_key?: string
  sender: { ... }
  target_ref_keys?: Record<string, string>
  content?: {
    text?: string
    media?: {
      type: 'photo' | 'document' | 'voice' | 'video' | 'sticker'
      url?: string          // download URL (e.g. Telegram CDN)
      file_name?: string
      mime_type?: string
      file_size?: number
      data?: Uint8Array
    }
    raw?: unknown
  }
  metadata?: Record<string, unknown>
  timestamp: Date
}
```

### `ConnectorContent` — tambah `media.name`, `media_group`, `target_scope_key`

```typescript
/** Single media item — dipakai di content.media maupun di dalam content.media_group[] */
export interface ConnectorMediaItem {
  type: 'image' | 'video' | 'document' | 'voice'
  /** Public URL atau Telegram file URL — adapter download sendiri */
  url?: string
  /** Raw bytes — untuk file yang sudah di-download atau di-generate */
  data?: Uint8Array
  /** Filename (wajib untuk document, opsional untuk image/video) */
  name?: string
  /**
   * Caption yang tampil di bawah media.
   * Untuk media_group, hanya item pertama yang ditampilkan Telegram secara menonjol.
   * Telegram limit: 1024 karakter (vs 4096 untuk pesan teks biasa).
   */
  caption?: string
  /**
   * Jika true, caption akan di-parse sebagai Markdown (MarkdownV2 untuk Telegram).
   * Gunakan ini untuk marketing content dengan bold, italic, links, hashtags.
   */
  caption_markdown?: boolean
}

export interface ConnectorContent {
  text?: string
  markdown?: boolean
  /** Single media — satu foto, dokumen, atau voice note */
  media?: ConnectorMediaItem
  /**
   * Media group (album) — kirim beberapa foto/video sekaligus sebagai satu album.
   * Telegram: max 10 item, mixed photo+video diperbolehkan, document tidak bisa dicampur dengan photo/video.
   * Jika adapter tidak support media_group, fallback ke kirim satu per satu secara sequential.
   */
  media_group?: ConnectorMediaItem[]
  buttons?: Array<{ text: string; data: string }>
  /** Override target scope (e.g. kirim ke topic tertentu dalam group) */
  target_scope_key?: string
}
```

### Interface Baru: `ConnectorTarget` — tambah `scope_key`

```typescript
export interface ConnectorTarget {
  ref_keys: Record<string, string>
  reply_to_ref_keys?: Record<string, string>
  scope_key?: string        // ← untuk routing ke thread/topic tertentu
}
```

### Type Baru: `ConnectorTargetRecord`

```typescript
export interface ConnectorTargetRecord {
  id: string
  connector_id: string
  name: string
  display_name?: string
  description?: string
  ref_keys: Record<string, string>
  scope_key?: string
  metadata: Record<string, unknown>
}
```

---

## `ConnectorAdapter` Base Class Changes (`@jiku/kit`)

```typescript
export abstract class ConnectorAdapter {
  // ... semua yang ada sekarang ...

  /**
   * Compute scope_key dari event yang diterima.
   * Default implementation returns undefined (DM/single-chat adapters tidak perlu override).
   * Multi-chat adapters (Telegram, Discord) HARUS override ini.
   */
  computeScopeKey?(event: { ref_keys: Record<string, string>; metadata?: Record<string, unknown> }): string | undefined

  /**
   * Build ConnectorTarget dari scope_key.
   * Dipakai event-router untuk reply ke scope yang benar.
   */
  targetFromScopeKey?(scopeKey: string): ConnectorTarget | null
}
```

---

## `event-router.ts` Changes

### 1. Scope Key Injection

```typescript
// Setelah build event di adapter, sebelum routing:
const adapter = connectorRegistry.getAdapterForConnector(connectorUuid)
if (adapter?.computeScopeKey && !event.scope_key) {
  event.scope_key = adapter.computeScopeKey(event)
}
```

### 2. Scope-Aware Conversation Resolution

Ganti conversation resolution di `executeConversationAdapter()`:

```typescript
async function resolveConversationId(
  event: ConnectorEvent,
  binding: ConnectorBinding,
  identity: ConnectorIdentity,
  agentId: string,
  connectorId: string,
  projectId: string,
): Promise<string> {
  const scopeKey = event.scope_key ?? null

  if (scopeKey === null) {
    // DM path — existing behavior, gunakan identity.conversation_id
    if (identity.conversation_id) return identity.conversation_id
    const conv = await createConversation({ project_id: projectId, agent_id: agentId, title: `...` })
    await updateIdentity(identity.id, { conversation_id: conv.id })
    return conv.id
  }

  // Group/topic/thread path — scope-scoped conversation
  const existing = await getScopeConversation(connectorId, scopeKey, agentId)
  if (existing) {
    await touchScopeConversation(existing.id)
    return existing.conversation_id
  }

  const conv = await createConversation({
    project_id: projectId,
    agent_id: agentId,
    title: buildScopeTitle(event, scopeKey),
  })
  await createScopeConversation({ connector_id: connectorId, scope_key: scopeKey, agent_id: agentId, conversation_id: conv.id })
  return conv.id
}
```

### 3. Scope Filter in `matchesTrigger()`

```typescript
// Tambah setelah semua checks yang ada:
if (binding.scope_key_pattern && event.scope_key !== undefined) {
  if (!matchesScopePattern(event.scope_key, binding.scope_key_pattern)) return false
}
if (binding.scope_key_pattern === 'dm:*' && event.scope_key !== undefined) return false  // DM only
if (binding.scope_key_pattern === 'group:*' && !event.scope_key?.startsWith('group:')) return false

function matchesScopePattern(scopeKey: string | undefined, pattern: string): boolean {
  if (pattern.endsWith(':*')) {
    const prefix = pattern.slice(0, -1)  // remove '*'
    return (scopeKey ?? '').startsWith(prefix)
  }
  return (scopeKey ?? '') === pattern
}
```

### 4. Media Download & Attachment Injection

```typescript
// Di executeConversationAdapter(), sebelum build input untuk AI:
let mediaContext = ''
if (event.content?.media?.url) {
  try {
    const fs = await getFilesystemService(projectId)
    if (fs) {
      const buffer = await downloadUrl(event.content.media.url)
      const fileName = event.content.media.file_name ?? `media_${Date.now()}`
      const storagePath = `/connector_media/${connectorId}/${fileName}`
      await fs.getAdapter().upload(storagePath, buffer)
      mediaContext = `\n[Media attached: ${event.content.media.type} — ${fileName} — saved to ${storagePath}]`
      // Future: inject sebagai image part ke AI jika type === 'photo' dan model support vision
    }
  } catch (err) {
    console.warn('[connector] media download failed:', err)
  }
}

const input = contextString
  ? `${contextString}${mediaContext}\n\n${inputText}`
  : `${mediaContext}\n\n${inputText}`
```

### 5. Scope Context di `buildConnectorContextString()`

```typescript
// Tambah scope info ke context string
if (event.scope_key) {
  parts.push(`Chat scope: ${event.scope_key}`)
}
```

---

## TelegramAdapter Changes (`plugins/jiku.telegram`)

### 1. Populate `scope_key`

```typescript
// Di class TelegramAdapter:
override computeScopeKey(event: { ref_keys: Record<string, string>; metadata?: Record<string, unknown> }): string | undefined {
  const chatId = event.ref_keys['chat_id']
  const chatType = event.metadata?.['chat_type'] as string | undefined
  const threadId = event.ref_keys['thread_id']

  if (!chatId) return undefined

  // DM chat — no scope_key (uses identity conversation)
  if (chatType === 'private') return undefined

  // Group/supergroup
  const base = `group:${chatId}`
  if (threadId) return `${base}:topic:${threadId}`
  return base
}

override targetFromScopeKey(scopeKey: string): ConnectorTarget | null {
  // "group:-1001234" → { ref_keys: { chat_id: "-1001234" } }
  // "group:-1001234:topic:42" → { ref_keys: { chat_id: "-1001234", thread_id: "42" } }
  const parts = scopeKey.split(':')
  if (parts[0] !== 'group') return null
  const chatId = parts[1]
  if (!chatId) return null

  const ref_keys: Record<string, string> = { chat_id: chatId }
  const topicIdx = parts.indexOf('topic')
  if (topicIdx !== -1 && parts[topicIdx + 1]) {
    ref_keys['thread_id'] = parts[topicIdx + 1]!
  }
  return { ref_keys }
}
```

### 2. Populate `ref_keys.thread_id` dan `metadata.chat_type`

```typescript
// Di bot.on('message') handler:
const event: ConnectorEvent = {
  type: 'message',
  connector_id: this.id,
  ref_keys: {
    message_id: String(msg.message_id),
    chat_id: String(msg.chat.id),
    // ← tambah:
    ...(msg.message_thread_id ? { thread_id: String(msg.message_thread_id) } : {}),
  },
  sender: { ... },
  content: {
    text: msg.text ?? msg.caption,
    // ← tambah media:
    ...(await this.extractMedia(msg)),
  },
  metadata: {
    language_code: msg.from?.language_code ?? null,
    client_timestamp: new Date(msg.date * 1000).toISOString(),
    // ← tambah:
    chat_type: msg.chat.type,  // 'private' | 'group' | 'supergroup' | 'channel'
    chat_title: 'title' in msg.chat ? msg.chat.title : undefined,
  },
  timestamp: new Date(msg.date * 1000),
}
```

### 3. Media Extraction Helper

```typescript
private async extractMedia(msg: any): Promise<{ media?: ConnectorEvent['content']['media'] }> {
  if (!this.bot) return {}

  try {
    if (msg.photo?.length) {
      const largest = msg.photo[msg.photo.length - 1]
      const file = await this.bot.api.getFile(largest.file_id)
      return { media: {
        type: 'photo',
        url: `https://api.telegram.org/file/bot${this.token}/${file.file_path}`,
        file_size: largest.file_size,
      }}
    }
    if (msg.document) {
      const file = await this.bot.api.getFile(msg.document.file_id)
      return { media: {
        type: 'document',
        url: `https://api.telegram.org/file/bot${this.token}/${file.file_path}`,
        file_name: msg.document.file_name,
        mime_type: msg.document.mime_type,
        file_size: msg.document.file_size,
      }}
    }
    if (msg.voice) {
      const file = await this.bot.api.getFile(msg.voice.file_id)
      return { media: {
        type: 'voice',
        url: `https://api.telegram.org/file/bot${this.token}/${file.file_path}`,
        mime_type: msg.voice.mime_type,
        file_size: msg.voice.file_size,
      }}
    }
  } catch (err) {
    console.warn('[telegram] media extraction failed:', err)
  }
  return {}
}
```

### 4. `sendMessage()` — Single Media + Media Group Support

```typescript
async sendMessage(target: ConnectorTarget, content: ConnectorContent): Promise<ConnectorSendResult> {
  if (!this.bot) return { success: false, error: 'Bot not initialized' }
  const chatId = target.ref_keys['chat_id']
  const threadId = target.ref_keys['thread_id'] ?? target.scope_key?.split(':topic:')[1]
  const replyToId = target.reply_to_ref_keys?.['message_id']
  if (!chatId) return { success: false, error: 'Missing chat_id' }

  const commonOpts = {
    ...(threadId ? { message_thread_id: Number(threadId) } : {}),
    ...(replyToId ? { reply_parameters: { message_id: Number(replyToId) } } : {}),
  }

  // ── Media group (album) ──────────────────────────────────────────────
  if (content.media_group?.length) {
    const results = await this.sendMediaGroup(chatId, content.media_group, commonOpts)
    return results
  }

  // ── Single media ─────────────────────────────────────────────────────
  if (content.media) {
    return this.sendSingleMedia(chatId, content.media, content.text, commonOpts)
  }

  // ── Text send ────────────────────────────────────────────────────────
  const rawText = content.text ?? ''
  const text = content.markdown ? telegramifyMarkdown(rawText, 'escape') : rawText
  const chunks = splitMessage(text)
  let lastSent: { message_id: number; chat: { id: number } } | null = null

  for (let i = 0; i < chunks.length; i++) {
    lastSent = await this.bot.api.sendMessage(chatId, chunks[i] || '-', {
      parse_mode: content.markdown ? 'MarkdownV2' : undefined,
      ...commonOpts,
      ...(i === 0 && replyToId ? { reply_parameters: { message_id: Number(replyToId) } } : {}),
    })
  }

  return { success: true, ref_keys: { message_id: String(lastSent!.message_id), chat_id: String(lastSent!.chat.id) } }
}

/** Send multiple media items as a Telegram album (sendMediaGroup). Max 10 items. */
private async sendMediaGroup(
  chatId: string,
  items: ConnectorMediaItem[],
  commonOpts: Record<string, unknown>,
): Promise<ConnectorSendResult> {
  const { InputFile, InputMediaPhoto, InputMediaDocument, InputMediaVideo } = await import('grammy')

  // Telegram constraint: max 10 items per album
  const capped = items.slice(0, 10)

  // Resolve each item to grammY InputMedia shape
  const inputMedia = await Promise.all(capped.map(async (item, idx) => {
    const media = item.url
      ? item.url                                              // URL — Telegram downloads directly
      : new InputFile(item.data!, item.name ?? `file_${idx}`) // Buffer

    // Telegram hanya tampilkan caption item pertama secara menonjol di album
    const rawCaption = idx === 0 ? item.caption : undefined
    const caption = rawCaption && item.caption_markdown
      ? telegramifyMarkdown(rawCaption, 'escape')
      : rawCaption
    const parse_mode = rawCaption && item.caption_markdown ? 'MarkdownV2' as const : undefined

    if (item.type === 'image') {
      return { type: 'photo' as const, media, caption, parse_mode }
    } else if (item.type === 'video') {
      return { type: 'video' as const, media, caption, parse_mode }
    } else {
      return { type: 'document' as const, media, caption, parse_mode }
    }
  }))

  // Detect type homogeneity: photo/video can mix, document must be separate batch
  const hasPhotoOrVideo = inputMedia.some(m => m.type === 'photo' || m.type === 'video')
  const hasDocument = inputMedia.some(m => m.type === 'document')

  if (hasPhotoOrVideo && hasDocument) {
    // Telegram tidak izinkan campur photo/video dengan document dalam satu album.
    // Fallback: kirim photo/video grup dulu, lalu document satu per satu.
    const photoVideoItems = inputMedia.filter(m => m.type !== 'document')
    const docItems = capped.filter(item => item.type === 'document')

    const results: ConnectorSendResult[] = []

    if (photoVideoItems.length > 0) {
      const sent = await this.bot!.api.sendMediaGroup(chatId, photoVideoItems as any, commonOpts as any)
      results.push({ success: true, ref_keys: { message_id: String(sent[0]!.message_id), chat_id: chatId } })
    }
    for (const docItem of docItems) {
      results.push(await this.sendSingleMedia(chatId, docItem, undefined, commonOpts))
    }

    return results[0] ?? { success: false, error: 'No items sent' }
  }

  const sent = await this.bot!.api.sendMediaGroup(chatId, inputMedia as any, commonOpts as any)
  return {
    success: true,
    ref_keys: { message_id: String(sent[0]!.message_id), chat_id: chatId },
  }
}

/** Send a single media item (photo, document, voice). */
private async sendSingleMedia(
  chatId: string,
  item: ConnectorMediaItem,
  fallbackCaption: string | undefined,
  commonOpts: Record<string, unknown>,
): Promise<ConnectorSendResult> {
  const { InputFile } = await import('grammy')
  const rawCaption = item.caption ?? fallbackCaption
  const caption = rawCaption && item.caption_markdown
    ? telegramifyMarkdown(rawCaption, 'escape')
    : rawCaption
  const parse_mode = rawCaption && item.caption_markdown ? 'MarkdownV2' as const : undefined

  const media = item.url
    ? item.url
    : new InputFile(item.data!, item.name ?? 'file')

  if (item.type === 'image') {
    const sent = await this.bot!.api.sendPhoto(chatId, media, { caption, parse_mode, ...commonOpts as any })
    return { success: true, ref_keys: { message_id: String(sent.message_id), chat_id: String(sent.chat.id) } }
  } else if (item.type === 'voice') {
    const sent = await this.bot!.api.sendVoice(chatId, media, { caption, parse_mode, ...commonOpts as any })
    return { success: true, ref_keys: { message_id: String(sent.message_id), chat_id: String(sent.chat.id) } }
  } else {
    const sent = await this.bot!.api.sendDocument(chatId, media, { caption, parse_mode, ...commonOpts as any })
    return { success: true, ref_keys: { message_id: String(sent.message_id), chat_id: String(sent.chat.id) } }
  }
}
```

### 5. New Actions untuk Group Management

```typescript
override readonly actions: ConnectorAction[] = [
  // ... actions yang sudah ada (send_reaction, delete_message, edit_message, pin_message, unpin_message, send_file, send_photo, get_chat_info) ...

  // ── New actions ───────────────────────────────────────────────────────

  {
    id: 'send_media_group',
    name: 'Send Media Group (Album)',
    description: 'Send multiple photos, videos, or documents as a single album message. Photos and videos can be mixed (max 10). Documents must be sent separately from photos/videos — if mixed, photos/videos go first as album then documents are sent individually. Each item can have its own caption; only the first item caption is shown prominently by Telegram.',
    params: {
      chat_id: { type: 'string', required: true, description: 'Telegram chat ID' },
      media: {
        type: 'array',
        required: true,
        description: 'Array of media items. Each item: { type: "photo"|"video"|"document", url?: string, file_path?: string, caption?: string }. Max 10 items. Use url for public URLs, file_path for project filesystem files.',
      },
      thread_id: { type: 'string', required: false, description: 'Forum topic thread ID' },
    },
  },

  {
    id: 'send_url_media',
    name: 'Send Media from URL',
    description: 'Send a single image or document from a public URL directly to a chat — no filesystem needed',
    params: {
      chat_id: { type: 'string', required: true, description: 'Telegram chat ID' },
      url: { type: 'string', required: true, description: 'Public direct URL to the media file' },
      type: { type: 'string', required: true, description: '"photo" or "document"' },
      caption: { type: 'string', required: false, description: 'Optional caption' },
      thread_id: { type: 'string', required: false, description: 'Forum topic thread ID' },
    },
  },

  {
    id: 'send_to_scope',
    name: 'Send to Scope',
    description: 'Send a message to a specific scope (group, topic, or thread) using a scope_key. Useful for routing to exact conversation spaces.',
    params: {
      scope_key: { type: 'string', required: true, description: 'Scope key, e.g. "group:-1001234" or "group:-1001234:topic:42"' },
      text: { type: 'string', required: true, description: 'Message text' },
      markdown: { type: 'boolean', required: false, description: 'Parse text as Markdown (default true)' },
    },
  },

  {
    id: 'get_chat_members',
    name: 'Get Chat Members',
    description: 'Get the list of administrators in a Telegram group or channel',
    params: {
      chat_id: { type: 'string', required: true, description: 'Telegram chat ID' },
    },
  },

  {
    id: 'create_invite_link',
    name: 'Create Invite Link',
    description: 'Create an invite link for a Telegram group or channel',
    params: {
      chat_id: { type: 'string', required: true, description: 'Telegram chat ID' },
      name: { type: 'string', required: false, description: 'Link name/label' },
      expire_date: { type: 'string', required: false, description: 'ISO date when link expires' },
      member_limit: { type: 'number', required: false, description: 'Max uses (1–99999)' },
    },
  },

  {
    id: 'forward_message',
    name: 'Forward Message',
    description: 'Forward a message from one chat to another',
    params: {
      from_chat_id: { type: 'string', required: true, description: 'Source chat ID' },
      message_id: { type: 'string', required: true, description: 'Message ID to forward' },
      to_chat_id: { type: 'string', required: true, description: 'Destination chat ID' },
      thread_id: { type: 'string', required: false, description: 'Destination topic thread ID' },
    },
  },

  {
    id: 'set_chat_description',
    name: 'Set Chat Description',
    description: 'Update the description of a group or channel',
    params: {
      chat_id: { type: 'string', required: true, description: 'Telegram chat ID' },
      description: { type: 'string', required: true, description: 'New description (max 255 chars)' },
    },
  },

  {
    id: 'ban_member',
    name: 'Ban Member',
    description: 'Ban a user from the group. Use with caution.',
    params: {
      chat_id: { type: 'string', required: true, description: 'Telegram chat ID' },
      user_id: { type: 'string', required: true, description: 'User ID to ban' },
      until_date: { type: 'string', required: false, description: 'ISO date when ban expires (omit = permanent)' },
    },
  },
]
```

---

## New Tools in `buildConnectorTools()`

### `connector_list_targets`

```typescript
defineTool({
  meta: {
    id: 'connector_list_targets',
    name: 'List Channel Targets',
    description: 'List named channel targets — predefined destinations (groups, channels, DMs) you can send to by name without knowing chat IDs. Call this before connector_send_to_target.',
    group: 'connector',
  },
  input: z.object({
    connector_id: z.string().optional().describe('Filter by connector ID (omit for all connectors in project)'),
  }),
  execute: async (args) => {
    const { connector_id } = args as { connector_id?: string }
    const targets = await getConnectorTargets(projectId, connector_id)
    return { targets }
  },
})
```

### `connector_send_to_target`

```typescript
defineTool({
  meta: {
    id: 'connector_send_to_target',
    name: 'Send to Channel Target',
    description: 'Send a message to a named channel target. Use connector_list_targets first to see available targets.',
    group: 'connector',
  },
  input: z.object({
    target_name: z.string().describe('Target name from connector_list_targets, e.g. "morning-briefing"'),
    text: z.string().describe('Message text'),
    connector_id: z.string().optional().describe('Connector ID (omit if target name is unique)'),
    markdown: z.boolean().default(true),
  }),
  execute: async (args) => {
    const { target_name, text, connector_id, markdown } = args as { target_name: string; text: string; connector_id?: string; markdown: boolean }
    const target = await getConnectorTargetByName(projectId, target_name, connector_id)
    if (!target) return { success: false, error: `Target "${target_name}" not found. Use connector_list_targets to see available targets.` }

    const adapter = connectorRegistry.getAdapterForConnector(target.connector_id)
    if (!adapter) return { success: false, error: 'Connector not active' }

    const sendTarget: ConnectorTarget = {
      ref_keys: target.ref_keys as Record<string, string>,
      scope_key: target.scope_key ?? undefined,
    }

    return adapter.sendMessage(sendTarget, { text, markdown })
  },
})
```

### `connector_list_scopes`

```typescript
defineTool({
  meta: {
    id: 'connector_list_scopes',
    name: 'List Active Scopes',
    description: 'List active conversation scopes (groups, topics, threads) that the connector has seen. Useful for discovering where the bot is active.',
    group: 'connector',
  },
  input: z.object({
    connector_id: z.string().describe('Connector ID'),
    limit: z.number().int().min(1).max(50).default(20),
  }),
  execute: async (args) => {
    const { connector_id, limit } = args as { connector_id: string; limit: number }
    const scopes = await getConnectorScopes(connector_id, limit)
    return { scopes }
  },
})
```

---

## DB Queries (`@jiku-studio/db`)

Functions baru yang perlu dibuat di `queries/connector.ts`:

```typescript
// Channel Targets
export async function getConnectorTargets(projectId: string, connectorId?: string): Promise<ConnectorTargetRecord[]>
export async function getConnectorTargetByName(projectId: string, name: string, connectorId?: string): Promise<ConnectorTargetRecord | null>
export async function createConnectorTarget(data: CreateConnectorTargetInput): Promise<ConnectorTargetRecord>
export async function updateConnectorTarget(id: string, data: Partial<CreateConnectorTargetInput>): Promise<ConnectorTargetRecord>
export async function deleteConnectorTarget(id: string): Promise<void>

// Scope Conversations
export async function getScopeConversation(connectorId: string, scopeKey: string, agentId: string): Promise<ScopeConversationRecord | null>
export async function createScopeConversation(data: CreateScopeConversationInput): Promise<ScopeConversationRecord>
export async function touchScopeConversation(id: string): Promise<void>
export async function getConnectorScopes(connectorId: string, limit: number): Promise<ScopeRecord[]>
```

---

## API Routes Changes (`apps/studio/server/src/routes/connectors.ts`)

Tambah endpoint baru:

```
GET    /projects/:pid/connectors/:id/targets         → list targets
POST   /projects/:pid/connectors/:id/targets         → create target
PATCH  /projects/:pid/connectors/:id/targets/:tid    → update target
DELETE /projects/:pid/connectors/:id/targets/:tid    → delete target

GET    /projects/:pid/connectors/:id/scopes          → list active scopes
```

---

## Web UI Changes

### Connector Detail Page — Channel Targets Tab

New tab "Targets" di connector detail view:

```
[Overview] [Bindings] [Identities] [Targets] [Logs]
```

Targets tab:
- Table: Name | Display Name | Chat ID | Scope | Actions
- "Add Target" button → modal: Name (slug), Display Name, Description, chat_id, thread_id (optional)
- Edit/Delete per row
- Helper text: "Use these names in agent prompts: connector_send_to_target('name', message)"

### Binding Editor — Scope Filter Field

Di binding create/edit form, tambah:

```
Scope Filter (optional)
[ group:* / dm:* / exact scope_key / leave empty for all ]

Examples:
  group:*                    → match only group chats
  dm:*                       → match only DMs  
  group:-1001234567890       → only this specific group
  group:-1001234567890:topic:42  → only this forum topic
```

---

## Implementation Phases

### Phase A — Foundation (core changes, no breaking) [~1-2 hari]
- [ ] DB: migration untuk `connector_scope_conversations` dan `connector_targets`, alter `connector_bindings` tambah `scope_key_pattern`
- [ ] Types: update `ConnectorEvent` (scope_key), `ConnectorContent` (media name/caption), `ConnectorTarget` (scope_key)
- [ ] Kit: tambah `computeScopeKey()` dan `targetFromScopeKey()` optional methods ke `ConnectorAdapter`
- [ ] DB queries: `getScopeConversation`, `createScopeConversation`, `touchScopeConversation`, `getConnectorTargets`, `getConnectorTargetByName`, semua CRUD
- [ ] event-router: scope_key injection, scope-aware conversation resolution, scope filter in matchesTrigger, scope context string

### Phase B — Telegram Adapter Update [~1 hari]
- [ ] TelegramAdapter: `computeScopeKey()`, `targetFromScopeKey()`
- [ ] TelegramAdapter: populate `ref_keys.thread_id` + `metadata.chat_type` + `metadata.chat_title`
- [ ] TelegramAdapter: `extractMedia()` helper untuk photo/document/voice
- [ ] TelegramAdapter: `sendMessage()` media support (photo/document via URL dan buffer)
- [ ] TelegramAdapter: new actions (`send_media_group`, `send_url_media`, `send_to_scope`, `get_chat_members`, `create_invite_link`, `forward_message`, `set_chat_description`, `ban_member`)
- [ ] TelegramAdapter: `runAction` handler untuk `send_media_group` — resolve each item (url vs file_path→filesystem download), call `sendMediaGroup()` private method, handle photo/video vs document batch split

### Phase C — Media Pipeline [~0.5 hari]
- [ ] event-router: media download dari URL → upload ke filesystem
- [ ] event-router: inject media context ke AI input string
- [ ] Graceful degradation: jika filesystem tidak configured, log warning saja (tidak block)

### Phase D — Channel Targets [~1 hari]
- [ ] Tool: `connector_list_targets`, `connector_send_to_target`, `connector_list_scopes` di `buildConnectorTools()`
- [ ] API routes: CRUD untuk targets dan list scopes
- [ ] Web UI: Targets tab di connector detail

### Phase E — Binding Scope Filter UI [~0.5 hari]
- [ ] Binding editor: scope filter field dengan helper text dan examples
- [ ] Save/load `scope_key_pattern` dari API

---

## Testing Scenarios

### Real Case 1: User chat via Telegram group dengan topic isolation

1. Bot masuk ke Telegram supergroup dengan forum topics enabled
2. User kirim pesan di Topic "Support"
3. event-router: scope_key = `"group:-1001234:topic:5"`, buat conversation baru untuk scope ini
4. Binding dengan `scope_key_pattern = "group:*"` match
5. AI reply ke topic yang sama (bukan general chat)
6. User lain kirim di Topic "Sales" → conversation berbeda, isolated

### Real Case 2: Cron task kirim daily briefing ke channel

1. Connector Telegram aktif dengan bot token
2. Admin buat Channel Target: name = `"daily-briefing"`, chat_id = `"-1001234567890"`, thread_id = `"42"`
3. Cron task configured: "Every day 08:00, run agent dengan prompt: 'Buat daily briefing dan kirim ke target daily-briefing'"
4. Agent call `connector_list_targets()` → lihat `daily-briefing`
5. Agent call `connector_send_to_target("daily-briefing", summary_text)`
6. Adapter kirim ke group + topic yang benar

### Real Case 3: User kirim gambar ke bot

1. User kirim foto ke bot DM
2. TelegramAdapter `extractMedia()` → populate `content.media.url`
3. event-router download file dari Telegram CDN
4. Upload ke `/connector_media/<connector_id>/photo_<timestamp>.jpg` di filesystem
5. AI input string: `[Media attached: photo — photo_1234.jpg — saved to /connector_media/.../photo_1234.jpg]`
6. AI bisa menyebut attachment dalam reply

### Real Case 4: AI kirim konten marketing ke Telegram channel

1. Agent task: "Buat konten marketing untuk promo akhir tahun, kirim ke channel `@mystore` dengan gambar produk"
2. Agent generate/pilih gambar → simpan ke `/marketing/promo.jpg` via `fs_write`
3. Agent tulis caption marketing dengan formatting:
   ```
   *🎉 Promo Akhir Tahun!*

   Diskon hingga 50% untuk semua produk pilihan.
   Berlaku 25–31 Desember 2026.

   👉 [Shop Now](https://mystore.com/sale)

   #promo #sale #diskon
   ```
4. Agent call `connector_run_action("send_photo", { chat_id: "@mystore", file_path: "/marketing/promo.jpg", caption: "...", caption_markdown: true })`
5. Telegram channel terima: gambar dengan caption MarkdownV2 — bold, link, hashtag tampil dengan benar

**Catatan channel vs group:**
- Channel: `chat_id` bisa `@channelname` (public) atau negatif ID (private channel)
- Bot harus jadi admin dengan permission "Post Messages"
- Channel post tidak punya `sender` — bot yang kirim tampil sebagai channel itu sendiri
- Semua ini transparan dari sisi AI — cukup pass `chat_id` yang benar

---

### Real Case 5: AI kirim carousel produk (multiple images) ke channel marketing

1. Cron task: "Generate 3 chart PNG dan kirim ke target `daily-briefing` sebagai album"
2. Agent generate 3 file: `chart_revenue.png`, `chart_users.png`, `chart_retention.png` via fs_write
3. Agent call `connector_run_action("send_media_group", { chat_id: "...", media: [{ type: "photo", file_path: "/charts/chart_revenue.png", caption: "Revenue hari ini" }, { type: "photo", file_path: "/charts/chart_users.png" }, { type: "photo", file_path: "/charts/chart_retention.png" }] })`
4. TelegramAdapter download semua dari filesystem → `sendMediaGroup()` → Telegram terima sebagai album 3 foto
5. User di Telegram lihat 3 chart sekaligus dalam 1 pesan albumnya

**Telegram constraints:**
- Max 10 item per album
- Photo + video bisa dicampur dalam satu album
- Document tidak bisa dicampur dengan photo/video → auto-split: foto dikirim sebagai album, dokumen dikirim individually setelahnya
- Caption hanya tampil menonjol pada item pertama; item lain bisa punya caption tapi tampil lebih kecil

---

### Real Case 6: AI manage group — kirim ke multiple topics

1. AI task: "Kirim announcement ke semua topic di group -1001234"
2. AI call `connector_run_action("send_to_scope", { scope_key: "group:-1001234:topic:1", text: "..." })`
3. AI call `connector_run_action("send_to_scope", { scope_key: "group:-1001234:topic:2", text: "..." })`
4. Atau gunakan `connector_list_scopes()` untuk discovery topics yang aktif

---

## Migration Notes

- Backward compat terjaga: `scope_key = null` → path lama via `identity.conversation_id`
- Connector yang sudah ada tidak terpengaruh sampai adapter mereka implement `computeScopeKey`
- `connector_identities.conversation_id` tetap ada dan tidak deprecated
- Semua tools lama (`connector_send`, `connector_run_action`, dll) tetap berfungsi tanpa perubahan
