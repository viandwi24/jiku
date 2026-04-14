# Commands

User-triggered `/slash` system. FS-first (plus plugin) discovery; mirror arsitektur Skills.

## What it does

User mengetik `/slug arg1 arg2` sebagai message pertama di turn — dispatcher:
1. Detect prefix `/` di input.
2. Resolve slug via `CommandLoader` (`/commands/<slug>/COMMAND.md` folder atau `/commands/<slug>.md` file tunggal).
3. Eligibility check vs agent's `command_access_mode` + `agent_commands` allow-list.
4. Parse args per `manifest.args` schema.
5. Compose `body + <command_args>` block.
6. **Inject as per-turn `extra_system_segments`** with label `Command Invoked: /<slug>` — user input message stays LITERAL (just `/slug args` as typed). User's chat history + edit flow stay clean; agent sees the SOP body via system context for that turn only.
7. Audit `command.invoke`.

> **Update 2026-04-14:** dispatcher dulu **REPLACE** user input dengan resolved body. Itu bikin message DB jadi kotor (giant body bukan `/slug args`), edit flow rusak, history aneh. Sekarang pakai per-turn segment model — sama seperti `@file` reference hint. User text stays literal, command body lives in system context.

Command body adalah markdown instruksi untuk agent — bisa referensi `@plans/marketing.md` (the @file reference hint akan merender notice-nya).

## Surfaces wired

- ✅ Chat route — user input chat box
- ✅ Task runner — spawn_task tool, manual task
- ✅ Cron scheduler (via task runner) — `cron_create(prompt: "/marketing-channel-execute ...")`
- ✅ Heartbeat (via task runner)
- ✅ Connector inbound (Telegram + any adapter that goes through `event-router`) — ADR-088 reversed ADR-085's earlier defer. Gated uniformly via `command_access_mode` (ADR-089).

## UI: `/` autocomplete in chat input

Typing `/` as the first character of the chat input pops a dropdown of matching commands:
- ↑ / ↓ navigate the list.
- Tab / Enter insert `/<slug> ` (with trailing space, ready for args).
- Esc dismiss (soft dismiss — appends a space to break the prefix match).
- Popup filters live as the user types (`/mar` → commands whose slug starts with "mar").
- Shows emoji (from `manifest.metadata.jiku.emoji`), slug, description, up to 2 tags.
- Respects `command_access_mode`: in `manual` mode shows the agent's allow-list; in `all` mode shows every active project command. Matches the backend dispatcher's gate.
- Fires `POST /projects/:pid/commands/refresh` on mount so FS-added commands appear without a project-wide reload.

Implementation: `apps/studio/web/components/chat/slash-command-autocomplete.tsx`. Requires parent to wrap `<PromptInput>` in `<PromptInputProvider>` so the autocomplete can read + set the input value through the shared controller.

## Access-mode gate is uniform (ADR-089)

`command_access_mode` is honored on every surface. `manual` = only commands explicitly assigned to the agent via `agent_commands`; `all` = any active project command. No surface-special-cases. If a user wants "free chat access but gated connector access", they fork the need into two agents with different modes — the config is the single source of truth.

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
