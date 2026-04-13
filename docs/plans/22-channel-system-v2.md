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

### ADR-058 — Media Pipeline: Lazy Fetch via Event Log Metadata

**Context:** Tiga opsi dipertimbangkan:
- **Eager download**: Event-router langsung download media setiap inbound message berisi foto/file → simpan ke filesystem.
- **In-memory adapter cache**: TelegramAdapter menyimpan `Map<messageKey, file_id>` di memory — tidak persistent, hilang saat server restart.
- **Event log metadata**: Simpan `file_id` + metadata ke `connector_events.metadata` (kolom `jsonb` yang sudah ada) — persistent, auditable, consistent.

**Decision:** Lazy fetch via event log metadata. Saat TelegramAdapter menerima message berisi media, ia:
1. Simpan `file_id` + metadata ke `connector_events.metadata` field saat event di-log
2. Emit `ConnectorEvent.content.media` hanya dengan metadata (type, size, name) — tanpa url/data
3. AI terima event dengan hint: `[Media available: photo 234KB — use fetch_media(event_id="...")]`
4. Ketika AI call `connector_run_action("fetch_media", { event_id, save_path })`, adapter lookup `connector_events.metadata` → dapat `file_id` → call Telegram `getFile()` → download → return bytes

**Kenapa event log metadata lebih baik dari in-memory cache:**
1. **Persistent** — server restart tidak hilang; AI bisa fetch media dari event lama sekalipun
2. **Auditable** — bisa lihat history `file_id` per inbound message dari DB
3. **Consistent** — satu source of truth; tidak perlu sync memory + DB
4. **Referenceable** — AI cukup pegang `event_id` yang sudah ada di conversation context, tidak perlu `chat_id:message_id` composite key
5. **Gratis** — `connector_events.metadata` sudah ada, tidak perlu migrasi kolom baru
6. **Telegram-idiomatic** — `file_id` valid selamanya untuk bot yang sama; URL dari `getFile()` expire 1 jam, jadi lebih baik call `getFile()` lazily di fetch time

**Consequences:** `ConnectorEvent.content.media` hanya membawa metadata (type, file_name, mime_type, file_size) — tidak ada url/data. `connector_events.metadata` menyimpan `{ media_file_id, media_type, media_file_name, media_mime_type, media_file_size }` saat ada media. Context injection berubah dari "file saved to path" menjadi "media available, fetch when needed via event_id".

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

### Existing: `connector_events` — kolom `metadata` dan `payload` digunakan lebih penuh

Tidak perlu migrasi — kolom `metadata jsonb` dan `payload jsonb` sudah ada. Konvensi penggunaan:

| Field | Isi | Diakses oleh |
|-------|-----|--------------|
| `payload` | Data publik: `{ text, media_type, media_file_size, ... }` | AI (via event log query), monitoring |
| `metadata.media_file_id` | `file_id` internal Telegram — prefix `media_*` | Adapter saat `fetch_media` action |
| `metadata.chat_type` | `"private"` / `"group"` / `"supergroup"` | Event-router scope resolution |
| `metadata.chat_title` | Nama group/channel | Context injection ke AI |
| `metadata.raw_message` | Full raw Telegram message object | Fallback — hanya jika benar-benar dibutuhkan |

`metadata.raw_message` disimpan terpisah agar tidak polute metadata terstruktur, tapi tersedia kalau adapter atau tool butuh data yang tidak ter-extract secara default. **Tidak diekspos ke AI secara default** — AI hanya lihat `payload` dan injected context string.

---

## Type System Changes (`@jiku/types`)

### `ConnectorEvent` — tambah `scope_key` + media metadata only

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
    /**
     * Media metadata only — NO url/data, NO file_id.
     * file_id disimpan di connector_events.metadata (internal, tidak diekspos ke AI).
     * AI fetch media via connector_run_action("fetch_media", { event_id, save_path }).
     * event_id tersedia di AI context; adapter lookup file_id dari event log DB.
     */
    media?: {
      type: 'photo' | 'document' | 'voice' | 'video' | 'sticker'
      file_name?: string
      mime_type?: string
      file_size?: number    // bytes
    }
    raw?: unknown
  }
  metadata?: Record<string, unknown>
  timestamp: Date
}
// ref_keys untuk Telegram inbound: { message_id, chat_id, thread_id? }
// AI mendapat message_id + chat_id di context string — berguna untuk memahami
// dari pesan mana media berasal, dan sebagai referensi untuk reply/quote.
// event_id (UUID dari connector_events row) dipakai untuk fetch_media action.
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

### 3. Media Extraction → Event Log Metadata

Tidak ada in-memory cache. Semua disimpan ke `connector_events` row:

- **`metadata`** — media `file_id` + metadata terstruktur (prefix `media_*`) + info lain (chat_type, chat_title, dll)
- **`payload`** — raw Telegram message object — disimpan di field terpisah agar tidak ganggu metadata, sebagai fallback kalau AI atau adapter butuh data raw

```typescript
/**
 * Extract media dari Telegram message.
 * Returns:
 * - `media` — metadata publik untuk ConnectorEvent.content.media (tanpa file_id)
 * - `mediaMetadata` — internal data untuk connector_events.metadata (berisi file_id)
 *
 * file_id TIDAK dikirim ke AI — hanya disimpan internal di event log.
 * AI fetch media via event_id, adapter lookup file_id dari DB.
 */
private extractMedia(msg: any): {
  media: ConnectorEvent['content']['media'] | undefined
  mediaMetadata: Record<string, unknown>
} {
  if (msg.photo?.length) {
    const largest = msg.photo[msg.photo.length - 1]
    return {
      media: { type: 'photo', file_size: largest.file_size },
      mediaMetadata: { media_file_id: largest.file_id, media_type: 'photo', media_file_size: largest.file_size },
    }
  }
  if (msg.document) {
    return {
      media: { type: 'document', file_name: msg.document.file_name, mime_type: msg.document.mime_type, file_size: msg.document.file_size },
      mediaMetadata: { media_file_id: msg.document.file_id, media_type: 'document', media_file_name: msg.document.file_name, media_mime_type: msg.document.mime_type, media_file_size: msg.document.file_size },
    }
  }
  if (msg.voice) {
    return {
      media: { type: 'voice', mime_type: msg.voice.mime_type, file_size: msg.voice.file_size },
      mediaMetadata: { media_file_id: msg.voice.file_id, media_type: 'voice', media_mime_type: msg.voice.mime_type, media_file_size: msg.voice.file_size },
    }
  }
  if (msg.video) {
    return {
      media: { type: 'video', file_name: msg.video.file_name, mime_type: msg.video.mime_type, file_size: msg.video.file_size },
      mediaMetadata: { media_file_id: msg.video.file_id, media_type: 'video', media_file_name: msg.video.file_name, media_mime_type: msg.video.mime_type, media_file_size: msg.video.file_size },
    }
  }
  return { media: undefined, mediaMetadata: {} }
}
```

Di `bot.on('message')` handler:

```typescript
const { media, mediaMetadata } = this.extractMedia(msg)

const event: ConnectorEvent = {
  type: 'message',
  connector_id: this.id,
  ref_keys: {
    message_id: String(msg.message_id),
    chat_id: String(msg.chat.id),
    ...(msg.message_thread_id ? { thread_id: String(msg.message_thread_id) } : {}),
  },
  sender: { ... },
  content: { text: msg.text ?? msg.caption, media },
  metadata: {
    chat_type: msg.chat.type,
    chat_title: 'title' in msg.chat ? msg.chat.title : undefined,
    language_code: msg.from?.language_code ?? null,
    client_timestamp: new Date(msg.date * 1000).toISOString(),
    ...mediaMetadata,  // media_file_id, media_type, etc. — ke field metadata
  },
  // raw Telegram message disimpan terpisah ke connector_events.payload —
  // tidak campur dengan metadata, tapi tersedia kalau adapter atau AI butuh raw data
  content: { text: msg.text ?? msg.caption, media, raw: msg },
  timestamp: new Date(msg.date * 1000),
}
```

> **Catatan implementasi:** `connector_events.payload` menyimpan `{ text, media_metadata }` untuk kebutuhan normal. Raw Telegram message (`msg`) disimpan ke `connector_events.metadata.raw_message` — field terpisah, hanya diakses jika benar-benar dibutuhkan. Tidak diekspos ke AI secara default.

**`connector_events` row structure** untuk inbound message berisi media:
```json
{
  "event_type": "message",
  "ref_keys": { "message_id": "42", "chat_id": "-1001234", "thread_id": "7" },
  "payload": { "text": "lihat ini", "media_type": "photo", "media_file_size": 234567 },
  "metadata": {
    "chat_type": "supergroup",
    "chat_title": "Marketing Team",
    "media_file_id": "AgACAgIAAxkBAAI...",
    "media_type": "photo",
    "media_file_size": 234567,
    "raw_message": { ... }
  }
}
```

**Context injection di event-router** — AI mendapat `event_id` + info `message_id`/`chat_id` agar bisa membuat keputusan:
```typescript
// Di buildConnectorContextString() — tambah:
if (event.content?.media) {
  const m = event.content.media
  const sizeHint = m.file_size ? ` ${Math.round(m.file_size / 1024)}KB` : ''
  const nameHint = m.file_name ? ` "${m.file_name}"` : ''
  // event_id sudah tersedia karena event di-log sebelum context dibangun
  parts.push(
    `Media available: ${m.type}${nameHint}${sizeHint}` +
    ` (from message_id=${event.ref_keys['message_id']}, chat_id=${event.ref_keys['chat_id']})` +
    ` — use connector_run_action("fetch_media", { event_id: "<event_id>", save_path: "/your/path" }) to download`
  )
}
```

Ketika AI call `fetch_media(event_id, save_path)`:
1. Adapter query `connector_events` by `event_id` → ambil `metadata.media_file_id`
2. Call Telegram `bot.api.getFile(file_id)` → dapat temporary URL (valid 1 jam)
3. Download bytes dari URL
4. Simpan ke `save_path` via filesystem adapter
5. Return path ke AI

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
    id: 'fetch_media',
    name: 'Fetch Media from Message',
    description: 'Download media from a previously received message and save it to the project filesystem. Use the message_id from the "Media available" hint in the conversation context. Returns the saved file path.',
    params: {
      message_id: { type: 'string', required: true, description: 'message_id from the inbound message that contained media' },
      chat_id: { type: 'string', required: true, description: 'chat_id from the same inbound message' },
      save_path: { type: 'string', required: false, description: 'Filesystem path to save the file, e.g. "/templates/promo.jpg". If omitted, auto-generates under /connector_media/.' },
    },
  },

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
- [ ] TelegramAdapter: `TelegramMediaCacheEntry` type + `mediaCache: Map` private field + `cacheMedia()` + `getCachedMedia()` helpers
- [ ] TelegramAdapter: `extractAndCacheMedia()` — extract metadata + cache `file_id`, NO download (replaces old `extractMedia()`)
- [ ] TelegramAdapter: `sendMessage()` media support (photo/document via URL, buffer, `sendMediaGroup`)
- [ ] TelegramAdapter: `sendSingleMedia()` + `sendMediaGroup()` private methods
- [ ] TelegramAdapter: new actions (`fetch_media`, `send_media_group`, `send_url_media`, `send_to_scope`, `get_chat_members`, `create_invite_link`, `forward_message`, `set_chat_description`, `ban_member`)
- [ ] TelegramAdapter: `runAction` handler `fetch_media` — lookup cache → `bot.api.getFile(file_id)` → download buffer → `fs.write(save_path)` → return `{ path, size }`
- [ ] TelegramAdapter: `runAction` handler `send_media_group` — resolve items (url / file_path→filesystem) → `sendMediaGroup()` private → handle photo+video vs document split

### Phase C — Media Context Injection [~0.5 hari]
- [ ] event-router `buildConnectorContextString()`: detect `event.content.media` → inject hint string dengan `message_id`, `chat_id`, dan contoh `fetch_media` call
- [ ] Pastikan `message_id` + `chat_id` selalu ada di `event.ref_keys` (Telegram adapter sudah, tapi perlu verified)
- [ ] Graceful: jika tidak ada media di event, context string tidak berubah

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

### Real Case 6: Template-based scheduled marketing publish

Use case: User kirim template (teks + foto) ke bot sekali, AI simpan, lalu kirim otomatis via cron ke channel tujuan.

**Sesi 1 — User kirim template ke bot via Telegram DM:**

1. User kirim pesan ke bot:
   ```
   Simpan ini sebagai template "promo_sale":

   *🎉 Flash Sale Akhir Tahun!*
   Diskon hingga 50% untuk semua produk pilihan.
   Berlaku 25–31 Desember.
   👉 https://mystore.com/sale
   #promo #sale #diskon
   ```
   Plus attach foto produk (misal banner promo).

2. Plan 22 Phase C: event-router download foto → simpan ke `/connector_media/<id>/photo_1234.jpg`, inject context ke AI.

3. AI terima:
   - Text: isi template dari user
   - Context: `[Media attached: photo — saved to /connector_media/.../photo_1234.jpg]`

4. AI call:
   ```
   fs_write("/templates/promo_sale.md", "*🎉 Flash Sale Akhir Tahun!*\n...")
   fs_move("/connector_media/.../photo_1234.jpg", "/templates/promo_sale.jpg")
   ```

5. AI reply ke user: "Template 'promo_sale' sudah disimpan beserta foto. Kapan mau dijadwalkan?"

**Sesi 2 — User set jadwal:**

6. User: "Kirim setiap Senin jam 09:00 ke channel @mystore"

7. AI (atau user via UI) buat cron task dengan prompt:
   ```
   Load template dari /templates/promo_sale.md dan kirim ke channel @mystore
   beserta foto /templates/promo_sale.jpg dengan caption markdown.
   ```

**Setiap Senin jam 09:00 — Cron fires:**

8. AI call `fs_read("/templates/promo_sale.md")` → dapat caption text
9. AI call:
   ```
   connector_run_action("send_photo", {
     chat_id: "@mystore",
     file_path: "/templates/promo_sale.jpg",
     caption: "<isi template>",
     caption_markdown: true
   })
   ```
10. Channel `@mystore` terima foto + caption dengan formatting sempurna.

**Mengapa ini works tanpa infrastruktur baru:**

| Capability | Dari mana |
|---|---|
| Terima foto dari user via Telegram | Plan 22 Phase B+C (inbound media capture) |
| `fs_write`, `fs_read`, `fs_move` | Plan 14 — Filesystem (sudah ada) |
| `send_photo` action dengan `file_path` | Sudah ada di TelegramAdapter |
| `caption_markdown` support | Plan 22 (tambahan di ConnectorMediaItem) |
| Cron scheduling | Plan 16 — Cron Task System (sudah ada) |

**Variasi — Multiple templates:**
AI bisa kelola banyak template: `/templates/promo_sale.md + .jpg`, `/templates/product_launch.md + .jpg`, dll. Cron task masing-masing independent. AI bisa list templates via `fs_list("/templates/")`.

**Variasi — Template dengan media group (carousel):**
User kirim beberapa foto sekaligus sebagai album → AI simpan semua → cron kirim sebagai media group:
```
connector_run_action("send_media_group", {
  chat_id: "@mystore",
  media: [
    { type: "photo", file_path: "/templates/promo_1.jpg", caption: "...", caption_markdown: true },
    { type: "photo", file_path: "/templates/promo_2.jpg" },
    { type: "photo", file_path: "/templates/promo_3.jpg" }
  ]
})
```

---

### Real Case 7: AI manage group — kirim ke multiple topics

1. AI task: "Kirim announcement ke semua topic di group -1001234"
2. AI call `connector_list_scopes({ connector_id: "..." })` → dapat list scope aktif
3. AI call `connector_run_action("send_to_scope", { scope_key: "group:-1001234:topic:1", text: "..." })`
4. AI call `connector_run_action("send_to_scope", { scope_key: "group:-1001234:topic:2", text: "..." })`

---

## Migration Notes

- Backward compat terjaga: `scope_key = null` → path lama via `identity.conversation_id`
- Connector yang sudah ada tidak terpengaruh sampai adapter mereka implement `computeScopeKey`
- `connector_identities.conversation_id` tetap ada dan tidak deprecated
- Semua tools lama (`connector_send`, `connector_run_action`, dll) tetap berfungsi tanpa perubahan

---

## Revision — 2026-04-13 (post-ship bug fixes + architecture tightening)

Catatan revisi yang tidak mengubah scope plan, tapi mengatasi bug dan gap yang muncul setelah shipped.

### Masalah yang dilaporkan

1. **Cron infinite loop** — cron prompt disimpan verbatim seperti pesan user, saat fire agent re-interpret sebagai permintaan bikin cron baru → loop.
2. **Edit pesan user menghapus delivery context** di prompt cron yang sudah dibuat (AI SDK `execute()` dipanggil ulang saat replay history hasil edit — tool side-effectful dieksekusi dua kali, overwrite).
3. **Missing cron menu** untuk admin karena permission list role stale pasca-penambahan `cron_tasks:*`.
4. **Cron agent tidak tahu "user B"** — hanya tahu user yang chat sekarang. Perlu cross-user awareness untuk "ingatkan user B jam 8".
5. **Delivery context hilang saat edit prompt** — karena `[Cron Trigger]` + `[Cron Delivery]` di-stuff ke dalam `prompt` string yang user bisa edit.

### Keputusan arsitektur (lanjutan ADR)

#### ADR-060 — Side-effectful tool dedup on replay

**Decision.** Tambah `ToolMeta.side_effectful?: boolean`. Runner scan full conversation history sekali di awal run, build map `${tool_name}:${hash(args)} → result`. Saat AI SDK call tool `execute()`, kalau tool `side_effectful` dan key sudah ada di map → return cached result, skip executor. Hash pakai stable JSON stringify (sorted keys).

Tools yang ditandai: `cron_create/update/delete`, `connector_send`, `connector_send_to_target`, `connector_run_action`, `connector_create_target/update_target/delete_target/save_current_scope`, `identity_set`.

**Consequences.** Edit pesan user → tool result lama di-replay tanpa double-write. Cron rows nggak duplikasi, pesan nggak kirim dobel. Kerugian: kalau user *sengaja* mau tool jalan dua kali dengan args identik (jarang) — harus ubah args sedikit.

#### ADR-061 — Cron context separation (prompt vs context jsonb)

**Decision.** `cron_tasks` tambah kolom `context jsonb`. Shape: `{ origin, delivery, subject, notes }`. `prompt` jadi intent murni (pendek, bisa user edit). Scheduler compose `[Cron Trigger]` + `[Cron Origin]` + `[Cron Subject]` + `prompt` + `[Cron Delivery]` saat fire, lewat helper di `apps/studio/server/src/cron/context.ts`.

`cron_create` tool sekarang terima `origin`, `delivery`, `subject` sebagai field terpisah. `cron_update` shallow-merge `context` — UI edit prompt TIDAK sentuh context.

**Consequences.** Edit prompt aman. Context terstruktur bisa di-inspeksi / di-query / ditampilkan di UI tanpa parse string. Subject ≠ originator (untuk kasus "user A minta diingatkan user B").

#### ADR-062 — Per-run extra_system_segments (no global plugin for per-project context)

**Context.** Plugin prompt segments diinjeksi global (tidak project-aware di call site). Untuk Company & Team structure yang per-project + per-caller, plugin nggak cocok.

**Decision.** Tambah `JikuRunParams.extra_system_segments?: string[]`. Studio `runtimeManager.run` selalu append segment "[Company & Team]" — list members + role + known identities (user_identities + connector_identities.external_ref_keys untuk mapped_user). Rules instruksi: pakai `identity_find` / `identity_get` untuk resolve, jangan tebak kalau identity kosong.

**Consequences.** Agent paham siapa "user B" + channel mana yang reachable. Tanpa harus loop tool call.

#### ADR-063 — Cron-triggered runs KEEP cron mutation tools (no suppression)

**Context.** Sempat diusulkan strip `cron_create/update/delete` saat cron-triggered run untuk cegah loop.

**Decision.** Batalkan. Cron dinamis (cron yang bikin cron conditional) adalah fitur yang diinginkan. Cegah loop murni lewat prompt discipline + [Cron Trigger] preamble + side-effectful dedup.

Mekanisme `JikuRunParams.suppress_tool_ids` tetap ada sebagai escape hatch, cuma tidak di-apply untuk cron.

### Perubahan file

- Types: `packages/types/src/index.ts` — `ToolMeta.side_effectful`, `JikuRunParams.suppress_tool_ids`, `JikuRunParams.extra_system_segments`.
- Core runner: `packages/core/src/runner.ts` — build `priorSideEffectResults` map, dedup di execute wrapper; combine plugin segments + `extra_system_segments`.
- DB schema: `apps/studio/db/src/schema/cron_tasks.ts` — `context jsonb` kolom.
- DB migration: `apps/studio/db/src/migrations/0019_plan22_backfill_admin_cron_perms.sql` (backfill cron perms ke Admin role), `0020_plan22_cron_context.sql` (cron context column).
- Cron: `apps/studio/server/src/cron/context.ts` (baru — prelude composer), `apps/studio/server/src/cron/tools.ts` (cron_create/update refactor — field origin/delivery/subject terpisah, prompt bersih, safety rails), `apps/studio/server/src/cron/scheduler.ts` (compose prelude dari context saat fire).
- Runtime: `apps/studio/server/src/runtime/team-structure.ts` (baru — build [Company & Team] segment), `apps/studio/server/src/runtime/manager.ts` (inject team segment ke setiap run, UUID guard untuk non-user caller `'system'`/`'connector:*'`).
- Connectors: `apps/studio/server/src/connectors/tools.ts` — tandai tools side-effectful.
- Routes: `apps/studio/server/src/routes/cron-tasks.ts` — admin lihat semua cron saat punya `cron_tasks:write`.
- Web UI: `apps/studio/web/app/(app)/.../settings/permissions/page.tsx` — tambah group "Cron Tasks" di permission UI.
- Telegram adapter: tool `cron_create` description + safety rails (pre-existing dari plan 22, diperkuat di revisi).

### Migration & run order

1. `bun db:push` — apply `0018` (jika belum) + `0019` + `0020`.
2. Restart server.
3. Hapus cron task lama yang format prompt-nya masih gabungan (pre-context separation); buat ulang via chat agar tersimpan ke `context` jsonb. Atau patch manual via `cron_update` → isi `context.delivery`.
4. QA: kirim "ingatkan saya jam X" via Telegram → cek `cron_tasks.prompt` = intent pendek; `cron_tasks.context` = { origin, delivery }; saat fire, task conversation input punya `[Cron Trigger]` + `[Cron Delivery]` block terkomposisi.
5. QA edit: edit pesan user yang trigger cron_create sebelumnya → cron row original TIDAK berubah (side-effectful dedup aktif).


