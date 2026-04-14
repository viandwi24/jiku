# Commands (Plan 24)

User-triggered `/slash` system. FS-first (plus plugin) discovery; mirror arsitektur Skills.

## What it does

User mengetik `/slug arg1 arg2` sebagai message pertama di turn — dispatcher:
1. Detect prefix `/` di input.
2. Resolve slug via `CommandLoader` (`/commands/<slug>/COMMAND.md` folder atau `/commands/<slug>.md` file tunggal).
3. Eligibility check vs agent's `command_access_mode` + `agent_commands` allow-list.
4. Parse args per `manifest.args` schema.
5. Replace input dengan `body + <command_args>` block.
6. Audit `command.invoke`.

Command body adalah markdown instruksi untuk agent — bisa referensi `@plans/marketing.md` (Plan 25 hint akan merender notice-nya).

## Surfaces wired

- ✅ Chat route — user input chat box
- ✅ Task runner — spawn_task tool, manual task
- ✅ Cron scheduler (via task runner) — `cron_create(prompt: "/marketing-channel-execute ...")`
- ✅ Heartbeat (via task runner)
- ⏭️ Connector inbound — DEFERRED (ADR-085, security-gated opt-in di backlog)

## Public API

- Tabel `project_commands` — cache manifest (source of truth tetap FS/plugin).
- Tabel `agent_commands` — per-agent allow-list.
- Kolom `agents.command_access_mode`: `'manual'` (pakai allow-list) | `'all'` (semua active project commands).
- Routes: `/projects/:pid/commands` CRUD, `/refresh`, `/agents/:aid/commands`, `/command-access-mode`.
- UI: `/projects/:pid/commands` page, `/projects/:pid/agents/:aid/commands` per-agent page, sidebar link.

## Manifest shape

```yaml
---
name: "Marketing Channel Execute"
description: "Eksekusi posting marketing terjadwal"
tags: [marketing, channel]
args:
  - name: raw
    description: "Free-form instruction from user/cron"
  - name: jam
    type: string
    required: false
metadata:
  jiku:
    emoji: "📣"
    entrypoint: COMMAND.md
---

# Body markdown instructions for agent...
```

## Known limitations

- Connector inbound tidak ter-dispatch (design intent — lihat ADR-085).
- Args parser sederhana: kalau cuma satu arg bernama `raw` atau bertipe `string`, seluruh sisa string setelah `/slug ` jadi nilai. Untuk multi-arg, whitespace-split per posisi; arg terakhir kumpulkan sisa kalau bertipe string.
- Tidak ada "args schema form builder" di UI — user harus edit YAML frontmatter langsung di file explorer.
- UI tidak pakai `command_access_mode='all'` — allow-list selalu ditampilkan (backlog).

## Related files

- Core: `packages/core/src/commands/{manifest,registry}.ts`
- Studio: `apps/studio/server/src/commands/{loader,dispatcher}.ts`
- DB: `apps/studio/db/src/schema/commands.ts`, `queries/commands.ts`, migration `0030_plan24_commands.sql`
- Types: `packages/types/src/index.ts` (CommandManifest, CommandEntry, CommandArgSpec, CommandDispatchResult, CommandAccessMode)
- Routes: `apps/studio/server/src/routes/commands.ts`
- UI: `apps/studio/web/app/(app)/studio/companies/[company]/projects/[project]/commands/page.tsx`, `.../agents/[agent]/commands/page.tsx`
- API client: `apps/studio/web/lib/api.ts` → `api.commands.*`

## Related ADRs

- **ADR-085** — why dispatcher skips connector inbound for MVP.
