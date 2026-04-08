# OpenClaw — Platform Overview

> Dokumen ini menganalisis codebase OpenClaw yang dijadikan referensi untuk pengembangan Jiku. Baca ini untuk memahami apa itu OpenClaw, bagaimana arsitekturnya, dan kenapa Jiku berbeda secara fundamental.

---

## Apa itu OpenClaw?

**OpenClaw** adalah **personal AI assistant platform** yang didesain untuk dijalankan oleh satu pengguna di device mereka sendiri. Bukan SaaS, bukan multi-tenant — ini adalah control plane lokal yang mengkoordinasikan AI agent dengan kemampuan akses ke dunia nyata (komputer, browser, device).

**Tagline:** *"The AI that actually does things"*

**Target Pengguna:**
- Individual/power user yang mau AI assistant yang benar-benar bisa mengerjakan task nyata
- Developer yang butuh AI dengan akses penuh ke machine mereka
- Orang yang mementingkan privasi (data tetap di device sendiri)

**Use Cases Utama:**
- Menjalankan AI yang bisa eksekusi task di komputer (buka browser, jalankan script, kirim pesan)
- Multi-channel inbox terpusat (WhatsApp, Telegram, Slack, Discord, dll — semua dijawab oleh AI)
- Automasi terjadwal (cron jobs berbasis AI)
- Integrasi device: macOS, iOS, Android bisa jadi "node" yang dikontrol

---

## Struktur Codebase

```
openclaw/
├── src/
│   ├── gateway/          # WebSocket control plane — inti dari segalanya
│   ├── agents/           # Agent runtime, tool execution, schemas
│   ├── channels/         # Core channel system + routing logic
│   ├── config/           # Config schema, validation, persistence (~40 type modules)
│   ├── cli/              # Entry point, command routing
│   ├── commands/         # Business logic tiap command
│   ├── plugin-sdk/       # Public contract untuk third-party plugins (40+ subpaths)
│   ├── plugins/          # Plugin discovery, registry, loader
│   ├── routing/          # Session/agent routing logic
│   ├── sessions/         # Session state management
│   ├── media/            # Media pipeline (image, audio, video)
│   ├── memory-host-sdk/  # Interface untuk memory/embedding engine
│   ├── mcp/              # MCP (Model Context Protocol) support
│   ├── wizard/           # Onboarding & setup wizard
│   ├── pairing/          # Device pairing protocol
│   ├── cron/             # Scheduled tasks
│   ├── secrets/          # Secret/credential management
│   ├── browser/          # Browser automation (CDP)
│   ├── canvas/           # Visual workspace (A2UI)
│   └── voice/            # Voice wake, PTT, talk mode
│
├── extensions/           # 100+ bundled plugin packages
│   ├── anthropic/        # Anthropic provider
│   ├── openai/           # OpenAI provider
│   ├── discord/          # Discord channel
│   ├── slack/            # Slack channel
│   ├── telegram/         # Telegram channel
│   ├── memory-lancedb/   # Vector memory backend
│   ├── memory-wiki/      # Knowledge base memory
│   └── ... (100+ lainnya)
│
├── ui/                   # Control UI (React/TypeScript/Vite)
│
└── apps/
    ├── macos/            # macOS menubar app (Swift/SwiftUI)
    ├── ios/              # iOS companion app
    └── android/          # Android companion app
```

---

## Tech Stack

| Komponen | Teknologi |
|---|---|
| Runtime | Node.js 22+ (TypeScript/ESM) |
| AI Agent Core | `@mariozechner/pi-agent-core` (Anthropic's Pi runtime) |
| Discord | discord.js |
| Telegram | grammY |
| Slack | @slack/bolt |
| WebSocket | ws |
| Schema Validation | TypeBox + Zod |
| Config Format | JSON5 (human-editable) |
| Memory | SQLite + vector extensions (LanceDB) |
| Testing | vitest |
| Build | Vite (UI), native Node.js (core) |
| macOS App | Swift/SwiftUI |
| iOS App | Swift |
| Android App | Kotlin |

---

## Fitur-Fitur

### Core

| Fitur | Deskripsi |
|---|---|
| Multi-channel inbox | 23+ platform pesan: WhatsApp, Telegram, Slack, Discord, Signal, Teams, IRC, Matrix, dll |
| AI agent (Pi runtime) | Task execution dengan tool streaming dan block streaming |
| Browser automation | Kontrol Chrome/Chromium dedicated, screenshot, form-filling |
| Canvas / Visual workspace | Agent-driven UI rendering (A2UI — Anthropic UI) |
| Voice mode | Wake word, PTT (macOS/iOS), continuous mode (Android) |
| Cron / Scheduled tasks | Task berbasis jadwal yang dieksekusi agent |
| Media pipeline | Transkrip gambar/audio/video, resize, MIME detection |
| Device control (nodes) | macOS: `system.run`, notifikasi, kamera, lokasi |

### Agent & Routing

| Fitur | Deskripsi |
|---|---|
| Multi-agent | Banyak named agent dengan workspace + session independen |
| Agent routing | Binding channel/account/peer ke agent tertentu |
| Session isolation | Main session, per-peer session, per-group session |
| Activation modes | `mention` (respond hanya kalau di-mention), `always` (respond selalu) |
| Queue modes | `off`, `on` (buffer saat thinking), `reply-back` (ack dulu baru balas) |
| Inter-agent tools | Agent bisa memanggil agent lain via tool `agent` |

### Skills & Tools

| Fitur | Deskripsi |
|---|---|
| Skills platform | Bundled, managed, dan workspace skills |
| Plugin system | 100+ bundled plugin, bisa tambah via npm |
| Tool streaming | Tools bisa stream hasil secara progresif ke agent |
| Tool gating | `ownerOnly` flag, action gates per session |
| Sandbox mode | Allowlist/denylist tools per session |

### Memory & Persistence

| Fitur | Deskripsi |
|---|---|
| Session transcripts | JSONL file per session, size-bounded dengan auto-pruning |
| Memory engine | Pluggable backend (LanceDB vector, Wiki, JSON) |
| Semantic search | Embedding-based memory retrieval |
| Per-session config | Model, thinking level, permissions — persist per session |
| Workspace state | Agent files (AGENTS.md, SOUL.md, TOOLS.md) di direktori |

### Security & Access

| Fitur | Deskripsi |
|---|---|
| DM pairing | Pairing code untuk kontak baru (default aman) |
| Allowlist | Kontrol siapa yang bisa kirim pesan |
| Owner vs non-owner | Owner = akses penuh, non-owner = tools dibatasi |
| Auth mode | Optional: password ATAU Tailscale identity |
| Secrets management | Env var → credential file → config (tidak hardcode) |

---

## Arsitektur: Cara Kerja Sistem

### Gateway — Pusat Segalanya

Gateway adalah WebSocket server yang jadi orkestrator utama. Semua aliran data lewat sini.

```
Gateway (WebSocket server)
├── Channel plugins terhubung ke sini
├── Agent runtime dipanggil dari sini
├── Tool execution dikelola di sini
├── Session state disimpan di sini
└── Config di-manage dari sini
```

### Plugin System

```
1. Config reference plugin (bundled atau npm spec)
2. Plugin Manifest Discovery → baca openclaw.plugin.json
3. Capability Registration → plugin register channels/providers/tools
4. Runtime Injection → plugin hooks dipanggil saat gateway boot
5. Runtime Sealing → setelah boot, tidak bisa tambah plugin baru (immutable)
```

### Agent Execution Model

Setiap agent punya:
- **ID + workspace directory** (`~/.openclaw/agents/{agentId}/`)
- **AGENTS.md** — system prompt
- **SOUL.md** — karakter/kepribadian (opsional)
- **TOOLS.md** — dokumentasi tools yang tersedia
- **skills/** — skill yang terinstall

Agent dijalankan via **Pi Runtime** (Anthropic's agent core) dengan RPC mode.

---

## Flow Utama

### Inbound Message (User Kirim Pesan)

```
Channel (WhatsApp/Telegram/dll)
    ↓
Channel Plugin Handler
    ↓
Route Resolution → agent + session key
    ↓
Session Envelope (metadata: sender, context, dll)
    ↓
Gateway.inboundMessage()
    ↓
Auto-reply? ATAU Queue untuk agent
    ↓
Agent Runtime (Pi core)
    ├── Assemble prompt (AGENTS.md + TOOLS.md + history)
    ├── Call Pi Runtime via RPC
    ├── Tool loop:
    │   ├── Agent request tool
    │   ├── Gateway validasi params (TypeBox)
    │   ├── Execute handler (with streaming)
    │   └── Feed result ke agent
    └── Generate reply
    ↓
Reply Chunking (sesuai limit channel)
    ↓
Channel Send Dispatch
    ↓
Channel Plugin Output Handler
    ↓
Terkirim ke pengguna
```

### Session Routing

```
(channel, account, peer) 
    ↓
resolve-route.ts
    ↓
Agent ID (dari binding rules atau default agent)
    ↓
Session Key = encode(agentId + channel + account + peer)
    ↓
Load/create session transcript
    ↓
Inject ke agent context
```

---

## Cara Kerja Tools

**Definisi Tool (TypeBox schema):**
```typescript
const myTool: AgentTool<TSchema, Result> = {
  name: "tool_name",
  description: "Human description",
  parameters: Type.Object({ ... }),
  handler: async (params) => { return result; }
}
```

**Kategori Tools:**
| Kategori | Deskripsi |
|---|---|
| Gateway Tools | Interaksi dengan channel, config, sessions |
| Provider Tools | Operasi spesifik provider |
| Channel Tools | Aksi spesifik channel |
| System Tools | Browser, canvas, nodes, cron |
| Plugin Tools | Tools dari third-party plugins |

**Tool Gating:**
- `ownerOnly` flag → hanya session owner yang bisa pakai
- Action gates → kontrol granular per tool per session
- Sandbox mode → allowlist/denylist per session

**Built-in Tools Penting:**
- `message` — kirim pesan ke channels
- `agent` / `agents_list` / `agents_history` — koordinasi antar agent
- `browser` — web automation
- `canvas` — render visual UI
- `cron` — jadwalkan tasks
- `nodes` — perintah device
- `image_generate`, `video_generate`, `music_generate` — media creation

---

## Persistence & Memory

### Session Transcripts
- **Lokasi:** `~/.openclaw/agents/{agentId}/sessions/{sessionId}.jsonl`
- **Format:** JSONL — tool calls, results, teks asisten, pesan user, metadata
- **Pruning:** Otomatis saat ukuran melebihi batas

### Memory Engine
- Pluggable via slot `memory-core` (hanya satu yang aktif)
- **LanceDB** — vector search, embedding-based
- **Wiki** — knowledge base
- Diakses via `memory-host-sdk` RPC interface

### Config Persistence
- **Lokasi:** `~/.openclaw/openclaw.json`
- **Format:** JSON5 (human-editable, bisa komentar)
- **Validasi:** Zod schemas
- **Cache:** Runtime snapshot dengan hash-based invalidation

### Credentials
- **Lokasi:** `~/.openclaw/credentials/`
- **Resolution:** env vars → credential file → config → default
- Tidak ada hardcoded secrets

---

## Model Akses: Single-User by Design

Ini poin terpenting. OpenClaw adalah **single-user system**:

```
Satu Gateway instance = Satu pengguna

├── "Owner" = user yang menjalankan Gateway = akses penuh ke semua tools
└── "Non-owner" = orang lain yang kirim pesan lewat channel = tools dibatasi
```

**Tidak ada:**
- User accounts atau registrasi
- Tenant isolation di level database
- RBAC (hanya owner vs non-owner)
- Billing per user / usage tracking per tenant
- SSO / OAuth / SAML
- Konsep "project" atau "company"

**Yang ada adalah multi dari sisi lain:**
- **Multi-channel** — satu user, banyak platform pesan
- **Multi-agent** — satu user, banyak named agent dengan tujuan berbeda
- **Multi-device** — macOS + iOS + Android bisa jadi "node" milik satu user
- **Multi-session** — satu agent, banyak thread percakapan (per channel/group)

---

## Perbandingan: OpenClaw vs Jiku

| Aspek | OpenClaw | Jiku |
|---|---|---|
| **Model Pengguna** | Single user per instance | Multi-tenant (Company → Project → Agent) |
| **Deployment** | Lokal di device user | Server terpusat |
| **Auth** | Optional password atau Tailscale | JWT, user accounts |
| **Isolasi** | File system + process | Database row-level per project |
| **Config** | JSON5 file di `~/.openclaw/` | Database (PostgreSQL) |
| **Data Residency** | Di device user | Di server vendor |
| **Skalabilitas** | Per-device (satu user) | Horizontal (banyak user/company) |
| **Billing** | Bayar langsung ke provider | SaaS subscription |
| **Extensibility** | Plugin npm packages | Plugin system internal |
| **Privasi** | Data lokal sepenuhnya | Data di server vendor |
| **Permissions** | Owner vs non-owner saja | Role-based RBAC, Policy rules |
| **Team Support** | Tidak ada | Core feature (project memberships) |
| **Audit Trail** | Tanggung jawab user | Managed vendor |
| **Device Control** | Ya (`system.run`, camera, dll) | Tidak (cloud-only) |
| **Browser Automation** | Ya (dedicated Chrome/CDP) | Pernah dicoba, gagal (marked for removal) |
| **Voice Mode** | Ya (PTT, wake word) | Tidak |
| **Mobile Apps** | Ya (iOS + Android native) | Tidak |
| **Memory Backend** | Pluggable (LanceDB, Wiki) | Built-in (PostgreSQL scoring) |

---

## Yang Menarik dari OpenClaw (untuk Referensi Jiku)

### Plugin SDK yang Matang
OpenClaw punya `plugin-sdk` dengan 40+ subpaths yang well-defined. Kontrak public yang jelas memungkinkan third-party plugin tanpa memodifikasi core. Ini berbeda dari Jiku yang lebih internal.

### Session Routing yang Fleksibel
Sistem binding `(channel, account, peer) → agent` sangat ekspresif. Bisa route grup ke agent berbeda, route DM ke agent berbeda — semua tanpa kode, cukup config.

### Tool Streaming
Tools bisa stream hasil secara progresif ke agent (bukan hanya return nilai final). Ini penting untuk task yang lama seperti browser automation.

### Skills Platform
Skills adalah file-based knowledge yang bisa diinstall, di-manage, dan di-assign ke workspace agent. Konsepnya mirip dengan skills di Jiku tapi dengan packaging yang lebih matang (npm-based).

### Memory Engine yang Pluggable
Satu slot `memory-core`, bisa diganti implementasinya (LanceDB untuk vector search, Wiki untuk knowledge base, dll). Jiku menggunakan scoring berbasis keyword di PostgreSQL — bisa belajar dari abstraksi ini.

### AGENTS.md / SOUL.md Pattern
System prompt agent disimpan sebagai file Markdown yang bisa diedit langsung. Ini lebih human-friendly daripada form input.

---

## Keterbatasan OpenClaw (Konteks Jiku)

1. **Single-user only** — tidak bisa scale ke team atau company
2. **Tidak ada isolasi data** — semua agent dan channel milik satu user
3. **Tidak ada billing/usage tracking per user** — tidak cocok untuk SaaS
4. **Config berbasis file** — tidak bisa dikelola via UI secara dinamis dari remote
5. **Tidak ada audit trail terstruktur** — hanya JSONL log
6. **Tidak ada rate limiting** — per-user atau per-group quota tidak ada
7. **Ketergantungan pada device lokal** — tidak bisa diakses dari mana saja tanpa setup Tailscale/tunnel
8. **No web-based management** — UI ada tapi terbatas, utamanya dikelola via config file

---

## Ringkasan 1 Paragraf

OpenClaw adalah personal AI assistant platform yang berjalan lokal di device pengguna. Satu Gateway instance per user, dengan 100+ plugin yang menghubungkan ke 23+ platform pesan (WhatsApp, Telegram, Slack, dll), browser automation via CDP, kontrol device macOS/iOS/Android, dan AI agent berbasis Pi runtime (Anthropic). Desainnya single-user-first: tidak ada multi-tenancy, tidak ada user accounts, hanya "owner" (user yang menjalankan) dan "non-owner" (orang lain yang chat). Yang "multi" adalah multi-channel, multi-agent, dan multi-device — semuanya tetap milik satu pengguna. Ini sangat berbeda dari Jiku yang didesain untuk Company → Project → Agent hierarchy dengan isolasi penuh antar tenant, RBAC, dan credential management terpusat.
