# Plan 9 — Persona System

> Status: Planning Done  
> Depends on: Plan 8 (Memory System)  
> Layer: App (sama seperti Memory — bukan plugin)

---

## 1. Overview

Persona adalah identitas agent yang **hidup dan berkembang**. Bukan config statis — agent mengelola persona-nya sendiri via memory tools. User/admin hanya menyediakan **initial seed** (titik awal), setelah itu agent yang bertanggung jawab.

**Prinsip utama:**
- Persona disimpan di memory system sebagai scope `agent_self`
- Agent update persona via tool, bukan user via UI form
- User hanya bisa set initial seed di agent settings
- Inject ke `[Persona]` section di system prompt (sebelum `[Memory]`)

---

## 2. Extend Memory System: Scope `agent_self`

Plan 8 mendefinisikan 3 scope. Plan 9 menambah scope ke-4:

```
agent_caller    → agent_id + user_id (private per pasangan)
agent_global    → agent_id only (berlaku semua user)
runtime_global  → project_id only (shared semua agent)
agent_self      → agent_id only, khusus persona & self-knowledge   ← NEW
```

### Perbedaan `agent_self` vs `agent_global`

| Aspek | `agent_global` | `agent_self` |
|-------|---------------|--------------|
| Isi | Facts tentang topik/user | Facts tentang diri agent sendiri |
| Siapa yang write | Agent (via tool) | Agent (via tool) |
| Inject di | `[Memory]` section | `[Persona]` section |
| Tier | core + extended | core only (selalu inject semua) |
| User bisa edit | Tidak (hanya delete) | Bisa set initial seed |

### Kenapa `agent_self` terpisah dari `agent_global`

- Injection section berbeda (Persona vs Memory)
- Tidak perlu relevance scoring — **semua** `agent_self` memories selalu inject
- Semantik berbeda: `agent_global` = "apa yang agent tahu", `agent_self` = "siapa agent ini"

---

## 3. Initial Persona Seed

User/admin set seed awal di agent settings. Ini adalah **bootstrap** — hanya dipakai saat `agent_self` kosong atau di-reset.

### Schema seed (di table `agents`)

```typescript
// Tambah kolom di agents table
persona_seed: jsonb  // nullable

// Type
interface PersonaSeed {
  name?: string           // nama agent (default: agent slug)
  role?: string           // "Assistant", "Analyst", "Coach", dll
  personality?: string    // deskripsi bebas: "curious, direct, warm"
  communication_style?: string  // "concise", "detailed", "casual", "formal"
  background?: string     // latar belakang / expertise domain
  initial_memories?: string[]   // list facts untuk di-seed ke agent_self
}
```

### Seed behavior

```
Saat agent pertama kali dijalankan (agent_self kosong):
  → Convert persona_seed → agent_self core memories
  → Simpan ke DB
  → Agent bisa update/expand dari sini

Saat agent_self sudah ada:
  → Seed diabaikan, tidak overwrite
  → User bisa force reset via "Reset Persona" button di UI
```

---

## 4. Memory Tools untuk Persona

### Tools baru (selalu aktif, app layer)

```typescript
// Baca semua agent_self memories
persona_read: tool({
  description: "Read your current persona and self-knowledge",
  parameters: z.object({}),
  execute: async () => {
    return getMemoriesByScope('agent_self', agentId)
  }
})

// Update/tambah fact tentang diri sendiri
persona_update: tool({
  description: "Update or add to your persona and self-knowledge. Use this when you learn something new about yourself, receive feedback about your communication style, or want to refine your identity.",
  parameters: z.object({
    action: z.enum(['append', 'replace', 'remove']),
    key: z.string(),           // identifier: "personality", "communication_style", "expertise", dll
    content: z.string(),       // konten memory
    tier: z.enum(['core']).default('core'),  // agent_self selalu core
  }),
  execute: async (input) => {
    // upsert ke memory DB dengan scope: agent_self
  }
})
```

### Tidak ada `persona_write` dari user

User tidak punya tool untuk write `agent_self`. User hanya bisa:
1. Set initial seed di settings
2. Reset persona (hapus semua `agent_self`, trigger re-seed)

---

## 5. System Prompt Injection

### Urutan section (update dari Plan 8)

```
[Base Prompt]
[Persona]           ← agent_self memories (Plan 9)
[Memory]
  ## What I Remember
  ### About This Project   ← runtime_global core
  ### General              ← agent_global core
  ### About {user.name}   ← agent_caller core
  ### Relevant Context    ← extended top N
[Plugin Prompts]
[Tool Hints]
[Mode Instruction]
[User Context]
```

### Format `[Persona]` section

```
## Who I Am
**Name:** {name}
**Role:** {role}

{agent_self core memories, formatted as natural prose or bullet list}
```

### Contoh hasil inject

```
## Who I Am
**Name:** Aria
**Role:** Research Assistant

- I communicate in a concise, direct style — I avoid unnecessary filler
- I have deep expertise in DeFi protocols and on-chain analytics
- I prefer to ask clarifying questions before diving into complex analysis
- I've learned that this team values data-backed responses over opinions
- I adapt my tone to be more casual in quick chats, more formal in reports
```

### Kalau `agent_self` kosong dan seed belum di-set

```
## Who I Am
I am {agent.name}, an AI assistant. I'm still learning about myself.
```

---

## 6. Post-run Extraction untuk Persona

Setelah setiap conversation stream selesai (async, non-blocking), sistem juga cek apakah ada **persona-relevant signals**:

```typescript
// Ditambahkan ke extractMemoriesPostRun() yang sudah ada di Plan 8
async function extractPersonaPostRun(context: ExtractionContext) {
  const signals = [
    "user gave feedback about agent's communication style",
    "user corrected agent's self-description",
    "agent demonstrated new capability or expertise",
    "user asked agent to adjust personality",
  ]
  
  // Small LLM check: apakah ada persona signal di conversation?
  // Kalau ya → suggest update via persona_update tool di next turn
  // Atau langsung auto-extract kalau confidence tinggi
}
```

**Decision:** Auto-extract kalau ada explicit feedback dari user ("bisa lebih singkat?", "kamu terlalu formal"), suggest-only kalau implicit.

---

## 7. DB Schema Changes

### Extend `memories` table (dari Plan 8)

```sql
-- Plan 8 sudah punya scope column
-- Tinggal tambah value baru ke enum
ALTER TYPE memory_scope ADD VALUE 'agent_self';
```

### Tambah kolom di `agents` table

```sql
ALTER TABLE agents 
ADD COLUMN persona_seed jsonb,
ADD COLUMN persona_seeded_at timestamptz;  -- null = belum di-seed
```

### Index

```sql
-- Query agent_self memories by agent_id (frequent)
CREATE INDEX idx_memories_agent_self 
ON memories(agent_id, scope) 
WHERE scope = 'agent_self';
```

---

## 8. UI Changes

### Agent Settings — Tab "Persona" (baru)

```
┌─ Agent Settings ──────────────────────────────────┐
│  Info │ LLM │ Prompt │ Persona │ Tools │ Memory   │
│                                                    │
│  Initial Seed                                      │
│  ┌──────────────────────────────────────────────┐ │
│  │ Name          [Aria                        ] │ │
│  │ Role          [Research Assistant          ] │ │
│  │ Personality   [curious, direct, warm       ] │ │
│  │ Comm. Style   [concise and data-backed     ] │ │
│  │ Background    [DeFi, on-chain analytics    ] │ │
│  └──────────────────────────────────────────────┘ │
│                                                    │
│  Initial Memories (seed)                           │
│  ┌──────────────────────────────────────────────┐ │
│  │ + Add memory...                              │ │
│  │ • I prefer asking clarifying questions first │ │
│  │ • I avoid making assumptions about data      │ │
│  └──────────────────────────────────────────────┘ │
│                                                    │
│  Current Persona (live — managed by agent)         │
│  ┌──────────────────────────────────────────────┐ │
│  │ [list agent_self memories dari DB]           │ │
│  │ Last updated: 2 hours ago                    │ │
│  └──────────────────────────────────────────────┘ │
│                                                    │
│  [Save Seed]              [Reset to Seed] ⚠️       │
└────────────────────────────────────────────────────┘
```

**"Reset to Seed"** — hapus semua `agent_self` memories, set `persona_seeded_at = null` sehingga next run trigger re-seed dari `persona_seed`.

### Chat Header — Memory button (extend dari Plan 8)

Memory sheet yang sudah ada di Plan 8 tambah section:

```
┌─ Context Preview ─────────────────────────────────┐
│  [Persona] [Memory] [Tools] [Prompt]               │
│                                                    │
│  Persona (injected)                                │
│  • Name: Aria                                      │
│  • Role: Research Assistant                        │
│  • 5 self-knowledge entries (~320 tokens)          │
└────────────────────────────────────────────────────┘
```

---

## 9. `buildSystemPrompt()` Changes

```typescript
async function buildSystemPrompt(ctx: RuntimeContext): Promise<string> {
  const sections: string[] = []

  // 1. Base prompt
  sections.push(agent.system_prompt)

  // 2. Persona (NEW — Plan 9)
  const personaSection = await buildPersonaSection(ctx)
  if (personaSection) sections.push(personaSection)

  // 3. Memory (Plan 8)
  const memorySection = await buildMemorySection(ctx)
  if (memorySection) sections.push(memorySection)

  // 4. Plugin prompts
  // 5. Tool hints
  // 6. Mode instruction
  // 7. User context

  return sections.join('\n\n')
}

async function buildPersonaSection(ctx: RuntimeContext): Promise<string | null> {
  // Ensure seeded
  await ensurePersonaSeeded(ctx.agentId)
  
  // Get all agent_self memories (no relevance filter — always all)
  const memories = await getMemoriesByScope('agent_self', ctx.agentId)
  
  if (memories.length === 0) return null

  const lines = memories.map(m => `- ${m.content}`)
  
  return [
    '## Who I Am',
    `**Name:** ${ctx.agent.name}`,
    ctx.agent.persona_seed?.role ? `**Role:** ${ctx.agent.persona_seed.role}` : '',
    '',
    lines.join('\n'),
  ].filter(Boolean).join('\n')
}

async function ensurePersonaSeeded(agentId: string) {
  const agent = await db.query.agents.findFirst({ where: eq(agents.id, agentId) })
  
  if (agent.persona_seeded_at) return  // sudah di-seed
  if (!agent.persona_seed) return       // tidak ada seed config
  
  const seed = agent.persona_seed as PersonaSeed
  const memoriesToInsert: NewMemory[] = []
  
  if (seed.name) memoriesToInsert.push({ content: `My name is ${seed.name}`, key: 'name' })
  if (seed.role) memoriesToInsert.push({ content: `My role is ${seed.role}`, key: 'role' })
  if (seed.personality) memoriesToInsert.push({ content: `My personality: ${seed.personality}`, key: 'personality' })
  if (seed.communication_style) memoriesToInsert.push({ content: `My communication style: ${seed.communication_style}`, key: 'communication_style' })
  if (seed.background) memoriesToInsert.push({ content: `My background and expertise: ${seed.background}`, key: 'background' })
  seed.initial_memories?.forEach((m, i) => memoriesToInsert.push({ content: m, key: `seed_${i}` }))
  
  await db.transaction(async (tx) => {
    await tx.insert(memories).values(
      memoriesToInsert.map(m => ({
        ...m,
        agent_id: agentId,
        scope: 'agent_self',
        tier: 'core',
        importance: 'high',
      }))
    )
    await tx.update(agents)
      .set({ persona_seeded_at: new Date() })
      .where(eq(agents.id, agentId))
  })
}
```

---

## 10. Implementation Checklist

### @jiku/types

- [ ] Tambah `agent_self` ke `MemoryScope` enum
- [ ] Tambah `PersonaSeed` interface
- [ ] Tambah `persona_seed`, `persona_seeded_at` ke `Agent` type

### @jiku-studio/db

- [ ] Migration: alter `memory_scope` enum tambah `agent_self`
- [ ] Migration: alter `agents` tambah `persona_seed`, `persona_seeded_at`
- [ ] Migration: tambah index `idx_memories_agent_self`

### apps/studio/server

- [ ] `buildPersonaSection()` — query + format persona memories
- [ ] `ensurePersonaSeeded()` — bootstrap on first run
- [ ] `buildSystemPrompt()` — insert persona section sebelum memory
- [ ] `buildMemoryTools()` — tambah `persona_read`, `persona_update` tools
- [ ] `extractPersonaPostRun()` — extend post-run extraction
- [ ] Route: `PATCH /api/agents/:id/persona` — update seed
- [ ] Route: `POST /api/agents/:id/persona/reset` — reset persona
- [ ] Route: `GET /api/agents/:id/persona/memories` — list agent_self memories

### apps/studio/web

- [ ] Tab "Persona" di agent settings layout
- [ ] `PersonaSeedForm` component — name, role, personality, comm style, background
- [ ] `PersonaSeedMemories` component — list + add initial memories
- [ ] `CurrentPersonaPanel` component — live view agent_self memories (read-only)
- [ ] "Reset to Seed" confirmation dialog
- [ ] Extend `ContextPreviewSheet` — tambah Persona tab/section

---

## 11. Tidak Perlu di Plan 9

Yang **tidak** di-implement di plan ini (defer ke plan berikutnya):

- `user_relationship` config (`superior` | `peer` | `subordinate`) → Plan 11 (Deeper Agentic)
- `proactive` / `can_refuse` flags → Plan 11
- Persona yang berbeda per user (agent_caller persona) → defer, terlalu complex
- Persona versioning / history → defer

---

*Plan 9 — Persona System*  
*Depends on: Plan 8 (Memory System)*  
*Generated: 2026-04-05*