# Plan 15 — OpenClaw-Inspired Agentic Improvements

> Referensi: `docs/sum/openclaw.md`, `docs/sum/jiku.md`

Plan ini berisi fitur-fitur yang diadopsi atau terinspirasi dari OpenClaw untuk memperkuat kemampuan agentic AI Jiku. Setiap fitur sudah disesuaikan dengan arsitektur multi-tenant Jiku.

**Scope:** 9 fitur aktif. 2 fitur ditunda ke phase berikutnya (Thinking Mode, Media Pipeline).

---

## Daftar Fitur

| # | Fitur | Prioritas |
|---|---|---|
| 15.1 | Tool Streaming (Progressive Results) | High |
| 15.2 | Semantic Memory (Qdrant + Hybrid Scoring) | High |
| 15.3 | Conversation Queue Mode | High |
| 15.4 | Enhanced Inter-Agent Calling | High |
| 15.5 | Channel Routing Rules | High |
| 15.6 | MCP Support + Tool On/Off Registry | High |
| 15.7 | ~~Thinking Mode~~ | _Deferred_ |
| 15.8 | Progress Reporting Tool | Medium |
| 15.9 | Structured Persona (Traits & Boundaries) | Medium |
| 15.10 | Auto-Reply System | Medium |
| 15.11 | ~~Media Pipeline~~ | _Deferred_ |

---

## 15.1 — Tool Streaming (Progressive Results)

### Description
Saat ini semua tool execute lalu return satu nilai final. Tool streaming memungkinkan tool mengirim hasil secara progresif — penting untuk long-running tools seperti web scraping, filesystem bulk operations, atau future browser automation.

### Goals
- Tools yang long-running bisa yield progress ke agent selama eksekusi
- Agent bisa mulai reasoning sebelum tool selesai sepenuhnya
- User bisa melihat progres tool real-time di stream

### Yang Sudah Ada
- `ToolDefinition.execute` di `@jiku/types` (line 73): `(args: unknown, ctx: ToolContext) => Promise<unknown>` — synchronous return only
- `AgentRunner.run()` di `runner.ts` (line 420): `execute: async (args) => resolvedTool.execute(args, toolCtx)` — direct await
- Vercel AI SDK v6 sudah support `experimental_toToolResultContent` dan generator-based tools

### Tools yang Akan Menerapkan Streaming
1. **`fs_search`** — search banyak file, bisa yield per file match
2. **`fs_read` (bulk)** — jika membaca banyak file sekaligus
3. **`connector_get_thread`** — saat load banyak messages
4. **`run_task` (attach mode)** — stream progress dari sub-task ke parent agent
5. **Future tools** — browser automation, web scraping, data processing

### Implementation Plan

**Phase A: Extend ToolDefinition Type**

File: `packages/types/src/index.ts`

```typescript
// Tambahkan ke ToolDefinition
export interface ToolDefinition {
  // ... existing fields ...
  execute: (args: unknown, ctx: ToolContext) => Promise<unknown>
  /**
   * Optional streaming execute. When defined, takes precedence over execute.
   * Yields intermediate results, final return is the tool result.
   */
  executeStream?: (args: unknown, ctx: ToolContext) => AsyncGenerator<ToolStreamChunk, unknown>
}

export interface ToolStreamChunk {
  type: 'progress' | 'partial'
  data: unknown
}
```

**Phase B: Update AgentRunner**

File: `packages/core/src/runner.ts`

Di dalam `createUIMessageStream` (line 408-425), ubah tool registration:

```typescript
for (const resolvedTool of modeTools) {
  if (resolvedTool.executeStream) {
    // Streaming tool — use generator
    aiTools[resolvedTool.tool_name] = tool({
      description: resolvedTool.meta.description,
      inputSchema: toInputSchema(resolvedTool.input),
      execute: async function* (args: unknown) {
        const gen = resolvedTool.executeStream!(args, toolCtx)
        let result: unknown
        for await (const chunk of gen) {
          // Emit progress to client via jiku-tool-data
          toolCtx.writer.write('jiku-tool-data', {
            tool_id: resolvedTool.resolved_id,
            data: chunk,
          })
          yield chunk.data // yield ke AI SDK
        }
        // Final result dari generator.return()
        const final = await gen.return(undefined)
        return final.value
      },
    })
  } else {
    // Existing non-streaming path — unchanged
    aiTools[resolvedTool.tool_name] = tool({ ... })
  }
}
```

**Phase C: Update Built-in Tools**

Retrofit `fs_search` sebagai contoh pertama:

File: `apps/studio/server/src/filesystem/tools.ts`

```typescript
// Sebelum: return semua results sekaligus
// Sesudah: yield per batch
defineToolStreaming({
  // ...
  async *executeStream(args, ctx) {
    const files = await listAllFiles(projectId)
    const matches = []
    for (const file of files) {
      if (matchesQuery(file, args.query)) {
        matches.push(file)
        yield { type: 'progress', data: { found: file.path, total_so_far: matches.length } }
      }
    }
    return { matches, total: matches.length }
  },
})
```

**Tasks:**
- [ ] Tambahkan `ToolStreamChunk` type dan `executeStream` ke `ToolDefinition`
- [ ] Update `AgentRunner` untuk handle streaming tools
- [ ] Retrofit `fs_search` sebagai proof-of-concept
- [ ] Update `jiku-tool-data` stream event untuk termasuk progress chunks
- [ ] Update web UI tool result display untuk show progressive results

---

## 15.2 — Semantic Memory (Qdrant + Hybrid Scoring)

### Description
Memory system Jiku saat ini menggunakan keyword matching + recency + access frequency scoring di `relevance.ts`. Ini "buta" terhadap sinonim dan konteks semantik. Fitur ini menambahkan vector search via Qdrant untuk hybrid scoring (keyword + semantic).

### Goals
- Memory retrieval berdasarkan kemiripan makna, bukan hanya kata kunci
- Hybrid scoring: bobot gabungan keyword score + vector similarity score
- Memory yang sudah ada tetap berfungsi (backward compatible)
- Qdrant sebagai infrastruktur vector DB

### Yang Sudah Ada
- `relevance.ts`: `scoreMemory()` dengan keyword+recency+access weights
- `findRelevantMemories()`: filter berdasarkan min_score + sort + slice max_extended
- `builder.ts`: `buildMemoryContext()` yang load core + extended memories
- `agent_memories` tabel di PostgreSQL (tanpa kolom embedding)
- `ResolvedMemoryConfig` type: weights `{ keyword, recency, access }`

### Metode: Hybrid Scoring

Memory lama tetap relevan. Scoring berubah dari 3-faktor ke 4-faktor:

```
Score = keyword * W_keyword
      + semantic * W_semantic   ← BARU
      + recency  * W_recency
      + access   * W_access
```

Default weights baru: `{ keyword: 0.25, semantic: 0.35, recency: 0.25, access: 0.15 }`

Jika Qdrant tidak tersedia (embedding gagal, service down), fallback ke scoring lama (keyword=0.5, recency=0.3, access=0.2) — **degradasi graceful, bukan error**.

### Qdrant Infra

Qdrant jalan sebagai Docker container, sama seperti PostgreSQL dan RustFS.

### Embedding Model

Embedding generation dilakukan via API — bukan lokal. Gunakan model kecil dan murah:
- **Default:** OpenAI `text-embedding-3-small` (1536 dim, ~$0.02/1M tokens)
- **Alternatif:** model embedding dari provider yang sudah di-configure di project credentials
- Konfigurasi di level project: `embedding_provider`, `embedding_model`

### Implementation Plan

**Phase A: Infra — Docker Compose**

File: `apps/studio/server/docker-compose.yml`

```yaml
  qdrant:
    image: qdrant/qdrant:v1.13.2
    ports:
      - "${QDRANT_HTTP_PORT:-6333}:6333"
      - "${QDRANT_GRPC_PORT:-6334}:6334"
    volumes:
      - qdrant_data:/qdrant/storage
    environment:
      QDRANT__SERVICE__GRPC_PORT: 6334

volumes:
  # ... existing ...
  qdrant_data:
```

File: `infra/dokploy/docker-compose.yml`

```yaml
  qdrant:
    image: qdrant/qdrant:v1.13.2
    restart: unless-stopped
    expose:
      - "6333"
      - "6334"
    volumes:
      - qdrant_data:/qdrant/storage
    networks:
      - dokploy-network

volumes:
  # ... existing ...
  qdrant_data:
```

Environment variables pada `app` service:
```
QDRANT_URL: http://qdrant:6333
```

**Phase B: Embedding Service**

File baru: `apps/studio/server/src/memory/embedding.ts`

```typescript
export interface EmbeddingService {
  embed(texts: string[]): Promise<number[][]>
  dimensions: number
}

/**
 * Resolve embedding service dari project credentials.
 * Fallback ke OpenAI text-embedding-3-small jika ada OPENAI_API_KEY.
 * Return null jika tidak ada provider yang tersedia.
 */
export function createEmbeddingService(projectId: string): EmbeddingService | null
```

**Phase C: Qdrant Client Wrapper**

File baru: `apps/studio/server/src/memory/qdrant.ts`

```typescript
import { QdrantClient } from '@qdrant/js-client-rest'

/**
 * Singleton Qdrant client.
 * Collection naming: `jiku_memories_{projectId}`
 * Points: id = memory.id, vector = embedding, payload = { agent_id, scope, tier }
 */
export class MemoryVectorStore {
  /** Upsert embedding for a memory */
  async upsert(projectId: string, memoryId: string, embedding: number[], metadata: Record<string, string>): Promise<void>

  /** Delete point by memory ID */
  async delete(projectId: string, memoryId: string): Promise<void>

  /** Search by vector similarity — return sorted memory IDs + scores */
  async search(projectId: string, queryEmbedding: number[], filter: QdrantFilter, limit: number): Promise<Array<{ id: string; score: number }>>

  /** Ensure collection exists for project (called on wakeUp) */
  async ensureCollection(projectId: string, dimensions: number): Promise<void>
}
```

**Phase D: Update Memory Lifecycle**

1. **Saat memory di-INSERT (`storage.saveMemory`)**:
   - Generate embedding via EmbeddingService
   - Upsert ke Qdrant dengan metadata `{ agent_id, scope, tier, caller_id }`
   - Jika embedding gagal → simpan memory tanpa vector (graceful fallback)

2. **Saat memory di-DELETE (`storage.deleteMemory`)**:
   - Hapus dari Qdrant juga

File yang diubah: `apps/studio/server/src/runtime/storage.ts` (StudioStorageAdapter)

**Phase E: Update Relevance Scoring (Hybrid)**

File: `packages/core/src/memory/relevance.ts`

```typescript
export function scoreMemory(
  memory: AgentMemory,
  currentInput: string,
  weights = { keyword: 0.25, semantic: 0.35, recency: 0.25, access: 0.15 },
  halfLifeDays = 30,
  semanticScore?: number, // ← BARU: dari Qdrant search, 0-1
): number {
  const kw = keywordScore(memory, currentInput)
  const sem = semanticScore ?? 0  // fallback 0 jika tidak ada Qdrant
  const rec = recencyScore(memory, halfLifeDays)
  const acc = accessScore(memory)
  const imp = importanceMultiplier(memory)

  return (kw * weights.keyword + sem * weights.semantic + rec * weights.recency + acc * weights.access) * imp
}
```

**Phase F: Update buildMemoryContext**

File: `packages/core/src/memory/builder.ts`

Sebelum memanggil `findRelevantMemories`, query Qdrant dulu untuk mendapatkan semantic scores:

```typescript
// 1. Embed current_input
const queryEmbedding = await embeddingService.embed([current_input])
// 2. Search Qdrant untuk extended memories
const vectorResults = await vectorStore.search(projectId, queryEmbedding[0], filter, max_extended * 2)
// 3. Build semanticScores map: memoryId → score
const semanticScores = new Map(vectorResults.map(r => [r.id, r.score]))
// 4. Pass ke findRelevantMemories
findRelevantMemories(extPool, current_input, config.relevance, semanticScores)
```

**Phase G: Config**

Tambahkan ke `ResolvedMemoryConfig.relevance.weights`:

```typescript
weights: {
  keyword: number   // default 0.25
  semantic: number  // default 0.35 ← BARU
  recency: number   // default 0.25
  access: number    // default 0.15
}
```

UI memory config editor di Studio juga di-update.

**Tasks:**
- [ ] Tambahkan Qdrant ke `apps/studio/server/docker-compose.yml`
- [ ] Tambahkan Qdrant ke `infra/dokploy/docker-compose.yml`
- [ ] Install `@qdrant/js-client-rest` di `apps/studio/server`
- [ ] Buat `embedding.ts` — service abstraction
- [ ] Buat `qdrant.ts` — Qdrant client wrapper
- [ ] Update `StudioStorageAdapter.saveMemory` untuk upsert embedding
- [ ] Update `StudioStorageAdapter.deleteMemory` untuk delete dari Qdrant
- [ ] Tambahkan `semantic` weight ke `ResolvedMemoryConfig`
- [ ] Update `scoreMemory()` di `relevance.ts` untuk hybrid scoring
- [ ] Update `buildMemoryContext()` untuk query Qdrant sebelum scoring
- [ ] Ensure collection pada `runtimeManager.wakeUp()`
- [ ] Graceful fallback: jika Qdrant/embedding tidak tersedia, gunakan scoring lama
- [ ] Update memory config UI (web) untuk semantic weight
- [ ] Backfill script: generate embeddings untuk memories yang sudah ada

---

## 15.3 — Conversation Queue Mode

### Description
Saat ini jika run sedang aktif dan pesan baru masuk ke conversation yang sama, ada dua perilaku: web UI mendapat 409 Conflict (dari `StreamRegistry.isRunning`), dan connector adapter mengirim "⏳ Agent is still processing..." lalu drop pesan. Queue mode membuat pesan yang masuk saat agent busy di-queue dan diproses setelah run sebelumnya selesai.

### Goals
- Pesan yang masuk saat agent running di-queue, bukan di-drop
- Queue diproses FIFO setelah run sebelumnya selesai
- Konfigurasi per agent: `queue_mode: 'off' | 'queue' | 'ack_queue'`
  - `off` = perilaku sekarang (409 / drop)
  - `queue` = buffer pesan, proses berurutan
  - `ack_queue` = buffer + kirim ack message ("⏳ Sedang memproses...") ke pengirim
- Berlaku untuk semua channel: web, connector (Telegram, dll), API

### Yang Sudah Ada
- `StreamRegistry` (`stream-registry.ts`): tracking active runs, `isRunning()` guard
- `event-router.ts` line 449: `runningConversations.has(conversationId)` → kirim "⏳" lalu return
- `chat.ts` route (API): cek `streamRegistry.isRunning()` → 409

### Implementation Plan

**Phase A: Queue Infrastructure**

File baru: `apps/studio/server/src/runtime/conversation-queue.ts`

```typescript
interface QueuedMessage {
  input: string
  caller: CallerContext
  attachments?: ChatAttachment[]
  input_file_parts?: ChatFilePart[]
  resolve: (result: JikuRunResult) => void
  reject: (error: Error) => void
}

class ConversationQueue {
  private queues = new Map<string, QueuedMessage[]>()
  private processing = new Set<string>()

  /** Enqueue pesan untuk conversation yang sedang running */
  enqueue(conversationId: string, msg: QueuedMessage): void

  /** Tandai conversation selesai running — trigger next in queue */
  onRunComplete(conversationId: string): void

  /** Cek apakah ada item di queue */
  hasQueued(conversationId: string): boolean

  /** Get queue length */
  queueLength(conversationId: string): number
}

export const conversationQueue = new ConversationQueue()
```

**Phase B: Integrate ke Chat Route**

File: `apps/studio/server/src/routes/chat.ts`

```typescript
// Sebelum:
if (streamRegistry.isRunning(conversationId)) {
  return res.status(409).json({ error: 'Run already in progress' })
}

// Sesudah:
if (streamRegistry.isRunning(conversationId)) {
  const agent = await getAgentById(agentId)
  const queueMode = agent?.queue_mode ?? 'off'

  if (queueMode === 'off') {
    return res.status(409).json({ error: 'Run already in progress' })
  }

  // Queue the message — resolve when it's the message's turn
  const result = await new Promise<JikuRunResult>((resolve, reject) => {
    conversationQueue.enqueue(conversationId, {
      input, caller, attachments, input_file_parts, resolve, reject
    })
  })

  // Stream the result to client (same as normal flow)
  return pipeRunResultToResponse(result, res)
}
```

**Phase C: Integrate ke Connector Event Router**

File: `apps/studio/server/src/connectors/event-router.ts`

Di `executeConversationAdapter`, ganti logic `runningConversations.has`:

```typescript
if (runningConversations.has(conversationId)) {
  const agent = await getAgentById(agentId)
  const queueMode = agent?.queue_mode ?? 'off'

  if (queueMode === 'off') {
    connectorAdapter?.sendMessage(...)  // existing "⏳" message
    return
  }

  if (queueMode === 'ack_queue') {
    connectorAdapter?.sendMessage(
      { ref_keys: event.ref_keys },
      { text: '⏳ Pesan kamu sudah diterima, sedang menunggu giliran.' }
    )
  }

  // Enqueue — will be processed when current run finishes
  conversationQueue.enqueue(conversationId, {
    input, caller, resolve: ..., reject: ...
  })
  return
}
```

**Phase D: Run Complete Hook**

File: `apps/studio/server/src/routes/chat.ts` dan `event-router.ts`

Setelah run selesai (stream fully consumed):

```typescript
conversationQueue.onRunComplete(conversationId)
```

`onRunComplete` akan:
1. Dequeue next message
2. Call `runtimeManager.run()` untuk message tersebut
3. Pipe hasilnya ke resolve() callback
4. Jika connector: kirim response via adapter

**Phase E: Agent Config**

Tambahkan ke tabel `agents`:
```sql
ALTER TABLE agents ADD COLUMN queue_mode text DEFAULT 'off';
-- values: 'off', 'queue', 'ack_queue'
```

Tambahkan ke API agents update + UI agent settings.

**Tasks:**
- [ ] Buat `conversation-queue.ts`
- [ ] Tambahkan kolom `queue_mode` ke tabel agents (migration)
- [ ] Update chat route: queue jika running + mode != off
- [ ] Update connector event-router: queue jika running + mode != off
- [ ] Hook `onRunComplete` setelah stream selesai
- [ ] Ack message untuk `ack_queue` mode (kirim "⏳ sedang menunggu giliran")
- [ ] Update agent settings API: expose queue_mode
- [ ] Update agent settings UI: toggle queue mode
- [ ] Handle edge cases: queue overflow (max 10 queued per conversation), timeout

---

## 15.4 — Enhanced Inter-Agent Calling

### Description
`run_task` saat ini sudah support attach mode (detach=false) yang menunggu + return hasilnya. Tapi: (1) hasil yang di-return hanya status + output string, bukan structured data, (2) tidak ada tools untuk baca history agent lain, (3) agent discovery via `list_agents` sudah ada tapi tidak bisa filter berdasarkan capability.

### Goals
- `run_task` attach mode yang return structured result (termasuk tool results, not just text)
- Tool baru: `agent_read_history` — baca conversation history agent lain
- Enhance `list_agents` — tambahkan filter by mode dan description search
- Tracking: `caller_agent_id` di conversation metadata untuk audit trail

### Yang Sudah Ada
- `run_task` (`task/tools.ts` line 93-169): support `detach: true/false`, attach mode waits via `Promise.race` dengan timeout
- `spawnTask` + `runTaskConversation` (`task/runner.ts`): creates task conversation, drains stream, returns `{ status, output }`
- `list_agents` (`task/tools.ts` line 64-87): returns id, name, slug, description
- `TaskMetadata` type (`@jiku/types`): sudah ada `goal`, `output`, `progress_log`
- `parent_conversation_id` di tabel conversations: sudah tracking chain

### Implementation Plan

**Phase A: Enhanced run_task Result**

File: `apps/studio/server/src/task/runner.ts`

Update `runTaskConversation` untuk return lebih lengkap:

```typescript
export interface RunTaskResult {
  status: 'completed' | 'failed'
  output?: string
  /** Structured: semua tool results dari run ini */
  tool_results?: Array<{ tool_name: string; args: unknown; result: unknown }>
  /** Jumlah messages yang dihasilkan */
  message_count?: number
}
```

Setelah drain stream, extract tool results dari final messages:

```typescript
const messages = await getConversationMessages(conversationId)
const toolResults = messages
  .filter(m => m.role === 'assistant')
  .flatMap(m => m.parts.filter(p => p.type === 'tool-invocation'))
  .map(p => ({ tool_name: p.toolName, args: p.args, result: p.result }))

return { status: 'completed', output: finalOutput, tool_results: toolResults, message_count: messages.length }
```

File: `apps/studio/server/src/task/tools.ts`

Update `run_task` execute untuk return enhanced result:

```typescript
return {
  status: result.status,
  task_id: conversationId,
  output: result.output,
  tool_results: result.tool_results,  // ← baru
  message_count: result.message_count, // ← baru
}
```

**Phase B: Agent History Read Tool**

File: `apps/studio/server/src/task/tools.ts`

```typescript
export function buildAgentReadHistoryTool(projectId: string): ToolDefinition {
  return {
    meta: {
      id: 'agent_read_history',
      name: 'Read Agent History',
      description: 'Read recent conversation history of another agent. Useful for reviewing what another agent has done.',
      group: 'task',
    },
    permission: '*',
    modes: ['chat', 'task'],
    input: z.object({
      agent_id: z.string().describe('Agent ID whose history to read'),
      conversation_id: z.string().optional().describe('Specific conversation. If omitted, reads latest.'),
      limit: z.number().int().min(1).max(20).default(5).describe('Number of recent messages'),
    }),
    execute: async (args) => {
      // Get latest conversation for agent, or specific one
      // Return messages (text parts only, stripped of tool internals)
    },
  }
}
```

**Phase C: Enhanced list_agents**

Tambahkan filter ke input schema:

```typescript
input: z.object({
  mode: z.enum(['chat', 'task']).optional().describe('Filter by supported mode'),
  search: z.string().optional().describe('Search in name/description'),
}),
```

**Phase D: Caller Agent Tracking**

Tambahkan ke `TaskMetadata`:
```typescript
caller_agent_id?: string  // agent mana yang meminta run_task
```

Di `spawnTask`, pass `caller_agent_id` dari `runtimeCtx.agent.id`.

**Tasks:**
- [ ] Update `RunTaskResult` untuk include tool_results + message_count
- [ ] Update `runTaskConversation` untuk extract tool results dari messages
- [ ] Update `run_task` tool response untuk return enhanced result
- [ ] Buat `agent_read_history` tool
- [ ] Enhance `list_agents` dengan filter mode + search
- [ ] Tambahkan `caller_agent_id` ke task metadata
- [ ] Register `agent_read_history` di `runtimeManager.wakeUp()`

---

## 15.5 — Channel Routing Rules

### Description
Connector binding system Jiku sudah punya routing (source_type, trigger_mode, output_adapter). Tapi routing saat ini 1 binding = 1 agent tetap. Fitur ini memperkaya routing dengan multi-binding evaluation yang lebih ekspresif dan priority-based.

### Goals
- Satu connector bisa route ke banyak agent berdasarkan kondisi
- Priority-based resolution (binding dengan priority tertinggi yang match, menang)
- Routing berdasarkan: peer identity, group, keyword, regex, time-of-day
- Fallback default agent jika tidak ada rule yang match

### Yang Sudah Ada
- `ConnectorBinding` type (`@jiku/types`): source_type, source_ref_keys, trigger_mode, trigger_keywords, output_config (agent_id)
- `matchesTrigger()` (`event-router.ts` line 76-112): matching berdasarkan source_ref_keys + trigger_source + trigger_mode
- `routeConnectorEvent()`: iterates semua matching bindings → executes all matches (bukan first-match)
- Binding sudah punya `enabled` flag
- Binding sudah di-DB (connector_bindings table)

### Implementation Plan

**Phase A: Extend Binding Model**

Tambahkan ke tabel `connector_bindings`:

```sql
ALTER TABLE connector_bindings ADD COLUMN priority integer DEFAULT 0;
ALTER TABLE connector_bindings ADD COLUMN match_mode text DEFAULT 'all';
-- match_mode: 'all' (execute semua match, current behavior) | 'first' (first match wins)

ALTER TABLE connector_bindings ADD COLUMN trigger_regex text;
-- Regex pattern untuk match terhadap message text

ALTER TABLE connector_bindings ADD COLUMN schedule_filter jsonb;
-- { timezone: 'Asia/Jakarta', active_hours: [{ day: [1,2,3,4,5], from: '09:00', to: '17:00' }] }
```

Extend `ConnectorBinding` type di `@jiku/types`.

**Phase B: Enhanced Matching**

File: `apps/studio/server/src/connectors/event-router.ts`

Update `matchesTrigger()`:

```typescript
function matchesTrigger(event: ConnectorEvent, binding: ConnectorBinding): boolean {
  // ... existing checks ...

  // NEW: Regex match
  if (binding.trigger_regex && event.type === 'message') {
    const text = event.content?.text ?? ''
    try {
      if (!new RegExp(binding.trigger_regex, 'i').test(text)) return false
    } catch { return false }
  }

  // NEW: Schedule filter (time-of-day gate)
  if (binding.schedule_filter) {
    if (!isWithinSchedule(binding.schedule_filter)) return false
  }

  return true
}
```

**Phase C: Priority-based Resolution**

Update `routeConnectorEvent()`:

```typescript
// Sort by priority (descending)
const sorted = matchingBindings.sort((a, b) => (b.binding.priority ?? 0) - (a.binding.priority ?? 0))

// Check match_mode of the connector config (or per-binding)
const firstMatchOnly = sorted[0]?.binding.match_mode === 'first'

for (const { binding, connector } of sorted) {
  // ... execute adapter ...
  if (firstMatchOnly) break  // stop after first match
}
```

**Phase D: Default Fallback Agent**

Tambahkan ke connector config (DB):
```sql
ALTER TABLE connectors ADD COLUMN default_agent_id text REFERENCES agents(id);
```

Jika tidak ada binding yang match → route ke default_agent_id (jika set).

**Phase E: Unified Message Interface**

Perkaya `ConnectorEvent` interface di `@jiku/types` agar adapter bisa provide lebih banyak metadata:

```typescript
export interface ConnectorEvent {
  // ... existing ...
  /** Platform-specific peer metadata (group name, topic, etc.) */
  peer_metadata?: {
    type: 'dm' | 'group' | 'channel' | 'thread'
    name?: string
    topic?: string
    member_count?: number
  }
}
```

Ini memungkinkan routing yang lebih pintar (e.g. route thread tertentu ke agent tertentu).

**Tasks:**
- [ ] Migration: tambahkan `priority`, `match_mode`, `trigger_regex`, `schedule_filter` ke connector_bindings
- [ ] Migration: tambahkan `default_agent_id` ke connectors
- [ ] Extend `ConnectorBinding` type + `ConnectorEvent.peer_metadata`
- [ ] Update `matchesTrigger()` untuk regex + schedule support
- [ ] Update `routeConnectorEvent()` untuk priority sorting + first-match mode
- [ ] Implement fallback default agent routing
- [ ] Update binding CRUD API endpoints
- [ ] Update connector settings UI: priority editor, regex field, schedule filter

---

## 15.6 — MCP Support + Tool On/Off Registry

### Description
Dua fitur yang saling terkait: (1) MCP (Model Context Protocol) support agar agent bisa terhubung ke external tool servers, dan (2) mekanisme on/off untuk semua tools (built-in, plugin, MCP) per agent.

### Goals
- Agent bisa connect ke MCP servers — tools dari MCP tampil sama dengan built-in tools
- Semua tools (built-in + plugin + MCP) default ON
- Per-agent bisa disable tools tertentu — state disimpan di DB
- UI untuk manage tools: list semua, toggle on/off, configure MCP servers
- MCP configuration per project (global) atau per agent (override)

### Yang Sudah Ada
- `ToolDefinition` + `ResolvedTool` types di `@jiku/types`
- `AgentRunner.run()` builds tools dari `scope.active_tools` + `agent.built_in_tools`
- Policy system bisa restrict tools via rules — tapi ini access control, bukan on/off toggle
- `agents.built_in_tools` di `runtimeManager` di-compose saat register

### Implementation Plan

**Phase A: Tool State Registry (DB)**

```sql
-- Global per project: tool default states
CREATE TABLE project_tool_states (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  tool_id text NOT NULL,           -- resolved tool ID, e.g. '__builtin__:memory_search'
  enabled boolean NOT NULL DEFAULT true,
  created_at timestamptz DEFAULT now(),
  UNIQUE(project_id, tool_id)
);

-- Per agent: overrides project defaults
CREATE TABLE agent_tool_states (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id uuid NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  tool_id text NOT NULL,
  enabled boolean NOT NULL DEFAULT true,
  created_at timestamptz DEFAULT now(),
  UNIQUE(agent_id, tool_id)
);
```

Resolution order:
1. All tools default **enabled**
2. `project_tool_states` can disable globally
3. `agent_tool_states` can override (enable/disable) per agent

**Phase B: Tool Resolution Update**

File: `packages/core/src/runner.ts`

Di `run()`, setelah `resolveScope()` dan sebelum build `aiTools`:

```typescript
// Filter tools by on/off state
const toolStates = await this.storage.getToolStates?.(agentId, projectId)
const enabledTools = modeTools.filter(t => {
  const agentState = toolStates?.agent[t.resolved_id]
  const projectState = toolStates?.project[t.resolved_id]
  // Agent override > project override > default (true)
  if (agentState !== undefined) return agentState
  if (projectState !== undefined) return projectState
  return true
})
```

**Phase C: MCP Server Configuration (DB)**

```sql
CREATE TABLE mcp_servers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  agent_id uuid REFERENCES agents(id) ON DELETE CASCADE,  -- null = project-global
  name text NOT NULL,
  transport text NOT NULL,  -- 'stdio' | 'sse' | 'streamable-http'
  config jsonb NOT NULL,    -- { url?, command?, args?, env?, headers? }
  enabled boolean NOT NULL DEFAULT true,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);
```

**Phase D: MCP Client Integration**

File baru: `apps/studio/server/src/mcp/client.ts`

```typescript
import { Client } from '@modelcontextprotocol/sdk/client/index.js'

export class MCPClientManager {
  private clients = new Map<string, Client>()

  /** Connect ke MCP server, fetch tool list */
  async connect(serverId: string, config: MCPServerConfig): Promise<void>

  /** Disconnect */
  async disconnect(serverId: string): Promise<void>

  /** Get tools dari semua connected servers untuk project/agent */
  getTools(projectId: string, agentId?: string): ToolDefinition[]

  /** Execute MCP tool call */
  async callTool(serverId: string, toolName: string, args: unknown): Promise<unknown>
}

export const mcpManager = new MCPClientManager()
```

**Phase E: Wrap MCP Tools as ToolDefinition**

Setiap MCP tool di-wrap menjadi `ToolDefinition` biasa:

```typescript
function wrapMCPTool(serverId: string, mcpTool: MCPToolSchema): ToolDefinition {
  return {
    meta: {
      id: `mcp_${serverId}_${mcpTool.name}`,
      name: mcpTool.name,
      description: mcpTool.description ?? '',
      group: 'mcp',
    },
    permission: '*',
    modes: ['chat', 'task'],
    input: mcpTool.inputSchema,
    execute: async (args) => mcpManager.callTool(serverId, mcpTool.name, args),
  }
}
```

**Phase F: Integrate ke Runtime**

File: `apps/studio/server/src/runtime/manager.ts`

Di `wakeUp()`:
1. Load MCP server configs dari DB
2. Connect ke semua enabled servers
3. Wrap MCP tools + inject ke agent `built_in_tools`

Di `syncAgent()`:
1. Reload MCP tools untuk agent tersebut

**Phase G: API + UI**

- `GET /api/agents/:id/tools` — list semua tools + status (enabled/disabled) + source (builtin/plugin/mcp)
- `PATCH /api/agents/:id/tools/:tool_id` — toggle on/off
- `GET /api/projects/:id/mcp-servers` — list MCP servers
- `POST /api/projects/:id/mcp-servers` — add MCP server
- `PATCH /api/mcp-servers/:id` — update
- `DELETE /api/mcp-servers/:id` — remove

UI:
- Agent Tools page: list tools, toggle switches, source badge
- MCP Servers page (project settings): add/edit/remove servers

**Tasks:**
- [ ] Migration: create `project_tool_states`, `agent_tool_states`, `mcp_servers` tables
- [ ] Install `@modelcontextprotocol/sdk` di `apps/studio/server`
- [ ] Buat `mcp/client.ts` — MCPClientManager
- [ ] Buat MCP tool wrapping functions
- [ ] Add `getToolStates` ke `JikuStorageAdapter` interface
- [ ] Update `AgentRunner.run()` untuk filter by tool states
- [ ] Inject MCP tools di `runtimeManager.wakeUp()` dan `syncAgent()`
- [ ] API routes: tool states CRUD, MCP server CRUD
- [ ] DB queries: tool states get/set, MCP servers CRUD
- [ ] Agent tools UI page (list + toggle)
- [ ] MCP servers settings UI page
- [ ] MCP server health check / connection test endpoint

---

## 15.7 — Thinking Mode _(DEFERRED — Phase Berikutnya)_

Ditunda. Akan diimplementasikan di phase berikutnya.

---

## 15.8 — Progress Reporting Tool

### Description
Untuk task mode, user tidak tahu progress agent. Fitur ini menambahkan built-in tool `report_progress` yang agent panggil setelah setiap langkah signifikan.

### Goals
- Agent bisa report progress terstruktur selama task execution
- Progress tersimpan di conversation metadata
- UI menampilkan progress bar + timeline di run detail
- Live update via stream event saat agent running

### Yang Sudah Ada
- `TaskMetadata` di `@jiku/types` (line 18-22): sudah ada `progress_log: Array<{ message, percent, at }>`
- `conversation.metadata` di DB: JSONB, bisa di-extend
- `JikuStreamWriter` — sudah bisa emit custom events ke stream
- `jiku-tool-data` stream event type — sudah ada

### Implementation Plan

**Phase A: Built-in Tool**

File baru: `apps/studio/server/src/task/progress-tool.ts`

```typescript
export function buildProgressTool(conversationId: string): ToolDefinition {
  return {
    meta: {
      id: 'report_progress',
      name: 'Report Progress',
      description: 'Report current progress of this task. Call after each significant step.',
      group: 'task',
    },
    permission: '*',
    modes: ['task'],
    input: z.object({
      step: z.string().describe('What was just completed'),
      percentage: z.number().min(0).max(100).optional().describe('Progress 0-100'),
      details: z.string().optional().describe('Additional context'),
    }),
    execute: async (args, ctx) => {
      const { step, percentage, details } = args as { step: string; percentage?: number; details?: string }

      // Append to conversation metadata
      const conv = await getConversationById(conversationId)
      const meta = (conv?.metadata ?? {}) as Record<string, unknown>
      const log = (meta.progress_log as Array<unknown>) ?? []
      const entry = { message: step, percent: percentage, details, at: new Date().toISOString() }
      log.push(entry)

      await updateConversation(conversationId, {
        metadata: { ...meta, progress_log: log, current_progress: { step, percentage } },
      })

      // Emit ke stream untuk live observers
      ctx.writer.write('jiku-tool-data', {
        tool_id: 'report_progress',
        data: entry,
      })

      return { recorded: true }
    },
  }
}
```

**Phase B: Inject ke Task/Heartbeat Runs**

File: `apps/studio/server/src/runtime/manager.ts`

Di `wakeUp()` dan `syncAgent()`, tambahkan `buildProgressTool(conversationId)` ke `built_in_tools` — tapi ini per-conversation, jadi harus di-inject di `run()` time, bukan register time.

Alternatif yang lebih bersih: inject di `runtimeManager.run()` sebelum delegate ke `runtime.run()`:

```typescript
// Di runtimeManager.run(), sebelum call runtime.run()
if (params.mode === 'task') {
  // Inject progress tool for this specific conversation
  // via params.extra_tools atau runtime.addConversationTools()
}
```

Ini butuh extend `JikuRunParams` untuk support `extra_built_in_tools`.

**Phase C: System Prompt Injection**

Tambahkan ke task mode instruction di `resolver/prompt.ts`:

```
After each significant step, call report_progress to update the user on your progress.
```

**Phase D: UI**

- Run detail page: progress bar + timeline dari `metadata.progress_log`
- Run list page: badge showing `current_progress.percentage` untuk running tasks
- Live update via stream subscription

**Tasks:**
- [ ] Buat `progress-tool.ts`
- [ ] Extend `JikuRunParams` atau `AgentRunner` untuk accept extra tools per-run
- [ ] Inject progress tool hanya pada task mode runs
- [ ] Add prompt instruction ke task mode
- [ ] Emit progress events ke stream (jiku-tool-data)
- [ ] UI: progress timeline di run detail page
- [ ] UI: progress badge di run list page

---

## 15.9 — Structured Persona (Traits & Boundaries)

### Description
Persona saat ini adalah free-text `persona_prompt`. Fitur ini menambahkan structured fields untuk identity, traits, dan boundaries — sambil tetap aman untuk multi-user environment.

### Goals
- Persona punya structure: identity, traits (tone, humor level, formality), boundaries
- Setiap user tetap mengakses agent yang sama, tapi communication style bisa diadaptasi via memory scope `agent_caller` — bukan persona
- Persona adalah identitas agent yang konsisten untuk semua user
- Agent bisa update traits-nya berdasarkan feedback (via tool)

### Yang Sudah Ada
- `PersonaSeed` type: `{ name, role, personality, communication_style, background, initial_memories }`
- `persona_prompt` field di agent (text, injected di system prompt)
- `formatPersonaSection()` di `builder.ts`: format persona dari seed + agent_self memories
- Persona extraction post-run di `runner.ts` line 521-529

### Perhatian Multi-User
Persona = identitas agent, sama untuk semua user. Jangan campur dengan preferensi user.
Contoh:
- **Persona (sama untuk semua):** "Saya Jiku, assistant formal dan detail-oriented"
- **Per-user preference (di agent_caller memory):** "User ini suka jawaban singkat" atau "User ini prefer bahasa Indonesia"

### Implementation Plan

**Phase A: Structured Persona Schema**

Update `PersonaSeed` di `@jiku/types`:

```typescript
export interface PersonaSeed {
  name?: string
  role?: string
  personality?: string
  communication_style?: string
  background?: string
  initial_memories?: string[]
  // ← NEW structured fields
  traits?: {
    formality: 'casual' | 'balanced' | 'formal'         // default: balanced
    verbosity: 'concise' | 'moderate' | 'detailed'       // default: moderate
    humor: 'none' | 'light' | 'frequent'                 // default: light
    empathy: 'low' | 'moderate' | 'high'                 // default: moderate
    expertise_display: 'simplified' | 'balanced' | 'technical'  // default: balanced
  }
  boundaries?: string[]  // Things the agent refuses to do, e.g. ["Never give financial advice"]
}
```

**Phase B: Update Persona Section Builder**

File: `packages/core/src/memory/builder.ts`

```typescript
export function formatPersonaSection(
  agentName: string,
  selfMemories: AgentMemory[],
  seed?: PersonaSeed | null,
): string | null {
  // ... existing ...

  // NEW: Inject traits as behavioral guidelines
  if (seed?.traits) {
    lines.push('')
    lines.push('### Communication Style')
    lines.push(`- Formality: ${seed.traits.formality}`)
    lines.push(`- Verbosity: ${seed.traits.verbosity}`)
    lines.push(`- Humor: ${seed.traits.humor}`)
    lines.push(`- Empathy: ${seed.traits.empathy}`)
    lines.push(`- Expertise display: ${seed.traits.expertise_display}`)
  }

  if (seed?.boundaries?.length) {
    lines.push('')
    lines.push('### Boundaries')
    seed.boundaries.forEach(b => lines.push(`- ${b}`))
  }

  return lines.join('\n')
}
```

**Phase C: Persona Update Tool**

Built-in tool agar agent bisa self-update traits berdasarkan general feedback:

```typescript
export function buildUpdatePersonaTool(agentId: string, projectId: string): ToolDefinition {
  return {
    meta: { id: 'update_persona_trait', name: 'Update Persona Trait', ... },
    modes: ['chat', 'task'],
    input: z.object({
      trait: z.enum(['formality', 'verbosity', 'humor', 'empathy', 'expertise_display']),
      value: z.string(),
      reason: z.string(),
    }),
    execute: async (args) => {
      // Load current persona_seed, update trait, save back to DB
      // Only applies to agent-level persona, not per-user
    },
  }
}
```

**Phase D: UI**

Persona settings page:
- Trait sliders/selects (formality, verbosity, dll)
- Boundaries list (add/remove)
- Preview section: "Begini cara agent ini akan berkomunikasi"

**Tasks:**
- [ ] Extend `PersonaSeed` type dengan `traits` dan `boundaries`
- [ ] Update `formatPersonaSection()` untuk inject traits + boundaries
- [ ] Buat `update_persona_trait` tool (optional — agent bisa self-tune)
- [ ] Update persona API endpoints
- [ ] Update persona settings UI: trait selectors + boundaries editor
- [ ] Migration: update persona_seed column handling (backward compatible, existing seeds tetap valid)

---

## 15.10 — Auto-Reply System

### Description
Layer evaluasi sebelum agent dipanggil yang bisa langsung balas tanpa LLM — hemat token, response instan.

### Goals
- Rule-based auto-reply sebelum agent dipanggil
- Trigger types: exact match, contains, regex, command
- Availability schedule: agent tidak aktif di luar jam tertentu → kirim offline message
- Per-agent konfigurasi

### Yang Sudah Ada
- Chat route di server: langsung call `runtimeManager.run()`
- Connector event-router: langsung route ke agent
- Tidak ada interceptor layer sebelum agent execution

### Implementation Plan

**Phase A: Auto-Reply Config Schema**

Tambahkan ke tabel `agents`:

```sql
ALTER TABLE agents ADD COLUMN auto_replies jsonb DEFAULT '[]';
-- Array of: { trigger: 'exact'|'contains'|'regex'|'command', pattern: string, response: string, enabled: boolean }

ALTER TABLE agents ADD COLUMN availability_schedule jsonb;
-- { enabled: boolean, timezone: string, hours: [{ days: [0-6], from: 'HH:MM', to: 'HH:MM' }], offline_message: string }
```

Type di `@jiku/types`:

```typescript
export interface AutoReplyRule {
  trigger: 'exact' | 'contains' | 'regex' | 'command'
  pattern: string
  response: string
  enabled: boolean
}

export interface AvailabilitySchedule {
  enabled: boolean
  timezone: string
  hours: Array<{ days: number[]; from: string; to: string }>
  offline_message: string
}
```

**Phase B: Auto-Reply Evaluator**

File baru: `apps/studio/server/src/auto-reply/evaluator.ts`

```typescript
export interface AutoReplyResult {
  matched: boolean
  response?: string
  reason?: 'rule_match' | 'offline' | 'none'
}

export function evaluateAutoReply(
  input: string,
  rules: AutoReplyRule[],
  schedule: AvailabilitySchedule | null,
): AutoReplyResult {
  // 1. Check schedule — if outside hours, return offline message
  if (schedule?.enabled && !isWithinSchedule(schedule)) {
    return { matched: true, response: schedule.offline_message, reason: 'offline' }
  }

  // 2. Check rules
  for (const rule of rules.filter(r => r.enabled)) {
    switch (rule.trigger) {
      case 'exact':
        if (input.trim().toLowerCase() === rule.pattern.toLowerCase())
          return { matched: true, response: rule.response, reason: 'rule_match' }
        break
      case 'contains':
        if (input.toLowerCase().includes(rule.pattern.toLowerCase()))
          return { matched: true, response: rule.response, reason: 'rule_match' }
        break
      case 'regex':
        try {
          if (new RegExp(rule.pattern, 'i').test(input))
            return { matched: true, response: rule.response, reason: 'rule_match' }
        } catch { /* invalid regex, skip */ }
        break
      case 'command':
        if (input.trim().startsWith(`/${rule.pattern}`))
          return { matched: true, response: rule.response, reason: 'rule_match' }
        break
    }
  }

  return { matched: false, reason: 'none' }
}
```

**Phase C: Integrate ke Chat Route**

File: `apps/studio/server/src/routes/chat.ts`

Sebelum `runtimeManager.run()`:

```typescript
const agent = await getAgentById(agentId)
const autoReply = evaluateAutoReply(
  input,
  agent?.auto_replies ?? [],
  agent?.availability_schedule ?? null,
)

if (autoReply.matched) {
  // Save user message + auto-reply as assistant message
  await storage.addMessage(conversationId, { role: 'user', parts: [{ type: 'text', text: input }] })
  await storage.addMessage(conversationId, { role: 'assistant', parts: [{ type: 'text', text: autoReply.response }] })

  // Return as stream (agar client bisa handle sama)
  return streamAutoReply(res, autoReply.response, conversationId)
}
```

**Phase D: Integrate ke Connector Event Router**

Di `executeConversationAdapter`, sebelum `runtimeManager.run()`:

```typescript
const autoReply = evaluateAutoReply(inputText, agent.auto_replies, agent.availability_schedule)
if (autoReply.matched) {
  connectorAdapter?.sendMessage(
    { ref_keys: event.ref_keys, reply_to_ref_keys: event.ref_keys },
    { text: autoReply.response },
  )
  return  // skip agent execution
}
```

**Phase E: UI + API**

- Agent settings: auto-reply rules editor (trigger type, pattern, response)
- Agent settings: availability schedule (timezone, hours per day, offline message)
- API: exposed via agent PATCH endpoint

**Tasks:**
- [ ] Migration: add `auto_replies` + `availability_schedule` to agents table
- [ ] Types: `AutoReplyRule`, `AvailabilitySchedule` di `@jiku/types`
- [ ] Buat `evaluator.ts` — auto-reply logic
- [ ] Helper: `isWithinSchedule()` utility function
- [ ] Intercept di chat route sebelum agent run
- [ ] Intercept di connector event router sebelum agent run
- [ ] Update agent API: expose auto_replies + availability_schedule
- [ ] UI: auto-reply rules editor
- [ ] UI: availability schedule editor

---

## 15.11 — Media Pipeline _(DEFERRED — Phase Berikutnya)_

Ditunda. Akan diimplementasikan di phase berikutnya bersama Thinking Mode.

---

## Dependency Graph (Urutan Implementasi)

```
15.3 Queue Mode ──────────────────┐
                                  │
15.5 Channel Routing ─────────────┤ (bisa paralel)
                                  │
15.10 Auto-Reply ─────────────────┘
         ↓
15.6 MCP + Tool On/Off ──────────── (standalone, bisa dimulai bersamaan)
         ↓
15.2 Semantic Memory (Qdrant) ───── (standalone, bisa dimulai bersamaan)
         ↓
15.4 Enhanced Inter-Agent ────────── (depends on: run_task understanding)
         ↓
15.1 Tool Streaming ──────────────── (depends on: tool system stable)
         ↓
15.8 Progress Reporting ──────────── (depends on: stream events stable)
         ↓
15.9 Structured Persona ──────────── (standalone, low risk)
```

**Recommended Sprint Order:**

1. **Sprint 1:** 15.3 (Queue) + 15.10 (Auto-Reply) + 15.5 (Channel Routing) — channel/conversation reliability
2. **Sprint 2:** 15.6 (MCP + Tool On/Off) + 15.2 (Semantic Memory) — core intelligence
3. **Sprint 3:** 15.4 (Inter-Agent) + 15.1 (Tool Streaming) — agentic power
4. **Sprint 4:** 15.8 (Progress) + 15.9 (Persona) — polish
