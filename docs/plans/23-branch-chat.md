# Plan 23 — Branch Chat: Message-Level Branching dalam Conversation

## Goals

Tambah fitur **message branching** di chat mode — mirip Claude.ai dan ChatGPT. Branching terjadi **di dalam satu conversation yang sama** (bukan conversation terpisah). Conversation ID dan URL tetap. Yang berubah hanya jalur (path) mana yang sedang aktif di dalam pohon pesan.

### Konsep Inti

```
                                ┌─ msg3a (user)  ─→ msg4a (assistant)  ─→ msg5a (user) ─→ msg6a (assistant) ← tip A
msg1 (user) ─→ msg2 (assistant) ┤
                                └─ msg3b (user)  ─→ msg4b (assistant) ← tip B
                                                       ↑
                                            (parent msg3a == parent msg3b == msg2)
```

- Setiap message punya `parent_message_id` ke pesan sebelumnya
- Conversation menyimpan `active_tip_message_id` — leaf paling ujung dari branch yang sedang aktif
- Untuk tampilkan branch: dari tip → ikuti chain `parent_message_id` ke belakang sampai root → balik urutannya → linear history
- **Branch terdeteksi** ketika ≥2 message punya `parent_message_id` yang sama
- Navigator `← N/total →` muncul di posisi message dengan sibling

### Real Cases

1. **Edit user message** — User edit pesan N → dibuat user message baru dengan `parent_message_id` sama dengan parent N → ini otomatis jadi branch karena dua message share parent. AI generate response baru.
2. **Regenerate response** — User regenerate response M → buat assistant message baru dengan `parent_message_id` = parent M (user message sebelumnya). Otomatis jadi sibling.
3. **A/B prompting** — User mau coba prompt berbeda dari titik yang sama tanpa kehilangan branch lain.

### Non-Goals

- Branch merging
- Branch labeling/naming oleh user
- Branch di `task` mode atau `readonly` mode (chat saja)
- Visual diff antar branch
- Hard delete branches (soft archiving acceptable, defer)

---

## Architecture Decisions

### ADR-060 — Message-Level Branching dengan `parent_message_id`

**Context:** Branching bisa di-implement dengan dua pendekatan:
- **Conversation-level**: Branch = conversation baru, copy messages. Sederhana tapi tidak match dengan UX Claude/ChatGPT (URL berubah, conversation list jadi membengkak).
- **Message-level**: Branch = pohon di dalam satu conversation. Match dengan UX standar.

**Decision:** Message-level branching. Tambah `parent_message_id` (self-referential, nullable) dan `branch_index` (integer) ke tabel `messages`. Conversation tetap satu — pesan-pesannya membentuk pohon.

**Konsekuensi:**
- `messages` tidak lagi linear → semua kode yang load messages harus refactor untuk traverse pohon
- Runner perlu tahu cabang mana yang aktif → conversation menyimpan `active_tip_message_id`
- Migrasi data lama: backfill `parent_message_id` berdasarkan urutan `created_at` (linear → tree dengan branching factor 1)
- Backward compat untuk existing conversations setelah backfill

---

### ADR-061 — `active_tip_message_id` di Conversation (Server-Side State)

**Context:** Server perlu tahu cabang mana yang aktif untuk:
1. Load history saat user buka conversation
2. Tentukan parent untuk new messages
3. Pertahankan state lintas reload / device

**Opsi:**
- **Client-side only**: Frontend track active tip, kirim ke server di setiap request → race condition antar tab, hilang setelah reload
- **Server-side persisted**: Conversation simpan `active_tip_message_id` → konsisten lintas device

**Decision:** Server-side. Tambah `active_tip_message_id` ke tabel `conversations`. Update otomatis saat:
- Pesan baru dikirim → tip = ID pesan baru (assistant response)
- User navigasi branch → tip = leaf dari subtree yang dipilih

**Konsekuensi:**
- Branch switch = `PATCH /conversations/:id/active-tip { tip_message_id }`
- Page reload → server load active path → user lihat branch terakhir yang aktif
- Multi-tab: last writer wins (acceptable)

---

### ADR-062 — Active Path Loading via Recursive CTE

**Context:** Untuk render conversation, server harus mengirim hanya pesan yang ada di active branch path (bukan seluruh pohon). Path = chain dari `active_tip_message_id` ke root via `parent_message_id`.

**Decision:** Single recursive CTE PostgreSQL query yang traverse parent links + attach sibling counts:

```sql
WITH RECURSIVE active_path AS (
  SELECT m.*, 0 AS depth
  FROM messages m
  WHERE m.id = $active_tip_id
  UNION ALL
  SELECT m.*, ap.depth + 1
  FROM messages m
  INNER JOIN active_path ap ON m.id = ap.parent_message_id
)
SELECT
  ap.*,
  COALESCE(
    (SELECT COUNT(*)::int FROM messages
     WHERE conversation_id = ap.conversation_id
       AND parent_message_id IS NOT DISTINCT FROM ap.parent_message_id),
    1
  ) AS sibling_count,
  (SELECT array_agg(id ORDER BY branch_index, created_at ASC)
   FROM messages
   WHERE conversation_id = ap.conversation_id
     AND parent_message_id IS NOT DISTINCT FROM ap.parent_message_id) AS sibling_ids
FROM active_path ap
ORDER BY ap.depth DESC;  -- root first, tip last
```

**Konsekuensi:**
- Satu query untuk semua data yang dibutuhkan UI (linear history + branch navigator metadata)
- Performa: index pada `(conversation_id, parent_message_id)` membuat sibling lookup O(log n)
- `IS NOT DISTINCT FROM` handle NULL parent (root messages share NULL parent)

---

### ADR-063 — Branching Implicit (No Dedicated Branch API)

**Context:** Branch creation bisa di-trigger via dedicated endpoint, atau implicit dari operasi normal.

**Decision:** Branching **implicit**. Branching terjadi secara otomatis ketika message baru dibuat dengan `parent_message_id` yang sudah punya children. Tidak perlu endpoint khusus untuk "create branch".

**Trigger:**
| Aksi | Operasi | Hasil |
|------|---------|-------|
| Send message normal | POST /chat dengan `parent_message_id = active_tip` | Linear extend (parent belum punya children) |
| Edit user message N | POST /chat dengan `parent_message_id = parent(N)` | Branch baru karena msg N sudah jadi child dari parent(N) |
| Regenerate response M | POST /regenerate dengan `user_message_id = parent(M)` | Branch baru di sisi assistant |

**Konsekuensi:**
- Server tidak perlu tahu apakah ini "branch" atau bukan — selalu set `parent_message_id` dan `branch_index = max(siblings) + 1`
- Branching jadi natural consequence dari design data model
- Hanya satu endpoint baru: `regenerate` (karena beda dari send-message biasa: tidak buat user message, hanya assistant)

---

### ADR-064 — Branch Switch: Pilih Tip dengan Strategy "Latest Leaf"

**Context:** User klik `→` di navigator untuk pindah ke sibling. Sibling itu mungkin punya descendants (sub-branches). Tip mana yang dipilih?

**Decision:** Strategi **"latest leaf"** — dari sibling yang dipilih, walk ke bawah selalu pilih child dengan `branch_index` tertinggi (= terbaru), sampai leaf.

**Rationale:**
- Match intuisi user — kalau terakhir buka branch B, tip-nya adalah leaf di B
- Deterministic — selalu hasilkan tip yang sama untuk subtree yang sama
- Tidak butuh tracking state tambahan (`last_visited_at` per message)

**SQL:**
```sql
-- Find latest leaf in subtree rooted at $sibling_id
WITH RECURSIVE descendants AS (
  SELECT id, branch_index, created_at, 0 AS depth
  FROM messages WHERE id = $sibling_id
  UNION ALL
  SELECT child.id, child.branch_index, child.created_at, d.depth + 1
  FROM messages child
  INNER JOIN descendants d ON child.parent_message_id = d.id
  WHERE child.branch_index = (
    SELECT MAX(branch_index) FROM messages
    WHERE parent_message_id = d.id
  )
)
SELECT id FROM descendants
WHERE id NOT IN (SELECT parent_message_id FROM messages WHERE parent_message_id IS NOT NULL)
ORDER BY depth DESC LIMIT 1;
```

---

### ADR-065 — Branch Navigator Inline pada Setiap Message dengan Siblings

**Context:** Posisi navigator di UI. Vortex options:
- Header conversation (terpusat)
- Tiap message punya navigator
- Hanya di message yang punya siblings

**Decision:** Inline pada setiap message dalam active path yang `sibling_count > 1`. Posisi: di **atas** message bubble, sebelum content. Format: `← N/total →` dengan label kontekstual ("Edit" jika user message, "Response" jika assistant).

**Konsekuensi:**
- Multiple navigators bisa muncul di satu conversation (kalau ada beberapa branch points)
- Tidak butuh logic "deteksi branch point" terpisah — dataset dari API sudah menyertakan `sibling_count` per message

---

### ADR-066 — Branch Switch Diblokir Saat Conversation Running

**Context:** Saat AI sedang streaming response, user tidak boleh switch branch (akan corrupt state).

**Decision:** Disable navigator + edit + regenerate buttons selama `run_status === 'running'` atau `streaming === true`. Show toast jika user mencoba.

---

## Database Changes

### Alter: `messages`

```sql
ALTER TABLE messages
  ADD COLUMN parent_message_id UUID REFERENCES messages(id) ON DELETE CASCADE,
  ADD COLUMN branch_index INTEGER NOT NULL DEFAULT 0;

CREATE INDEX idx_messages_parent
  ON messages(parent_message_id);

CREATE INDEX idx_messages_conv_parent
  ON messages(conversation_id, parent_message_id);
```

**Field semantics:**

| Field | Nilai | Artinya |
|-------|-------|---------|
| `parent_message_id` | NULL | Root message dalam conversation (biasanya pesan pertama) |
| `parent_message_id` | UUID | Pointer ke message sebelumnya di branch ini |
| `branch_index` | 0 | Child pertama dari parent (default branch) |
| `branch_index` | N (≥1) | Branch ke-N+1 dari parent yang sama (urutan kreasi) |

`ON DELETE CASCADE` — jika parent dihapus, semua descendants ikut terhapus. Ini protect dari orphaned messages tapi catatan: kita defer fitur delete message sampai plan terpisah.

### Alter: `conversations`

```sql
ALTER TABLE conversations
  ADD COLUMN active_tip_message_id UUID REFERENCES messages(id) ON DELETE SET NULL;

CREATE INDEX idx_conv_active_tip
  ON conversations(active_tip_message_id)
  WHERE active_tip_message_id IS NOT NULL;
```

**Field semantics:**
- NULL = conversation kosong (belum ada pesan)
- Non-NULL = ID leaf di branch yang sedang aktif. Diupdate setiap pesan baru atau saat user navigasi.

### Migration File

`apps/studio/db/src/migrations/0018_branch_chat.sql`

```sql
-- 0018_branch_chat.sql
-- Plan 23: Message-level branching

BEGIN;

-- 1. Schema additions
ALTER TABLE messages
  ADD COLUMN parent_message_id UUID REFERENCES messages(id) ON DELETE CASCADE,
  ADD COLUMN branch_index INTEGER NOT NULL DEFAULT 0;

ALTER TABLE conversations
  ADD COLUMN active_tip_message_id UUID REFERENCES messages(id) ON DELETE SET NULL;

-- 2. Backfill parent_message_id for existing messages
-- Treat existing messages as a single linear branch: each message's parent
-- is the previous message (by created_at) in the same conversation.
WITH ordered_msgs AS (
  SELECT
    id,
    conversation_id,
    LAG(id) OVER (PARTITION BY conversation_id ORDER BY created_at ASC, id ASC) AS prev_id
  FROM messages
)
UPDATE messages m
SET parent_message_id = ordered_msgs.prev_id
FROM ordered_msgs
WHERE m.id = ordered_msgs.id
  AND ordered_msgs.prev_id IS NOT NULL;

-- 3. Backfill active_tip_message_id to the last message in each conversation
UPDATE conversations c
SET active_tip_message_id = (
  SELECT id FROM messages
  WHERE conversation_id = c.id
  ORDER BY created_at DESC, id DESC
  LIMIT 1
);

-- 4. Indexes (after backfill so they're built efficiently)
CREATE INDEX idx_messages_parent ON messages(parent_message_id);
CREATE INDEX idx_messages_conv_parent ON messages(conversation_id, parent_message_id);
CREATE INDEX idx_conv_active_tip ON conversations(active_tip_message_id)
  WHERE active_tip_message_id IS NOT NULL;

COMMIT;
```

**Validation post-migration:**
```sql
-- Sanity check: every message except the first in each conversation should have a parent
SELECT conversation_id, COUNT(*) AS orphan_count
FROM messages
WHERE parent_message_id IS NULL
GROUP BY conversation_id
HAVING COUNT(*) > 1;
-- Expected: 0 rows (each conversation should have at most 1 root)

-- Sanity check: every non-empty conversation should have active_tip set
SELECT COUNT(*)
FROM conversations c
WHERE active_tip_message_id IS NULL
  AND EXISTS (SELECT 1 FROM messages WHERE conversation_id = c.id);
-- Expected: 0
```

---

## Drizzle Schema Changes

### `apps/studio/db/src/schema/conversations.ts`

```typescript
export const messages = pgTable('messages', {
  id:                 uuid('id').primaryKey().defaultRandom(),
  conversation_id:    uuid('conversation_id').notNull().references(() => conversations.id, { onDelete: 'cascade' }),
  role:               varchar('role', { length: 20 }).notNull(),
  parts:              jsonb('parts').notNull(),
  // ── Plan 23 additions ─────────────────────────────────────────────────────
  parent_message_id:  uuid('parent_message_id').references((): AnyPgColumn => messages.id, { onDelete: 'cascade' }),
  branch_index:       integer('branch_index').notNull().default(0),
  // ──────────────────────────────────────────────────────────────────────────
  created_at:         timestamp('created_at').notNull().defaultNow(),
}, t => [
  index('idx_messages_conversation').on(t.conversation_id, t.created_at),
  index('idx_messages_parent').on(t.parent_message_id),
  index('idx_messages_conv_parent').on(t.conversation_id, t.parent_message_id),
])

export const conversations = pgTable('conversations', {
  // ... existing fields ...
  active_tip_message_id: uuid('active_tip_message_id').references((): AnyPgColumn => messages.id, { onDelete: 'set null' }),
})
```

`AnyPgColumn` digunakan untuk circular reference (messages → messages, dan conversations → messages dimana messages → conversations).

---

## Type System Changes (`@jiku/types`)

Tambah ke shape message yang dikirim ke frontend:

```typescript
// Existing UIMessage tetap dipakai untuk render
// Tambahan: branch metadata di-attach via separate query

export interface MessageWithBranchMeta {
  id: string
  role: string
  parts: unknown[]
  created_at: string
  parent_message_id: string | null
  branch_index: number
  // ── Branch navigator data ────────────────────────────────────────────────
  sibling_count: number       // 1 = no branching at this position
  sibling_ids: string[]       // ordered by branch_index, includes self
  current_sibling_index: number  // 0-based index of `id` in sibling_ids
}

export interface ActivePathResponse {
  conversation_id: string
  active_tip_message_id: string | null
  messages: MessageWithBranchMeta[]
}
```

---

## Server Changes

### `packages/core/src/storage` (atau equivalent storage interface)

Refactor message loading:

```typescript
// OLD:
async getMessages(conversation_id: string): Promise<Message[]>
  // SELECT * FROM messages WHERE conversation_id = ? ORDER BY created_at ASC

// NEW:
async getActivePathMessages(conversation_id: string): Promise<MessageWithBranchMeta[]>
  // Recursive CTE from active_tip_message_id

async getMessagesByPath(tip_message_id: string): Promise<Message[]>
  // Walk parent_message_id from tip backwards, return ordered ASC

async addMessageWithParent(data: {
  conversation_id: string
  parent_message_id: string | null
  role: string
  parts: unknown[]
}): Promise<Message>
  // Insert with branch_index = max(siblings) + 1
  // Update conversation.active_tip_message_id atomically
```

### `apps/studio/db/src/queries/conversation.ts`

Tambah:

```typescript
export async function getActivePath(conversationId: string): Promise<MessageWithBranchMeta[]>
export async function getLatestLeafInSubtree(rootMessageId: string): Promise<string | null>
export async function setActiveTip(conversationId: string, tipMessageId: string): Promise<void>
export async function addBranchedMessage(input: {
  conversation_id: string
  parent_message_id: string | null
  role: string
  parts: unknown[]
}): Promise<Message>
  // 1. Compute branch_index = (max(branch_index) + 1) for siblings, or 0 if no siblings
  // 2. INSERT message
  // 3. UPDATE conversations.active_tip_message_id = new_message.id
  // All in single transaction
```

### Runner Changes (`packages/core/src/runner.ts`)

**Current:** Load `getMessages(conversation_id)` → linear by created_at.

**New:** Load `getActivePathMessages(conversation_id)` → traverse from active tip.

```typescript
// Before model call
const conv = await this.storage.getConversation(conversation_id)
const history = conv.active_tip_message_id
  ? await this.storage.getMessagesByPath(conv.active_tip_message_id)
  : []

// After saving user message:
const userMsg = await this.storage.addMessageWithParent({
  conversation_id,
  parent_message_id: conv.active_tip_message_id,  // new user msg parent = current tip
  role: 'user',
  parts: userParts,
})
// addMessageWithParent atomically updates active_tip_message_id

// After model response:
const assistantMsg = await this.storage.addMessageWithParent({
  conversation_id,
  parent_message_id: userMsg.id,
  role: 'assistant',
  parts: assistantParts,
})
```

**Penting:** Untuk edit/regenerate, `parent_message_id` di-override dari frontend request. Lihat chat route changes berikut.

### Chat Route (`apps/studio/server/src/routes/chat.ts`)

**Tambah parameter `parent_message_id` di body POST chat:**

```typescript
// POST /conversations/:id/chat
{
  id: string
  messages: UIMessage[]    // last user message
  parent_message_id?: string  // ← NEW: override parent for branching
}
```

**Logic:**
```typescript
const parentId = body.parent_message_id ?? conv.active_tip_message_id
// Validate parent belongs to this conversation
if (parentId) {
  const parent = await getMessageById(parentId)
  if (!parent || parent.conversation_id !== convId) {
    return res.status(400).json({ error: 'Invalid parent_message_id' })
  }
}

// Pass parentId to runner — runner uses it as parent for new user message
await runtimeManager.run({
  conversation_id: convId,
  parent_message_id: parentId,  // ← passed through
  user_input: ...,
})
```

### Endpoint Baru: Regenerate

```typescript
// POST /conversations/:id/regenerate
// Body: { user_message_id: string }
//
// Re-run model dengan user message sebagai input, buat assistant message baru
// dengan parent = user_message_id (jadi sibling dari assistant response sebelumnya).

router.post('/conversations/:id/regenerate', async (req, res) => {
  const { user_message_id } = req.body
  const convId = req.params.id

  // 1. Validate user_message_id exists in this conversation and role === 'user'
  // 2. Set active_tip = user_message_id (so runner uses path ending here)
  // 3. Trigger runner with no new user input — runner just calls model with current path
  //    Runner detects: active_tip is a user message → don't add user msg, just generate assistant
  // 4. New assistant message has parent_message_id = user_message_id, branch_index = max+1
  // 5. New assistant becomes new active tip
})
```

Alternatif lebih clean: extend chat endpoint dengan flag `regenerate: true` instead of separate endpoint. Decided: separate endpoint untuk clarity.

### Endpoint Baru: Switch Active Branch

```typescript
// PATCH /conversations/:id/active-tip
// Body: { tip_message_id: string }
//
// Direct switch — frontend tahu tip mana yang dipilih (computed via "latest leaf in subtree")

router.patch('/conversations/:id/active-tip', async (req, res) => {
  const { tip_message_id } = req.body
  // Validate tip belongs to conversation
  // Update conversations.active_tip_message_id
  // Return new active path
})
```

### Endpoint Baru: Resolve Sibling Tip

Untuk client yang mau pindah ke sibling tapi belum tahu leaf-nya:

```typescript
// GET /conversations/:id/sibling-tip?sibling_id=<msg_id>
// Returns the latest leaf in the subtree rooted at sibling_id
// Used by branch navigator to compute the next active tip

router.get('/conversations/:id/sibling-tip', async (req, res) => {
  const siblingId = req.query.sibling_id
  const tip = await getLatestLeafInSubtree(siblingId)
  res.json({ tip_message_id: tip })
})
```

### Endpoint Refactor: Get Messages

```typescript
// GET /conversations/:id/messages
// Sebelum: return semua messages flat
// Sesudah: return active path + branch metadata

router.get('/conversations/:id/messages', async (req, res) => {
  const conv = await getConversationById(req.params.id)
  const messages = await getActivePath(conv.id)  // recursive CTE
  res.json({
    conversation_id: conv.id,
    active_tip_message_id: conv.active_tip_message_id,
    messages,
  })
})
```

---

## Frontend Changes

### API Client (`web/lib/api.ts`)

```typescript
conversations: {
  // ... existing ...

  // Updated: return type now includes branch metadata
  messages: (convId: string) => request<{
    conversation_id: string
    active_tip_message_id: string | null
    messages: MessageWithBranchMeta[]
  }>(`/api/conversations/${convId}/messages`),

  // New: regenerate
  regenerate: (convId: string, userMessageId: string) =>
    request<{ ok: boolean }>(`/api/conversations/${convId}/regenerate`, {
      method: 'POST',
      body: JSON.stringify({ user_message_id: userMessageId }),
    }),

  // New: switch branch
  setActiveTip: (convId: string, tipMessageId: string) =>
    request<{ ok: boolean; messages: MessageWithBranchMeta[] }>(
      `/api/conversations/${convId}/active-tip`,
      { method: 'PATCH', body: JSON.stringify({ tip_message_id: tipMessageId }) },
    ),

  // New: compute sibling tip
  resolveSiblingTip: (convId: string, siblingId: string) =>
    request<{ tip_message_id: string }>(
      `/api/conversations/${convId}/sibling-tip?sibling_id=${siblingId}`,
    ),
}
```

### `ConversationViewer` Updates

**State tambahan:**
```typescript
const [activeTip, setActiveTip] = useState<string | null>(initialActiveTip)
const [branchMeta, setBranchMeta] = useState<Map<string, MessageWithBranchMeta>>(...)
```

**`prepareSendMessagesRequest` update:**
```typescript
prepareSendMessagesRequest: ({ id, messages }) => {
  const lastUser = [...messages].reverse().find(m => m.role === 'user')
  return {
    body: {
      id,
      messages: lastUser ? [lastUser] : [],
      parent_message_id: activeTip,  // ← NEW
    },
  }
}
```

**Branch switch handler:**
```typescript
async function switchBranch(siblingId: string) {
  // 1. Resolve tip in sibling subtree
  const { tip_message_id } = await api.conversations.resolveSiblingTip(convId, siblingId)
  // 2. Update server-side active tip
  const { messages: newMessages } = await api.conversations.setActiveTip(convId, tip_message_id)
  // 3. Refresh local state
  setActiveTip(tip_message_id)
  setMessages(toUIMessages(newMessages))
  setBranchMeta(buildBranchMetaMap(newMessages))
}
```

**Edit handler:**
```typescript
async function submitEdit(messageId: string, newText: string) {
  const editedMsg = branchMeta.get(messageId)
  if (!editedMsg) return
  // Send new user message with parent = parent of edited message
  // (Server creates new user msg as sibling, runs model)
  // Manually call sendMessage with overridden parent
  await fetch(`/api/conversations/${convId}/chat`, {
    method: 'POST',
    body: JSON.stringify({
      id: convId,
      messages: [{ role: 'user', parts: [{ type: 'text', text: newText }] }],
      parent_message_id: editedMsg.parent_message_id,
    }),
  })
  // After response, refresh active path
}
```

**Regenerate handler:**
```typescript
async function regenerate(assistantMessageId: string) {
  const assistantMsg = branchMeta.get(assistantMessageId)
  if (!assistantMsg?.parent_message_id) return
  await api.conversations.regenerate(convId, assistantMsg.parent_message_id)
  // Stream observer akan refresh messages saat selesai
}
```

---

## UI Components

### `BranchNavigator` (baru)

`apps/studio/web/components/chat/branch-navigator.tsx`

```tsx
interface BranchNavigatorProps {
  currentIndex: number     // 1-based untuk display
  total: number
  onPrev: () => void
  onNext: () => void
  disabled?: boolean
  label?: string           // "Edit" | "Response" | undefined
}

export function BranchNavigator({ currentIndex, total, onPrev, onNext, disabled, label }: BranchNavigatorProps) {
  if (total <= 1) return null
  return (
    <div className="flex items-center gap-1.5 text-xs text-muted-foreground py-1">
      <button onClick={onPrev} disabled={disabled || currentIndex <= 1} className="p-0.5 hover:text-foreground disabled:opacity-30">
        <ChevronLeft className="w-3.5 h-3.5" />
      </button>
      <span className="tabular-nums">{currentIndex} / {total}</span>
      <button onClick={onNext} disabled={disabled || currentIndex >= total} className="p-0.5 hover:text-foreground disabled:opacity-30">
        <ChevronRight className="w-3.5 h-3.5" />
      </button>
      {label && <span className="text-[10px] uppercase tracking-wide opacity-60">{label}</span>}
    </div>
  )
}
```

### `MessageEditInput` (baru)

`apps/studio/web/components/chat/message-edit-input.tsx`

Inline textarea yang muncul saat user klik Pencil. Submit → call `submitEdit` → branch baru. Cancel → tutup tanpa kirim.

### Update `ConversationViewer` Render

```tsx
{messages.map((msg, idx) => {
  const meta = branchMeta.get(msg.id)
  const showNavigator = meta && meta.sibling_count > 1
  const isEditing = editingId === msg.id

  return (
    <div key={msg.id}>
      {showNavigator && (
        <BranchNavigator
          currentIndex={meta.current_sibling_index + 1}
          total={meta.sibling_count}
          onPrev={() => switchBranch(meta.sibling_ids[meta.current_sibling_index - 1])}
          onNext={() => switchBranch(meta.sibling_ids[meta.current_sibling_index + 1])}
          disabled={isStreaming}
          label={msg.role === 'user' ? 'Edit' : 'Response'}
        />
      )}
      <Message from={msg.role}>
        <MessageContent>
          {isEditing ? (
            <MessageEditInput
              initialText={getMessageText(msg)}
              onSubmit={(text) => { submitEdit(msg.id, text); setEditingId(null) }}
              onCancel={() => setEditingId(null)}
            />
          ) : (
            <MessageParts msg={msg} />
          )}
        </MessageContent>
        {/* Action bar */}
        {!isStreaming && (
          <div className="flex items-center gap-1 mt-1">
            <CopyButton text={getMessageText(msg)} />
            {msg.role === 'user' && (
              <button onClick={() => setEditingId(msg.id)} title="Edit">
                <Pencil className="w-3.5 h-3.5" />
              </button>
            )}
            {msg.role === 'assistant' && (
              <button onClick={() => regenerate(msg.id)} title="Regenerate">
                <RefreshCw className="w-3.5 h-3.5" />
              </button>
            )}
          </div>
        )}
      </Message>
    </div>
  )
})}
```

---

## Edge Cases

### 1. Root Message Branching (Edit Pesan Pertama)

**Case:** User edit pesan pertama (`parent_message_id = NULL`).

**Behavior:**
- Buat user message baru dengan `parent_message_id = NULL`
- Sekarang ada 2 root messages dengan parent NULL → mereka jadi siblings
- Navigator muncul di pesan paling atas dengan `2 / 2`
- Query siblings pakai `parent_message_id IS NOT DISTINCT FROM NULL` (handle NULL comparison)

### 2. Concurrent Branch Switch / Send

**Case:** User di tab A switch branch, sementara tab B kirim message.

**Behavior:**
- Tab B kirim dengan `parent_message_id = active_tip_lama_di_tab_B`
- Server validate parent ada di conversation → OK
- Server append message dengan parent itu, update `active_tip_message_id`
- Tab A reload nanti akan dapat tip baru — branch yang Tab A lihat mungkin berubah
- Acceptable; SSE notification bisa update Tab A jika kita mau

### 3. Streaming Saat User Trigger Branch

**Case:** AI sedang stream response, user klik regenerate / edit / branch switch.

**Behavior:**
- UI disable semua action button selama `isStreaming`
- Server reject request 503 jika conversation `run_status === 'running'`
- User dipaksa menunggu

### 4. Regenerate dari Assistant yang Bukan Tip

**Case:** Active path: msg1 → msg2 → msg3 → msg4 (assistant, tip). User regenerate msg2 (assistant, di tengah).

**Behavior:**
- Buat assistant message baru dengan `parent_message_id = parent(msg2) = msg1`
- Branch baru = msg1 → newAssistant
- Active tip pindah ke newAssistant
- msg3 dan msg4 masih ada di tree tapi tidak di active path lagi
- User bisa kembali via navigator

### 5. Compaction & Branching

**Case:** Compaction biasanya replace messages dengan summary message. Tapi sekarang messages punya parent links.

**Behavior:**
- Compaction operate hanya pada **active path**
- Buat summary message sebagai child dari last message yang dipertahankan, atau ganti chain dengan summary node
- Detail implementation defer — initial release **disable compaction** kalau conversation punya branching (ada message dengan sibling_count > 1 di mana saja)

### 6. Delete Conversation

**Behavior:**
- Existing `soft delete` via `deleted_at` tetap berfungsi
- `ON DELETE CASCADE` di messages.conversation_id memastikan pesan ikut terhapus saat hard delete
- Tidak ada perubahan

### 7. Frontend Optimistic Update

**Case:** User kirim message → frontend optimistically tampilkan tanpa tunggu server → message muncul tanpa branch metadata yang valid.

**Behavior:**
- AI SDK `useChat()` handle optimistic message
- Setelah server respond, refresh active path → message id valid + branch metadata di-fetch
- Branch navigator tidak ditampilkan untuk optimistic message (tunggu confirmed)

### 8. Migration Failure Mid-Flight

**Backfill safety:**
- Migration dalam transaksi BEGIN/COMMIT — kalau gagal di tengah, rollback
- Validation queries setelah migration untuk memastikan tidak ada orphan
- Rollback plan: drop columns, drop indexes (tersedia di migration `down` script)

---

## Implementation Phases

### Phase A — Schema Migration & Backfill (Foundation)
- [ ] Tulis `0018_branch_chat.sql` dengan migration + backfill + indexes
- [ ] Update Drizzle schema `conversations.ts` (tambah `parent_message_id`, `branch_index`, `active_tip_message_id`)
- [ ] Run migration di environment dev → validasi sanity check queries
- [ ] Dokumentasi rollback path

### Phase B — Server: Active Path Loading
- [ ] Implementasi `getActivePath()` query function (recursive CTE)
- [ ] Implementasi `getMessagesByPath()` (untuk runner)
- [ ] Implementasi `getLatestLeafInSubtree()`
- [ ] Implementasi `addBranchedMessage()` (insert + update tip atomik)
- [ ] Implementasi `setActiveTip()`
- [ ] Unit test untuk semua query (terutama edge cases: NULL parent, single message, deep tree)

### Phase C — Server: Runner & Routes Refactor
- [ ] Update runner (`runner.ts`) untuk pakai `getMessagesByPath` instead of linear `getMessages`
- [ ] Update runner untuk pakai `addBranchedMessage` saat persist user/assistant message
- [ ] Update `POST /conversations/:id/chat` untuk terima `parent_message_id` di body
- [ ] Update `GET /conversations/:id/messages` untuk return active path + branch meta
- [ ] Tambah endpoint `POST /conversations/:id/regenerate`
- [ ] Tambah endpoint `PATCH /conversations/:id/active-tip`
- [ ] Tambah endpoint `GET /conversations/:id/sibling-tip`
- [ ] Integration test: kirim → edit → regenerate flow lengkap

### Phase D — Frontend: API Client & State
- [ ] Update `api.conversations.messages` return type
- [ ] Tambah `api.conversations.regenerate`, `setActiveTip`, `resolveSiblingTip`
- [ ] Update `ConversationViewer` untuk track `activeTip` + `branchMeta`
- [ ] Update `prepareSendMessagesRequest` untuk kirim `parent_message_id`
- [ ] Helper `toUIMessages()` dan `buildBranchMetaMap()`

### Phase E — UI: Branch Navigator
- [ ] Buat `BranchNavigator` component
- [ ] Render di message list — di atas message yang `sibling_count > 1`
- [ ] Implement `switchBranch()` handler
- [ ] Loading state saat navigation
- [ ] Disable saat streaming

### Phase F — UI: Edit Message
- [ ] Buat `MessageEditInput` component (inline textarea)
- [ ] Wire Pencil button di user message
- [ ] Submit edit → call chat endpoint dengan parent = parent of edited
- [ ] Cancel handling, escape key, dirty state

### Phase G — UI: Regenerate
- [ ] Tambah RefreshCw button di assistant message action bar
- [ ] Wire ke `regenerate()` handler
- [ ] Disable saat streaming
- [ ] Loading indicator

### Phase H — Polish & Edge Cases
- [ ] Disable compaction untuk branched conversations (initial)
- [ ] Visual hint: subtle highlight untuk message di non-default branch
- [ ] Conversation list sidebar: indicator "(branched)" jika ada branching
- [ ] Error toasts untuk semua error paths
- [ ] Keyboard shortcut: arrow keys di navigator (optional)

### Phase I — QA & Testing
- [ ] Manual test semua scenarios
- [ ] E2E test untuk edit flow
- [ ] E2E test untuk regenerate flow
- [ ] E2E test untuk multi-branch navigation
- [ ] Performance test: conversation dengan banyak branches (10+ branch points)

---

## Testing Scenarios

### Scenario 1: Linear Conversation (No Branch)
- New conversation, kirim 5 pesan bolak-balik
- Verify: setiap message punya `parent_message_id` ke message sebelumnya, `branch_index = 0`
- Verify: `active_tip_message_id` = last assistant message
- Navigator: tidak muncul di mana-mana

### Scenario 2: Edit User Message di Tengah
- Conversation 6 pesan: U1 → A1 → U2 → A2 → U3 → A3
- Active tip = A3
- User edit U2 → submit "edited text"
- Server: buat U2' dengan parent = A1, branch_index = 1
- Server: jalan model → buat A2' dengan parent = U2'
- Active tip = A2' (baru)
- Frontend: re-fetch active path → U1 → A1 → U2' → A2'
- Navigator muncul di U2' position: `2 / 2`
- User klik ← → kembali ke U2 → tip update → path lama muncul

### Scenario 3: Regenerate Response
- Conversation: U1 → A1 (active tip)
- User klik Regenerate di A1
- Server: buat A1' dengan parent = U1, branch_index = 1
- Active tip = A1'
- Frontend: navigator muncul di A1' position: `2 / 2`
- User toggle ← → bandingkan A1 dan A1'

### Scenario 4: Multiple Regenerates
- U1 → A1, regenerate 3x → siblings A1, A1', A1'', A1'''
- Navigator: `4 / 4`
- Setiap toggle update tip dan re-fetch path

### Scenario 5: Edit Root Message (Pesan Pertama)
- Conversation: U1 → A1
- User edit U1 → "new first message"
- Server: buat U1' dengan parent = NULL, branch_index = 1
- Server: jalan model → A1' dengan parent = U1'
- Sekarang ada 2 root messages (U1 dan U1') → siblings
- Navigator muncul di paling atas: `2 / 2`

### Scenario 6: Nested Branching
- U1 → A1 → U2 → A2 (linear)
- Edit U2 → branch: U2' → A2'
- Sekarang di branch baru, edit lagi: parent = A1, jadi U2'' branch ke-3
- Navigator di U2/U2'/U2'' position: `3 / 3`
- Active tip = leaf dari branch terbaru
- Switch antar 3 branches via navigator

### Scenario 7: Branch Switch Selama Streaming
- User kirim message → AI streaming response
- User klik branch navigator → diabaikan / show toast "wait for response"
- Setelah selesai → enable kembali

### Scenario 8: Backfill Migration
- Database existing dengan 100+ conversations dengan messages linear
- Run migration
- Verify: setiap message punya `parent_message_id` ke message sebelumnya kecuali yang pertama
- Verify: setiap conversation punya `active_tip_message_id` valid
- Open conversation lama di UI → tampil seperti biasa, navigator tidak muncul (karena belum ada branching)
- Edit message lama → branch terbentuk seperti yang baru

### Scenario 9: Latest Leaf Strategy
- Tree:
  ```
  U1 → A1 → U2a → A2a → U3a → A3a (deep)
            → U2b → A2b
  ```
- Active tip awalnya A3a
- User di posisi A1 klik → navigate ke U2b → tip pindah ke A2b
- User klik ← kembali → tip jadi A3a (latest leaf di subtree U2a, follow max branch_index)

### Scenario 10: Concurrent Multi-Tab
- Tab A dan Tab B buka conversation yang sama
- Tab B kirim message → server update tip
- Tab A still pegang tip lama → kalau Tab A kirim message dengan tip lama, validation OK, tapi tip baru Tab A overwrite Tab B
- Acceptable race; bisa di-improve dengan SSE notification (defer)

---

## Risks & Open Questions

### Risk 1: Performance Recursive CTE
- Conversation panjang (100+ messages) bisa slow di recursive CTE
- Mitigation: index `(conversation_id, parent_message_id)`, depth limit (cap at 1000?)
- Monitor query performance setelah migration

### Risk 2: Data Loss Saat Migration
- Backfill update massive → risk
- Mitigation: BEGIN/COMMIT transaction, dry-run di staging, validation queries

### Risk 3: Compaction Compatibility
- Compaction belum compatible dengan branching → disable awalnya
- Open question: bagaimana proper design compaction untuk branched conversations?

### Risk 4: SSE Stream Routing
- Stream tied ke conversation_id, bukan branch — kalau user switch branch saat streaming, observer dapat data dari branch yang salah
- Mitigation: disable branch switch saat running

### Risk 5: AI SDK `useChat()` Compatibility
- `useChat()` assume linear messages — kita override dengan `setMessages()` setiap branch switch
- Kalau AI SDK update bawa breaking change, perlu re-adapt
- Mitigation: pin version, write integration test

### Open Question 1: Multiple Active Tips per User
- Apakah `active_tip_message_id` perlu per-user (jika multi-user di satu conversation)?
- Saat ini: 1 per conversation (global). Cukup untuk single-user case.
- Defer multi-user case sampai dibutuhkan.

### Open Question 2: Branch Naming/Labeling
- User mungkin mau label branch ("v1 prompt", "v2 lebih sopan")
- Defer ke plan terpisah.

---

## Summary Diagram

```
┌─────────────────────────────────────────────────────────────────┐
│ conversations                                                    │
│   id, agent_id, ..., active_tip_message_id ─┐                   │
└─────────────────────────────────────────────┼───────────────────┘
                                              │
                                              ▼
┌─────────────────────────────────────────────────────────────────┐
│ messages                                                         │
│   id, conversation_id, role, parts, created_at,                 │
│   parent_message_id ──┐ (self-ref)                              │
│   branch_index        │                                          │
└───────────────────────┘                                          │
            ▲                                                      │
            └──────────────────────────────────────────────────────┘

Tree structure example:
  msg1 (parent=null, idx=0)
  └── msg2 (parent=msg1, idx=0)
      ├── msg3a (parent=msg2, idx=0) ← active path
      │   └── msg4a (parent=msg3a, idx=0) ← active_tip
      └── msg3b (parent=msg2, idx=1) ← alt branch
          └── msg4b (parent=msg3b, idx=0)

Active path query (from active_tip msg4a):
  msg4a → msg3a → msg2 → msg1 → reverse → linear history

Branch detection:
  msg3a has sibling_count=2 (msg3a, msg3b share parent msg2)
  → render BranchNavigator above msg3a
```
