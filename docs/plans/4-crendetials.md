# Plan 4 — Credentials System

> Status: **PLANNING**
> Date: 2026-04-04
> Scope: DB schema, server API, web UI, agent model selector, 404 fixes, missing pages

---

## Daftar Isi

1. [Overview](#1-overview)
2. [Credentials Concept](#2-credentials-concept)
3. [Adapter System](#3-adapter-system)
4. [DB Schema](#4-db-schema)
5. [Encryption](#5-encryption)
6. [Server — API Routes](#6-server--api-routes)
7. [Web — Pages & Components](#7-web--pages--components)
8. [404 Fix & Missing Pages](#8-404-fix--missing-pages)
9. [Agent Model Selector](#9-agent-model-selector)
10. [File Changes](#10-file-changes)
11. [Implementation Checklist](#11-implementation-checklist)

---

## 1. Overview

### Scope Plan 4

1. **Credentials system** — CRUD credentials dengan scope company/project, enkripsi AES-256-GCM, adapter system dengan group ID
2. **Missing pages** — company settings, project settings, project permissions
3. **404 fixes** — slug-based navigation konsisten di semua routes
4. **Agent model selector** — agent bisa pilih credentials + model + metadata override
5. **Sidebar navigation** — settings links untuk company dan project

### Keputusan Desain

```
- URL navigation  → slug (bukan ID)
- Encryption      → AES-256-GCM via Node.js crypto
- Adapters        → built-in dulu, plugin bisa register post-MVP
- Conflict        → tidak ada conflict — credentials punya identity sendiri (id + name)
                    yang berbeda hanya scope (company vs project)
```

---

## 2. Credentials Concept

### Identity

Credentials bukan di-override by type. Setiap credential punya identity sendiri:

```
id           → unique identifier
name         → "OpenAI Production", "Anthropic Dev Key"
description  → optional, human readable
group_id     → kategori besar: "provider-model" | "channel" | "storage"
adapter_id   → implementasi spesifik: "openai" | "anthropic" | "telegram"
scope        → "company" | "project"
scope_id     → company_id atau project_id (tergantung scope)
fields       → secret fields, ENCRYPTED (api_key, bot_token, dll)
metadata     → non-secret fields, plain JSON (org_id, base_url, dll)
```

### Visibility / Scope

```
Company credentials (scope: "company")
  → visible di SEMUA project dalam company

Project credentials (scope: "project")
  → visible HANYA di project tersebut

Agent pilih credentials by ID dari pool yang available
  → pool = union(company credentials, project credentials)
  → tidak ada conflict, agent bebas pilih mana
```

### Contoh

```
Company "Bitorex":
  credentials:
    - id: cred-1, name: "OpenAI Production", adapter: openai   (scope: company)
    - id: cred-2, name: "Anthropic Main",    adapter: anthropic (scope: company)

Project "Trading Bot":
  credentials:
    - id: cred-3, name: "OpenAI Testing",    adapter: openai   (scope: project)

Agent "Signal Analyzer" bisa pilih dari:
  → cred-1 "OpenAI Production"  (dari company)
  → cred-2 "Anthropic Main"     (dari company)
  → cred-3 "OpenAI Testing"     (dari project)
```

---

## 3. Adapter System

### Struktur

```
group_id: "provider-model"      → LLM providers
  adapter_id: "openai"
  adapter_id: "anthropic"
  adapter_id: "openrouter"
  adapter_id: "ollama"

group_id: "channel"             → messaging channels
  adapter_id: "telegram"
  adapter_id: "discord"         (future)
  adapter_id: "slack"           (future)

group_id: "storage"             → future
group_id: "webhook"             → future
```

### Built-in Adapters Definition

```typescript
// apps/studio/server/src/credentials/adapters.ts

export interface AdapterField {
  key: string
  label: string
  type: 'secret' | 'string' | 'number' | 'boolean'
  required: boolean
  default?: string
  placeholder?: string
}

export interface AdapterModel {
  id: string
  name: string
  description?: string
}

export interface CredentialAdapter {
  group_id: string
  adapter_id: string
  name: string
  icon: string
  fields: AdapterField[]     // secret → dienkripsi
  metadata: AdapterField[]   // non-secret → plain JSON
  models: AdapterModel[]     // kosong = dynamic fetch
}

export const CREDENTIAL_ADAPTERS: CredentialAdapter[] = [
  {
    group_id: 'provider-model',
    adapter_id: 'openai',
    name: 'OpenAI',
    icon: 'openai',
    fields: [
      { key: 'api_key', label: 'API Key', type: 'secret', required: true, placeholder: 'sk-...' }
    ],
    metadata: [
      { key: 'organization_id', label: 'Organization ID', type: 'string', required: false },
      { key: 'base_url', label: 'Base URL (override)', type: 'string', required: false },
    ],
    models: [
      { id: 'gpt-4o', name: 'GPT-4o' },
      { id: 'gpt-4o-mini', name: 'GPT-4o Mini' },
      { id: 'gpt-4-turbo', name: 'GPT-4 Turbo' },
      { id: 'o1', name: 'o1' },
      { id: 'o1-mini', name: 'o1 Mini' },
    ]
  },
  {
    group_id: 'provider-model',
    adapter_id: 'anthropic',
    name: 'Anthropic',
    icon: 'anthropic',
    fields: [
      { key: 'api_key', label: 'API Key', type: 'secret', required: true, placeholder: 'sk-ant-...' }
    ],
    metadata: [
      { key: 'base_url', label: 'Base URL (override)', type: 'string', required: false },
    ],
    models: [
      { id: 'claude-opus-4-6', name: 'Claude Opus 4.6' },
      { id: 'claude-sonnet-4-6', name: 'Claude Sonnet 4.6' },
      { id: 'claude-haiku-4-5-20251001', name: 'Claude Haiku 4.5' },
    ]
  },
  {
    group_id: 'provider-model',
    adapter_id: 'openrouter',
    name: 'OpenRouter',
    icon: 'openrouter',
    fields: [
      { key: 'api_key', label: 'API Key', type: 'secret', required: true }
    ],
    metadata: [
      { key: 'site_url', label: 'Site URL', type: 'string', required: false },
      { key: 'site_name', label: 'Site Name', type: 'string', required: false },
    ],
    models: []  // dynamic dari OpenRouter API
  },
  {
    group_id: 'provider-model',
    adapter_id: 'ollama',
    name: 'Ollama (Local)',
    icon: 'ollama',
    fields: [],  // tidak ada secret
    metadata: [
      { key: 'base_url', label: 'Base URL', type: 'string', required: true, default: 'http://localhost:11434' }
    ],
    models: []  // dynamic dari Ollama instance
  },
  {
    group_id: 'channel',
    adapter_id: 'telegram',
    name: 'Telegram Bot',
    icon: 'telegram',
    fields: [
      { key: 'bot_token', label: 'Bot Token', type: 'secret', required: true }
    ],
    metadata: [],
    models: []
  },
]

export function getAdapter(adapter_id: string): CredentialAdapter | undefined {
  return CREDENTIAL_ADAPTERS.find(a => a.adapter_id === adapter_id)
}

export function getAdaptersByGroup(group_id?: string): CredentialAdapter[] {
  if (!group_id) return CREDENTIAL_ADAPTERS
  return CREDENTIAL_ADAPTERS.filter(a => a.group_id === group_id)
}
```

---

## 4. DB Schema

### Tabel Baru

```typescript
// apps/studio/db/src/schema/credentials.ts

export const credentials = pgTable('credentials', {
  id:               uuid('id').primaryKey().defaultRandom(),
  name:             varchar('name', { length: 255 }).notNull(),
  description:      text('description'),
  group_id:         varchar('group_id', { length: 100 }).notNull(),
  adapter_id:       varchar('adapter_id', { length: 100 }).notNull(),
  scope:            varchar('scope', { length: 20 }).notNull(),
  // 'company' | 'project'
  scope_id:         uuid('scope_id').notNull(),
  // company_id atau project_id tergantung scope
  fields_encrypted: text('fields_encrypted'),
  // AES-256-GCM encrypted JSON: { api_key: '...', bot_token: '...' }
  metadata:         jsonb('metadata').default({}),
  // Plain JSON: { org_id: '...', base_url: '...' }
  created_by:       uuid('created_by').references(() => users.id),
  created_at:       timestamp('created_at').defaultNow(),
  updated_at:       timestamp('updated_at').defaultNow(),
})

// Agent ↔ Credential assignment
// One-to-one: satu agent punya satu primary credential
export const agent_credentials = pgTable('agent_credentials', {
  id:                uuid('id').primaryKey().defaultRandom(),
  agent_id:          uuid('agent_id').references(() => agents.id).notNull(),
  credential_id:     uuid('credential_id').references(() => credentials.id).notNull(),
  model_id:          varchar('model_id', { length: 255 }),
  // model yang dipilih: 'gpt-4o', 'claude-sonnet-4-6', dll
  metadata_override: jsonb('metadata_override').default({}),
  // Per-agent override, merge dengan credential.metadata
  // agent override menang
}, t => ({ uq: unique().on(t.agent_id) }))
```

### Revisi Tabel `agents`

```typescript
// HAPUS dari agents:
//   provider_id  (pindah ke agent_credentials)
//   model_id     (pindah ke agent_credentials)
//
// TAMBAH ke agents:
//   slug  (untuk URL navigation)

export const agents = pgTable('agents', {
  id:            uuid('id').primaryKey().defaultRandom(),
  project_id:    uuid('project_id').references(() => projects.id).notNull(),
  name:          varchar('name', { length: 255 }).notNull(),
  slug:          varchar('slug', { length: 255 }).notNull(),   // ← TAMBAH
  description:   text('description'),
  base_prompt:   text('base_prompt').notNull(),
  allowed_modes: text('allowed_modes').array().notNull().default(['chat']),
  created_at:    timestamp('created_at').defaultNow(),
}, t => ({ uq: unique().on(t.project_id, t.slug) }))
```

---

## 5. Encryption

### AES-256-GCM

```typescript
// apps/studio/server/src/credentials/encryption.ts

import { createCipheriv, createDecipheriv, randomBytes } from 'crypto'

const ALGORITHM = 'aes-256-gcm'
const IV_LENGTH = 16
const TAG_LENGTH = 16

function getKey(): Buffer {
  const key = process.env.CREDENTIALS_ENCRYPTION_KEY
  if (!key) throw new Error('CREDENTIALS_ENCRYPTION_KEY not set in env')
  const buf = Buffer.from(key, 'hex')
  if (buf.length !== 32) throw new Error('CREDENTIALS_ENCRYPTION_KEY must be 32 bytes (64 hex chars)')
  return buf
}

export function encrypt(plaintext: string): string {
  const key = getKey()
  const iv = randomBytes(IV_LENGTH)
  const cipher = createCipheriv(ALGORITHM, key, iv)

  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()

  // Format: iv:tag:encrypted (semua base64 untuk compactness)
  return [iv.toString('base64'), tag.toString('base64'), encrypted.toString('base64')].join('.')
}

export function decrypt(ciphertext: string): string {
  const key = getKey()
  const [ivB64, tagB64, encB64] = ciphertext.split('.')

  const decipher = createDecipheriv(ALGORITHM, key, Buffer.from(ivB64, 'base64'))
  decipher.setAuthTag(Buffer.from(tagB64, 'base64'))

  return Buffer.concat([
    decipher.update(Buffer.from(encB64, 'base64')),
    decipher.final()
  ]).toString('utf8')
}

export function encryptFields(fields: Record<string, string>): string {
  return encrypt(JSON.stringify(fields))
}

export function decryptFields(encrypted: string): Record<string, string> {
  return JSON.parse(decrypt(encrypted))
}

export function maskFields(fields: Record<string, string>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(fields).map(([k, v]) => [
      k,
      v.length > 8 ? `${v.slice(0, 3)}...${v.slice(-4)}` : '••••'
    ])
  )
}
```

### Rules Keamanan

```
- fields_encrypted TIDAK PERNAH dikirim ke client
- API response hanya kirim fields_masked (4 char terakhir visible)
- Test connection → server decrypt + test, tidak expose nilai ke client
- CREDENTIALS_ENCRYPTION_KEY di .env — generate: openssl rand -hex 32
- Rotate key → re-encrypt semua credentials (future tooling)
```

---

## 6. Server — API Routes

### Adapter Routes

```
GET /api/credentials/adapters
GET /api/credentials/adapters?group_id=provider-model
```

### Credentials CRUD

```
# Company-scoped
GET    /api/companies/:slug/credentials
POST   /api/companies/:slug/credentials

# Project-scoped
GET    /api/projects/:slug/credentials
POST   /api/projects/:slug/credentials

# Available untuk project (union company + project)
GET    /api/projects/:slug/credentials/available
GET    /api/projects/:slug/credentials/available?group_id=provider-model

# Shared operations (by credential ID)
PATCH  /api/credentials/:id
DELETE /api/credentials/:id
POST   /api/credentials/:id/test
```

### Agent Credentials

```
GET    /api/agents/:slug/credentials         ← get assignment
POST   /api/agents/:slug/credentials         ← assign credential + model
PATCH  /api/agents/:slug/credentials         ← update model / metadata_override
DELETE /api/agents/:slug/credentials         ← unassign
```

### Response Shapes

```typescript
// Credential response (TIDAK include fields_encrypted)
interface CredentialResponse {
  id: string
  name: string
  description: string | null
  group_id: string
  adapter_id: string
  scope: 'company' | 'project'
  scope_id: string
  metadata: Record<string, unknown>
  fields_masked: Record<string, string>  // "sk-...4321"
  adapter: CredentialAdapter             // full adapter definition
  created_at: string
}

// Available credentials response
interface AvailableCredentialsResponse {
  credentials: CredentialResponse[]
  // credentials sudah diurutkan: company dulu, lalu project
}

// Agent credential response
interface AgentCredentialResponse {
  id: string
  agent_id: string
  credential: CredentialResponse
  model_id: string | null
  metadata_override: Record<string, unknown>
}
```

### Credential Service

```typescript
// apps/studio/server/src/credentials/service.ts

// Build Vercel AI SDK provider dari credential
export function buildProvider(
  adapter_id: string,
  fields: Record<string, string>,
  metadata: Record<string, string>,
  model_id?: string | null
) {
  switch (adapter_id) {
    case 'openai':
      return createOpenAI({
        apiKey: fields.api_key,
        organization: metadata.organization_id,
        baseURL: metadata.base_url || undefined,
      })(model_id ?? 'gpt-4o')

    case 'anthropic':
      return createAnthropic({
        apiKey: fields.api_key,
        baseURL: metadata.base_url || undefined,
      })(model_id ?? 'claude-sonnet-4-6')

    case 'openrouter':
      return createOpenAI({
        apiKey: fields.api_key,
        baseURL: 'https://openrouter.ai/api/v1',
        defaultHeaders: {
          'HTTP-Referer': metadata.site_url ?? '',
          'X-Title': metadata.site_name ?? 'Jiku',
        }
      })(model_id ?? 'openai/gpt-4o')

    case 'ollama':
      return createOllama({
        baseURL: metadata.base_url ?? 'http://localhost:11434',
      })(model_id ?? 'llama3.2')

    default:
      throw new Error(`Unknown adapter: ${adapter_id}`)
  }
}

// Resolve model untuk agent — decrypt + build provider
export async function resolveAgentModel(agentId: string) {
  const agentCred = await getAgentCredential(agentId)

  if (!agentCred) {
    // Fallback ke env default
    const defaultKey = process.env.ANTHROPIC_API_KEY
    if (defaultKey) {
      return createAnthropic({ apiKey: defaultKey })('claude-sonnet-4-6')
    }
    throw new Error(`Agent ${agentId} has no credential assigned and no default provider`)
  }

  const fields = agentCred.credential.fields_encrypted
    ? decryptFields(agentCred.credential.fields_encrypted)
    : {}

  const metadata = {
    ...agentCred.credential.metadata as Record<string, string>,
    ...agentCred.metadata_override as Record<string, string>,
    // Per-agent override menang atas credential metadata
  }

  return buildProvider(
    agentCred.credential.adapter_id,
    fields,
    metadata,
    agentCred.model_id
  )
}
```

---

## 7. Web — Pages & Components

### New Pages

```
/[company]/settings
  → General: edit company name, slug
  → Danger zone: delete company

/[company]/settings/credentials
  → List company credentials
  → Add/edit/delete/test credentials

/[company]/[project]/settings
  → General: edit project name, slug
  → Danger zone: delete project

/[company]/[project]/settings/credentials
  → List project credentials + show inherited company credentials
  → Add/edit/delete/test project-scoped credentials

/[company]/[project]/settings/permissions
  → Placeholder untuk MVP, content future
```

### Credentials Components (packages/ui)

#### `CredentialSelector`

```
Filter: [All Groups ▾] [All Adapters ▾]

── provider-model ──────────────────────
● OpenAI Production    company  openai
○ Anthropic Main       company  anthropic
○ OpenAI Testing       project  openai

── channel ─────────────────────────────
○ Telegram Bot         company  telegram
```

#### `CredentialForm`

```
Name *          [OpenAI Production          ]
Description     [Main key for prod          ]

Adapter *       [OpenAI                   ▾ ]

── Secret Fields ────────────────────────────
API Key *       [••••••••••••••••••••••••   ]

── Metadata (Optional) ──────────────────────
Organization    [org-xxxxx                  ]
Base URL        [                           ]

[Test Connection]            [Cancel] [Save]
```

#### `ModelSelector`

```
── GPT Models ──────────────────────────────
● gpt-4o          GPT-4o
○ gpt-4o-mini     GPT-4o Mini
○ gpt-4-turbo     GPT-4 Turbo

── Reasoning ───────────────────────────────
○ o1              o1
○ o1-mini         o1 Mini
```

Kalau adapter tidak punya static models (ollama, openrouter) → free text input.

#### `MetadataOverrideForm`

```
Metadata Override (optional)
Overrides credential defaults for this agent

base_url    [https://custom.api/v1          ]
[+ Add Field]
```

### Agent Settings — Tab "Model & Provider"

```
Agent Settings
Tabs: [Overview] [Model & Provider] [Permissions] [Danger]

[Model & Provider tab]

Provider Credential
┌────────────────────────────────────────────────────────┐
│ OpenAI Production                          [Change]    │
│ Adapter: OpenAI  |  Scope: Company                    │
│ Status: ● Connected                                    │
└────────────────────────────────────────────────────────┘

Model
┌────────────────────────────────────────────────────────┐
│ ● gpt-4o         GPT-4o                               │
│ ○ gpt-4o-mini    GPT-4o Mini                          │
│ ○ o1             o1                                    │
└────────────────────────────────────────────────────────┘

Metadata Override (optional)
┌────────────────────────────────────────────────────────┐
│ No overrides set                           [+ Add]     │
└────────────────────────────────────────────────────────┘

[Save Changes]
```

### Credentials Page — Company & Project

```
Company Settings / Credentials

Company Credentials                         [+ Add Credential]
┌────────────────────────────────────────────────────────────┐
│ Name                │ Adapter    │ Status      │ Actions   │
├────────────────────────────────────────────────────────────┤
│ OpenAI Production   │ OpenAI     │ ● Connected │ [⋯]      │
│ Anthropic Main      │ Anthropic  │ ● Connected │ [⋯]      │
│ Telegram Bot        │ Telegram   │ ● Connected │ [⋯]      │
└────────────────────────────────────────────────────────────┘
```

```
Project Settings / Credentials

Inherited from Company                      (read-only)
┌────────────────────────────────────────────────────────────┐
│ OpenAI Production   │ OpenAI     │ ● Connected │ (company) │
│ Anthropic Main      │ Anthropic  │ ● Connected │ (company) │
└────────────────────────────────────────────────────────────┘

Project Credentials                         [+ Add Credential]
┌────────────────────────────────────────────────────────────┐
│ OpenAI Testing      │ OpenAI     │ ● Connected │ [⋯]      │
└────────────────────────────────────────────────────────────┘
```

### Sidebar Navigation Update

```
[Company Name]
  ├── Projects
  └── Settings
        ├── General
        └── Credentials ←

[Project Name]
  ├── Agents
  └── Settings
        ├── General
        ├── Credentials ←
        └── Permissions ←
```

---

## 8. 404 Fix & Missing Pages

### Root Cause

URL pakai slug tapi kemungkinan link di web navigate ke ID. Perlu audit semua `router.push()` dan `<Link href>` di web.

### Fix Strategy

```typescript
// Semua navigation pakai slug
// Contoh yang benar:
router.push(`/${company.slug}/${project.slug}/agents/${agent.slug}`)

// Bukan:
router.push(`/${company.id}/${project.id}/agents/${agent.id}`)
```

### Auto-generate Slug

```typescript
// apps/studio/server/src/utils/slug.ts

export function generateSlug(name: string): string {
  return name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
}

// Kalau slug sudah exist di project/company, tambah suffix
export async function uniqueSlug(
  base: string,
  checkExists: (slug: string) => Promise<boolean>
): Promise<string> {
  let slug = generateSlug(base)
  let counter = 1

  while (await checkExists(slug)) {
    slug = `${generateSlug(base)}-${counter}`
    counter++
  }

  return slug
}
```

### Agents Perlu Slug

Agent sebelumnya tidak punya slug. Plan ini tambahkan slug ke agents agar URL-nya clean:

```
/bitorex/trading-bot/agents/signal-analyzer
                              ↑ agent slug
```

---

## 9. Agent Model Selector — Flow

```
1. User buka /[company]/[project]/agents/[agent]/settings
   → pilih tab "Model & Provider"

2. Fetch:
   GET /api/projects/:slug/credentials/available?group_id=provider-model
   → dapat list credentials yang bisa dipilih

3. GET /api/agents/:slug/credentials
   → dapat current assignment (kalau ada)

4. Tampil CredentialSelector dengan filter group_id: 'provider-model'

5. User pilih credential
   → fetch adapter definition dari registry (sudah di-cache di client)
   → tampil ModelSelector sesuai adapter.models
   → kalau models kosong → tampil free text input

6. Optional: tampil MetadataOverrideForm

7. User klik Save:
   POST/PATCH /api/agents/:slug/credentials
   {
     credential_id: 'cred-123',
     model_id: 'gpt-4o',
     metadata_override: {}
   }

8. Server: runtime.syncAgent(projectId, agentId)
   → resolveAgentModel() → decrypt + buildProvider()
   → agent di runtime sekarang pakai model baru
```

---

## 10. File Changes

### New Files

```
apps/studio/db/src/schema/credentials.ts
apps/studio/db/src/queries/credentials.ts

apps/studio/server/src/credentials/adapters.ts
apps/studio/server/src/credentials/encryption.ts
apps/studio/server/src/credentials/service.ts
apps/studio/server/src/routes/credentials.ts
apps/studio/server/src/utils/slug.ts

apps/studio/web/app/(app)/[company]/settings/page.tsx
apps/studio/web/app/(app)/[company]/settings/credentials/page.tsx
apps/studio/web/app/(app)/[company]/[project]/settings/page.tsx
apps/studio/web/app/(app)/[company]/[project]/settings/credentials/page.tsx
apps/studio/web/app/(app)/[company]/[project]/settings/permissions/page.tsx

packages/ui/src/components/credentials/credential-selector.tsx
packages/ui/src/components/credentials/credential-form.tsx
packages/ui/src/components/credentials/credential-card.tsx
packages/ui/src/components/credentials/credential-list.tsx
packages/ui/src/components/credentials/model-selector.tsx
packages/ui/src/components/credentials/metadata-override-form.tsx
```

### Modified Files

```
apps/studio/db/src/schema/agents.ts
  → Tambah slug field
  → Hapus provider_id, model_id

apps/studio/db/src/schema/relations.ts
  → Tambah: credentials, agent_credentials

apps/studio/server/src/runtime/manager.ts
  → wakeUp() → call resolveAgentModel() per agent
  → syncAgent() → reload agent + credential

apps/studio/server/src/routes/agents.ts
  → Lookup by slug
  → Create: auto-generate slug
  → PATCH/DELETE: trigger syncAgent / removeAgent

apps/studio/server/src/routes/companies.ts
  → Lookup by slug (bukan id)

apps/studio/server/src/routes/projects.ts
  → Lookup by slug
  → Create: wakeUp() → auto-generate slug

apps/studio/server/src/index.ts
  → Register credentials routes

apps/studio/web/lib/api.ts
  → Tambah: credentials, adapters endpoints

apps/studio/web/app/(app)/[company]/layout.tsx
  → Tambah settings nav

apps/studio/web/app/(app)/[company]/[project]/layout.tsx
  → Tambah settings nav

apps/studio/web/app/(app)/[company]/[project]/agents/[agent]/settings/page.tsx
  → Revisi: hapus provider/model fields lama
  → Tambah: tab "Model & Provider"

apps/studio/web/.env.example (atau server)
  → Tambah CREDENTIALS_ENCRYPTION_KEY

packages/ui/src/index.ts
  → Export credentials components
```

---

## 11. Implementation Checklist

### `@jiku-studio/db`
- [ ] Schema: `credentials` table
- [ ] Schema: `agent_credentials` table
- [ ] Schema: revisi `agents` — tambah `slug`, hapus `provider_id` + `model_id`
- [ ] Schema: update `relations.ts`
- [ ] Query: `getCompanyCredentials(companyId)`
- [ ] Query: `getProjectCredentials(projectId)`
- [ ] Query: `getAvailableCredentials(projectId)` — union company + project
- [ ] Query: `createCredential(data)` — encrypt fields sebelum simpan
- [ ] Query: `updateCredential(id, data)`
- [ ] Query: `deleteCredential(id)`
- [ ] Query: `getAgentCredential(agentId)`
- [ ] Query: `assignAgentCredential(data)`
- [ ] Query: `updateAgentCredential(agentId, data)`
- [ ] Query: `unassignAgentCredential(agentId)`
- [ ] Migration: generate + test

### `@jiku-studio/server`
- [ ] `credentials/adapters.ts` — registry + 5 built-in adapters
- [ ] `credentials/encryption.ts` — AES-256-GCM encrypt/decrypt + mask
- [ ] `credentials/service.ts` — maskCredential, testCredential, buildProvider, resolveAgentModel
- [ ] `utils/slug.ts` — generateSlug, uniqueSlug
- [ ] Routes: `GET /api/credentials/adapters` (+ ?group_id filter)
- [ ] Routes: company credentials CRUD
- [ ] Routes: project credentials CRUD
- [ ] Routes: `GET /api/projects/:slug/credentials/available`
- [ ] Routes: `POST /api/credentials/:id/test`
- [ ] Routes: agent credentials assign/update/delete
- [ ] Runtime: `resolveAgentModel()` dipanggil di `wakeUp()` + `syncAgent()`
- [ ] Semua routes pakai slug lookup (bukan ID)
- [ ] Auto-generate slug saat create company/project/agent
- [ ] `.env.example`: tambah `CREDENTIALS_ENCRYPTION_KEY`

### `packages/ui`
- [ ] `credentials/credential-selector.tsx` — filter by group + adapter
- [ ] `credentials/credential-form.tsx` — dynamic form per adapter
- [ ] `credentials/credential-card.tsx` — display dengan masked fields + status
- [ ] `credentials/credential-list.tsx` — tabel dengan scope badge
- [ ] `credentials/model-selector.tsx` — static list atau free text
- [ ] `credentials/metadata-override-form.tsx` — key-value editor
- [ ] Export semua dari `index.ts`

### `apps/studio/web`
- [ ] Fix 404: audit + fix semua navigation links (slug bukan ID)
- [ ] Company settings page — general
- [ ] Company settings/credentials page
- [ ] Project settings page — general
- [ ] Project settings/credentials page — inherited + project-scoped
- [ ] Project settings/permissions page — placeholder
- [ ] Agent settings — revisi: tambah tab "Model & Provider"
- [ ] Agent settings — CredentialSelector (filtered provider-model)
- [ ] Agent settings — ModelSelector (dynamic per adapter)
- [ ] Agent settings — MetadataOverrideForm
- [ ] Sidebar: settings nav untuk company + project
- [ ] `lib/api.ts`: credentials + adapters endpoints

---

*Generated: 2026-04-04 | Status: Planning — Ready for Implementation*