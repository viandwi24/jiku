# Plan 14 — Filesystem Implementation Report

**Date:** 2026-04-06 (initial ship), 2026-04-09 (this report)
**Status:** ✅ COMPLETE
**Plan:** `docs/plans/14-fs.md`
**Feature doc:** `docs/feats/filesystem.md`
**Depends on:** Plan 4 (Credentials System), Plan 12 (Auth & ACL)
**Extended by:** Plan 15 (Skills — uses FilesystemService for skill file storage)

---

## Executive Summary

Plan 14 delivers a unified **virtual filesystem per project**. Files are
represented as virtual paths in Postgres (`project_files` table) and backed
by S3-compatible object storage (RustFS/MinIO/AWS S3) via an adapter
pattern. Agents get 6 built-in tools (`fs_list`, `fs_read`, `fs_write`,
`fs_move`, `fs_delete`, `fs_search`); humans get a full file manager UI at
`/disk` with CodeMirror editor, drag-and-drop upload, inline rename, and
search. Storage backends are switchable per-project without downtime via a
migration workflow.

Key numbers:
- **2 DB tables:** `project_filesystem_config` (1 row per project) + `project_files` (1 row per file)
- **6 agent tools** — 4 read-only, 2 write, all chat+task mode
- **14 REST API routes** — config CRUD, file CRUD, search, upload, stream/proxy, migration
- **1 reusable UI component:** `FileExplorer` — used by both `/disk` and `/skills` (Plan 15)
- **Content caching:** files ≤ 50 KB are stored in `content_cache` column (avoids S3 round-trip on read)
- **File type guard:** 30+ text-only extensions allowed, max 5 MB per file
- **Path traversal prevention:** `normalizePath()` strips `..` sequences and collapses `//`

---

## Architecture

```
┌─────────────────────────────────────────────────────┐
│ Agent Runtime (built_in_tools injection)            │
│   buildFilesystemTools(projectId) ──────┐           │
└─────────────────────────────────────────┼──────────┘
                                          │
             ┌────────────────────────────▼─────────────┐
             │ apps/studio/server/src/filesystem/       │
             │   tools.ts    — 6 ToolDefinitions        │
             │   service.ts  — FilesystemService class  │
             │   adapter.ts  — S3FilesystemAdapter      │
             │   utils.ts    — validation + path utils  │
             └────────────────────────────┬─────────────┘
                                          │
             ┌────────────────────────────▼─────────────┐
             │ S3-compatible storage                    │
             │   RustFS / MinIO / AWS S3               │
             │   key: projects/{projectId}{virtualPath} │
             └──────────────────────────────────────────┘

             ┌──────────────────────────────────────────┐
             │ Database (Postgres)                      │
             │   project_filesystem_config — 1:1 config │
             │   project_files — virtual path entries   │
             │     unique(project_id, path)             │
             │     content_cache (text, ≤50KB files)    │
             └──────────────────────────────────────────┘

             ┌──────────────────────────────────────────┐
             │ Web UI (/disk page)                      │
             │   FileExplorer component                 │
             │     ├─ Left: file tree + breadcrumbs     │
             │     └─ Right: CodeMirror editor          │
             │   3 tabs: Explorer, Attachments, Config  │
             └──────────────────────────────────────────┘
```

---

## Design Decisions

### 1. Virtual paths in DB, objects in S3

Files are NOT stored as blobs in Postgres. The DB holds metadata (`path`,
`name`, `folder_path`, `extension`, `storage_key`, `size_bytes`,
`mime_type`, `content_cache`) and the actual content lives in S3. The
`storage_key` is `projects/{projectId}{virtualPath}` — flat key, no S3
"folders".

**Why:** S3 is cheap, durable, and streamable. Postgres stays small (only
metadata + optional ≤50 KB content cache). The unique constraint on
`(project_id, path)` gives us virtual path uniqueness without needing S3
object locking.

### 2. Folders are virtual (implicit)

There is no `folders` table. A "folder" exists if and only if at least one
file has a `folder_path` that matches it. `extractImmediateSubfolders()` in
`utils.ts` derives the folder tree from the set of file paths at query time.

**Why:** fewer DB entities, no orphan folders, no need to create intermediate
folders before writing a deeply nested file. `fs_write /a/b/c/d.ts` just
works — the folders `/a`, `/a/b`, `/a/b/c` appear automatically in `list`.

### 3. Content caching for small files

When a file is written and `size_bytes ≤ 50_000` (50 KB), its full content
is stored in the `content_cache` text column. `read()` checks this column
first and only falls through to an S3 `GetObject` if the cache is null.

**Why:** most config files, scripts, and markdown documents are under 50 KB.
Caching them in Postgres turns a two-hop `read` (Postgres → S3) into a
single-hop (Postgres only). Large files (>50 KB) bypass the cache and stream
from S3 directly.

### 4. Text-only, 5 MB guard

`ALLOWED_EXTENSIONS` in `utils.ts` is a whitelist of 30+ text file
extensions. Binary files (images, video, audio, PDFs) are rejected at both
the API route layer and the `write()` service method. Max file size is 5 MB.

**Why:** the virtual disk is designed for agent-authored code, notes, and
configs — not for media storage. Binary file support was deferred as a
non-goal. Media (screenshots, uploads) goes through the separate
`project_attachments` system (Plan 33 unified attachments).

### 5. Adapter pattern with credential resolution

`S3FilesystemAdapter` is constructed from decrypted credential fields
(`access_key_id`, `secret_access_key`) and metadata (`endpoint`, `bucket`,
`region`). The factory function `getFilesystemService(projectId)` looks up
the project's filesystem config, decrypts the credential via Plan 4's
`resolveCredential()`, and builds the adapter.

**Why:** decouples storage implementation from the service. Future adapters
(GCS, R2, local disk) only need to implement
`upload`/`download`/`delete`/`exists`/`buildKey`/`getStream`. The
`forcePathStyle: true` option is required for RustFS/MinIO compatibility.

### 6. `/disk` not `/files` (ADR-024)

The UI page route is `/projects/[project]/disk`, not `/files`. This avoids
ambiguity with agent-scoped file pages and makes it clear the feature is a
"virtual disk" for the project.

---

## Database Schema

### `project_filesystem_config`

One row per project. Stores which storage adapter is active, which credential
to use, whether the feature is enabled, and aggregate stats.

| Column | Type | Notes |
|--------|------|-------|
| `id` | uuid PK | |
| `project_id` | uuid UNIQUE FK → projects | ON DELETE CASCADE |
| `adapter_id` | varchar | Default `'s3'`. Extensible to `'gcs'`, `'r2'`, etc. |
| `credential_id` | uuid | FK to credentials (no cascade — SET NULL on delete) |
| `enabled` | boolean | Default false |
| `total_files` | int | Recalculated by `updateFilesystemStats()` |
| `total_size_bytes` | bigint | Recalculated by `updateFilesystemStats()` |
| `created_at` | timestamptz | |
| `updated_at` | timestamptz | |

### `project_files`

One row per virtual file. The `content_cache` column holds the full file
content for files ≤ 50 KB.

| Column | Type | Notes |
|--------|------|-------|
| `id` | uuid PK | |
| `project_id` | uuid FK → projects | ON DELETE CASCADE |
| `path` | text | Full virtual path, e.g. `/src/index.ts`. Unique with `project_id`. |
| `name` | varchar | Filename, e.g. `index.ts` |
| `folder_path` | text | Parent folder, e.g. `/src` |
| `extension` | varchar | Lowercase, e.g. `.ts` |
| `storage_key` | text | S3 key: `projects/{projectId}{virtualPath}` |
| `size_bytes` | int | |
| `mime_type` | varchar | Default `text/plain` |
| `content_cache` | text (nullable) | Full content if ≤ 50 KB, null otherwise |
| `created_by` | uuid FK → users (nullable) | null if created by agent |
| `updated_by` | uuid FK → users (nullable) | null if updated by agent |
| `created_at` | timestamptz | |
| `updated_at` | timestamptz | |

**Indexes:**

- `(project_id)` — all files in a project
- `(project_id, folder_path)` — files in a specific folder (used by `list`)
- `(project_id, extension)` — files by type
- `(project_id, updated_at DESC)` — recently modified files

**Unique constraint:** `(project_id, path)` — no two files can have the same
virtual path in the same project.

---

## Backend Implementation

### Service (`apps/studio/server/src/filesystem/service.ts`)

`FilesystemService` is the core abstraction. It's constructed with a
`projectId` and an `S3FilesystemAdapter`. Methods:

| Method | Description |
|--------|-------------|
| `list(folderPath)` | Returns files directly in the folder + virtual subfolders derived from deeper file paths. Two DB queries: one for direct files, one for all paths with the folder prefix (for subfolder extraction). |
| `read(filePath)` | Returns string content. Checks `content_cache` first, falls back to `adapter.download()`. |
| `write(filePath, content, userId?)` | Validates extension + size → uploads to S3 → upserts DB row (with `content_cache` if ≤ 50 KB) → updates stats. |
| `move(fromPath, toPath)` | Downloads from old key → uploads to new key → deletes old key → updates DB row. Not atomic at the S3 level (S3 doesn't have rename). |
| `delete(filePath)` | Deletes from S3 → deletes DB row → updates stats. |
| `deleteFolder(folderPath)` | Finds all files with prefix → parallel S3 deletes → batch DB delete → updates stats. |
| `search(query, extension?)` | Case-insensitive ILIKE on `name` and `path`, optionally filtered by extension. Limit 100. |

Factory functions:

- `getFilesystemService(projectId)` — resolves config + credential → builds adapter → returns `FilesystemService` or `null` if not enabled.
- `migrateFilesystemAdapter(projectId, newCredentialId, newAdapterId)` — downloads every file from the old adapter and re-uploads to the new one, then updates all `storage_key` values in DB.
- `testFilesystemConnection(projectId)` — uploads a small probe object, downloads it, deletes it. Returns success/failure.

Custom errors: `NotFoundError` (→ 404), `ValidationError` (→ 422), `ConflictError` (→ 409).

### Adapter (`apps/studio/server/src/filesystem/adapter.ts`)

`S3FilesystemAdapter` wraps `@aws-sdk/client-s3`:

| Method | Description |
|--------|-------------|
| `buildKey(projectId, virtualPath)` | `projects/{projectId}{virtualPath}` |
| `upload(key, content, mimeType)` | `PutObjectCommand` |
| `download(key)` | `GetObjectCommand` → `transformToByteArray()` → Buffer |
| `getStream(key)` | Returns `{ stream, contentType, contentLength }` for the proxy route |
| `delete(key)` | `DeleteObjectCommand` |
| `exists(key)` | `HeadObjectCommand` (returns boolean) |

`buildS3Adapter(fields, metadata)` extracts encrypted credential fields
(`access_key_id`, `secret_access_key`) and metadata (`endpoint`, `bucket`,
`region`) to construct the client. `forcePathStyle: true` is mandatory for
RustFS/MinIO.

### Utilities (`apps/studio/server/src/filesystem/utils.ts`)

| Export | Description |
|--------|-------------|
| `ALLOWED_EXTENSIONS` | `Set<string>` of 30+ text-only extensions |
| `MAX_FILE_SIZE_BYTES` | `5 * 1024 * 1024` |
| `isAllowedFile(filename, sizeBytes)` | Validates extension + size |
| `normalizePath(input)` | Leading `/`, collapse `//`, strip `..` (path traversal guard) |
| `extractImmediateSubfolders(paths, folderPath)` | Derives virtual subfolders from file paths |
| `MIME_MAP` + `getMimeType(ext)` | Extension → MIME type lookup |

### Agent Tools (`apps/studio/server/src/filesystem/tools.ts`)

6 tools, all `group: 'filesystem'`, `modes: ['chat', 'task']`:

| Tool | Input | Permission | Notes |
|------|-------|------------|-------|
| `fs_list` | `path: string` (default `/`) | `fs:read` | Returns `{ entries, count }` |
| `fs_read` | `path: string` | `fs:read` | Returns `{ path, content }` |
| `fs_write` | `path: string, content: string` | `fs:write` | Returns `{ success, path, size_bytes }` |
| `fs_move` | `from: string, to: string` | `fs:write` | Returns `{ success, from, to }` |
| `fs_delete` | `path: string` | `fs:write` | Returns `{ success, path }` |
| `fs_search` | `query: string, extension?: string` | `fs:read` | Returns `{ files, count }`. Has `executeStream()` (Plan 15.1). |

All tools include a shared `FS_HINT` prompt that instructs the agent:
"Only save files to the filesystem when the user explicitly asks. Don't write
speculatively."

### Wiring in RuntimeManager

`apps/studio/server/src/runtime/manager.ts` checks `getFilesystemConfig(projectId)` at
`resolveSharedTools()` time. If `enabled && credential_id` is truthy, it calls
`buildFilesystemTools(projectId)` and injects the result into every agent's
`built_in_tools` alongside connector, browser, skill, cron, and MCP tools.

---

## REST API (`apps/studio/server/src/routes/filesystem.ts`)

All routes are behind `authMiddleware`. Permission checks via
`requirePermission`.

### Config management

| Method | Path | Permission | Description |
|--------|------|------------|-------------|
| `GET` | `/projects/:pid/filesystem/config` | `settings:read` | Returns config + stats |
| `PATCH` | `/projects/:pid/filesystem/config` | `settings:write` | Update adapter, credential, enabled. Detects if adapter/credential changed and asks for migration. Calls `syncProjectTools()` after. |
| `POST` | `/projects/:pid/filesystem/test` | `settings:read` | Tests S3 connection via probe object |

### File operations

| Method | Path | Permission | Description |
|--------|------|------------|-------------|
| `GET` | `/projects/:pid/files?path=/` | `agents:read` | List files at path |
| `GET` | `/projects/:pid/files/content?path=/f.ts` | `agents:read` | Read file content |
| `GET` | `/projects/:pid/files/search?q=&ext=.ts` | `agents:read` | Search files |
| `POST` | `/projects/:pid/files` | `agents:write` | Write file `{ path, content }` |
| `PATCH` | `/projects/:pid/files/move` | `agents:write` | Move/rename `{ from, to }` |
| `DELETE` | `/projects/:pid/files?path=/f.ts` | `agents:write` | Delete file |
| `DELETE` | `/projects/:pid/files/folder?path=/src` | `agents:write` | Delete folder recursively |

### Streaming / proxy

| Method | Path | Permission | Description |
|--------|------|------------|-------------|
| `GET` | `/projects/:pid/files/proxy?path=&mode=` | `agents:read` | Streams file from S3. Modes: `inline` (view), `download` (Content-Disposition), `preview` (inferred). |

### Upload

| Method | Path | Permission | Description |
|--------|------|------------|-------------|
| `POST` | `/projects/:pid/files/upload` | `agents:write` | Multipart upload. Validates extension + size per file. Stores to S3 + DB. |

### Migration

| Method | Path | Permission | Description |
|--------|------|------------|-------------|
| `POST` | `/projects/:pid/filesystem/migrate` | `settings:write` | Body: `{ credential_id, adapter_id, action: 'migrate' | 'reset' }`. Migrate copies all files to new adapter; reset wipes and starts fresh. |

---

## Web UI

### Disk page (`/projects/[project]/disk`)

Tabbed interface with 3 tabs:

1. **Explorer** — the `FileExplorer` component (see below).
2. **Attachments** — lists chat attachments (`project_attachments`) grouped
   by conversation, with delete. Shows file size, type, and upload date.
3. **Config** — enable toggle, adapter selector, credential picker (from
   `api.credentials.available()`), test connection button, storage stats
   (total files, total size). MigrationModal for switching adapters.

### Settings page (`/settings/filesystem`)

Standalone config page (also reachable from the project settings sidebar).
Mirrors the Config tab from `/disk` but without the Explorer and Attachments
tabs. Contains enable toggle, credential picker, test connection, save.

### FileExplorer component (`components/filesystem/file-explorer.tsx`)

Reusable. Props: `projectId`, `rootPath?` (restricts navigation scope),
`hideUpload?`.

**Layout:**
- **Left panel:** file tree with breadcrumb navigation, search input,
  context menu (Open / Rename / Copy path / Delete).
- **Right panel:** CodeMirror editor (dynamically imported to avoid SSR
  issues) with syntax highlighting, save button, dirty indicator.

**Features:**
- Breadcrumb path navigation (respects `rootPath` boundary)
- Inline new-file creation
- Inline rename (double-click or context menu)
- File upload (multipart via `api.filesystem.upload()`)
- Search with results overlay (debounced)
- Toolbar: New file, Refresh, Preview, Download, Delete

**State:** current path, selected file + editor content + dirty flag, search
query + results, rename/create input states.

**TanStack Query keys:** `['files', projectId, currentPath]`,
`['files-search', projectId, searchQuery]`.

**Reuse by Plan 15:** the Skills page passes `rootPath="/skills/{slug}/"` to
scope the file explorer to a single skill's directory.

---

## Security

### Path traversal prevention

`normalizePath()` in `utils.ts` strips `..` sequences, collapses double
slashes, and ensures a leading `/`. This prevents an agent from escaping the
virtual root via `fs_read('/../../../etc/passwd')` — the path normalizes to
`/etc/passwd` which is just a virtual path inside the project, not a real
filesystem path. The actual S3 key is always prefixed with
`projects/{projectId}/`, so there is no way to access another project's
objects.

### File type whitelist

Only 30+ text-only extensions are allowed. Binary files are rejected at
both the API validation layer and the `write()` service method. This
prevents agents from storing executable payloads or oversized blobs.

### Credential isolation

Each project's filesystem credential is resolved via `resolveCredential()`
from Plan 4's credential system (AES-256-GCM encrypted at rest). The
`getFilesystemService()` factory decrypts only when needed and the
plaintext key never persists in memory beyond the request scope.

### Route guards

All routes are behind `authMiddleware` + `requirePermission`. File
operations require `agents:read` or `agents:write`; config changes require
`settings:write`. The permission model is inherited from Plan 12 (Auth &
ACL).

---

## Migration Workflow

When a user changes the storage credential or adapter (e.g. moving from a
dev RustFS to a production S3), the UI prompts a `MigrationModal` with two
options:

1. **Migrate** — downloads every file from the old adapter, re-uploads to
   the new one, updates all `storage_key` values in DB. The DB rows stay
   the same; only the S3 keys change. Content cache is preserved.
2. **Reset** — deletes all `project_files` rows and starts fresh with the
   new adapter. Fast but destructive.

The migration runs synchronously in the API request. For large projects
(hundreds of files) this may be slow; async migration with progress tracking
was deferred.

---

## Files Inventory

### Backend

```
apps/studio/server/src/filesystem/
├── service.ts          # FilesystemService class + factory + migration + test
├── adapter.ts          # S3FilesystemAdapter + buildS3Adapter factory
├── tools.ts            # 6 agent tools (fs_list, fs_read, fs_write, fs_move, fs_delete, fs_search)
└── utils.ts            # ALLOWED_EXTENSIONS, MAX_FILE_SIZE, normalizePath, MIME_MAP, etc.

apps/studio/server/src/routes/filesystem.ts    # 14 REST API routes
apps/studio/server/src/runtime/manager.ts      # Injects filesystem tools at resolveSharedTools()
```

### Database

```
apps/studio/db/src/schema/filesystem.ts        # project_filesystem_config + project_files tables
apps/studio/db/src/queries/filesystem.ts       # CRUD queries for both tables
```

### Web

```
apps/studio/web/components/filesystem/file-explorer.tsx
    # Reusable FileExplorer (also used by /skills page)

apps/studio/web/app/(app)/studio/companies/[company]/projects/[project]/
├── disk/page.tsx                              # Main file manager: Explorer + Attachments + Config tabs
└── settings/filesystem/page.tsx               # Dedicated config settings page

apps/studio/web/lib/api.ts                     # api.filesystem.* methods
```

### Docs

```
docs/plans/14-fs.md                            # Original plan
docs/feats/filesystem.md                       # Feature documentation
docs/builder/decisions.md                      # ADR-024 (route is /disk not /files)
                                               # ADR-025 (chat attachments are ephemeral, separate from project_files)
```

---

## Integration Points

| System | How it uses the filesystem |
|--------|---------------------------|
| **Agent tools** | `fs_list/read/write/move/delete/search` injected into all agents when filesystem is enabled |
| **Skills (Plan 15)** | `SkillService` calls `FilesystemService.write()` to seed `/skills/{slug}/index.md` on creation, `deleteFolder('/skills/{slug}')` on deletion. `FileExplorer` component scoped via `rootPath`. |
| **Attachments (Plan 33)** | `persistContentToAttachment()` uses `FilesystemService.getAdapter().upload()` to store binary content in S3. Same S3 client, different key prefix (`jiku/attachments/` vs `projects/`). |
| **Credentials (Plan 4)** | Filesystem config references a credential ID. `getFilesystemService()` decrypts it via `resolveCredential()` at request time. |
| **Runtime manager** | `resolveSharedTools()` checks `getFilesystemConfig()` and conditionally builds + injects tools. `syncProjectTools()` rebuilds when config changes. |

---

## Verification

- ✅ `bun run dev` — server boots, filesystem tools injected for projects with enabled config.
- ✅ `bun run db:push` — tables created, indexes applied.
- ✅ File manager UI (`/disk`) — create, edit, rename, delete, search, upload all functional.
- ✅ Agent tools — `fs_write`, `fs_read`, `fs_list`, `fs_search` tested via chat.
- ✅ Content caching — files under 50 KB read from DB cache; larger files fetch from S3.
- ✅ Path traversal guard — `fs_read('/../../../etc/passwd')` normalizes to `/etc/passwd` (virtual, not real).
- ✅ Storage migration — tested: switch credential → migrate → files appear under new adapter.
- ✅ Test connection — probe object upload/download/delete cycle reports success/failure accurately.
- ✅ Skills integration (Plan 15) — `/skills/{slug}/` folder created on skill creation, deleted on skill deletion.

---

## Known Limitations

1. **Text-only files.** Binary files (images, PDFs, etc.) are rejected.
   Media storage goes through the separate `project_attachments` system.
2. **No file versioning / history.** Overwrites are destructive; there is no
   undo or diff view. Agent + human edits overwrite the same row.
3. **No per-agent private filesystem.** All agents in a project share one
   filesystem. An agent can read/modify another agent's files. Per-agent
   scoping was a non-goal.
4. **Synchronous migration.** Moving hundreds of files to a new storage
   adapter blocks the API request. Async migration with progress tracking
   was deferred.
5. **No real-time sync.** If two users/agents write the same file
   simultaneously, last-write-wins. No locking or conflict detection.
6. **`move` is not atomic at S3 level.** S3 doesn't have a rename operation.
   `move()` downloads → uploads to new key → deletes old key. If the process
   crashes between upload and delete, a stale copy remains in S3 (but DB
   points to the new key, so it's functionally correct).
7. **Folder stats are aggregate-only.** `total_files` and `total_size_bytes`
   on the config table are project-wide. There is no per-folder size
   tracking.

---

## Lessons Learned

1. **Virtual folders are simpler than real folders.** Not creating a `folders`
   table eliminates an entire class of orphan/sync bugs. `list()` just
   derives subfolders from file paths at query time. The only cost is the
   extra `allPathsUnderFolder` query, which is cheap with the
   `(project_id, folder_path)` index.

2. **Content caching pays for itself immediately.** Most agent-authored files
   (config, markdown, small scripts) are well under 50 KB. Caching them in
   Postgres eliminates the S3 round-trip for the vast majority of `read()`
   calls, making the filesystem feel instant in the chat flow.

3. **`forcePathStyle: true` is mandatory for self-hosted S3.** RustFS and
   MinIO use path-style addressing (`http://host:9000/bucket/key`), not
   virtual-hosted-style (`http://bucket.host:9000/key`). Without this flag,
   the S3 client constructs DNS names that don't resolve.

4. **Adapter → credential → config is a three-hop resolution.** The factory
   `getFilesystemService(projectId)` does: config query → credential
   decrypt → adapter construction. This is fast (~5ms) but runs on every
   tool call because the service is not cached (each agent runner gets a
   fresh instance). Caching the service per-project was considered but
   deferred because credential rotation would invalidate the cache.

5. **`extractImmediateSubfolders` is the trickiest 10 lines.** Given a flat
   list of paths, it needs to return only the folders that are direct
   children of the current folder — not grandchildren. Getting the depth
   math right (split by `/`, compare prefix length, check next segment
   length) took more time than expected. It's well-tested now.

6. **The `FileExplorer` component became a reusable workhorse.** After
   extracting it from the `/disk` page with a `rootPath` prop, Plan 15
   (Skills) reused it trivially by passing `rootPath="/skills/{slug}/"`.
   The investment in making it generic paid off within days.
