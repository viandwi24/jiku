# Reference Hint Provider — @file (Plan 25)

Pre-prompt subsystem yang scan input untuk `@path/to/file` mention, verify file ada di virtual disk, inject `<user_references>` notice — tanpa eager expand konten (progressive disclosure, sama seperti Skills hint).

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
