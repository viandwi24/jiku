# Plan 4 — Credentials System: Implementation Report

> Status: **DONE**
> Date: 2026-04-05
> Implementor: Claude (claude-sonnet-4-6)

---

## Ringkasan

Plan 4 mengimplementasikan sistem credentials end-to-end: DB schema baru, enkripsi AES-256-GCM, adapter registry, API routes, UI components, dan halaman settings untuk company/project/agent. Termasuk migrasi chat dari WebSocket ke HTTP streaming via Vercel AI SDK + implementasi `buildProvider()`. Semua backlog items telah diselesaikan.

---

## Checklist Status

### `@jiku-studio/db`

- [x] Schema: `credentials` table
- [x] Schema: `agent_credentials` table
- [x] Schema: revisi `agents` — tambah `slug`, hapus `provider_id` + `model_id`
- [x] Schema: update `relations.ts`
- [x] Query: `getCompanyCredentials(companyId)`
- [x] Query: `getProjectCredentials(projectId)`
- [x] Query: `getAvailableCredentials(projectId)` — union company + project
- [x] Query: `createCredential(data)`
- [x] Query: `updateCredential(id, data)`
- [x] Query: `deleteCredential(id)`
- [x] Query: `getAgentCredential(agentId)`
- [x] Query: `assignAgentCredential(data)`
- [x] Query: `updateAgentCredential(agentId, data)`
- [x] Query: `unassignAgentCredential(agentId)`
- [x] Migration: generate (`0001_lumpy_ezekiel.sql`) + push ke DB
- [x] Query tambahan: `getAgentBySlug(projectId, slug)`
- [x] Query tambahan: `updateCompany(id, data)`, `deleteCompany(id)`
- [x] Query tambahan: `updateProject(id, data)`

### `@jiku-studio/server`

- [x] `credentials/adapters.ts` — registry + 5 built-in adapters
- [x] `credentials/encryption.ts` — AES-256-GCM encrypt/decrypt + mask
- [x] `credentials/service.ts` — `formatCredential`, `testCredential`, `resolveAgentModel`, `buildProvider`
- [x] `utils/slug.ts` — `generateSlug`, `uniqueSlug`
- [x] Routes: `GET /api/credentials/adapters` (+ `?group_id` filter)
- [x] Routes: company credentials CRUD (`GET/POST /api/companies/:slug/credentials`)
- [x] Routes: project credentials CRUD (`GET/POST /api/projects/:id/credentials`)
- [x] Routes: `GET /api/projects/:id/credentials/available`
- [x] Routes: `POST /api/credentials/:id/test`
- [x] Routes: agent credentials assign/patch/delete (`/api/agents/:id/credentials`)
- [x] `env.ts`: tambah `CREDENTIALS_ENCRYPTION_KEY`
- [x] Auto-generate slug saat create company/project/agent
- [x] Runtime manager: hapus `provider_id`/`model_id` dari `RuntimeAgent`, tambah `slug`
- [x] `PATCH /api/companies/:slug` — edit name/slug + conflict check
- [x] `DELETE /api/companies/:slug` — delete company
- [x] `PATCH /api/projects/:pid` — edit name/slug + conflict check
- [x] Chat migration: hapus WebSocket (`ws/chat.ts`, `ws/server.ts`), tambah `routes/chat.ts` (HTTP streaming via JikuRuntime)
- [x] `buildProvider()` — support openai, anthropic, openrouter, ollama via `@ai-sdk/*`
- [x] `JikuRuntimeManager` direwrite — pegang satu `JikuRuntime` per project (project = runtime)
- [x] `StudioStorageAdapter` implement full `JikuStorageAdapter` interface — messages disimpan sebagai `MessageContent[]` jsonb
- [x] Chat route pakai `runtimeManager.run()` → `JikuRuntime.run()` → `AgentRunner` (bukan streamText langsung)
- [x] Dynamic provider pattern — `resolveAgentModel()` + `buildProvider()` per-request, model di-cache sementara selama stream berlangsung
- [x] Plugin KV store: tabel `plugin_kv` (project_id, scope, key, value jsonb) + queries — `StudioStorageAdapter.pluginGet/Set/Delete/Keys` pakai DB bukan in-memory

### `packages/ui`

- [x] `credentials/credential-selector.tsx` — grouped by group_id, filter support
- [x] `credentials/credential-form.tsx` — dynamic fields + metadata per adapter, show/hide secret, edit mode (keep-current pattern untuk secret fields)
- [x] `credentials/credential-card.tsx` — scope badge (company/project), dropdown actions, pass full object ke onEdit
- [x] `credentials/credential-list.tsx` — empty state, readonly mode
- [x] `credentials/model-selector.tsx` — static list atau free text input
- [x] `credentials/metadata-override-form.tsx` — key-value editor dengan add/remove
- [x] Export semua dari `index.ts`

### `apps/studio/web`

- [x] Company settings page — form edit name/slug + danger zone (delete)
- [x] Company settings/credentials page — add + edit + delete + test
- [x] Project settings page — form edit name/slug + danger zone (delete)
- [x] Project settings/credentials page — inherited company (read-only) + project-scoped (full CRUD)
- [x] Project settings/permissions page — placeholder
- [x] Agent settings — tambah tab "Model & Provider"
- [x] Agent settings — `CredentialSelector` (filtered `provider-model`)
- [x] Agent settings — `ModelSelector` (dynamic per adapter)
- [x] Agent settings — `MetadataOverrideForm`
- [x] Settings button di company list page + project list page
- [x] `lib/api.ts`: credentials + adapters endpoints, companies/projects update + delete
- [x] `Agent` type: hapus `provider_id`/`model_id`, tambah `slug`
- [x] `AgentConfigForm`: hapus field model lama + `provider_id`/`model_id`
- [x] `CreateAgentDialog`: hapus `provider_id`/`model_id` dari payload
- [x] Fix 404 — `AgentCard`: URL pakai `agent.slug` (bukan `agent.id`)
- [x] Fix 404 — `AgentChatPage`: resolve `agent.id` dari `slug` param, semua API calls pakai resolved ID
- [x] Fix 404 — `AgentSettingsPage`: resolve `agentId` dari `agentSlug` param
- [x] Fix 404 — `PermissionsPage`: resolve `agentId` dari `agentSlug` param
- [x] Fix — `AgentChatPage`: hapus `agent.model_id` reference yang sudah dihapus dari schema
- [x] Chat migration: `ChatInterface` pakai `useChat` dari `@ai-sdk/react` + `DefaultChatTransport`
- [x] Fix UX — `ChatInterface` tampilkan error bubble merah saat server return error (e.g. credential belum di-assign)

---

## Deviasi dari Plan

### 1. `buildProvider()` selesai tapi implementasinya berbeda dari rencana awal

**Plan:** `service.ts` include `buildProvider()` yang return Vercel AI SDK provider instance, diimplementasi bersamaan dengan schema credentials.

**Aktual:** `buildProvider()` diimplementasi setelah `@ai-sdk/openai`, `@ai-sdk/anthropic`, `@openrouter/ai-sdk-provider` di-install. Packages ini tidak ada di server saat Plan 4 pertama kali dikerjakan. Selesai di iterasi kedua.

**Impact:** Tidak ada regresi. `resolveAgentModel()` sudah siap duluan dan langsung dipakai saat `buildProvider()` selesai.

### 2. `resolveAgentModel()` dipanggil per-request via dynamic provider pattern

**Plan:** Runtime manager memanggil `resolveAgentModel()` saat `wakeUp()` dan `syncAgent()`.

**Aktual:** `resolveAgentModel()` + `buildProvider()` dipanggil per-request di `runtimeManager.run()`. Model di-cache sementara di `modelCache` Map hanya selama durasi stream, lalu dihapus.

**Reasoning:** Menyimpan decrypted credentials di long-lived memory adalah security risk. Dynamic provider pattern memastikan decrypted key hanya ada di memory selama satu request berlangsung.

### 3. WebSocket diganti HTTP streaming via JikuRuntime (bukan diperbaiki)

**Plan awal (Plan 3):** Chat via WebSocket di `ws/chat.ts`, bypass `JikuRuntime`.

**Aktual:** WebSocket dihapus sepenuhnya. Chat sekarang lewat `JikuRuntime.run()` → `AgentRunner` → `streamText()`, streamed via `POST /api/conversations/:id/chat`. Client pakai `useChat` dari `@ai-sdk/react`. Policy enforcement, tool filtering, dan plugin system semua aktif melalui runtime.

**Reasoning:** WebSocket sudah broken setelah schema refactor, dan integrasi ke `JikuRuntime` diperlukan agar policy enforcement dan tool system berjalan.

### 4. Navigation dari plan §7 sidebar tidak diimplementasi sebagai sidebar items

**Plan:** Settings links di sidebar navigation (nested under company/project name).

**Aktual:** Settings diakses via gear icon button di halaman company list dan project list. Sidebar global tidak berubah karena tidak punya context current company/project.

**Reasoning:** Sidebar adalah global layout tanpa routing context. Gear button di page header lebih praktis tanpa refactor besar.

### 5. `createCredential` di query tidak encrypt — enkripsi di route layer

**Plan:** Query `createCredential` langsung encrypt fields.

**Aktual:** Enkripsi dilakukan di route handler sebelum memanggil `createCredential`. Query menerima `fields_encrypted` yang sudah terenkripsi.

**Reasoning:** Keeps DB layer pure (no side effects in queries), encryption is a transport/API concern.

---

## File yang Dibuat / Dimodifikasi

### New Files

```
apps/studio/db/src/schema/credentials.ts
apps/studio/db/src/schema/plugin_kv.ts
apps/studio/db/src/queries/credentials.ts
apps/studio/db/src/queries/plugin_kv.ts
apps/studio/db/src/migrations/0001_lumpy_ezekiel.sql

apps/studio/server/src/credentials/encryption.ts
apps/studio/server/src/credentials/adapters.ts
apps/studio/server/src/credentials/service.ts
apps/studio/server/src/routes/credentials.ts
apps/studio/server/src/routes/chat.ts
apps/studio/server/src/utils/slug.ts

apps/studio/web/app/(app)/[company]/settings/page.tsx
apps/studio/web/app/(app)/[company]/settings/credentials/page.tsx
apps/studio/web/app/(app)/[company]/[project]/settings/page.tsx
apps/studio/web/app/(app)/[company]/[project]/settings/credentials/page.tsx
apps/studio/web/app/(app)/[company]/[project]/settings/permissions/page.tsx

packages/ui/src/components/credentials/credential-card.tsx
packages/ui/src/components/credentials/credential-form.tsx
packages/ui/src/components/credentials/credential-list.tsx
packages/ui/src/components/credentials/credential-selector.tsx
packages/ui/src/components/credentials/model-selector.tsx
packages/ui/src/components/credentials/metadata-override-form.tsx
```

### Modified Files

```
apps/studio/db/src/schema/agents.ts         — tambah slug, hapus provider_id/model_id
apps/studio/db/src/schema/relations.ts      — tambah credentials relations
apps/studio/db/src/schema/index.ts          — export credentials
apps/studio/db/src/queries/agent.ts         — tambah getAgentBySlug
apps/studio/db/src/queries/company.ts       — tambah updateCompany, deleteCompany
apps/studio/db/src/queries/project.ts       — tambah updateProject
apps/studio/db/src/queries/conversation.ts  — tambah updateConversation, listConversationsByAgent, deleteMessagesByIds
apps/studio/db/src/index.ts                 — export queries/credentials + plugin_kv

apps/studio/server/src/env.ts               — tambah CREDENTIALS_ENCRYPTION_KEY
apps/studio/server/src/index.ts             — register credentialsRouter + chatRouter, hapus WebSocket
apps/studio/server/src/routes/agents.ts     — slug auto-generate, hapus provider_id/model_id
apps/studio/server/src/routes/projects.ts   — slug auto-generate, tambah PATCH route
apps/studio/server/src/routes/companies.ts  — slug auto-generate, tambah PATCH + DELETE routes
apps/studio/server/src/runtime/manager.ts   — rewrite: JikuRuntime per project, dynamic provider, runtimeManager.run()
apps/studio/server/src/runtime/storage.ts   — rewrite: implement full JikuStorageAdapter, messages disimpan sebagai MessageContent[]
apps/studio/server/src/credentials/service.ts — tambah buildProvider()
apps/studio/server/package.json             — tambah ai + @ai-sdk/* packages, hapus ws + @anthropic-ai/sdk

apps/studio/web/lib/api.ts                  — credentials API, update Agent type, companies/projects update+delete
apps/studio/web/lib/ws.ts                   — shim re-export dari @ai-sdk/react
apps/studio/web/components/agent/agent-config-form.tsx      — hapus model_id field
apps/studio/web/components/agent/agent-card.tsx             — URL pakai agent.slug
apps/studio/web/components/agent/create-agent-dialog.tsx    — hapus provider_id/model_id dari payload
apps/studio/web/components/agent/chat/chat-interface.tsx    — useChat dari @ai-sdk/react, tampilkan error state
apps/studio/web/app/(app)/[company]/page.tsx                — tambah settings button
apps/studio/web/app/(app)/[company]/[project]/page.tsx      — tambah settings button
apps/studio/web/app/(app)/[company]/[project]/agents/[agent]/page.tsx               — resolve agentId dari slug, guard agentId undefined
apps/studio/web/app/(app)/[company]/[project]/agents/[agent]/settings/page.tsx      — resolve agentId dari slug, tambah Model & Provider tab
apps/studio/web/app/(app)/[company]/[project]/agents/[agent]/settings/permissions/page.tsx — resolve agentId dari slug
apps/studio/web/package.json                — tambah @ai-sdk/react

packages/ui/src/components/credentials/credential-card.tsx — pass full object ke onEdit
packages/ui/src/components/credentials/credential-form.tsx — edit mode + keep-current secret pattern
packages/ui/src/components/credentials/credential-list.tsx — update onEdit signature
packages/ui/src/index.ts                    — export credentials components
```

### Deleted Files

```
apps/studio/server/src/ws/chat.ts   — diganti routes/chat.ts (HTTP streaming)
apps/studio/server/src/ws/server.ts — WebSocket server tidak dipakai lagi
```

---

*Generated: 2026-04-05 | Plan 4 Complete — no open items*
