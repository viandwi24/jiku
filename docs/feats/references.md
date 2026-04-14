# Reference Hint Provider — @file

Pre-prompt subsystem yang scan input untuk `@path/to/file` mention, verify file ada di virtual disk, inject `<user_references_filemention>` notice **sebagai per-turn system segment** (BUKAN appended ke user input) — tanpa eager expand konten (progressive disclosure, sama seperti Skills hint).

> **Renamed 2026-04-14:** dari `<user_references>` (terlalu generic) → `<user_references_filemention>`. Subsystem lain yang mau add reference jenis lain (e.g. `<user_references_url>`, `<user_references_image>`) bisa pakai naming serupa tanpa clash.
>
> **Injection model 2026-04-14:** dipindah dari "prepend ke input string" ke `params.extra_system_segments` di `runtimeManager.run`. Alasan: appending ke user input bikin block visible di chat UI (user lihat text yang dia tidak ketik) dan membingungkan saat user edit pesannya. Sekarang user message tetap bersih — block hanya hidup di system context untuk turn itu saja.
>
> **Suppress empty hint 2026-04-14:** dulu kalau semua mention 404 di disk, block "NOT present on the disk" tetap dirender. Sekarang kalau zero file resolve, ZERO hint — agent baca @mention dari user text saja sebagai signal.

## What it does

Input seperti:

```
Eksekusi marketing. Baca @plans/marketing-channel.md dan @reports/sales-2026-W15.md.
```

Scanner menemukan dua `@path` match, stat via `getFileByPath`, dan prepend block:

```xml
<user_references>
User / context is referencing the following files from the project workspace disk.
These files are available — use the `fs_read` tool to read their contents as needed. Do NOT ask the user to paste them.

- /plans/marketing-channel.md (2.8KB, updated 2026-04-14)
- /reports/sales-2026-W15.md (1.2KB, updated 2026-04-13)
</user_references>

Eksekusi marketing. Baca @plans/marketing-channel.md dan @reports/sales-2026-W15.md.
```

Body asli tetap utuh — agent lihat mention + notice konfirmasi.

## Surfaces wired

- ✅ Chat route (setelah command dispatch)
- ✅ Task runner — cron/heartbeat/task
- ✅ Connector event-router inbound

## Resolution rules

| Input | Resolves to |
|---|---|
| `@x/y.md` | `/x/y.md` (workspace-root absolute) |
| `@/abs/path.md` | `/abs/path.md` |
| `@./relative` | dropped — not supported MVP |
| `@../escape` | dropped — rejected |
| `@alice` (no slash or dot) | dropped silent (treated as username) |
| `\@foo` | literal, not scanned |
| Glob `@plans/*.md` | no glob support MVP |

## Cap & safety

- Max 20 refs per invocation — above that jadi noise / injection risk.
- File > 1 MB ditandai `LARGE — use offset/limit when fs_read-ing` di hint.
- Only stat, never content read → operasi ringan.
- Missing files tetap disebut di notice (section "NOT present on the disk") sebagai signal ke agent bahwa user mungkin salah path.
- Connector inbound: scanner tetap jalan; karena hint hanya muncul kalau file existed di workspace, external member tidak bisa paksa agent baca file sensitif yang tidak diupload ke workspace.

## Public API

```typescript
import { scanReferences } from '../references/hint.ts'
await scanReferences({ projectId, text, userId, surface })
// → { matches: ReferenceMatch[], hintBlock: string | null }
```

Surface: `'chat' | 'cron' | 'task' | 'heartbeat' | 'connector' | 'command_body'`.

## Audit

`reference.scan { surface, total, ok, missing }` — satu event per invocation.

## Related files

- `apps/studio/server/src/references/hint.ts`
- Wired in: `routes/chat.ts`, `task/runner.ts`, `connectors/event-router.ts`

## Related ADRs

- **ADR-084** — why stat-only / workspace-root-only / cap 20 / no glob in MVP.
