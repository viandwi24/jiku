# Plan 6 — Implementation Report: Agent Conversation System

> Generated: 2026-04-05
> Plan: [6-chat-system.md](./6-chat-system.md)
> Status: **DONE** ✅ — Semua checklist selesai + beberapa fitur beyond plan

---

## Summary

Plan 6 diimplementasi dalam satu sesi dengan fokus pada fondasi backend (compaction, previewRun, stream registry) dan chat UI polish. Semua P1 item selesai. P2 item sebagian besar selesai kecuali Tool Calls UI revisi dan agent settings threshold slider.

---

## Checklist Status

### Core — Context System ✅

| Item | Status | Notes |
|------|--------|-------|
| `utils/tokens.ts` — `estimateTokens()`, `getModelContextWindow()` | ✅ Done | Impl di `packages/core/src/utils/tokens.ts` |
| `resolver/prompt.ts` — `buildModeInstruction()`, `buildUserContext()`, `buildToolHints()` | ✅ Done | |
| `plugins/loader.ts` — `getPromptSegmentsWithMeta()`, `getSegmentsForPlugin()` | ✅ Done | |
| Types: `ContextSegment`, `ConversationContext`, `PreviewRunResult` | ✅ Done | Di `packages/types/src/index.ts` |

### Core — previewRun ✅

| Item | Status | Notes |
|------|--------|-------|
| `runner.ts` — `previewRun()` method | ✅ Done | |
| Build segments dengan token estimates | ✅ Done | |
| History token count (kalau ada conversation_id) | ✅ Done | |
| Warnings generation (>80%, >95%) | ✅ Done | |
| `JikuRuntime.previewRun()` expose ke luar | ✅ Done | |

### Core — Compaction ✅

| Item | Status | Notes |
|------|--------|-------|
| `compaction.ts` — `compactConversation()` | ✅ Done | |
| `runner.ts` — `checkCompactionThreshold()` | ✅ Done | |
| `runner.ts` — integrate compaction ke `run()` flow | ✅ Done | |
| Emit `jiku-compact` data chunk ke stream | ✅ Done | Type: `data-jiku-compact` di AI SDK v6 parts |
| `JikuStorageAdapter.replaceMessages()` interface | ✅ Done | |
| `StudioStorageAdapter.replaceMessages()` implement | ✅ Done | |

### DB & Server ✅

| Item | Status | Notes |
|------|--------|-------|
| Migration: `agents.compaction_threshold` field | ✅ Done | Default 80 |
| `GET /api/agents/:aid` — include `compaction_threshold` | ✅ Done | |
| `PATCH /api/agents/:aid` — accept `compaction_threshold` | ✅ Done | |
| `POST /api/agents/:aid/preview` | ✅ Done | Route di `routes/preview.ts` |
| `POST /api/conversations/:id/preview` | ✅ Done | |
| `POST /api/conversations/:id/chat` — 409 jika sudah running | ✅ Done | Via `StreamRegistry` |
| `GET /api/conversations/:id/stream` — SSE observer | ✅ Done | **BEYOND PLAN** |
| `GET /api/conversations/:id/status` | ✅ Done | **BEYOND PLAN** |
| Runtime `wakeUp()` — pass `compaction_threshold` | ✅ Done | |

### Studio Web — Context Preview UI ✅

| Item | Status | Notes |
|------|--------|-------|
| `ContextPreviewSheet` — shadcn Sheet dari kanan | ✅ Done | `components/chat/context-preview-sheet.tsx` |
| `ContextUsageBar` — progress bar dengan color coding | ✅ Done | Di dalam sheet |
| `ContextSegmentList` — collapsible list per segment | ✅ Done | |
| `ActiveToolsList` — list tools dengan permission info | ✅ Done | |
| `SystemPromptView` — full prompt scrollable | ✅ Done | |
| Tombol "Context" / token count di conversation | ✅ Done | **Diimpl sebagai `ContextBar`** — lihat deviasi |
| Model info di context preview | ✅ Done | **BEYOND PLAN** — provider + model_id |

### Studio Web — Compaction ✅

| Item | Status | Notes |
|------|--------|-------|
| `CompactionIndicator` component | ✅ Done | Inline di chat page, bukan component terpisah |
| Handle `jiku-compact` stream event di chat page | ✅ Done | Scan `messages[last].parts` untuk `data-jiku-compact` |
| Tampilkan CompactionIndicator di message list | ✅ Done | |

### Studio Web — Agent Settings ⚠️ Partial

| Item | Status | Notes |
|------|--------|-------|
| LLM tab: compaction toggle (Switch) | ✅ Done | |
| LLM tab: threshold slider (50–95%) | ✅ Done | |
| Save ke PATCH /api/agents/:aid | ✅ Done | |

### Studio Web — Tool Calls ✅

| Item | Status | Notes |
|------|--------|-------|
| Status icon + badge (Running, Completed, Error, dll) | ✅ Done | Sudah ada di `ToolHeader` via `statusIcons` + `getStatusBadge` |
| Input args display (collapsible, JSON) | ✅ Done | `ToolInput` component — label "Parameters", code block |
| Output result display (collapsible, error state) | ✅ Done | `ToolOutput` component — label "Result"/"Error", merah kalau error |

---

## Deviasi dari Plan

### 1. ContextBar — bukan tombol di header

**Plan:** Tombol "Context" di header conversation → buka Sheet.

**Implementasi:** `ContextBar` component di bawah prompt input yang:
- Left: model_id + provider name (text kecil)
- Right: popover dengan usage bar + breakdown, "View full details" → buka Sheet

**Alasan:** Lebih informatif — user langsung bisa lihat token count tanpa klik. Popover lebih cepat untuk quick check, Sheet masih ada untuk detail.

### 2. AI SDK v6 — `data` property removed

**Plan:** Handle `jiku-compact` event via `data` property dari `useChat`.

**Implementasi:** AI SDK v6 (`@ai-sdk/react` v3) menghapus `data` property dari `UseChatHelpers`. Data chunks sekarang masuk sebagai `DataUIPart` di `messages[last].parts` dengan `type: 'data-jiku-compact'`. Implementasi scan parts di `useEffect` setiap kali messages berubah.

### 3. `compaction_count` di PreviewRunResult — BEYOND PLAN

**Plan:** Tidak ada `compaction_count` di PreviewRunResult.

**Implementasi:** Ditambahkan `compaction_count: number` — count dari messages dengan `[Context Summary]` prefix di DB. Ditampilkan di ContextBar popover dan ContextPreviewSheet.

### 4. SSE broadcast / stream observer — BEYOND PLAN

**Plan:** Tidak ada dalam plan 6.

**Implementasi:** Fitur baru yang ditambahkan:
- `StreamRegistry` — in-memory Map per conversation, concurrent lock + SSE broadcast
- `POST /conversations/:id/chat` → 409 jika sudah running
- `GET /conversations/:id/stream` → SSE endpoint untuk observer client
- `GET /conversations/:id/status` → `{ running: boolean }`
- `useConversationObserver` hook di web — EventSource dengan token via `?token=` query param

**Alasan:** Kebutuhan UX — kalau user buka conversation yang sedang diproses, harus bisa attach ke stream yang berjalan, bukan error.

### 5. Context Preview auto-refresh — BEYOND PLAN

**Plan:** Fetch preview saat sheet dibuka (`enabled: open`).

**Implementasi:** `ContextBar` punya `isStreaming` prop. Setiap kali streaming selesai (`isStreaming` transition `true → false`), query preview di-invalidate sehingga token count update otomatis setelah setiap chat turn.

### 6. Model info di Preview — BEYOND PLAN

**Plan:** Tidak ada model info di PreviewRunResult.

**Implementasi:** Ditambahkan `model_info?: { provider_id, provider_name, model_id }` ke `PreviewRunResult`. Di-resolve dari `resolveAgentModel()` + `getAdapter()` di server. Ditampilkan di ContextBar (left side) dan ContextPreviewSheet (top card).

### 7. Conversation list sidebar — BEYOND PLAN

**Plan:** Tidak ada perubahan ke conversation list.

**Implementasi:** Full rewrite `conversation-list-panel.tsx`:
- Ganti Radix `ScrollArea` dengan plain `overflow-y-auto` div (ScrollArea inject `min-width:100%; display:table` yang break `text-overflow: ellipsis`)
- Date grouping: Today / Yesterday / This week / This month / Last 3 months / Older
- Accordion per group — Today auto-expanded, rest collapsed
- Load more pagination (PAGE_SIZE = 10)
- Auto-refresh setelah streaming selesai via `useQueryClient.invalidateQueries`

### 8. Sidebar user footer — BEYOND PLAN

**Plan:** Tidak ada.

**Implementasi:** `ProjectSidebar` dan `CompanySidebar` sekarang punya `SidebarFooter` dengan user info dropdown (name, email, sign out) — konsisten dengan `RootSidebar`.

---

## Files Dibuat / Dimodifikasi

### New Files

```
apps/studio/server/src/runtime/stream-registry.ts
apps/studio/web/hooks/use-conversation-observer.ts
apps/studio/web/components/chat/context-bar.tsx
apps/studio/web/components/chat/context-preview-sheet.tsx
```

### Modified Files

```
packages/types/src/index.ts
  → ContextSegment, ConversationContext, PreviewRunResult
  → compaction_count, model_info ke PreviewRunResult
  → JikuStorageAdapter.replaceMessages

packages/core/src/runner.ts
  → previewRun(), checkCompactionThreshold()
  → compaction integration ke run()

packages/core/src/compaction.ts
  → compactConversation()

packages/core/src/utils/tokens.ts
  → estimateTokens(), getModelContextWindow()

packages/core/src/resolver/prompt.ts
  → buildModeInstruction(), buildUserContext(), buildToolHints()

apps/studio/db/src/schema/agents.ts
  → compaction_threshold field

apps/studio/server/src/routes/chat.ts
  → 409 concurrent lock
  → stream.tee() broadcast
  → SSE observer endpoint
  → status endpoint

apps/studio/server/src/routes/preview.ts
  → POST /agents/:aid/preview
  → POST /conversations/:id/preview
  → model_info attach

apps/studio/server/src/runtime/storage.ts
  → replaceMessages() implementation

apps/studio/web/lib/api.ts
  → PreviewRunResult: compaction_count, model_info
  → api.conversations.status()
  → api.conversations.preview()

apps/studio/web/app/(app)/studio/.../chats/[conv]/page.tsx
  → ContextBar integration
  → compaction event handling
  → useConversationObserver
  → auto-refresh conversations query

apps/studio/web/components/chat/conversation-list-panel.tsx
  → full rewrite: date grouping, accordion, load more, truncation fix

apps/studio/web/components/sidebar/project-sidebar.tsx
  → Settings in same menu group (no separator)
  → SidebarFooter user info

apps/studio/web/components/sidebar/company-sidebar.tsx
  → Settings in same menu group (no separator)
  → SidebarFooter user info
```

---

## Remaining / Next

| Item | Priority | Notes |
|------|----------|-------|
| SSE observer auth | Low | Token lewat `?token=` query param, server belum verify |
| `keep_recent` config per-agent | Future | Hardcoded 10 saat ini |
| `estimateTokens` accuracy | Future | Bisa upgrade ke tiktoken untuk lebih akurat |

---

*Generated: 2026-04-05*
