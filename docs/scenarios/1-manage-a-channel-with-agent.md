# Scenario 1 — Manage a Channel with an Agent

> **Status:** v4 — fondasi ter-implementasi
> **Tanggal:** 2026-04-14
> **Tujuan:** memvalidasi apakah arsitektur Jiku saat ini bisa menjalankan skenario **"mengelola satu channel (Telegram group / forum topic / social) menggunakan agent Jiku"** secara end-to-end, dan mencatat gap + ide perbaikannya.
>
> **Update 2026-04-14 sesi sore** — keempat gap 🔴 High di §9 sudah di-ship end-to-end (lihat `docs/builder/changelog.md` entry "Scenario 1 foundations"). Dokumen ini sekarang jadi referensi desain; status implementasi ter-tandai di §8 dan §9.

Dokumen ini adalah notulensi diskusi — mendeskripsikan skenario konkret, memetakan tiap langkah ke kapabilitas Jiku yang sudah ada, lalu merumuskan fitur baru yang perlu ditambahkan supaya skenario jalan dengan bersih.

---

## Daftar Isi

1. [Ringkasan Eksekutif](#1-ringkasan-eksekutif)
2. [Persona & Aktor](#2-persona--aktor)
3. [Gambaran Besar](#3-gambaran-besar)
4. [Flow A — Channel Management Dasar](#4-flow-a--channel-management-dasar)
5. [Flow B — Marketing Terjadwal + Self-Improvement](#5-flow-b--marketing-terjadwal--self-improvement)
6. [Fitur Baru yang Diusulkan](#6-fitur-baru-yang-diusulkan)
   - [6.1 Commands (User-Triggered Slash)](#61-commands-user-triggered-slash)
   - [6.2 Reference Hint Provider (`@file`)](#62-reference-hint-provider-file)
   - [6.3 Filesystem Tool Permission via Metadata](#63-filesystem-tool-permission-via-metadata)
7. [Pemetaan Kapabilitas Jiku](#7-pemetaan-kapabilitas-jiku)
8. [Matriks Coverage per Step](#8-matriks-coverage-per-step)
9. [Gap & Rencana Perbaikan](#9-gap--rencana-perbaikan)
10. [Rekomendasi Urutan Eksekusi](#10-rekomendasi-urutan-eksekusi)
11. [Referensi](#11-referensi)

---

## 1. Ringkasan Eksekutif

Skenario ini menguji seberapa dekat Jiku dengan visinya sebagai platform agent otonom yang bisa dipercaya mengelola permukaan publik (channel komunitas, group marketing, forum). Hasil analisis:

- **Tulang punggung sudah ada** — connector, binding, persona, skills, cron task, heartbeat, memory, audit, usage tracking semuanya production-grade.
- **Coverage saat ini: ~90%** (naik dari 70% di v3, sedikit turun dari 95% karena gap disk media upload §9.E teridentifikasi). Skenario Flow A jalan clean; Flow B jalan kecuali jalur asset media harus sementara fallback ke Telegram saved messages.
- **Empat fitur fondasi yang sebelumnya 🆕 sudah di-ship 2026-04-14:**
  1. ✅ **Commands system** — user-triggered `/slash` FS-first. Mirror arsitektur Skills. Dispatcher live di chat + task + cron + heartbeat surface. Connector-inbound dispatcher ditunda (backlog, alasan keamanan).
  2. ✅ **Reference hint provider `@file`** — scanner + injector `<user_references>` dengan size + mtime + flag LARGE. Wired di 4 surface.
  3. ✅ **Filesystem tool permission via metadata** — `tool_permission` di `project_files` + `project_folders`, resolver inheritance walk, gate di `fs_write`/`fs_edit`/`fs_append`/`fs_move`/`fs_delete`, UI context menu + badge.
  4. ✅ **Connector custom params + hint injection** — `getParamSchema()` di `ConnectorAdapter`, `params` pass-through di `ConnectorContent`, Telegram declare 7 params, `connector_list` surface `param_schema` per-connector.
- **Gap baru teridentifikasi (🔴 High):** §9.E **Disk Media Upload** — virtual disk belum terima upload binary (jpg/png/webp/gif/svg/mp4/mov/mkv/mp3/pdf dll). Blocker untuk Flow B marketing yang butuh asset visual versioned di `/assets/marketing/`.
- **Nice-to-have** (bukan blocker untuk skenario jalan): moderation rule declarative, approval workflow outbound, per-channel dashboard, multi-channel broadcast, per-channel rate limit. Tidak berubah dari v3.

---

## 2. Persona & Aktor

| Aktor | Peran | Akses |
|---|---|---|
| **Admin / Owner** | Setup connector, agent, binding, plan, cron. | Superadmin / admin role |
| **Agent "Aria"** | Persona AI yang di-bind ke channel. Handle reply, moderasi, rekap, marketing. | Agent config di project |
| **Member channel** | User di Telegram group/topic. Kadang belum dikenal identity-nya. | Mapped via `connector_identities` |
| **Moderator manusia** (opsional) | Approver konten sensitif / broadcast. | Role `manager` |

---

## 3. Gambaran Besar

> **"Saya (Admin) punya 1 Telegram group komunitas dev. Saya ingin 1 agent bernama Aria yang:**
>
> 1. Online sebagai bot, jawab saat di-mention atau di-reply.
> 2. Moderasi pesan — flag yang melanggar guideline, eskalasi ke admin.
> 3. Tiap Senin 09:00 posting rekap diskusi minggu lalu.
> 4. Heartbeat tiap 6 jam: cek pertanyaan menggantung.
> 5. Jalankan pesan marketing terjadwal (09:00, 12:00, 15:00, 18:00) berdasarkan plan yang saya tulis bersama agent.
> 6. Self-improve: baca laporan penjualan & member join, revisi jadwal / pesan untuk iterasi berikutnya.
> 7. Admin bisa approve pesan sensitif sebelum terkirim."

Skenario di-split jadi dua flow:

- **Flow A** — channel management dasar (#1–#4).
- **Flow B** — marketing terjadwal + self-improvement (#5–#6), dengan approval gate (#7) mewarnai keduanya.

---

## 4. Flow A — Channel Management Dasar

### 4.1 Langkah End-to-End

**Step 1 — Connect channel.** Admin buka `/channels/new`, paste Telegram bot token, promote bot admin di group. Bot auto-register `connector_target` (ADR-057); forum topic ter-detect sebagai scope terpisah.

**Step 2 — Define persona "Aria".** Admin buat agent, isi persona tab (tone, do/don't). Persona seed ke `agent_self` memory, di-inject sebagai `## Who I Am`. Agent bisa evolve sendiri via `persona_update`.

**Step 3 — Assign skills & tools.** Enable tool `jiku.telegram:*`. Assign skill moderasi + summarization. Mode `manual` atau `all_on_demand`.

**Step 4 — Binding + trigger rule.** Binding `channel=DevCommunity, agent=Aria, trigger=mention|reply, scope=group+topic`. 5 trigger modes tersedia (`always`, `command`, `keyword`, `mention`, `reply`). Context injection otomatis (chat id, sender, topic title, locale).

**Step 5 — Moderation rules.** Saat ini: ditulis dalam persona Aria (prompt-based). Titik lemah — belum ada declarative rule builder (lihat §9.A).

**Step 6 — Rekap Senin 09:00.** Cron Task `0 9 * * 1`, prompt ambil event minggu lalu via `connector_get_events`, buat rekap, kirim ke `#general`. Delivery composition (ADR-062) izinkan agent emit `connector_send_to_target`.

**Step 7 — Heartbeat 6 jam.** Heartbeat cron di agent config. Prompt: cek pertanyaan unanswered >2 jam, reply atau eskalasi. Agent tahu trigger context (ADR-063).

**Step 8 — Review & audit.** Audit Log, Connector Event Log, Usage dashboard.

### 4.2 Yang Sudah Mulus

- Connector + binding + trigger mode lengkap.
- Persona + skills loader + eligibility gating stabil.
- Cron task + heartbeat jalan di background dengan context-aware prompt.
- Audit log & usage tracking mencakup semua tool invocation.

### 4.3 Yang Masih Terasa Manual

- Moderasi full prompt-based (cukup untuk MVP, nice-to-have declarative rule).
- Outbound langsung terkirim — tidak ada approval gate (cukup untuk MVP, nice-to-have kalau kebutuhan trust naik).
- Review tersebar di banyak page (nice-to-have: per-channel dashboard).
- Pesan tidak bisa pakai Markdown / reply-to / format Telegram spesifik kalau param adapter belum ter-expose (butuh §9.D).

---

## 5. Flow B — Marketing Terjadwal + Self-Improvement

### 5.1 Bentuk Ideal

1. User **bersama agent** susun `plans/marketing-channel.md` — jadwal (jam:pesan), varian, aset, target metric.
2. Plan di-commit ke virtual disk project — source of truth, versioned.
3. **Cron task** trigger command pada jam tertentu. Prompt cron singkat:

   ```
   /marketing-channel-execute "eksekusi pesan marketing jam 15.00"
   ```

4. System resolve command dari `commands/marketing-channel-execute.md`, baca body-nya, inject sebagai instruksi awal. Body-nya mereferensikan `@plans/marketing-channel.md` — sistem deteksi pola `@file`, verifikasi keberadaannya, inject **notice singkat** ke agent bahwa file itu ada dan relevan (bukan inject isi penuh — hemat token).
5. Agent baca plan via `fs_read` sesuai kebutuhan, cari slot jam 15:00, kirim pesan + asset lewat `connector_send_to_target`, append hasil ke section Log di plan.
6. **Laporan penjualan & member-join** disimpan di `reports/` (upload Admin atau auto-generate plugin). Agent baca periodik.
7. **Self-improvement**: agent revisi jadwal/pesan berdasarkan insight, tulis proposal ke section "Revision Log" di plan dengan status `proposed`. Eskalasi ke admin via DM. Admin approve → status `applied`, schedule aktif berubah. **Tanpa approval, revisi tidak diterapkan** (safety).

### 5.2 Anatomi File

```
/commands/
  marketing-channel-execute.md   # SOP eksekusi (atau folder dengan COMMAND.md + references/)
  marketing-review.md            # SOP self-improvement

/plans/
  marketing-channel.md           # jadwal + pesan + revision log + execution log

/reports/
  sales-2026-W15.md              # laporan penjualan (upload atau plugin-generated)
  member-join-daily.md           # agent-maintained
```

**`commands/marketing-channel-execute.md` (contoh):**

```markdown
---
name: "Marketing Channel Execute"
description: "Eksekusi posting marketing terjadwal berdasarkan plan + argumen user"
args:
  - name: raw
    description: "Instruksi natural dari user / cron. Biasanya menyebut jam target."
---

# Marketing Channel Execute

Kamu eksekusi marketing untuk channel DevCommunity.

Baca @plans/marketing-channel.md untuk jadwal dan pesan.

Langkah:
1. Parse section "Schedule" di plan.
2. Dari instruksi user (`{{args.raw}}`), tentukan jam target.
3. Ambil pesan + asset untuk slot jam tersebut.
4. Kirim via `connector_send_to_target(target='#DevCommunity', ...)`.
5. Append ke section "Log" di plan: `[HH:mm] dikirim — <summary>`.
6. Kalau slot menyebut A/B, rotate variant berdasarkan Log.
```

**`plans/marketing-channel.md` (sketsa):**

```markdown
# Marketing Channel Plan — Q2 2026

**Default channel:** `#DevCommunity`

## Schedule
| Jam | Tipe | Pesan | Asset |
|---|---|---|---|
| 09:00 | good-morning | "Selamat pagi builders..." | — |
| 12:00 | tips | A/B variants | `assets/tips-{n}.jpg` |
| 15:00 | community-spotlight | rotate member | — |
| 18:00 | cta | weekly CTA | — |

## Revision Log
- 2026-04-14 [applied] Tambah slot 18:00 setelah W14 tunjukkan engagement malam tinggi.

## Execution Log (auto-appended)
- 2026-04-14 15:00 — dikirim "community-spotlight: @alicia ..."
```

**Cron entry:**
```
Expression: 0 15 * * *
Prompt:     /marketing-channel-execute "eksekusi pesan marketing jam 15.00"
Agent:      Aria
```

### 5.3 Aset (Foto / Media)

Opsi penyimpanan:

- **Virtual disk** (`/assets/marketing/`) — versioned di repo, cocok kalau asset stabil.
- **Telegram saved messages** — cocok kalau tim design rotate asset langsung dari Telegram. Agent fetch via `connector_run_action('fetch_media')`.
- **Object storage eksternal** — belum didukung first-class, perlu plugin baru.

Rekomendasi MVP: virtual disk untuk struktur + Telegram saved messages untuk rotasi sering. Path di plan tentukan sumbernya.

### 5.4 Self-Improvement Loop

Command kedua `/marketing-review` dipicu weekly (atau on-demand):

1. Baca `@reports/sales-*.md` dan `@reports/member-join-*.md` terbaru.
2. Hitung engagement per slot (execution log vs member-join delta).
3. Kalau ada slot performa <threshold, propose revisi.
4. Tulis ke `plans/marketing-channel.md` section "Revision Log" dengan status `proposed`.
5. DM admin via connector. Admin reply `/approve revision-id` atau `/reject` → agent flip status, update Schedule.

---

## 6. Fitur Baru yang Diusulkan

Dua fitur ini **belum ada** di Jiku. Keduanya shared subsystem — tidak eksklusif untuk skenario channel marketing, tapi skenario ini kebutuhan pertama yang men-drive mereka.

### 6.1 Commands (User-Triggered Slash)

**Ide:** sistem FS-first mirror arsitektur Skills, tapi dengan trigger eksplisit via prefix `/`. **User** yang panggil (atau cron / task / heartbeat atas nama user), bukan agent autonomous pick.

**Perbedaan dengan Skills:**

| Aspect | Skills | Commands |
|---|---|---|
| Triggered by | Agent (autonomous pick) | User (explicit `/slug`) |
| Entry file | `SKILL.md` | `COMMAND.md` atau `commands/<slug>.md` |
| Folder | `/skills/<slug>/` | `/commands/<slug>/` atau file tunggal |
| Args | — | Optional schema via frontmatter |
| Prompt injection | Progressive disclosure (XML hint) | Full body injected saat invoke |
| Eligibility | Strict (gate agent autonomy) | Lebih longgar (user tahu konteks) |
| Access mode | `manual` / `all_on_demand` | Sama |
| Storage | `project_skills`, `agent_skills` | `project_commands`, `agent_commands` (new) |

**Bentuk file:**

```
/commands/marketing-channel-execute.md             # file tunggal, OK
/commands/marketing-channel-execute/
  COMMAND.md                                       # folder — saat perlu reference files
  references/tone-guide.md
```

**Frontmatter format:**

```yaml
---
name: "Marketing Channel Execute"
description: "Eksekusi marketing terjadwal"
tags: [marketing, channel]
args:
  - name: jam
    type: string
    required: false
  - name: raw
    description: "Sisa string bebas kalau tidak ada schema"
metadata:
  jiku:
    emoji: "📣"
    requires:
      permissions: [connector:send]
    entrypoint: COMMAND.md
---

body instruksi agent...
```

**Dispatcher flow:**

1. Detect prefix `/` di karakter pertama input.
2. Resolve slug via `CommandLoader` (project → agent allow-list → plugin source).
3. Parse args sesuai schema (fallback: raw string ke `{{args.raw}}`).
4. Eligibility check (OS/bins/env/permissions/config) — mirror Skills.
5. Inject body sebagai instruksi awal di conversation turn.
6. Audit `command.invoke { slug, source, args, caller, surface }`.
7. Gagal resolve → fallback ke raw input biasa (`/foo` literal, bukan error).

**Scope trigger:** chat input user, cron prompt, task prompt, heartbeat prompt, command body. Connector inbound message → gated permission (supaya member eksternal tidak sembarangan invoke `/deploy-prod`).

**Storage model (mirror `project_skills`):**

- Tabel `project_commands`: `(project_id, slug, source, manifest, manifest_hash, active, last_synced_at)`. Unique `(project_id, slug, source)`.
- Tabel `agent_commands`: `(agent_id, slug, source, pinned)` — per-agent allow-list.
- Field `agents.command_access_mode` default `'manual'`.

**UI di Studio:** mirror menu Skills.
- `/projects/:pid/commands` — list, badge source, import ZIP/GitHub, refresh.
- `/projects/:pid/agents/:aid/commands` — per-agent allow-list + access mode control.
- Agent overview page — section "Commands" di samping "Skills".

**Loader & code reuse:** `CommandLoader` bisa share ~70% code dengan `SkillLoader` — factoring ke base `ManifestLoader<T>` dengan parameter berbeda (entrypoint name, table name, registry).

**Reference resolution di dalam body:** tidak ada resolver khusus. Body bisa menulis `@plans/foo.md` — di-handle oleh subsystem §6.2 di bawah (bukan bagian dari Commands itu sendiri).

### 6.2 Reference Hint Provider (`@file`)

**Ide:** ringan. Tidak eager-inject konten file. Pre-prompt scan pattern `@path`, verifikasi keberadaan + permission di workspace, inject **notice singkat** ke agent bahwa file tersebut ada dan boleh dibaca. Agent tetap baca konten on-demand via `fs_read` standar.

**Kenapa bukan eager expand:**

| Aspect | Eager expand | Hint provider (pilihan) |
|---|---|---|
| Token cost | Selalu bayar konten semua `@file` | Cuma bayar metadata ringkas |
| File besar | Perlu truncate, rawan kehilangan konteks | Tidak masalah — agent pilih baca sebagian via offset |
| File banyak | Prompt membengkak | Hint tetap singkat |
| Agent flexibility | Terpaksa terima apa yang di-expand | Agent decide baca penuh / sebagian / skip |
| Konsistensi dengan pola Jiku | Break "progressive disclosure" | Sejalan — sama seperti Skills hint |

**Flow:**

```
Input teks (command body + user args)
        ↓
[1] Scanner — regex /@([^\s@][^\s]*)/, strip trailing punctuation
        ↓
[2] Resolver — workspace-root default, relative-prefix (./, ../), tolak escape workspace
        ↓
[3] Validator — exists, readable, permission check, dedupe
        ↓
[4] Manifest: [{ path, status, size?, lines?, mtime? }, ...]
        ↓
[5] Injector — render satu blok <user_references> ringkas
        ↓
Agent runner
```

**Contoh output ke LLM:**

```xml
<user_references>
User / konteks sedang mereferensikan file-file berikut dari disk workspace.
File-file ini tersedia dan relevan — gunakan tool `fs_read` untuk membaca
isinya sesuai kebutuhan task.

- plans/marketing-channel.md (2.8KB, 84 baris, diubah 2026-04-14)
- reports/sales-2026-W15.md (1.2KB, 40 baris)

Catatan: file berikut disebut tapi tidak dapat diakses:
- plans/draft.md — tidak ditemukan
</user_references>
```

Body asli (berisi `@plans/marketing-channel.md`) tetap utuh — agent lihat mention dari user + notice konfirmasi.

**Sumber scan:**
- ✅ Command body saat dispatcher load
- ✅ User chat input
- ✅ Cron / task / heartbeat prompt
- ✅ Connector inbound (file shared open antar members — gating tidak diperlukan untuk sekarang)

**Aturan resolusi path:**
- `@x/y` → dari workspace root (default, predictable).
- `@./x`, `@../x` → relative ke file pemanggil atau cwd conversation.
- `@/abs` → dari workspace root.
- Tolak path yang escape workspace via `..`.
- Tolak binary file di manifest (hint-nya jadi membingungkan). Biarkan agent `fs_read` binary kalau butuh.

**Budget & safety:**
- Manifest cap: 20 file per invocation. Lebih dari itu → hint "list terlalu panjang, sebutkan spesifik".
- Tidak baca konten file di tahap ini (cuma `stat`) → operasi ringan.
- Size cap tidak diperlukan untuk hint.
- File besar (>1MB) → tag `large: true` di notice supaya agent sadar pakai offset/range.

**Edge cases:**
- `@alice` (username) tanpa path-like chars → resolve gagal → abaikan tanpa error.
- `\@foo` → literal, tidak di-scan.
- Glob (`@plans/*.md`) → **tidak support** di MVP; exact path saja.
- Directory (`@plans/`) → bisa di-hint sebagai "N file, total X". Nice-to-have, bukan MVP.

**Audit:** `reference.scan { matches, ok, denied, not_found }` — satu event per invocation, ringan.

**Relasi dengan Commands:** subsystem **terpisah** tapi bekerja bersama. Commands load body → `@file` di body di-scan oleh provider ini. Tapi provider ini juga aktif di chat biasa / cron prompt tanpa Commands.

### 6.3 Filesystem Tool Permission via Metadata

**Ide:** setiap file dan folder di virtual disk punya metadata (sudah ada — pakai slot yang tersedia di FS service). Salah satu field metadata = **permission flag untuk filesystem tools**. Default `read+write`. User bisa set `read` via disk file explorer UI. Flag di-enforce **di layer FS tool** (mis. `fs_write`, `fs_delete`, `fs_move`) — bukan at rest; file tetap bisa dibaca + dibagi terbuka antar member.

**Karakteristik:**

- **Scope enforcement:** hanya ke filesystem tools yang dipakai agent (atau caller lain lewat tool). File explorer manual user **tidak** terkena — user masih bisa edit langsung dari UI (mereka sumber otoritas yang set flag).
- **Inheritance:** flag di folder parent meng-override children. Set `/plans/` → `read` → semua di bawahnya (`/plans/marketing-channel.md`, `/plans/marketing/index.md`, `/plans/archive/2025/Q4.md`) otomatis ikut read-only untuk tool.
- **Override ke bawah:** anak bisa di-set lebih ketat dari parent (parent `read+write`, anak spesifik `read`). Anak **tidak bisa** lebih longgar dari parent (parent `read` maka anak tidak bisa `read+write`) — konsisten dengan inheritance model seperti POSIX dan cloud ACL.
- **Tidak ada tiers** lain untuk MVP — hanya `read+write` vs `read`. Nanti bisa tambah `none` (agent tidak bisa baca juga — kalau ada use case).

**Bentuk metadata (konseptual):**

```jsonc
// metadata entry per file/folder
{
  "path": "/plans",
  "type": "folder",
  "tool_permission": "read",       // <-- field baru. null = inherit, "read"/"read+write" = explicit
  "tool_permission_source": "user", // "user" | "inherited" | "default"
  "updated_by": "user_123",
  "updated_at": "2026-04-14T..."
}
```

**Resolver (efektif permission untuk path X):**

1. Cek metadata path X. Kalau `tool_permission` explicit → pakai itu.
2. Kalau `null` / inherit → traverse parent, ambil explicit terdekat.
3. Kalau sampai root tidak ada → fallback default `read+write`.
4. Cache hasil resolve dengan invalidation saat metadata parent berubah.

**Enforcement di FS tool:**

```
tool call: fs_write(path="/plans/marketing-channel.md", content=...)
        ↓
[1] Resolve effective permission untuk path
    → walk up: /plans/marketing-channel.md (null) → /plans (read) → STOP
    → effective = "read"
        ↓
[2] Cek permission vs operation
    write operation + effective="read" → BLOCK
        ↓
[3] Return error ke agent:
    "Access denied: /plans is read-only for tools (set by user).
     Hint: tulis ke path di luar /plans atau minta user ubah permission."
        ↓
[4] Audit: fs.permission_denied { path, operation, effective_permission, source_path }
```

Operasi yang di-guard: `fs_write`, `fs_delete`, `fs_move`, `fs_mkdir` (destructive terhadap path target), `fs_append`. Read operasi (`fs_read`, `fs_list`, `fs_stat`) **selalu boleh** — konsisten dengan "file shared open".

**UI Disk File Explorer:**

- Context menu pada file/folder → "Permission for tools" → dropdown `Read + Write (default)` / `Read only`.
- Indikator visual: folder/file dengan flag eksplisit → badge 🔒 atau label "read-only for tools".
- Hover info: sumber permission (`explicit` / `inherited from /plans`).
- Bulk set: select multiple, apply flag sekaligus.

**Relevansi untuk skenario:**

- `/plans/marketing-channel.md` — wajar di-set **read+write** karena agent perlu append ke section Log + Revision Log. Biarkan default.
- `/reports/` — di-set **read only** untuk tools. Laporan penjualan / member-join adalah data ground-truth yang **tidak boleh** di-overwrite agent. Agent hanya boleh baca untuk review + self-improve.
- `/commands/` dan `/skills/` — bisa di-set **read only** supaya agent tidak sembarang edit SOP-nya sendiri. Hanya user yang kelola lewat UI atau export/import.

**Interaksi dengan `@file` hint (§6.2):**

Reference hint **tidak perlu** tahu soal tool permission — hint cuma soal "file ada atau tidak". Saat agent coba `fs_write` ke path read-only setelah dapat hint, error muncul di level tool call — konsisten dan tidak duplikat logic.

**Interaksi dengan layer permission lain (Policies, Plugin Permissions):**

Tool permission FS = **layer baru** di atas mereka. Urutan evaluasi:

1. Policy (resource/subject/effect) — apakah caller boleh invoke tool?
2. Plugin permission (binary capability grant) — apakah agent punya kapabilitas FS?
3. **FS path permission** (baru) — apakah path target writable untuk tools?

Ketiganya `AND` — harus lolos semua.

**Storage:**

Tidak perlu tabel baru kalau metadata FS sudah ada infrastruktur-nya. Tinggal tambah kolom / field JSON di metadata entry. Migrasi ringan.

**Audit event:**

- `fs.permission_set { path, permission, scope: 'self' | 'inherited', set_by }` — saat user ubah di UI.
- `fs.permission_denied { path, operation, effective_permission, source_path, caller }` — saat tool call ditolak.

**Edge cases:**

- Symlink / binding: ikuti path resolve akhir (follow symlink untuk permission check). Simple MVP: resolve sebelum enforcement.
- Race: user ubah permission sementara agent sedang `fs_write` batch. Enforcement per-operation, bukan per-batch → aman.
- Rename parent: metadata ikut path baru; re-resolve children saat rename. Ini seharusnya sudah di-handle FS service existing saat rename.

---

## 7. Pemetaan Kapabilitas Jiku

### 7.1 Yang Sudah Ada

| Kategori | Kapabilitas | Status |
|---|---|---|
| **Connector** | Telegram adapter, event routing, auto-register target (ADR-057), forum topic scope | ✅ |
| **Binding** | 5 trigger modes, scope-aware, context injection XML | ✅ |
| **Agent autonomy** | Cron task, task mode (`run_task`), heartbeat, context-aware trigger (ADR-063) | ✅ |
| **Identity** | Pending/approved/blocked lifecycle, per-binding member_mode | ✅ |
| **Permissions** | Policies (Layer 2), plugin permissions (Layer 3), rate limiting global | ✅ |
| **Memory** | 4 scopes, 2 tiers, hybrid relevance, dreaming | ✅ |
| **Persona** | Seed → `agent_self`, self-evolve via `persona_update` | ✅ |
| **Skills** | FS + plugin, eligibility gating, progressive disclosure, per-agent access mode | ✅ |
| **Observability** | Audit log, connector event log (SSE), usage monitor | ✅ |

### 7.2 Yang Baru (Diusulkan di §6)

| Kategori | Kapabilitas | Status |
|---|---|---|
| **Commands** | User-triggered `/slash`, FS + plugin, mirror Skills architecture | 🆕 |
| **Reference hints** | `@file` scanner + validator + notice injector | 🆕 |
| **FS tool permission** | Per-file/folder read-only flag via metadata, inherited | 🆕 |

---

## 8. Matriks Coverage per Step

Legenda: ✅ Full · ⚠️ Partial · ❌ Missing · 🆕 Butuh fitur baru (sudah tidak dipakai di v4 — semua 🆕 v3 sudah ship)

### 8.1 Flow A

| Step | Coverage | Catatan |
|---|---|---|
| Connect channel | ✅ | Telegram auto-register |
| Define persona | ✅ | Memory seed |
| Assign skills & tools | ✅ | Per-agent mode |
| Binding + trigger | ✅ | 5 trigger modes + scope |
| Moderation rules | ⚠️ | Prompt-based saja — cukup untuk sekarang (§9b Nice-to-have) |
| Rekap mingguan cron | ✅ | |
| Heartbeat unanswered | ✅ | |
| Human approval outbound | ⚠️ | Tidak ada gate — trust ke persona + audit post-facto (§9b Nice-to-have) |
| Reply format (Markdown, reply-to) | ✅ | Connector custom params: `params:{reply_to_message_id, parse_mode, ...}` + per-connector `param_schema` di `connector_list` |
| Review & audit | ⚠️ | Tersebar di beberapa page — cukup untuk sekarang (§9b Nice-to-have) |

### 8.2 Flow B

| Step | Coverage | Catatan |
|---|---|---|
| Plan file di FS | ✅ | Virtual disk + `fs_read` |
| Command `/marketing-channel-execute` | ✅ | Commands system — dispatcher live di chat/task/cron/heartbeat |
| `@plans/...` di command body | ✅ | @file reference hint — scanner inject `<user_references>` block |
| Cron trigger dengan SOP | ✅ | Cron prompt `/slug` → dispatcher resolve body + `<command_args>` |
| Kirim pesan ke channel | ✅ | `connector_send_to_target` |
| Format pesan (Markdown, media, reply-to) | ✅ | Connector custom params |
| Aset / foto di virtual disk | 🆕 | Butuh §9.E — saat ini disk belum terima upload media binary |
| Aset / foto via Telegram saved messages | ✅ | Fallback sementara via `connector_run_action('fetch_media')` |
| Append log ke plan | ✅ | `fs_append` |
| Baca laporan | ✅ | `fs_read` dari `/reports/` |
| Proteksi `/reports/` dari overwrite | ✅ | FS tool permission — set folder `tool_permission='read'` via file explorer context menu |
| Self-revise plan | ✅ | `fs_write` / `fs_edit` ke Revision Log — `/plans/` default `read+write` |
| Approval revisi ke admin | ⚠️ | Manual DM ke admin — cukup untuk MVP (§9b Nice-to-have) |
| Multi-channel broadcast | ⚠️ | Eksplisit per target — cukup untuk MVP (§9b Nice-to-have) |

---

## 9. Gap & Rencana Perbaikan

**Status per 2026-04-14 sesi sore — keempat item 🔴 High sudah SHIPPED.** Detail desain tetap disimpan sebagai referensi; subseksi "Ship notes" mencatat deviasi dari rencana awal.

### §9.A — Commands System ✅ SHIPPED
**Prioritas awal:** 🔴 High
**Masalah:** tidak ada mekanisme FS-first user-triggered. Setiap cron / task prompt harus copy-paste SOP panjang → drift, hard to maintain.
**Ide:** implement sesuai §6.1. Mirror arsitektur Skills, reuse loader code.

**Ship notes:**
- Migrasi `0030_plan24_commands.sql` (archival filename preserved; tabel `project_commands`, `agent_commands`, kolom `agents.command_access_mode`).
- Core: `parseCommandDoc`, `CommandRegistry`; types `CommandManifest`, `CommandSource`, dll di `@jiku/types`.
- Studio: `CommandLoader` FS scan `/commands/<slug>/COMMAND.md` (folder) atau `/commands/<slug>.md` (file tunggal). `dispatchSlashCommand()` dipanggil di chat route, task/cron/heartbeat runner. Body + parsed args digabung ke `<command_args>` block lalu disambung sebagai resolved input.
- Routes + UI project Commands page + per-agent allow-list page + sidebar link.
- Audit: `command.invoke`, `command.assignment_changed`, `command.source_changed`.
- **Deviasi dari rencana §6.1:** connector-inbound dispatcher (Telegram `/deploy-prod` dari member) TIDAK di-wire — alasan keamanan, masuk backlog. Surface chat/cron/task/heartbeat cukup untuk skenario marketing.

### §9.B — Reference Hint Provider (`@file`) ✅ SHIPPED
**Prioritas awal:** 🔴 High
**Masalah:** tidak ada mekanisme mengangkat file-mention ke context agent. Agent harus tebak nama file atau user harus expand manual.
**Ide:** implement sesuai §6.2. Ringan, lazy, non-invasive.

**Ship notes:**
- `apps/studio/server/src/references/hint.ts` — regex scanner, workspace-root normalisasi, reject `..` dan `./relative`, cap 20 matches, validator stat-only via `getFileByPath`, injeksi `<user_references>` block dengan size + mtime + flag `LARGE` untuk file > 1 MB.
- Wired di: chat route (setelah command dispatch), task runner (cron/heartbeat/task), connector event-router inbound.
- Audit: `reference.scan` dengan `{ surface, total, ok, missing }`.
- **Deviasi:** MVP tidak support glob (`@plans/*.md`) atau directory summarisation — masuk backlog.

### §9.C — Filesystem Tool Permission via Metadata ✅ SHIPPED
**Prioritas awal:** 🔴 High (khusus trust untuk self-improvement loop Flow B)
**Masalah:** agent bisa `fs_write` sembarang path. Untuk skenario self-improvement, agent baca `/reports/*` — kalau agent bug atau halusinasi, dia bisa overwrite ground-truth data. Tidak ada gate deklaratif.
**Ide:** implement sesuai §6.3. Per-file/folder metadata `tool_permission: read | read+write`, inherited dari parent, di-enforce di FS tool layer. User set via disk file explorer UI.

**Ship notes:**
- Migrasi `0031_plan26_fs_tool_permission.sql` (archival filename preserved) — kolom `tool_permission` di `project_files` + `project_folders` (nullable, `'read' | 'read+write'`).
- `resolveFsToolPermission(projectId, path)` di `@jiku-studio/db` — walk self → ancestor chain → default `read+write`. Return `{ effective, source, source_path }`.
- Gate `checkToolPermGate` dipanggil di `fs_write`, `fs_edit`, `fs_append`, `fs_move` (from + to), `fs_delete`. Return kode `FS_TOOL_READONLY` + hint yang menyebut sumber restriksi. Read operations tetap selalu boleh.
- Routes: `GET /projects/:pid/files/permission?path=`, `PATCH /projects/:pid/files/permission`.
- UI: context menu di file explorer dengan submenu "Tool permission" (Read+Write / Read only / Inherit), badge 🔒 muncul kalau effective = `read`, tooltip menyebut source.
- Audit: `fs.permission_set`, `fs.permission_denied`.
- **Untuk demo skenario — cara seed:** klik kanan folder `/reports/` → Tool permission → "Read only". Klik kanan `/commands/` + `/skills/` sama (nice-to-have supaya agent tidak edit SOP sendiri). `/plans/` biarkan default.
- **Deviasi:** tier `none` (read juga di-block) TIDAK dibuat — deferred, cuma `read` vs `read+write` seperti plan.

### §9.D — Connector Custom Params + Param Hint Injection ✅ SHIPPED
**Prioritas awal:** 🔴 High (khusus kualitas pesan Flow A & B)
**Masalah:** `connector_send` saat ini field-nya generik (target, text, dll). Padahal tiap connector punya kapabilitas spesifik — Telegram: `reply_to_message_id`, `parse_mode` (Markdown/HTML), `disable_web_page_preview`, `message_thread_id` (forum topic), `protect_content`.

**Ship notes:**
- `ConnectorParamSpec` type + optional `getParamSchema()` di `ConnectorAdapter` (`@jiku/kit`).
- `params?: Record<string, unknown>` di `ConnectorContent` (`@jiku/types`).
- `connector_send` + `connector_send_to_target` terima `params` → validate against adapter schema → unknown keys → `INVALID_PARAMS` error informatif.
- **Deviasi dari rencana hint injection:** alih-alih runner meng-inject `<connector_params>` block context-aware ke system prompt, schema di-surface via **tool output** — `connector_list` emit `param_schema` per connector. Agent baca saat list, zero prompt-bloat, sama context-aware karena agent tetap panggil `connector_list` tiap iteration (tool description sudah mewajibkan itu). Lebih murah token, lebih lazy.
- Telegram adapter declare 7 params: `reply_to_message_id`, `parse_mode`, `disable_web_page_preview`, `message_thread_id`, `protect_content`, `disable_notification`, `allow_sending_without_reply`. `sendMessage` merge ke `commonOpts` Bot API (translate `reply_to_message_id` → modern `reply_parameters`).
- **Validasi:** MVP hanya cek key membership. Type/enum checking (misal tolak `parse_mode:"foo"`) masuk backlog.

**Follow-up: rich text entities & forward/copy (belum di-ship).**

Dua kebutuhan lanjutan yang **masuk ke dalam §9.D** — tidak perlu abstraksi universal baru:

1. **Rich text entities (Telegram-specific).** Canonical form di Jiku tetap **Markdown subset** (lowest common denominator — Discord, Slack, WhatsApp pakai markdown flavor masing-masing). Adapter convert markdown ↔ format native. Fitur Telegram-only yang tidak bisa di-markdown-kan (`custom_emoji` animated premium, `text_mention` by user_id, kasus styling overlap) → masuk ke `params.entities` sebagai raw passthrough.

   **Dua path outbound di Telegram — mutually exclusive:**

   - **Path A (default, 90% kasus) — `parse_mode`.** Agent kirim `text` yang sudah ada markup + `params.parse_mode: 'HTML'` (preferred) atau `'MarkdownV2'`. Telegram yang parse di server. HTML dipilih default karena escape-nya cuma `< > &`, jauh lebih ramah daripada MarkdownV2 yang harus escape `_*[]()~\`>#+-=|{}.!`.
     ```js
     connector_send({
       target: '#DevCommunity',
       text: '<b>Halo builders</b>, cek <a href="...">docs</a>',
       params: { parse_mode: 'HTML' }
     })
     ```
   - **Path B (escape hatch, 10% kasus) — `entities`.** Agent kirim `text` mentah + array entity eksplisit. **Wajib** untuk `custom_emoji` (markdown Telegram tidak punya syntax), `text_mention` (mention by user_id), atau kasus nested yang markdown tidak bisa.
     ```js
     connector_send({
       target: '#DevCommunity',
       text: 'Halo builders 🔥',
       params: {
         entities: [
           { type: 'bold', offset: 0, length: 4 },
           { type: 'custom_emoji', offset: 14, length: 2, custom_emoji_id: '5123...' }
         ]
       }
     })
     ```

   **Validator enforcement:** adapter Telegram tolak kalau `params.parse_mode` dan `params.entities` dikirim bareng → error `"parse_mode and entities are mutually exclusive"`. Schema hint di `connector_list` tandai ini eksplisit supaya agent tahu sejak awal.

   **Inbound normalisasi.** Telegram selalu kirim `entities` array di update event (tidak pernah markdown string). Adapter normalisasi event ke:
   ```jsonc
   {
     "text": "Halo builders 🔥",                // raw
     "text_html": "Halo <b>builders</b> 🔥",    // adapter render entities → HTML
     "text_markdown": "Halo **builders** 🔥",   // render → MarkdownV2 (best-effort)
     "entities": [...],                         // passthrough
     "has_unrepresentable": true                // flag kalau ada entity yg ga ter-render (custom_emoji dll)
   }
   ```
   Agent 90% kasus baca `text_html`. Kalau mau forward konten verbatim dan `has_unrepresentable: true`, pakai `entities` raw + kirim via Path B.

   **Keputusan desain:** **tidak bikin skema entity universal `JikuEntity[]`** karena hanya 3–4 platform (Telegram, Twitter/X, Bluesky, LinkedIn) yang pakai model offset+length — mayoritas platform pakai markdown inline. Maintain abstraksi universal untuk kapabilitas minoritas = over-engineering.

2. **Forward / copy pesan.** **Bukan** tool universal baru. Masuk sebagai **connector-specific actions** via `connector_run_action`:
   - `connector_run_action('telegram', 'forward_message', { source_chat_id, source_message_id, destination_target })`
   - `connector_run_action('telegram', 'copy_message', { source_chat_id, source_message_id, destination_target, caption?, caption_entities? })`

   Adapter register action + param schema saat activation (reuse mekanisme schema di §9.D). Platform lain yang tidak punya native forward (Discord, Slack) register action `forward_message` sendiri dengan fallback fetch+repost — tetap di-handle adapter-nya sendiri, tidak dipaksa jadi primitive Jiku. Agent dapat daftar action yang tersedia dari `connector_list` output (pola yang sama dengan param schema yang sudah di-ship).

### §9.E — Disk Media Upload Support
**Prioritas:** 🔴 High (blocker untuk Flow B — pesan marketing hampir selalu bawa asset visual)
**Masalah:** virtual disk saat ini terbatas ke file text/markdown. Upload media binary (image, video, gif) belum didukung via file explorer UI. Akibatnya tim marketing tidak bisa taruh asset foto/video di `/assets/marketing/` sebagai source of truth versioned — terpaksa pakai Telegram saved messages saja atau bypass Jiku sepenuhnya.

**Lingkup dukungan:**

| Kategori | Format yang perlu didukung |
|---|---|
| **Image** | `.jpg`, `.jpeg`, `.png`, `.webp`, `.gif`, `.svg`, `.bmp`, `.tiff`, `.heic`, `.heif`, `.avif` |
| **Video** | `.mp4`, `.mov`, `.mkv`, `.webm`, `.avi`, `.m4v`, `.3gp` |
| **Audio** | `.mp3`, `.wav`, `.ogg`, `.m4a`, `.aac`, `.opus`, `.flac` |
| **Document** | `.pdf`, `.docx`, `.xlsx`, `.pptx`, `.odt`, `.csv`, `.json`, `.zip` |
| **Animated** | `.gif` (overlap image), `.webp` animated, `.apng` |
| **Script / code** | `.js`, `.ts`, `.tsx`, `.jsx`, `.py`, `.rb`, `.go`, `.rs`, `.java`, `.kt`, `.swift`, `.php`, `.sh`, `.bash`, `.zsh`, `.ps1`, `.sql`, `.yaml`, `.yml`, `.toml`, `.xml`, `.html`, `.css`, `.scss`, `.lua`, `.r`, `.pl` |

**Komponen yang perlu dibangun:**

1. **Upload UI di file explorer.**
   - Drag-and-drop ke folder target.
   - Multi-file picker via tombol "Upload".
   - Progress bar per-file + overall.
   - Paste image langsung dari clipboard (Ctrl+V / Cmd+V) — auto-generate nama file dengan timestamp.

2. **MIME detection & validasi.**
   - Deteksi MIME dari magic bytes (bukan cuma extension — supaya `.jpg` yang sebenarnya executable ter-block).
   - Whitelist per-project (configurable) — default whitelist sesuai tabel di atas.
   - Reject + error informatif kalau MIME tidak match extension atau di luar whitelist.

3. **Size caps.**
   - Per-file: default 50MB untuk image/doc, 500MB untuk video, configurable per-project.
   - Per-project total storage quota (configurable).
   - Streaming upload untuk file besar — tidak load semua ke memory.

4. **Storage backend.**
   - MVP: simpan binary di virtual disk (content-addressable hash storage atau blob path), metadata di table FS yang sama.
   - Future: opsional offload ke S3/R2 untuk file besar dengan signed URL akses.

5. **Thumbnail & preview.**
   - Auto-generate thumbnail untuk image (resize ke 256px) + video (frame pertama atau poster).
   - Preview inline di file explorer — klik file `.jpg` → render di panel preview.
   - Video: HTML5 `<video>` player dengan controls.
   - PDF: embed viewer atau link download.
   - SVG: render langsung (dengan sanitasi untuk cegah XSS via embedded script).

6. **Metadata ekstraksi.**
   - Dimensi (width × height) untuk image/video.
   - Durasi untuk video/audio.
   - EXIF strip opsional (privacy — drop GPS/camera info saat upload, configurable).
   - Simpan ke metadata entry sama yang dipakai `tool_permission` (§9.C) — tambah field `media: { width, height, duration_ms, mime, size_bytes, ... }`.

7. **Tool agent untuk baca media.**
   - `fs_read(path)` existing untuk text tetap. Untuk binary: `fs_read_media(path)` return **reference descriptor**, bukan blob:
     ```jsonc
     { "path": "/assets/marketing/cover.jpg", "mime": "image/jpeg", "size": 234567, "ref_id": "media_abc123" }
     ```
   - Agent pass `ref_id` atau `path` ke `connector_send` — adapter yang fetch + upload ke platform target. Agent tidak pegang blob mentah (hemat token + tidak perlu base64 di prompt).
   - Untuk LLM multi-modal yang bisa "lihat" image: tool `fs_read_media_vision(path)` yang embed image ke message (kalau model support).

8. **Integrasi dengan connector_send.**
   - `connector_send({ target, text, params: { media: { path: '/assets/marketing/cover.jpg', type: 'photo' } } })` — adapter Telegram upload via `sendPhoto` / `sendVideo` / `sendDocument` sesuai tipe.
   - Multi-media: `params.media_group: [{ path, type, caption? }, ...]` untuk album (Telegram `sendMediaGroup`).
   - Reuse mekanisme param schema §9.D — adapter declare field `media` + `media_group` + validator.

9. **Permission integration (§9.C).**
   - File media di `/assets/marketing/` kena aturan `tool_permission` yang sama. Kalau folder di-set read-only untuk tools, agent tidak bisa `fs_write` / replace file — tapi masih bisa baca + kirim via connector.

**Impact ke Flow B:**
- Matriks coverage "Aset / foto" yang saat ini ✅ dengan fallback Telegram saved messages → upgrade ke ✅ penuh dengan virtual disk sebagai source of truth versioned.
- `plans/marketing-channel.md` bisa reference `@assets/marketing/tips-cover-1.jpg` — §9.B hint provider tangkap sebagai file ada dengan metadata image (dimensi, size).
- Tim design upload asset via file explorer UI tanpa perlu buka Telegram.

**Edge cases:**
- SVG dengan embedded `<script>` — wajib sanitize saat render preview.
- Video codec yang browser tidak support (mis. HEVC di Firefox) — fallback download link.
- Animated WebP / APNG — render sebagai image biasa + play controls kalau mungkin.
- File rename mempertahankan content hash — tidak perlu re-upload blob.

---

## 9b. Nice to Have (Bukan Blocker)

Hal-hal yang enak untuk dipunya tapi **tidak mencegah skenario jalan**. Bisa dikerjakan kapan saja sesudah fondasi.

### Moderation Rule Templates
Declarative rule ("block pesan mengandung X", "require review untuk konten mencurigakan") sebagai alternatif prompt engineering. Sementara ini bisa ditangani lewat persona + skill moderasi manual.
**Ide future:** content-policy layer di atas `connector_send` (rule keyword/regex/toxicity-score), skill `content_check(text)`, UI Channel Settings → Rules tab.

### Approval Workflow untuk Outbound Message
Gate "draft → review → publish" sebelum pesan terkirim. Untuk sekarang audit log post-facto + trust ke persona agent sudah cukup. Tidak dipakai sampai skenario menuntut (mis. broadcast berisiko tinggi).
**Ide future:** binding config `outbound_approval_mode`, `pending_outbound_messages` queue, admin UI review, feedback loop ke agent.

### Per-Channel Dashboard
Halaman konsolidasi per-channel di `/channels/[connector_id]/[scope_key]` — timeline aktivitas, stats pesan agent (terkirim/gagal/pending), quick-link ke audit / binding / cron yang scope-nya channel itu, grafik aktivitas. Murni UX — data-nya sudah ada di Audit Log, Connector Event Log, Usage dashboard, Cron Tasks page. Tanpa dashboard, admin tetap bisa review tapi harus pindah-pindah page.

### Multi-Channel Broadcast
Broadcast groups / target aliases (satu alias → multiple connector targets). Tool `connector_broadcast(group='announcements', ...)`. Untuk sekarang kirim eksplisit per target cukup.

### Per-Channel / Per-Binding Rate Limit
Rate limit config per-binding (`max_outbound_per_minute`). Rate limit global existing sudah cukup mencegah abuse kasar.

### Polish UX
- Connector target editor: `description` + `category`.
- Binding UI: live preview trigger match.
- Cron task history full audit.
- Heartbeat timezone per-agent.
- Skills / Commands marketplace browser in-app.
- Autocomplete `/` dan `@` di chat input.

---

## 10. Rekomendasi Urutan Eksekusi

### Tahap 1 — Fondasi ✅ SELESAI (2026-04-14)

Keempat fitur di-ship sebagai feature additions di atas plan tree (bukan plan dokumen resmi — lihat changelog 2026-04-14):

1. ✅ **Commands system** — FS + plugin, dispatcher prefix `/` di chat/task/cron/heartbeat.
2. ✅ **Reference hint provider (`@file`)** — scanner + notice injector di 4 surface.
3. ✅ **Filesystem tool permission via metadata** — per-file/folder, inherited, UI context menu + badge.
4. ✅ **Connector custom params** — per-connector param schema di `connector_list` output (bukan prompt injection seperti rencana awal — lebih murah token, tetap context-aware).

### Tahap 2 — Nice to Have (belum dikerjakan)

Apa pun dari §9b sesuai kebutuhan aktual yang muncul (biasanya: moderation rule kalau skenario scale ke komunitas besar, approval workflow kalau konten sensitif muncul, per-channel dashboard kalau operasional harian terasa repot).

### Follow-up kecil yang dicatat di `docs/builder/tasks.md` post-ship

- Connector-inbound `/slash` dispatcher (gated opt-in) — bukan blocker.
- Commands: args schema editor UI, chat-UI chip "Command Invoked: /slug".
- @file: support `@./relative`, `@folder/` summary, `@path:L10-20` line-range.
- FS permission: tier `none`, bulk-set di file explorer.
- Connector params: type/enum validation, replikasi schema di Discord/WhatsApp adapter.
- Connector rich text (Telegram): dua path outbound mutually exclusive — `params.parse_mode: 'HTML' | 'MarkdownV2'` (default, 90% kasus) atau `params.entities[]` raw (escape hatch untuk custom_emoji, text_mention by user_id). Adapter validator tolak kalau keduanya dikirim bareng.
- Connector rich text inbound: normalisasi event ke `text` + `text_html` + `text_markdown` + `entities` passthrough + `has_unrepresentable` flag.
- Connector actions: `forward_message` + `copy_message` di Telegram adapter (via `connector_run_action`), action schema ter-expose di `connector_list` output.
- **Disk media upload (§9.E)** — blocker Flow B: drag-and-drop + paste clipboard di file explorer, MIME magic-byte validasi, size cap configurable, thumbnail auto-generate, metadata ekstraksi (dimensi/durasi), tool `fs_read_media(path)` return ref descriptor, integrasi ke `connector_send({ params: { media: { path, type } } })` + media_group untuk album.

### Deploy checklist untuk test besok

1. Apply migrasi `0030_plan24_commands.sql` + `0031_plan26_fs_tool_permission.sql`.
2. `bun run typecheck` di `apps/studio/server` + `apps/studio/web`.
3. Seed demo:
   - `/commands/marketing-channel-execute/COMMAND.md` dengan frontmatter `args: [{ name: raw }]` + body referensi `@plans/marketing-channel.md`.
   - `/plans/marketing-channel.md` — schedule table + Revision Log + Execution Log section.
   - File explorer → klik kanan `/reports/` → Tool permission → **Read only**.
4. Smoke test: chat `/marketing-channel-execute "jam 15.00"` ke agent Aria → verify dispatcher resolve body → `@plans/...` hint muncul → `connector_send params:{parse_mode:"HTML", disable_notification:true}` terpakai → audit log mencatat `command.invoke` + `reference.scan`.

---

## 11. Referensi

### Dokumen Arsitektur
- [`docs/architecture.md`](../architecture.md)
- [`docs/product_spec.md`](../product_spec.md)
- [`docs/overview.md`](../overview.md)

### Feature Docs Relevan
- [`docs/feats/connectors.md`](../feats/connectors.md)
- [`docs/feats/chat.md`](../feats/chat.md)
- [`docs/feats/persona.md`](../feats/persona.md)
- [`docs/feats/skills.md`](../feats/skills.md) — arsitektur yang di-mirror oleh Commands
- [`docs/feats/cron-tasks.md`](../feats/cron-tasks.md)
- [`docs/feats/task-heartbeat.md`](../feats/task-heartbeat.md)
- [`docs/feats/permission-policy.md`](../feats/permission-policy.md)
- [`docs/feats/audit-log.md`](../feats/audit-log.md)
- [`docs/feats/memory.md`](../feats/memory.md)
- [`docs/feats/rate-limiting.md`](../feats/rate-limiting.md)
- [`docs/feats/plugin-system.md`](../feats/plugin-system.md)

### ADR Relevan
- **ADR-057** — connector targets (named alias)
- **ADR-062** — delivery composition
- **ADR-063** — cron / heartbeat trigger context

### Plugin & Adapter
- `plugins/jiku.telegram/`
- `plugins/jiku.social/`
- `plugins/jiku.analytics/` (future)

---

**Catatan akhir:** dokumen ini artefak discovery + design, bukan spec implementasi. Saat masing-masing gap masuk ke `tasks.md` dan berlanjut ke `plans/NN-*.md`, referensi balik ke scenario ini supaya jejak "dari kebutuhan user → plan implementasi" tetap utuh.
