# Plan 3 — Studio Base: Implementation Report

> Plan: `docs/plans/3-studio-base.md`
> Status: **COMPLETE**
> Date: 2026-04-04

---

## Ringkasan

Plan 3 adalah implementasi Jiku MVP Studio dari nol — mencakup database layer, HTTP server, shared UI package, dan web frontend. Semua fitur dalam scope MVP berhasil diimplementasikan.

---

## Apa yang Diimplementasikan

### 1. `packages/ui` — Shared Component Library

Package React component library yang bisa di-share antara studio web dan future plugin UI contributions.

**Struktur:**
```
packages/ui/src/components/
  layout/   sidebar.tsx, header.tsx, empty-state.tsx
  data/     data-table.tsx, stat-card.tsx, permission-badge.tsx
  agent/    chat-bubble.tsx, chat-input.tsx, tool-call-view.tsx, thinking-indicator.tsx
```

**Keputusan:**
- Pakai shadcn/ui sebagai base primitives (Button, Input, Dialog, dll) via re-export dari `@jiku/ui`
- Tailwind CSS sebagai peer dependency — tidak di-bundle, consumer yang define theme
- Export path: `@jiku/ui` untuk semua komponen

---

### 2. `apps/studio/db` — Database Layer

Drizzle ORM schema, typed query helpers, migrations, dan seeding.

**11 Tabel:**
| Tabel | Deskripsi |
|-------|-----------|
| `users` | User accounts dengan hashed password |
| `companies` | Multi-tenant companies |
| `roles` | Custom roles per company (Owner, Admin, Member + custom) |
| `permissions` | Granular permission keys (e.g. `jiku.social:post:write`) |
| `role_permissions` | Many-to-many role ↔ permission |
| `company_members` | User membership + role assignment |
| `projects` | Projects dalam company |
| `agents` | AI agents dalam project |
| `policy_rules` | Access rules per agent |
| `agent_user_policies` | Self-restriction per user per agent |
| `conversations` + `messages` | Chat history |

**Query Helpers:** `auth.ts`, `company.ts`, `project.ts`, `agent.ts`, `policy.ts`, `conversation.ts`

**Seeding:** System permissions (`jiku.social:post:write/read/delete`) + per-company system roles (Owner/Admin/Member) dengan permission assignment otomatis saat company dibuat.

---

### 3. `apps/studio/server` — HTTP + WebSocket Server

Hono framework, JWT auth, REST API, WebSocket streaming chat.

**Stack:**
- `@hono/node-server` untuk HTTP (bukan `Bun.serve` — Node-compatible)
- `ws` npm package untuk WebSocket upgrade
- `jose` untuk JWT (HS256)
- `bcryptjs` untuk password hashing
- Anthropic SDK untuk LLM streaming

**Endpoints:**
```
POST /api/auth/register
POST /api/auth/login

GET  /api/companies
POST /api/companies

GET  /api/companies/:cid/projects
POST /api/companies/:cid/projects
DEL  /api/companies/:cid/projects/:pid

GET  /api/projects/:pid/agents
POST /api/projects/:pid/agents
PATCH /api/agents/:aid
DEL  /api/agents/:aid

GET/POST/DEL /api/agents/:aid/policies/rules
GET/PATCH    /api/agents/:aid/policies/users
GET/PATCH    /api/agents/:aid/policies/users/me

GET  /api/agents/:aid/conversations
POST /api/agents/:aid/conversations

WS  /ws/chat/:conversationId
```

**`JikuRuntimeManager`:** In-memory runtime per project. Boot semua project saat server start. Hot reload agent saat edit.

**`resolveCaller()`:** Load actual permissions dari role → intersect dengan self-restriction (AgentUserPolicy) → return `CallerContext`.

**`StudioStorageAdapter`:** Implements `JikuStorageAdapter` via DB queries untuk conversation + message persistence.

---

### 4. `apps/studio/web` — Next.js Frontend

Next.js App Router, TanStack Query, Zustand, shadcn/ui.

**Halaman:**
| Route | Deskripsi |
|-------|-----------|
| `/login`, `/register` | Auth pages |
| `/home` | Company selector |
| `/[company]` | Project list |
| `/[company]/[project]` | Agent list |
| `/[company]/[project]/agents/[agent]` | Chat interface |
| `/[company]/[project]/agents/[agent]/settings` | Agent config |
| `/[company]/[project]/agents/[agent]/settings/permissions` | Permission management |

**Auth Flow:**
- Zustand store dengan `persist` untuk token storage
- `_hydrated` flag + `onRehydrateStorage` untuk menunggu localStorage load sebelum redirect
- Auth guard di `(app)/layout.tsx` — redirect ke `/login` jika tidak ada token

**Chat:**
- WebSocket client (`lib/ws.ts`) dengan custom `useChat` hook
- Streaming chunks dari server dirender real-time
- Auto-scroll ke bawah, Enter to send, Shift+Enter untuk newline

**Permissions Page:**
- Policy rules table dengan add/delete
- User policy list dengan permission badges
- "Edit My Permissions" modal — self-restriction dengan checkbox per permission

---

## Deviasi dari Plan

| Item | Plan | Aktual | Alasan |
|------|------|--------|--------|
| Runtime | `Bun.serve` + `ServerWebSocket<Bun>` | `@hono/node-server` + `ws` npm | Node-compatible, tidak lock ke Bun runtime |
| Password | `Bun.password` | `bcryptjs` | Node-compatible |
| Env | `Bun.env` | `process.env` | Node-compatible |
| DB commands | Di `db/` package | Di `server/` package via `--env-file` | Single `.env` di server, tidak duplikasi |
| Docker | Tidak ada di plan | `docker-compose.yml` di server | Convenience untuk dev Postgres |

---

## Bug yang Ditemukan & Diperbaiki

1. **Login redirect loop** — `app/page.tsx` pakai `redirect('/login')` tanpa cek auth state. Fix: client component yang cek hydration dulu.
2. **Zustand hydration race** — `_hydrated` flag tidak set kalau pakai `useState`. Fix: `onRehydrateStorage` callback.
3. **`--font-sans: var(--font-sans)` self-reference** — CSS variable recursion. Fix: `var(--font-geist-sans)`.
4. **EADDRINUSE on hot reload** — `bun --watch` kill+restart tapi port belum release. Fix: `bun --hot` (in-process).
5. **`bcryptjs.verify` not found** — v3 export `compare`, bukan `verify`. Fix: import yang benar.
6. **Middleware path mismatch di projects route** — `router.use('/:cid/*')` menangkap `companies` sebagai `:cid`. Fix: `router.use('/companies/:cid/*')`.

---

## File yang Dibuat

```
packages/ui/
  package.json, src/index.ts
  src/components/layout/{sidebar,header,empty-state}.tsx
  src/components/data/{data-table,stat-card,permission-badge}.tsx
  src/components/agent/{chat-bubble,chat-input,tool-call-view,thinking-indicator}.tsx

apps/studio/db/
  package.json, drizzle.config.ts
  src/client.ts, src/seed.ts, src/index.ts
  src/schema/{users,companies,roles,permissions,projects,agents,policies,conversations,index,relations}.ts
  src/queries/{auth,company,project,agent,policy,conversation}.ts

apps/studio/server/
  package.json, docker-compose.yml, .env.example
  src/index.ts, src/env.ts, src/types.ts
  src/middleware/{auth,company}.ts
  src/routes/{auth,companies,projects,agents,policies,conversations}.ts
  src/runtime/{manager,storage,caller}.ts
  src/ws/{chat,server}.ts

apps/studio/web/
  package.json, next.config.ts, tailwind.config (via CSS)
  app/layout.tsx, app/globals.css, app/page.tsx
  app/(auth)/{login,register}/page.tsx
  app/(app)/layout.tsx, app/(app)/home/page.tsx
  app/(app)/[company]/{layout,page}.tsx
  app/(app)/[company]/[project]/{layout,page}.tsx
  app/(app)/[company]/[project]/agents/[agent]/{layout,page}.tsx
  app/(app)/[company]/[project]/agents/[agent]/settings/{page,permissions/page}.tsx
  components/providers.tsx
  components/auth/{login-form,register-form}.tsx
  components/company/{company-card,create-company-dialog}.tsx
  components/project/{project-card,create-project-dialog}.tsx
  components/agent/{agent-card,create-agent-dialog,agent-config-form}.tsx
  components/agent/chat/{chat-interface,message-list,input-bar}.tsx
  components/permissions/{policy-rules-table,user-policy-list,edit-my-permissions}.tsx
  lib/{api,ws,auth,utils}.ts
  lib/store/{auth,sidebar}.store.ts
```

---

*Generated: 2026-04-04*
