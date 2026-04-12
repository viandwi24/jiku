# Jiku — Codebase Overview

> Dokumen ini memberi gambaran menyeluruh tentang codebase Jiku untuk siapa pun — developer baru, kontributor, product owner, ataupun sekedar pembaca yang ingin memahami sistem. Baca dokumen ini dulu sebelum masuk ke detail teknis lain.
>
> **Tanggal analisis:** 2026-04-12
> **Branch:** main

---

## 1. Apa itu Jiku?

Jiku adalah **platform AI agent multi-tenant**. Artinya: sebuah sistem tempat perusahaan dapat membangun, men-deploy, dan mengelola AI agent mereka sendiri — lengkap dengan kepribadian (persona), memori, akses ke alat (tools), kendali perizinan, dan kemampuan berinteraksi dengan dunia luar (web, filesystem, webhook, dsb).

Jiku mendukung **dua mode interaksi**:

1. **Chat mode** — pengguna mengobrol langsung dengan agent, response streaming realtime.
2. **Task mode** — agent diberi goal dan bekerja otonom (dijadwalkan cron atau dipicu manual).

**Target audiens:**
- **SaaS builders** yang ingin menempelkan AI agent ke produknya.
- **Enterprise** yang butuh isolasi multi-tenant + access control granular.
- **Plugin developer** yang memperluas kemampuan agent (tool baru, connector, dll).

**Filosofi desain utama:** pemisahan tegas antara **runtime core** (zero-dependency, tidak tahu database/UI) dan **implementasi** (database, storage, API). Semua rule — perizinan, policy, tool availability — bersifat **data-driven**, bukan di-hardcode, sehingga bisa diubah runtime tanpa restart server.

---

## 2. Struktur Monorepo

Jiku adalah monorepo berbasis **Bun workspaces**:

```
jiku/
├── apps/
│   ├── studio/          Aplikasi utama (backend + frontend + DB)
│   └── playground/      Sandbox untuk testing lokal
├── packages/
│   ├── types/           @jiku/types     — Type definitions (zero deps)
│   ├── kit/             @jiku/kit       — SDK untuk plugin developer
│   ├── core/            @jiku/core      — Agent runtime (zero DB/UI)
│   ├── browser/         @jiku/browser   — Browser automation bridge
│   └── ui/              @jiku/ui        — React UI components (shadcn wrap)
├── plugins/             Built-in plugins (connector, cron, skills, dll)
├── infra/
│   └── dokploy/         Docker deployment config (self-hosted)
├── docs/                Dokumentasi (spec, arsitektur, plans, feats)
└── assets/              Aset statis
```

Tiap package punya tanggung jawab tunggal dan loose coupling.

---

## 3. Aplikasi Utama — `apps/studio`

Studio adalah produk utama Jiku. Terbagi tiga sub-aplikasi:

### 3.1 `apps/studio/db` — Database Layer
- **PostgreSQL** + **Drizzle ORM**.
- 20+ tabel: `companies`, `projects`, `agents`, `conversations`, `messages`, `memories`, `credentials`, `policies`, `cron_tasks`, `project_files`, `project_folders`, `attachments`, `skills`, `memberships`, dsb.
- Message parts disimpan sebagai JSONB (text, image, tool call).
- Soft-delete untuk conversation, optimistic locking (field `expected_version`) untuk filesystem writes.
- Folder `migrations/` berisi migration SQL lengkap.

### 3.2 `apps/studio/server` — Backend API

Express.js 5 + Hono 4 sebagai API layer. Pusat koordinasi semua subsistem.

**Konsep kunci:** `JikuRuntimeManager` — singleton yang membuat satu `JikuRuntime` per project secara lazy (on-demand). Runtime menampung plugin, tool registry, dan memory builder untuk project itu.

**Subsistem utama:**

| Subsistem | Fungsi |
|-----------|--------|
| **Runtime** | `AgentRunner` per conversation. Membangun system prompt, resolve tools, cek permission, streaming ke LLM. |
| **Credentials** | Enkripsi AES untuk API key (Anthropic, OpenAI, OpenRouter). |
| **Filesystem** | Virtual filesystem backed by S3/MinIO/RustFS. UUID-keyed, LRU cache (500 entries, 5min TTL), content cache ≤50KB, tsvector search + ILIKE fallback, async cleanup worker. Revisi v2 shipped 2026-04-10 (Plan 16). |
| **Browser** | Bridge ke Vercel `agent-browser` (Rust CDP client) di dalam Docker container. 33 action: navigate, click, fill, screenshot, cookies, tabs, eval, batch. Per-project mutex + per-agent tab affinity. |
| **Memory** | Memori persisten agent dengan 4 scope (agent_self, agent_caller, agent_global, runtime_global) dan 2 tier (core, extended). Scoring: keyword 0.5 + recency 0.3 + access 0.2. Ekstraksi memory async oleh LLM pasca-run. |
| **Cron** | Scheduler berbasis `croner` untuk task mode. |
| **Connectors** | Webhook inbound (Telegram + custom channel), tool `connector_send` & `connector_list`. |
| **Skills** | Knowledge base agent yang disimpan di filesystem virtual di path `/skills/{slug}/`. |
| **Policies** | Rule-based access control — dicek setiap tool invocation. |
| **MCP** | Model Context Protocol server integration. |

### 3.3 `apps/studio/web` — Frontend

Next.js 16 + React 19 + Tailwind CSS 4 + shadcn/ui. Streaming pakai Vercel AI SDK (`@ai-sdk/react`). State pakai TanStack Query.

**Hirarki navigasi:**
`Company → Project → Agent → Chat/Settings`

**Halaman utama:**
- **Agents**
  - `/agents` — daftar agent
  - `/agents/[agent]` — chat interface streaming
  - `/agents/[agent]/llm` — pilih model & credential
  - `/agents/[agent]/tools` — enable/disable tool
  - `/agents/[agent]/memory` — browse memori agent
  - `/agents/[agent]/task` — konfigurasi task mode & delegation
  - `/agents/[agent]/permissions` — permission set
  - `/agents/[agent]/usage` — token/biaya usage
- **Conversations**
  - `/chats` — list semua chat
  - `/chats/:id` — viewer + image gallery (fullscreen + minimap)
  - `/runs` — riwayat task run
- **Management**
  - `/disk` — file explorer filesystem virtual
  - `/cron-tasks` — scheduler UI
  - `/memory` — memory browser project-wide
  - `/plugins` — daftar plugin
  - `/channels` — connector
- **Settings** — credentials, filesystem, permissions, policies, MCP, browser automation (dengan live preview 16:9).

---

## 4. Packages

| Package | Isi | Untuk siapa |
|---------|-----|-------------|
| `@jiku/types` | Interface TypeScript: `AgentDefinition`, `ToolDefinition`, `PolicyRule`, `MessagePart`. Zero deps (kecuali `ai`). | Semua package. |
| `@jiku/kit` | Plugin SDK: `definePlugin()`, `defineTool()`, `defineAgent()`, connector helper. | Plugin developer. |
| `@jiku/core` | Runtime agent: `JikuRuntime`, `AgentRunner`, `PluginLoader`, `SharedRegistry`, `resolveScope()`, `checkAccess()`. Tidak tahu DB/UI — murni engine. | Internal (dipakai server). |
| `@jiku/browser` | Bridge ke `agent-browser` (Vercel, CDP), parser perintah, Dockerfile untuk container browser. | Internal. |
| `@jiku/ui` | Wrapper shadcn/ui. **Aturan proyek: pakai `@jiku/ui` dulu sebelum bikin komponen custom.** | Frontend. |

---

## 5. Daftar Fitur

Fitur-fitur yang sudah live (lihat juga `docs/feats/*.md`):

1. **Chat & Messages** — streaming SSE, message parts (text/image/tool), auto-title, soft-delete.
2. **Browser Automation** — 33 action lewat CDP; screenshot jadi attachment; live preview + debug panel di Settings.
3. **Chat Attachments** — upload gambar ke S3, per-conversation, gallery viewer dengan minimap.
4. **Filesystem** — virtual disk `/`, tools list/read/write/move/delete/search. Backed by S3.
5. **Memory System** — 4 scope × 2 tier, scoring hybrid, ekstraksi async.
6. **Persona** — identitas agent yang immutable, terpisah dari memory.
7. **Permissions & Policies** — rule data-driven, enforce per tool call, bisa di-update tanpa restart.
8. **Cron Tasks** — jadwalkan task dengan cron expression, trigger manual juga bisa.
9. **Task Heartbeat & Delegation** — task mode otonom, agent bisa delegasikan pakai tool `run_task`.
10. **Skills** — knowledge base files yang auto-seed saat agent dibuat.
11. **Connectors** — webhook inbound (Telegram, custom).
12. **Plugins Marketplace UI** — lihat/aktifkan plugin per project.
13. **Usage Monitoring** — tracking token & cost per agent.

---

## 6. Plugins System

Plugin adalah cara utama memperluas Jiku. Boot dalam 3 fase:

1. **Register** — load definisi, ambil metadata + dependency.
2. **Boot** — topological sort (Kahn's algorithm), panggil `setup()` sesuai urutan dependency.
3. **Activate** — tool siap dipakai di run berikutnya.

Tool ID dan permission otomatis di-prefix nama plugin (contoh: `create_post` → `jiku.social:create_post`).

**Built-in plugins** di folder `plugins/`:

| Plugin | Fungsi |
|--------|--------|
| `jiku.connector` | Webhook/channel adapter. |
| `jiku.cron` | Integrasi scheduler. |
| `jiku.skills` | Bridge skills ↔ filesystem. |
| `jiku.social` | Contoh plugin (social media tools). |
| `jiku.telegram` | Telegram connector. |

---

## 7. Tech Stack Singkat

| Lapisan | Teknologi |
|---------|-----------|
| Runtime | **Bun 1.3+** (wajib — bukan Node/npm/yarn) |
| Bahasa | TypeScript 5+ |
| Backend | Express 5 + Hono 4 |
| Database | PostgreSQL 15+ via Drizzle ORM |
| Frontend | Next.js 16, React 19, Tailwind CSS 4, shadcn/ui |
| AI | Vercel AI SDK v6, `@ai-sdk/anthropic`, `@ai-sdk/openai` |
| Validation | Zod v4 |
| Cron | croner v10 |
| Storage | S3 / MinIO / RustFS (path-style) |
| Browser | Vercel `agent-browser` (Rust CDP) di Docker |
| Streaming | HTTP SSE |

---

## 8. Alur Data Inti

**Hirarki domain:**
```
Company → Project → Agent → Conversation (chat | task)
              ↓
    Credentials, Memory, Filesystem, Policies, Plugins, Cron
```

**Chat flow:**
1. User kirim pesan → `POST /conversations/:id/chat`
2. Server load agent + caller → `JikuRuntimeManager.run()`
3. `AgentRunner` bangun system prompt, load memory, decrypt API key, panggil `streamText()` dengan tool loop.
4. LLM streaming response; setiap tool call dicek permission-nya; hasilnya disimpan ke DB.
5. Stream ke client via SSE.

**Task flow:**
1. Cron trigger (atau manual) → buat conversation bertipe `task`.
2. `AgentRunner` jalan otonom mengikuti goal.
3. Hasil disimpan, run count ditambah.

---

## 9. Pekerjaan Terbaru (State per 2026-04-10)

- **Plan 16 v2 — Filesystem Production-Scale** (2026-04-10): UUID-based S3 keys (move/rename = 0 S3 ops), LRU cache service, tabel `project_folders` untuk list O(1), optimistic locking, async cleanup & migration worker.
- **Plan 13/33 — Browser Rebuild** (2026-04-09): ganti Playwright headless dengan CDP bridge via Vercel agent-browser; Docker hardened (no-sandbox, dbus, readiness probe); live preview + debug panel; per-project mutex + per-agent tab affinity.
- Sebelumnya: cron task system, usage monitor, connector_list tool, conversation title generation + soft delete, task delegation, route security audit, chat attachments, skills integration (Plan 14).

Cek `docs/builder/current.md` untuk konteks aktif, `docs/builder/changelog.md` untuk history lengkap.

---

## 10. Infrastructure & Deployment

- `infra/dokploy/` — compose file untuk deploy via **Dokploy** (self-hosted PaaS).
- Container browser di-harden: `--no-sandbox`, Xvfb + Fluxbox + noVNC untuk live preview, dbus, readiness probe, per-process log.
- Tidak ada manifest Kubernetes — fokus self-hosted simple.

---

## 11. Konvensi & Gotchas Penting

- **Selalu `bun`**, jangan `node`/`npm`/`npx`/`yarn`.
- **Pakai `@jiku/ui` dulu** sebelum bikin komponen custom.
- **No dynamic `import()` di type signature** — static import saja.
- **No `any`** — pakai generic atau `unknown` dengan narrowing.
- **Route filesystem = `/disk`**, bukan `/files`.
- **Attachments ≠ project_files** — attachment itu gambar ephemeral di chat, project_files itu virtual filesystem persisten.
- **Content cache threshold 50 KB** — file lebih besar selalu round-trip ke S3.
- **Tool parts format berbeda** DB (`tool-invocation`) vs UI (`dynamic-tool`) — konversi via `dbPartsToUIParts()`.
- **Skills files source-of-truth-nya di filesystem**, bukan DB.
- **Concurrent write butuh `expected_version`** (optimistic locking).

---

## 12. Limitasi Saat Ini & Rencana Ke Depan

- Memory search masih keyword-based — belum ada embedding/vector search.
- `StreamRegistry` in-memory — hilang kalau server restart.
- Belum ada WebSocket (hanya HTTP SSE).
- Message belum di-encrypt (cukup untuk MVP).
- Belum ada rate limiting.
- Tool browser tidak bisa unregister tanpa restart.

---

## 13. Di Mana Harus Mulai Baca?

| Kalau kamu… | Mulai dari |
|-------------|------------|
| Mau paham produk | `docs/product_spec.md` |
| Mau paham arsitektur teknis | `docs/architecture.md` |
| Mau tahu apa yang lagi dikerjakan | `docs/builder/current.md` |
| Mau lihat backlog | `docs/builder/tasks.md` |
| Mau paham detail fitur tertentu | `docs/feats/<fitur>.md` |
| Mau tahu history perubahan | `docs/builder/changelog.md` |
| Mau bikin plugin | `packages/kit/` + plugin contoh di `plugins/jiku.social` |
| Mau oprek runtime | `packages/core/src/` |

---

**Ringkasan satu paragraf:** Jiku adalah platform AI agent multi-tenant modular berbasis Bun + TypeScript. Backend (Express/Hono + Drizzle/Postgres) menjalankan runtime agent zero-dependency (`@jiku/core`) yang dapat diperluas lewat plugin system (`@jiku/kit`). Frontend (Next.js + shadcn via `@jiku/ui`) menyediakan Studio lengkap untuk mengelola company → project → agent → conversation, dengan fitur chat streaming, task otonom, browser automation, virtual filesystem di S3, memory system bertingkat, permission data-driven, cron scheduler, connector webhook, dan skills. Semua subsistem sudah live & production-grade.
