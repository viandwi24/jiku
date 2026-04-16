# Feature: Filesystem / Virtual Disk (Plan 14)

## What it does

Per-project virtual filesystem backed by S3-compatible storage (RustFS/MinIO/AWS S3). Agents can read, write, list, move, delete, and search files via `fs_*` built-in tools. Users manage files via the `/disk` UI page. Virtual path system — folders are implicit (no folder entities in DB).

## Architecture

```
project_filesystem_config  ← per-project: adapter_id, credential_id, enabled, stats
project_files              ← virtual entries: path, name, folder_path, extension,
                             storage_key, size_bytes, mime_type, content_cache

FilesystemService          ← CRUD operations (list, read, write, move, delete)
  └→ FilesystemAdapter     ← interface: upload/download/delete/exists/buildKey
       └→ S3FilesystemAdapter ← @aws-sdk/client-s3, forcePathStyle=true

RuntimeManager.wakeUp()    ← if filesystem enabled: inject fs_* tools as built_in_tools
```

## Storage

Files stored in S3 at key: `projects/{projectId}{virtualPath}`
Example: `projects/abc123/src/index.ts`

Credentials are managed via the Credentials system (Plan 4). S3 credential type includes: `endpoint`, `access_key_id`, `secret_access_key`, `bucket`, `region`.

**Content cache**: Files ≤ 50 KB have `content_cache` stored in DB. `fs_read` returns cache directly (no S3 round-trip). Updated on every write.

## Allowed File Types

Text-only: `.txt .md .mdx .rst .html .css .js .jsx .ts .tsx .py .rs .go .java .c .cpp .h .rb .php .swift .kt .cs .sh .json .yaml .yml .toml .env .ini .xml .csv .sql`
Max size: 5 MB

## Claude-Code-style read-before-write + stale detection (2026-04-14)

To save tokens and prevent lost writes, mutating tools now enforce two invariants borrowed from Claude Code:

1. **Read before mutate**: `fs_write` / `fs_edit` require that the agent has `fs_read`-ed the file earlier in the same conversation. Exception: `fs_write` for a **brand-new file** (path does not exist on disk) — allowed without a prior read.
2. **Stale detection**: when the agent last read the file, the file's `version` is recorded in a session tracker. On mutate, the current DB `version` is compared to the tracked one. If someone else (another agent, another conversation, the UI) modified the file in the meantime, the mutate is rejected with `STALE_FILE_STATE` and the agent must `fs_read` again.

**Tracker persistence** — table `conversation_fs_reads (conversation_id, path, version, content_hash, read_at)` with PK `(conversation_id, path)`. Cascades on conversation delete. Upserted by `fs_read`; consulted by `fs_write` / `fs_edit`; row dropped on `fs_move` (old path) and `fs_delete`. Cursor file `apps/studio/db/src/migrations/0027_conversation_fs_reads.sql`.

**Error shapes** (returned verbatim as tool result so the model can react):
- `{ code: 'MUST_READ_FIRST', error: "MUST_READ_FIRST: file \"X\" has not been fs_read in this conversation yet..." }`
- `{ code: 'STALE_FILE_STATE', error: "STALE_FILE_STATE: file \"X\" was modified externally since your last fs_read (you saw v2, now v5)..." }`

**fs_edit** — substring replacement preferred over `fs_write` for partial changes:
- `old_string` must match **exactly once** unless `replace_all: true`.
- Empty `new_string` = deletion.
- Binary files rejected.
- Same read-gate + stale check as `fs_write`.

## Agent Tools

| Tool | Scope | Description |
|------|-------|-------------|
| `fs_list` | folder | List files and virtual folders at path |
| `fs_read` | file | Read file content (registers version in session tracker). Intercepts binary files |
| `fs_edit` | file | Replace a substring in an existing file. Requires prior `fs_read` + not stale |
| `fs_append` | file | **Preferred for append-only workflows** (logs, journals). No read required, clears tracker after |
| `fs_write` | file | Write/create file (creates ancestor folders implicitly) |
| `fs_mkdir` | folder | Create an EMPTY folder (idempotent; ancestors created automatically) |
| `fs_move` | file + folder | Move/rename. For folders, every descendant is rewritten in one DB transaction |
| `fs_delete` | file + folder | Delete. Folder requires explicit `{ recursive: true }` flag as a safety guard |
| `fs_search` | file | Search files by name/path pattern |

Project invariant: every file op has a folder counterpart in both UI and agent tools — except root `/` which cannot be moved/renamed/deleted. Folder writes (`fs_write` ancestor upsert vs explicit `fs_mkdir`) are the one nuance: empty folders need `fs_mkdir`, non-empty ones materialise on first file write.

All tagged `group: 'filesystem'`, `permission: '*'`. Active in `chat` and `task` modes.

Read tools (`fs_list`, `fs_read`, `fs_search`) include a prompt hint: "check disk FIRST before asking user to upload." Write tools (`fs_write`, `fs_move`, `fs_delete`) include: "only write when explicitly asked."

### Binary file interception in `fs_read`

Binary files are stored with a `__b64__:` prefix in the filesystem. `fs_read` intercepts this instead of passing raw base64 to the model (which wastes context and can overflow it):

1. **Registered adapter exists** (e.g. `.xlsx` → `sheet_read` from jiku.sheet plugin): returns structured redirect — `{ type: 'binary', suggested_tool: 'sheet_read', note: '...' }`. Agent is instructed to use the specialized tool instead.
2. **No adapter, file > 256 KB**: returns metadata + hint to find a specialized tool or ask user for text format.
3. **No adapter, file ≤ 256 KB**: passes content as-is (useful for small images with vision models).

The extension→tool hint map is built by `buildBinaryFileHints()` in `fileViewAdapterRegistry.ts` and passed to `buildFilesystemTools(projectId, hints)` in the runtime manager. Plugins register adapters via `ctx.fileViewAdapters.register()` which also populates this map.

**`BinaryFileHints`** = `Map<string, string>` from lowercase extension (e.g. `"xlsx"`) to tool name (e.g. `"sheet_read"`). Built fresh on each `wakeUp`.

## API Routes

```
GET    /api/projects/:pid/filesystem/config        → get config
PATCH  /api/projects/:pid/filesystem/config        → update (adapter, credential, enabled)
POST   /api/projects/:pid/filesystem/test          → test S3 connection
GET    /api/projects/:pid/files?path=/src          → list entries
GET    /api/projects/:pid/files/content?path=/x    → read content
POST   /api/projects/:pid/files                    → write { path, content }
PATCH  /api/projects/:pid/files/move               → move { from, to }
DELETE /api/projects/:pid/files?path=/x            → delete file
DELETE /api/projects/:pid/files/folder?path=/src   → delete folder (recursive)
GET    /api/projects/:pid/files/search?q=&ext=     → search
POST   /api/projects/:pid/files/upload             → multipart upload
POST   /api/projects/:pid/files/export-zip         → body { paths: string[] } → zip stream
POST   /api/projects/:pid/files/import-zip         → multipart + ?path=&conflict=overwrite|skip|rename
```

## ZIP export / import

End-to-end ZIP round-tripping (added 2026-04-15):

- **Export** — `POST /files/export-zip` with `{ paths: string[] }`. Paths can mix files and folders; folders expand to all descendants. Server returns `application/zip` with `Content-Disposition: attachment; filename="…"` and a `X-File-Count` header. Binary files (`__b64__:` cached) are decoded back to raw bytes before being added to the archive — so a round-trip preserves the original binary content. Gated by `disk:read`. UI: toolbar Download icon (current folder) + per-entry "Export as ZIP" / "Export folder as ZIP" dropdown action.
- **Import** — `POST /files/import-zip?path=&conflict=` with multipart `file` field. Conflict policy ∈ `{ overwrite, skip, rename }` — `skip` is the default (safe). `rename` suffixes the new file with ` (1)`, ` (2)`, … until free. Each entry runs through the SAME `isAllowedFile` allow-list as the regular multipart upload (extension + size cap) — ZIP is not a side-channel around the disk's content rules. Path-traversal guard rejects any entry with a `..` segment. Caps: `MAX_ZIP_BYTES = 50MB`, `MAX_ZIP_ENTRIES = 5000`. Returns per-policy counters + per-file error list. Gated by `disk:write` + `uploadRateLimit`. UI: toolbar FileArchive icon → `ImportZipDialog` (3-pill conflict selector + result panel with stat tiles).
- Service: `apps/studio/server/src/filesystem/zip.ts` (`exportZipWith` + `importZip`). Backed by `jszip ^3.10.1`. All writes go through `FilesystemService.write()` so audit / version / ancestor-folder upsert stay consistent with manual writes.

## Web UI

- `apps/studio/web/app/.../disk/page.tsx` — file manager: breadcrumb nav, folder/file list, CodeMirror split editor, context menu (rename/move/delete)
- `apps/studio/web/app/.../disk/code-editor.tsx` — syntax-highlighted CodeMirror editor
- `apps/studio/web/app/.../settings/filesystem/page.tsx` — enable toggle, adapter selector, credential picker, stats, test connection
- Sidebar: "Disk" nav item in project sidebar

## Development Setup (RustFS)

```yaml
# docker-compose.yml
rustfs:
  image: rustfs/rustfs:latest
  ports: ["9000:9000", "9001:9001"]
  environment:
    RUSTFS_ACCESS_KEY: minioadmin
    RUSTFS_SECRET_KEY: minioadmin
```

Default dev credential: endpoint `http://localhost:9000`, key `minioadmin`, secret `minioadmin`, bucket `jiku-local`.

## Known Limitations

- Binary files not supported by `fs_read` (text-only); images ARE viewable in the UI via the built-in image view adapter (`.png/.jpg/.jpeg/.gif/.webp/.svg/.bmp/.avif`) which loads via the signed inline proxy URL.
- No file versioning/history
- No per-agent private filesystem (all agents in project share same disk)
- Per-file `tool_permission` ACL controls agent access; UI access is gated by the `disk:*` project role permissions.
- Streaming upload/download not supported (5 MB limit)

## UI permissions

The Disk page + filesystem routes are gated by `disk:read` / `disk:write`:
- `disk:read`: browse, open, download, view images.
- `disk:write`: create file, create folder, upload, rename, move, delete, edit content.
- Server: write routes return 403 on missing perm. UI: `FileExplorer` + `FileDetailPanel` take a `canWrite` prop and hide all mutating controls (new file, new folder, upload, rename, delete, save; CodeEditor becomes read-only).
- `GET /filesystem/config` + `POST /filesystem/test` accept `disk:read` OR `settings:read` via `requireAnyPermission` — non-admin readers still need to know whether disk is configured.
- `PATCH /filesystem/config` and `/filesystem/migrate` remain `settings:write`. "Storage Config" tab in the UI is hidden for users without `settings:read`.

## Related Files

- `apps/studio/db/src/schema/filesystem.ts`
- `apps/studio/db/src/queries/filesystem.ts`
- `apps/studio/server/src/filesystem/adapter.ts`
- `apps/studio/server/src/filesystem/service.ts`
- `apps/studio/server/src/filesystem/tools.ts`
- `apps/studio/server/src/filesystem/utils.ts`
- `apps/studio/server/src/routes/filesystem.ts`
