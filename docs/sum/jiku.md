# Jiku — Platform Overview

> Baca dokumen ini untuk memahami seluruh sistem Jiku: apa itu, bagaimana arsitekturnya, fitur apa yang ada, bagaimana data mengalir, dan bagaimana setiap bagian saling terhubung.

---

## Apa itu Jiku?

**Jiku** adalah platform agentic AI multi-tenant. Platform ini memungkinkan perusahaan membangun, men-deploy, dan mengelola AI agent — dengan dua mode interaksi:

- **Chat Mode** — Percakapan real-time antara pengguna dan agent (seperti chatbot).
- **Task Mode** — Eksekusi otonom berbasis goal, bisa dipicu oleh cron schedule atau secara manual.

Target pengguna:
- SaaS builder yang mau embed AI agent ke produk mereka.
- Enterprise yang butuh multi-tenant isolation dan ACL yang fleksibel.
- Plugin author yang mau extend fungsionalitas agent.

---

## Monorepo Structure

```
jiku/
├── packages/
│   ├── types/        @jiku/types       Shared TypeScript types, zero deps
│   ├── kit/          @jiku/kit         Plugin SDK untuk plugin author
│   ├── core/         @jiku/core        Agent runtime: runner, plugin loader, resolver
│   └── ui/           @jiku/ui          Komponen React (shadcn/ui wrapper)
│
├── apps/
│   ├── playground/   @jiku/playground  Sandbox lokal untuk testing agent
│   └── studio/
│       ├── db/       @jiku-studio/db   Drizzle ORM + PostgreSQL schema + queries
│       ├── server/   @jiku-studio/server  Express.js API + Runtime manager
│       └── web/      Next.js 15 frontend (React 19)
│
└── plugins/
    ├── jiku.connector   Connector registry & adapter system
    ├── jiku.cron        Scheduled task execution
    ├── jiku.skills      Virtual filesystem skills
    ├── jiku.social      Contoh plugin (social media tools)
    └── jiku.telegram    Telegram connector
```

### Dependency Graph

```
@jiku/types  (zero deps, hanya bergantung pada ai@^6)
    ↑
    ├── @jiku/kit       (depends: @jiku/types)
    ├── @jiku/core      (depends: @jiku/types, @jiku/kit, ai, zod, hookable)
    ├── @jiku/ui        (depends: React 19, Tailwind 4, shadcn/ui)
    ├── plugins/*       (depends: @jiku/kit, @jiku/types)
    └── apps/studio     (depends: semua packages + plugins + Express + Drizzle + Next.js)
```

---

## Tech Stack

| Komponen | Teknologi |
|---|---|
| Runtime | Bun |
| Language | TypeScript 5+ |
| Package Manager | Bun workspaces |
| Backend | Express.js |
| Database | PostgreSQL + Drizzle ORM |
| Frontend | Next.js 15 + React 19 |
| UI Components | shadcn/ui + Tailwind CSS 4 |
| AI/LLM SDK | Vercel AI SDK v6 |
| AI Providers | Anthropic, OpenAI, OpenRouter |
| Validasi | Zod v4 |
| Plugin Hooks | hookable (UnJS) |
| Cron | croner v10 |
| File Storage | S3 / RustFS |
| Chat Transport | HTTP streaming (SSE) |

---

## Fitur-Fitur

### Core Agent

| Fitur | Deskripsi |
|---|---|
| Chat Mode | Streaming chat real-time via HTTP |
| Task Mode | Eksekusi otonom berbasis goal |
| Multi-Agent | Banyak agent per project, config & tools independen |
| Model Flexibility | Provider dinamis per-request (Anthropic / OpenAI / OpenRouter) |
| Tool System | Agent bisa memanggil tools yang diinjeksikan dari plugin |
| Plugin System v3 | 3-phase boot: register → setup → activate, dengan dependency resolution |

### Data & State

| Fitur | Deskripsi |
|---|---|
| Memory System | 4 scope (agent_caller, agent_global, runtime_global, agent_self), 2 tier (core/extended), scoring berbasis keyword + recency + akses |
| Persona System | Identitas diri agent terpisah dari memory, immutable setelah di-set |
| Conversation History | Riwayat pesan lengkap dengan parts (teks, tool call, gambar), soft-delete, auto-title |
| Usage Tracking | Token counting per conversation, agregasi per project/agent |
| Attachment System | Upload gambar ephemeral ke chat, inline gallery viewer |

### Access Control & Security

| Fitur | Deskripsi |
|---|---|
| Project Hierarchy | Company → Project → Agent → Conversations |
| Multi-Tenant | Isolasi resource per company dan per project |
| ACL System | Membership level project dengan role-based permissions |
| Policy System | Rules berbasis data (bukan kode), filtering akses tool, update tanpa restart |
| Credentials | API key terenkripsi per project, dekripsi on-demand |
| Agent Visibility | Kontrol agent mana yang terlihat oleh user mana |
| Invitation System | Undangan project-level dengan role grants |

### Scheduling & Automation

| Fitur | Deskripsi |
|---|---|
| Cron Task | Percakapan terjadwal menggunakan ekspresi CRON |
| Task Delegation | Tool `run_task` — agent bisa spawn sub-conversation ke agent lain |
| Heartbeat | Trigger manual atau terjadwal untuk task-mode |
| Webhook Connectors | Inbound webhook dari Telegram, channel custom |

### File & Skills

| Fitur | Deskripsi |
|---|---|
| Virtual Filesystem | S3-backed file management, tools `fs_*` (read/write/search) |
| Skills System | File pengetahuan agent di virtual filesystem (`/skills/{slug}/`) |

---

## Arsitektur Sistem

### Hierarchy Data

```
Company
└── Project (konfigurasi, credentials, policies, memory config)
    ├── Agents (model, prompt, tools, memory override)
    │   └── Conversations (chat/task sessions)
    │       └── Messages (parts: text, tool calls, images)
    ├── Memories (per scope, per agent/user)
    ├── Credentials (API keys, terenkripsi)
    ├── Cron Tasks
    ├── Virtual Filesystem (S3)
    └── Plugins (dengan config per project)
```

### Runtime Architecture

```
JikuRuntimeManager (singleton per server)
└── JikuRuntime (satu per project, lazy-loaded)
    ├── PluginLoader (bootstrap plugins)
    │   └── SharedRegistry (tools + prompts tersedia)
    └── AgentRunner (satu per conversation run)
        ├── resolveScope()      → active tools, permission
        ├── buildSystemPrompt() → system prompt lengkap
        ├── buildMemoryContext() → memory yang relevan
        ├── buildProvider()      → decrypt credentials → Anthropic/OpenAI
        └── streamText()         → LLM execution + tool loop
```

### Plugin System (3-Phase Boot)

```
Phase 1: register()
└── Simpan definisi plugin + deklarasi dependency

Phase 2: boot() — topological sort (Kahn's algorithm)
├── setup() per plugin (berdasarkan dependency order)
├── Kumpulkan contributes (tools, prompts, dll)
└── Simpan ke SharedRegistry

Phase 3: activate() — implicit
└── Tools tersedia saat agent.run() berikutnya
```

---

## Flow Utama

### 1. User Kirim Pesan (Chat)

```
User ketik pesan
    ↓
ChatInterface (useChat dari @ai-sdk/react)
    ↓
POST /api/conversations/:id/chat
    ↓
Server:
  ├── Verify JWT
  ├── Load conversation + agent config
  ├── Resolve caller (user_id, role, is_superadmin)
  └── runtimeManager.run({ agent_id, caller, mode: 'chat', input })
        ↓
        AgentRunner.run()
          ├── Load memory (semua scope)
          ├── Build system prompt
          ├── buildProvider() → decrypt API key → buat model instance
          ├── streamText({ model, tools, system, messages })
          │     ├── LLM generate response
          │     ├── Tool loop: LLM panggil tool → cek akses → eksekusi → feed ke LLM
          │     └── Stream chunks ke HTTP response
          ├── Simpan assistant message ke DB
          ├── generateTitle() → async fire-and-forget
          └── extractMemoriesPostRun() → async fire-and-forget
    ↓
Client terima stream:
  ├── Parse text delta
  ├── Render tool calls + results
  └── Update UI
```

### 2. Cron Task Execution

```
Server boot → RuntimeManager.wakeUp(projectId)
    ↓
CronTaskScheduler load semua cron tasks yang enabled
    ↓
croner register jadwal per task
    ↓
Pada waktu yang dijadwalkan:
  └── triggerTask(taskId)
        ├── Query task config + agent
        ├── Buat conversation { type: 'cron', mode: 'task' }
        ├── runtime.run({ agent_id, mode: 'task', input: { goal: task.prompt } })
        ├── Agent eksekusi otonom (bisa spawn subtask via run_task)
        ├── Increment run_count
        └── Update last_run_at
```

### 3. Memory Lifecycle

```
Run Start:
  ├── Load memories per scope (agent_caller, agent_global, runtime_global)
  ├── Score extended memories: 0.5*keyword + 0.3*recency + 0.2*access_count
  ├── Ambil top N extended + semua core
  └── Format → inject ke system prompt

During Run:
  └── Memory di-"touch" (increment access_count) setiap kali digunakan

Post-Run (async):
  ├── Jalankan extraction LLM
  ├── Parse fakta-fakta dari percakapan
  └── INSERT ke agent_memories (scope sesuai konfigurasi)
```

### 4. Access Control per Tool

```
Saat LLM mau panggil tool:
    ↓
checkAccess({ tool_id, caller, rules })
  ├── Extract tool.resolved_permission
  ├── Jika '*': allow langsung
  ├── Evaluasi rules berurutan:
  │   ├── Match subject (user_id, role, dll)
  │   ├── Check resource + action
  │   └── First match wins
  └── Default: allow (tanpa rules = bebas)
    ↓
Jika denied → throw JikuAccessError → stream error message ke client
Jika allowed → tool.execute(args, context)
```

---

## Database Schema (Ringkasan)

| Tabel | Isi |
|---|---|
| `companies` | Root multi-tenant |
| `projects` | Tenant isolation unit, punya memory_config |
| `users` | Registry user global |
| `agents` | Konfigurasi agent (model, prompt, tools, memory, persona) |
| `conversations` | Sesi chat/task, punya run_status + soft-delete |
| `messages` | Riwayat pesan, parts dalam format JSONB |
| `agent_memories` | Memory persisten, 4 scope, 2 tier, dengan scoring |
| `credentials` | API key terenkripsi per project/company |
| `policies` | Policy akses berbasis rules |
| `policy_rules` | Rule individual (resource, action, effect) |
| `cron_tasks` | Task terjadwal + snapshot caller |
| `usage_logs` | Token usage per conversation |
| `project_files` | Virtual filesystem (path + content_cache ≤50KB) |
| `project_attachments` | Gambar chat ephemeral |
| `project_skills` | Definisi skill per agent |
| `project_memberships` | Membership level project dengan role |
| `invitations` | Undangan project/company |
| `plugins_kv` | State persisten per plugin per project |

### Message Parts Format (AI SDK v6)

Setiap message punya `parts: MessagePart[]`:
- `{ type: 'text', text: string }`
- `{ type: 'image', data: string, mimeType: string }`
- `{ type: 'tool-invocation', toolInvocationId, toolName, args, state, result }`
- `{ type: 'dynamic-tool', toolCallId, state: 'output-available', input, output }`

---

## API Endpoints (Ringkasan)

### Auth
```
POST /api/auth/register
POST /api/auth/login
GET  /api/auth/me
```

### Companies & Projects
```
GET|POST             /api/companies
GET|POST             /api/companies/:company_id/projects
PATCH|DELETE         /api/projects/:project_id
GET                  /api/projects/:project_id/usage
```

### Agents
```
GET|POST             /api/projects/:project_id/agents
PATCH|DELETE         /api/agents/:agent_id
POST                 /api/agents/:agent_id/preview      ← preview context (tools + system prompt)
GET                  /api/agents/:agent_id/usage
```

### Conversations & Chat
```
GET|POST             /api/agents/:agent_id/conversations
GET                  /api/conversations/:id
DELETE               /api/conversations/:id              ← soft delete
PATCH                /api/conversations/:id/title
GET                  /api/conversations/:id/messages
POST                 /api/conversations/:id/chat         ← streaming HTTP (CORE)
GET                  /api/conversations/:id/status
GET                  /api/conversations/:id/stream       ← SSE live observer
```

### Memory
```
GET|DELETE           /api/projects/:project_id/memories
GET|PATCH            /api/projects/:project_id/memory-config
GET|PATCH            /api/agents/:agent_id/memory-config
GET                  /api/agents/:agent_id/memory-config/resolved
```

### Cron Tasks
```
GET|POST             /api/projects/:project_id/cron-tasks
GET|PATCH|DELETE     /api/cron-tasks/:id
POST                 /api/cron-tasks/:id/trigger          ← manual trigger
```

### Filesystem
```
GET                  /api/projects/:project_id/files
GET|POST|PATCH|DELETE /api/projects/:project_id/files/:path
GET|PATCH            /api/projects/:project_id/filesystem-config
```

### Policies
```
GET|POST             /api/companies/:company_id/policies
PATCH|DELETE         /api/policies/:policy_id
GET|POST|DELETE      /api/policies/:policy_id/rules
GET|POST|DELETE      /api/agents/:agent_id/policies
```

### ACL
```
GET|POST|PATCH|DELETE /api/projects/:project_id/roles
GET|PATCH|DELETE      /api/projects/:project_id/members
GET|POST|DELETE       /api/projects/:project_id/invitations
POST                  /api/invitations/:id/accept
```

### Webhooks
```
POST /webhook/:project_id/telegram
POST /webhook/:project_id/:connector_type
```

---

## Frontend Routes (Next.js)

```
/                                                         ← Company selector
/companies/:company                                       ← Project list
/companies/:company/projects/:project                     ← Project home

/companies/:company/projects/:project/agents              ← Agent list
/companies/:company/projects/:project/agents/:agent       ← Chat interface
/companies/:company/projects/:project/agents/:agent/settings
/companies/:company/projects/:project/agents/:agent/llm
/companies/:company/projects/:project/agents/:agent/tools
/companies/:company/projects/:project/agents/:agent/memory
/companies/:company/projects/:project/agents/:agent/persona
/companies/:company/projects/:project/agents/:agent/task
/companies/:company/projects/:project/agents/:agent/permissions
/companies/:company/projects/:project/agents/:agent/usage

/companies/:company/projects/:project/chats              ← Multi-agent chat
/companies/:company/projects/:project/chats/:conv        ← Conversation view

/companies/:company/projects/:project/runs               ← Task run history
/companies/:company/projects/:project/runs/:conv         ← Task run detail

/companies/:company/projects/:project/cron-tasks         ← Cron task list
/companies/:company/projects/:project/disk               ← Virtual filesystem

/companies/:company/projects/:project/memory             ← Memory browser
/companies/:company/projects/:project/plugins            ← Plugin management
/companies/:company/projects/:project/channels           ← Connector management

/companies/:company/projects/:project/settings/general
/companies/:company/projects/:project/settings/credentials
/companies/:company/projects/:project/settings/filesystem
/companies/:company/projects/:project/settings/permissions
/companies/:company/projects/:project/settings/policies

/companies/:company/settings/general
/companies/:company/settings/members
/companies/:company/settings/invitations
```

---

## Packages — Detail

### `@jiku/types`
Type definitions bersama. Zero logic. Satu-satunya external dep adalah `ai@^6`.

Key types: `AgentDefinition`, `JikuRunParams`, `ToolDefinition`, `PluginDefinition`, `PolicyRule`, `ResolvedMemoryConfig`, `MessagePart`.

### `@jiku/kit`
SDK untuk plugin author. Export: `definePlugin`, `defineTool`, `defineAgent`, `definePrompt`, connector APIs.

### `@jiku/core`
Agent runtime utama. Yang penting:
- `JikuRuntime` — container, inject dependencies
- `AgentRunner` — eksekusi per conversation, streaming
- `PluginLoader` — 3-phase boot, topological sort
- `SharedRegistry` — storage tools + prompts
- `resolveScope()` — evaluasi policy rules
- `checkAccess()` — enforcement per tool call
- `buildSystemPrompt()` — compose system prompt dinamis
- Memory functions: config, scoring, builder, extraction

### `@jiku-studio/db`
Database layer. Key files:
- `src/schema/` — Drizzle table definitions
- `src/queries/` — Semua fungsi CRUD (agent, conversation, memory, policy, cron, filesystem, dll)

### `@jiku-studio/server`
HTTP API + runtime manager. Key:
- `src/routes/` — 24+ Express routers
- `src/runtime/manager.ts` — JikuRuntimeManager (instantiate runtime per project)
- `src/runtime/storage.ts` — StudioStorageAdapter (DB-backed storage)
- `src/runtime/stream-registry.ts` — Active run tracking
- `src/credentials/service.ts` — buildProvider(), dekripsi kredensial
- `src/cron/scheduler.ts` — CronTaskScheduler (croner-based)
- `src/filesystem/service.ts` — FilesystemService (S3-backed)

---

## Konvensi & Gotchas Penting

### Code
- **No `any`** — gunakan proper types atau `unknown` dengan narrowing
- **Static imports only** — `import()` dinamis tidak boleh di type signatures
- **Import dari `@jiku/ui` dulu** — cek UI package sebelum buat komponen custom
- **Zod v4** — hoisted di workspace root

### Plugin
- **`contributes` harus function** — wajib dibungkus arrow function
- **Declare `depends`** — harus eksplisit agar dependency ordering benar
- **Tool ID di-namespace** — `'create_post'` jadi `'jiku.social:create_post'` setelah plugin load

### Memory
- **`agent_self` terpisah** — persona memories tidak pernah dicampur dengan memory query biasa
- **Scope selalu eksplisit** — selalu pass `scope` saat query
- **Extraction adalah fire-and-forget** — tidak blocking HTTP response

### Streaming
- **AI SDK v6 pakai `message.parts[]`** — bukan `message.content` string
- **Tool parts perlu konversi** — format DB vs UI berbeda, pakai `dbPartsToUIParts()` saat load
- **Auth SSE via query param** — `?token=...` karena EventSource tidak bisa kirim header
- **Stream cleanup** — `modelCache.delete()` harus setelah stream selesai dikonsumsi

### Filesystem
- **Route filesystem adalah `/disk`** — bukan `/files`
- **S3 butuh `forcePathStyle`** — untuk kompatibilitas RustFS/MinIO
- **Content cache threshold 50KB** — file lebih besar selalu S3 round-trip
- **Attachments ≠ project_files** — konsep berbeda, tabel berbeda

---

## Limitasi Saat Ini

1. **Browser Automation** — Implementasi ada tapi GAGAL; akan dihapus sebelum MVP
2. **Tidak ada vector/embedding search** — Memory scoring hanya keyword + recency
3. **Runtime state in-memory** — StreamRegistry dan live-parts buffer hilang saat server restart
4. **No WebSocket** — HTTP streaming only
5. **Message tidak terenkripsi** — OK untuk MVP
6. **Single-region S3** — Tidak ada multi-region failover
7. **No rate limiting** — Belum ada batas per user/project

---

## Ringkasan 1 Paragraf

Jiku adalah platform multi-tenant untuk membangun dan menjalankan AI agent. Setiap perusahaan punya project yang berisi agent. Agent bisa dijalankan dalam mode chat (interaktif, real-time streaming) atau task (otonom, bisa dipicu oleh cron atau manual). Setiap agent punya model LLM sendiri (Anthropic/OpenAI/OpenRouter dengan kredensial terenkripsi), system prompt, tools (dari plugin), memory persisten (4 scope, scoring otomatis), dan policy akses. Runtime dikelola oleh `JikuRuntimeManager` yang menjalankan `AgentRunner` per conversation — membangun system prompt dinamis, mengelola memory, menjalankan LLM via Vercel AI SDK v6 dengan tool loop, dan menyimpan semua ke PostgreSQL. Frontend-nya adalah dashboard Next.js 15 dengan chat interface, run history, memory browser, file manager, dan semua settings. Seluruh sistem ditulis TypeScript, jalan di Bun, dan diorganisasi sebagai monorepo Bun workspaces.
