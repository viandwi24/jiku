# Plan 13 / 33 — Browser Automation Implementation Report

**Date:** 2026-04-09
**Status:** ✅ COMPLETE (Plan 13 abandoned → Plan 33 shipped)
**Related plans:** `docs/plans/13-browser.md` (original, failed), Plan 33 (current, shipped)
**Related feats:** `docs/feats/browser.md`, `docs/feats/attachments.md`

---

## Executive Summary

Plan 13 (OpenClaw browser port) was abandoned after ~80 files were ported and the stack failed to work reliably (headless-only, CDP timeouts, untestable). It was replaced by **Plan 33**, which combines:

1. A new `@jiku/browser` package (CLI bridge to Vercel `agent-browser` via CDP + Docker).
2. A **unified content attachment system** so that tool outputs (screenshots, exports, binary blobs) are persisted to S3 via a single reusable persister — not embedded as base64.

End result: browser automation works, screenshots are stored as first-class attachments, and there are no URLs in the database — only `attachment_id` + `storage_key`, with URLs generated on-demand at the UI/LLM boundary.

---

## Scope

### What was built
- `packages/browser/` — Standalone package wrapping `agent-browser` CLI with CDP over Docker.
- `apps/studio/server/src/browser/` — Tool-definition layer (rewritten, no engine code).
- `apps/studio/server/src/content/persister.ts` — Unified `persistContentToAttachment()` service.
- Database schema extension: `source_type` + `metadata` columns on `project_attachments`.
- Auth-gated attachment serving endpoints (JWT + HMAC proxy token).
- UI updates: `ToolOutput` component + `useAttachmentUrl()` hook.

### What was deleted
- All ~80 OpenClaw engine files under `apps/studio/server/src/browser/browser/`.
- Shared-browser-server lifecycle (singleton, child process, control port).
- `ResolvedBrowserConfig` complex config resolution.

---

## Architecture

```
┌──────────────────────────────────────────────────────┐
│ Agent Runtime (manager.ts)                           │
│   buildBrowserTools(projectId, config) ─────────┐    │
└──────────────────────────────────────────────────┼───┘
                                                   │
                          ┌────────────────────────▼───────────┐
                          │ apps/studio/server/src/browser/    │
                          │   tool.ts   — zod schemas          │
                          │   execute.ts — action dispatcher   │
                          │   config.ts — CDP endpoint resolve │
                          │   index.ts  — per-project CDP map  │
                          └────────────────────────┬───────────┘
                                                   │
                          ┌────────────────────────▼───────────┐
                          │ @jiku/browser                      │
                          │   execBrowserCommand(cmd, cdpUrl)  │
                          └────────────────────────┬───────────┘
                                                   │ spawn
                          ┌────────────────────────▼───────────┐
                          │ agent-browser CLI (Rust)           │
                          │   --cdp ws://localhost:9222        │
                          └────────────────────────┬───────────┘
                                                   │ CDP
                          ┌────────────────────────▼───────────┐
                          │ Docker: Chromium + Xvfb + noVNC    │
                          │   :9222 CDP, :6080 noVNC viewer    │
                          └────────────────────────────────────┘
```

### Key design decisions

1. **No shared browser server.** Old design ran a Node child process wrapping Playwright. New design: per-command spawn of the Rust CLI. Stateless, testable, crash-isolated.
2. **CDP endpoint per project.** Stored in `projects.browser_config.cdp_url`, resolved at tool-build time. No start/stop lifecycle.
3. **Screenshots are attachments, not base64.** `executeBrowserAction()` intercepts the `screenshot` action and calls `persistContentToAttachment()`. Tool output returns an attachment reference.
4. **Attachment references, not URLs.** Output shape: `{ type: 'image', attachment_id, storage_key, mime_type }`. URLs are generated at UI render time (`useAttachmentUrl()`) or LLM delivery time (chat route).

---

## Unified Attachment System

### Database schema (`project_attachments`)

New columns:
- `source_type VARCHAR(32) DEFAULT 'user_upload'` — origin tag (`user_upload`, `browser_screenshot`, `connector_export`, `plugin_output`, etc.)
- `metadata JSONB` — arbitrary source-specific data (URL, viewport, selector, etc.)
- Index on `source_type` for filtering.
- Migration: `0008_add_attachment_source_tracking.sql`.

### Types (`packages/types/src/index.ts`)

```typescript
export interface ContentPersistOptions {
  projectId: string
  data: Buffer
  mimeType: string
  filename?: string
  sourceType: string
  metadata?: Record<string, unknown>
  scope?: { conversationId?: string; agentId?: string; userId?: string }
}

export interface ContentPersistResult {
  attachmentId: string
  storageKey: string
  mimeType: string
  sizeBytes: number
  // NO url field — URLs generated on-demand
}

export type ToolContentPart =
  | { type: 'text'; text: string }
  | {
      type: 'image'
      attachment_id: string
      storage_key: string
      mime_type: string
    }
```

### Persister (`apps/studio/server/src/content/persister.ts`)

1. Generate storage key: `jiku/attachments/{projectId}/{scope}/{uuid}.{ext}`
2. Upload buffer via filesystem adapter (S3).
3. Create `project_attachments` row with `source_type` + `metadata`.
4. Return `{ attachmentId, storageKey, mimeType, sizeBytes }`.

### Serving layers

| Endpoint | Auth | Consumer |
|----------|------|----------|
| `GET /api/attachments/:id/inline?token=JWT` | JWT token in query | UI (`<img src>`, downloads) |
| `GET /files/view?key=&token=HMAC` | HMAC proxy token | External model providers (OpenAI, Anthropic vision) |
| `POST /projects/:pid/attachments/:id/token` | JWT | Mints HMAC token for external consumers |

### LLM delivery path

In `apps/studio/server/src/routes/chat.ts`, the `attachment://{id}` URL scheme is resolved per-request:
- `file_delivery = 'proxy_url'` → mint HMAC token, build `/files/view?...` URL, send to LLM
- `file_delivery = 'base64'` → download from S3, inline as `data:mime;base64,...`

This is configured per-agent, not globally.

### UI rendering path

`packages/ui/src/components/ai-elements/tool.tsx` (`ToolOutput`) was updated to handle attachment references:

```typescript
// New format (persisted attachment)
{ type: 'image', attachment_id: '...', storage_key: '...', mime_type: 'image/png' }

// Legacy format (still supported)
{ type: 'image', data: 'base64...', mimeType: 'image/png' }
```

The `token` prop is passed from `conversation-viewer.tsx` via `getToken()`; `<img src>` URLs are built inline using `window.location.origin + /api/attachments/:id/inline?token=JWT`.

The `useAttachmentUrl()` hook (`apps/studio/web/hooks/use-attachment-url.ts`) provides the same for any other component that needs authenticated URLs.

---

## Browser Module Rewrite

### Files
| File | Before | After |
|------|--------|-------|
| `browser/index.ts` | Singleton server lifecycle | `Map<projectId, { endpoint }>` |
| `browser/config.ts` | Complex `resolveBrowserConfig` | `resolveCdpEndpoint(config)` |
| `browser/execute.ts` | OpenClaw wrappers | `@jiku/browser.execBrowserCommand()` |
| `browser/tool.ts` | `buildBrowserTools(serverBaseUrl)` | `buildBrowserTools(projectId, config)` |
| `browser/browser/` (80 files) | OpenClaw port | **DELETED** |

### Screenshot flow

```typescript
// apps/studio/server/src/browser/execute.ts
case 'screenshot': {
  const result = await execBrowserCommand({ action: 'screenshot' }, cdpEndpoint)
  const buffer = Buffer.from(result.data.base64, 'base64')

  const persisted = await persistContentToAttachment({
    projectId,
    data: buffer,
    mimeType: 'image/png',
    sourceType: 'browser_screenshot',
    metadata: { url: result.data.url, viewport: result.data.viewport },
  })

  return {
    content: [{
      type: 'image',
      attachment_id: persisted.attachmentId,
      storage_key: persisted.storageKey,
      mime_type: persisted.mimeType,
    }],
  }
}
```

### Runtime manager changes

- Removed `startBrowserServer`, `stopBrowserServer`, `stopAllBrowserServers` imports.
- Removed `Promise.race` timeout wrapper (no server to start).
- `syncProjectTools()` calls `buildBrowserTools(projectId, config)` synchronously.
- `sleep()` and `stopAll()` no longer touch browser processes.

### API routes (`routes/browser.ts`)

Simplified `BrowserConfigSchema`:
```typescript
{
  cdp_url: z.string().url(),
  timeout_ms: z.number().int().positive().default(30000),
  evaluate_enabled: z.boolean().default(false),
  screenshot_as_attachment: z.boolean().default(true),
}
```
Removed: `mode`, `headless`, `executable_path`, `control_port`.

`POST /projects/:pid/browser/ping` now tests the CDP endpoint directly via HTTP `/json/version` instead of querying a control server.

---

## Decisions recorded

- **ADR-034** (`docs/builder/decisions.md`) — Content references use `attachment_id` + `storage_key`, never URLs. Single source of truth in DB; URLs derived on-demand at the edge.

---

## Files Changed / Added / Deleted

### Added
- `apps/studio/server/src/content/persister.ts`
- `apps/studio/web/hooks/use-attachment-url.ts`
- `apps/studio/db/src/migrations/0008_add_attachment_source_tracking.sql`
- `packages/browser/` (entire package — see `docs/feats/browser.md`)

### Modified
- `packages/types/src/index.ts` — `ToolContentPart`, `ContentPersistResult`, `ContentPersistOptions`
- `packages/ui/src/components/ai-elements/tool.tsx` — attachment reference rendering
- `apps/studio/db/src/schema/attachments.ts` — `source_type`, `metadata` columns
- `apps/studio/server/src/browser/index.ts` — per-project CDP map
- `apps/studio/server/src/browser/config.ts` — `resolveCdpEndpoint()`
- `apps/studio/server/src/browser/execute.ts` — dispatch via `@jiku/browser` + screenshot persistence
- `apps/studio/server/src/browser/tool.ts` — new signature
- `apps/studio/server/src/routes/browser.ts` — simplified schema + ping
- `apps/studio/server/src/routes/chat.ts` — already handled `attachment://` resolution (verified)
- `apps/studio/server/src/routes/attachments.ts` — `/inline` and `/files/view` endpoints (verified)
- `apps/studio/server/src/runtime/manager.ts` — removed server lifecycle
- `apps/studio/web/components/chat/conversation-viewer.tsx` — pass JWT token to `ToolOutput`

### Deleted
- `apps/studio/server/src/browser/browser/*` (~80 files, full OpenClaw port)

---

## Verification

- ✅ `bun run dev` — server boots, all plugins load, all runtimes boot.
- ✅ `bun run db:push` — migrations applied cleanly.
- ⏳ End-to-end screenshot test (open page → screenshot → attachment persisted → rendered in chat UI) — pending manual verification with a live browser container.
- ⏳ Connector action output persistence — not yet migrated to the unified persister (tracked as Phase 6 in `docs/builder/current.md`).

---

## Pending Work

1. **Phase 6** — Migrate connector action outputs to `persistContentToAttachment()`.
2. **Phase 7** — Write integration test for browser screenshot → attachment → render pipeline.
3. **Multi-tab isolation** — Current design uses agent-browser's single active tab; concurrent users on the same profile will collide. Deferred.

---

## Lessons Learned

1. **Don't port what you don't own.** Plan 13 tried to port ~80 files of OpenClaw internals. Most of it wasn't load-bearing, and debugging the broken subset was worse than starting over.
2. **CLI bridges beat library ports** for language-mismatched engines. Spawning a Rust binary per command is simpler than maintaining a thick Node wrapper.
3. **Storage references, not URLs.** Every time a URL is stored in the DB, it becomes a liability when the domain, auth, or CDN changes. `id + key` with on-demand URL generation is strictly more flexible.
4. **Persistence should be a one-liner for tools.** The `persistContentToAttachment()` service makes it trivial for any tool (browser, connector, plugin, future exporters) to persist outputs without touching S3, DB, or auth code.