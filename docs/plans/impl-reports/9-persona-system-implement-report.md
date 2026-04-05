# Plan 9 — Persona System: Implementation Report

**Plan Reference:** `docs/plans/9-persona.md`  
**Report Date:** 2026-04-05  
**Overall Status:** 95% COMPLETE — Production Ready (pending DB migration)

---

## Executive Summary

Plan 9 (Persona System) berhasil diimplementasikan penuh. Agent kini punya identitas hidup yang disimpan sebagai scope `agent_self` di memory system, di-inject sebagai section `## Who I Am` di system prompt sebelum `[Memory]`. User/admin bisa set initial seed di settings, agent mengelola persona-nya sendiri via built-in tools.

Satu item pending: DB migration (`bun db:push`) untuk menerapkan kolom `persona_seed` dan `persona_seeded_at` ke tabel `agents` di production.

Di luar plan, sesi ini juga menyelesaikan dua enhancement: **Active Tools UI** (debug panel untuk tools yang aktif di chat) dan **Tool Group Metadata** (meta `group` di setiap tool untuk UI grouping).

---

## What Was Implemented

### 1. Scope `agent_self` — Memory Layer

**`packages/types/src/index.ts`**
- Tambah `agent_self` ke union `MemoryScope`
- Tambah interface `PersonaSeed` (name, role, personality, communication_style, background, initial_memories)
- Extend `PreviewRunResult.active_tools` dengan field `description`, `input_schema`, `group`

**`apps/studio/db/src/schema/agents.ts`**
- Tambah kolom `persona_seed: jsonb` dan `persona_seeded_at: timestamp` ke tabel `agents`

**`apps/studio/db/src/schema/memories.ts`**
- Scope column type sudah `varchar(50)` — mendukung `agent_self` tanpa perlu ALTER ENUM

**`apps/studio/db/src/queries/memory.ts`**
- Tambah `agent_self` ke local MemoryScope type
- Tambah fungsi: `updateAgentPersonaSeed`, `markAgentPersonaSeeded`, `resetAgentPersona`, `getAgentSelfMemories`

### 2. Persona Seeding & Injection

**`apps/studio/server/src/memory/persona.ts`** *(file baru)*
- `ensurePersonaSeeded(agentId, projectId, hasSelfMemories)` — cek apakah `persona_seeded_at` null, lalu seed memories dari `persona_seed` config
- Bootstrap memories: name, role, personality, communication_style, background, initial_memories list

**`packages/core/src/memory/builder.ts`**
- `formatPersonaSection(agentName, selfMemories, seed?)` — format block `## Who I Am` dari agent_self memories
- Kalau kosong dan seed tidak ada: fallback minimal "I am {name}, an AI assistant"

**`packages/core/src/resolver/prompt.ts`**
- `buildSystemPrompt()` terima parameter `persona_section?: string`
- Inject persona section setelah base prompt, sebelum memory section

**`packages/core/src/runner.ts`**
- `AgentRunner` constructor terima `personaSeed?: PersonaSeed | null`
- `run()` dan `previewRun()` keduanya: load agent_self memories → format persona section → pass ke buildSystemPrompt
- **Bug fix**: `previewRun()` sebelumnya tidak merge `built_in_tools` — fixed, tools count sekarang akurat

**`packages/core/src/runtime.ts`**
- `addAgent(def, memoryConfig?, personaSeed?)` — forward personaSeed ke AgentRunner

### 3. Built-in Persona Tools

**`apps/studio/server/src/memory/tools.ts`**
- `persona_read` — baca semua agent_self memories (group: `'persona'`)
- `persona_update` — append/replace/remove agent_self memories (group: `'persona'`)
- Semua memory tools kini punya `group: 'memory'` di meta
- Persona tools punya `group: 'persona'` di meta

### 4. Runtime Integration

**`apps/studio/server/src/runtime/manager.ts`**
- `wakeUp()` dan `syncAgent()` — pass `(a.persona_seed ?? null) as PersonaSeed | null` ke `addAgent()`
- `run()` — panggil `ensurePersonaSeeded` sebelum menjalankan runtime

### 5. API Routes

**`apps/studio/server/src/routes/persona.ts`** *(file baru)*
- `GET /agents/:aid/persona/memories` — list agent_self memories
- `GET /agents/:aid/persona/seed` — read persona_seed config
- `PATCH /agents/:aid/persona/seed` — update persona_seed
- `POST /agents/:aid/persona/reset` — hapus agent_self memories, reset persona_seeded_at

**`apps/studio/server/src/index.ts`**
- Register `personaRouter`

### 6. Web UI — Agent Settings Persona Tab

**`apps/studio/web/app/.../agents/[agent]/layout.tsx`**
- Tambah nav item "Persona" dengan icon `Sparkles` di antara Prompt dan Tools

**`apps/studio/web/app/.../agents/[agent]/persona/page.tsx`** *(file baru)*
- Form PersonaSeed (name, role, personality, communication_style, background)
- List initial_memories dengan add/remove
- Panel Current Persona (live agent_self memories dari DB, read-only)
- AlertDialog "Reset to Seed" — konfirmasi sebelum hapus semua agent_self

**`apps/studio/web/lib/api.ts`**
- Tambah `PersonaSeed` type
- Tambah `api.persona.*` methods (getSeed, updateSeed, getMemories, reset)
- Update `active_tools` type: tambah `description`, `input_schema`, `group`

---

## Enhancement: Active Tools UI (Beyond Plan 9)

Request user selama sesi: lengkapi UI active tools di context bar dan preview sheet.

### Context Bar (`context-bar.tsx`)
- Tombol "Tools" dengan count di footer chat bar
- Popover usage menampilkan tools summary (count, built-in vs plugin badge)
- Two action buttons: "Tools" dan "Details"
- Tambah `persona` ke SOURCE_LABELS dan SOURCE_COLORS (violet)

### Context Preview Sheet (`context-preview-sheet.tsx`)
- Tab switcher Context / Tools
- `ToolRow` — expandable per tool: name, description (collapsed), full detail (description, tool ID, params schema)
- `schemaToParams()` — parse JSON schema properties menjadi daftar param dengan type + required badge
- Tool ID display dipersingkat: `memory_search` bukan `__builtin__:memory_search`
- Grouping by `meta.group` (memory / persona / plugin); fallback ke ID prefix

---

## Enhancement: Tool Group Metadata

**`packages/types/src/index.ts`** — tambah `group?: string` ke `ToolMeta` dan `PreviewRunResult.active_tools`

**`apps/studio/server/src/memory/tools.ts`** — semua 9 memory tools kini punya `group: 'memory'`, 2 persona tools punya `group: 'persona'`

**`packages/core/src/runner.ts`** — mapper `previewRun` pass `group: t.meta.group`

---

## Enhancement: Context Preview Sheet Layout

Sesuai request user: layout context preview sheet diubah:
1. Context usage bar + model info (top)
2. System prompt (collapsible, sebelum tabs)
3. Tab Context — segment list di-group by source dengan token total per group
4. Tab Tools — tools di-group by `meta.group`

---

## What's Pending

### DB Migration (REQUIRED before production use)

```bash
cd apps/studio/db && bun run db:push
```

Migration ini menerapkan:
- Kolom `persona_seed jsonb` ke tabel `agents`
- Kolom `persona_seeded_at timestamptz` ke tabel `agents`

> DB push sebelumnya gagal karena connection error, bukan schema error.

### Not Implemented (Deferred per Plan 9 § 11)

| Item | Deferred To |
|------|------------|
| `extractPersonaPostRun()` — auto-extract persona signals setelah conversation | Plan berikutnya |
| `user_relationship` config (superior/peer/subordinate) | Plan 11 |
| `proactive` / `can_refuse` flags | Plan 11 |
| Persona berbeda per user (agent_caller persona) | Defer |
| Persona versioning / history | Defer |

---

## Plan Checklist Verification

| Item | Status |
|------|--------|
| `agent_self` ke MemoryScope | ✅ Done |
| `PersonaSeed` interface | ✅ Done |
| DB migration agents columns | ⏳ Pending push |
| `ensurePersonaSeeded()` | ✅ Done |
| `buildPersonaSection()` / `formatPersonaSection()` | ✅ Done |
| `buildSystemPrompt()` inject persona | ✅ Done |
| `persona_read` + `persona_update` tools | ✅ Done |
| `extractPersonaPostRun()` | ❌ Deferred |
| Persona settings tab + form | ✅ Done |
| Current persona live panel | ✅ Done |
| Reset to Seed dialog | ✅ Done |
| API routes (seed, memories, reset) | ✅ Done |
| Context preview sheet — persona section | ✅ Done (via segment grouping) |

---

## Files Changed

### New Files
- `apps/studio/server/src/memory/persona.ts`
- `apps/studio/server/src/routes/persona.ts`
- `apps/studio/db/src/schema/memories.ts`
- `apps/studio/web/app/(app)/studio/companies/[company]/projects/[project]/agents/[agent]/persona/page.tsx`
- `docs/plans/impl-reports/9-persona-system-implement-report.md`

### Modified Files
- `packages/types/src/index.ts`
- `packages/core/src/memory/builder.ts`
- `packages/core/src/memory/index.ts`
- `packages/core/src/resolver/prompt.ts`
- `packages/core/src/runner.ts`
- `packages/core/src/runtime.ts`
- `apps/studio/db/src/schema/agents.ts`
- `apps/studio/db/src/schema/index.ts`
- `apps/studio/db/src/queries/memory.ts`
- `apps/studio/server/src/memory/tools.ts`
- `apps/studio/server/src/runtime/manager.ts`
- `apps/studio/server/src/index.ts`
- `apps/studio/web/lib/api.ts`
- `apps/studio/web/app/(app)/studio/companies/[company]/projects/[project]/agents/[agent]/layout.tsx`
- `apps/studio/web/components/chat/context-bar.tsx`
- `apps/studio/web/components/chat/context-preview-sheet.tsx`

---

*Plan 9 — Persona System*  
*Report Date: 2026-04-05*
