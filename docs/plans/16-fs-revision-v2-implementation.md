# Plan 16-FS-Revision-V2 — Grounded Implementation Plan

**Date:** 2026-04-10
**Status:** 📋 PROPOSED — awaiting confirmation
**Revises:** Plan 14 (Filesystem)
**Source:** `docs/plans/16-fs-revision-v2.md` (architecture analysis)
**Grounded against:** actual codebase read on 2026-04-10

---

## Goals (unchanged from 16-FS-Revision-V2)

1. UUID-based S3 keys → move/rename jadi 0 S3 ops, S3 partition spread 256x
2. LRU-cached FilesystemService → eliminasi AES decrypt + S3Client rebuild per tool call
3. `project_folders` table → eliminasi full scan di `list()`
4. Content cache dengan version + TTL → invalidation strategy
5. tsvector search → eliminasi ILIKE full table scan
6. Optimistic locking → safe concurrent write
7. Storage cleanup queue → deferred S3 delete (tombstone pattern)
8. Async migration → tidak block API thread
9. (Tier 3, future) Audit log + rate limiting

---

## Codebase State Saat Ini (Ground Truth)

### Files yang akan disentuh

| File | Peran saat ini | Apa yang berubah |
|------|----------------|------------------|
| `apps/studio/db/src/schema/filesystem.ts` | Drizzle schema: `project_filesystem_config` + `project_files` | Tambah kolom baru di `project_files`, tambah 3 tabel baru |
| `apps/studio/db/src/queries/filesystem.ts` | 13 query functions (CRUD + search + migration) | Update `upsertFile`, `searchFiles`, tambah folder queries, cleanup queries |
| `apps/studio/server/src/filesystem/adapter.ts` | `S3FilesystemAdapter` dengan `buildKey(projectId, virtualPath)` | `buildKey(fileId)` → UUID-based key. Tambah `isLegacyKey()` |
| `apps/studio/server/src/filesystem/service.ts` | `FilesystemService` class + `getFilesystemService()` factory | Extract factory → LRU cache. Rewrite `write()`, `move()`, `delete()`, `search()`, `list()` |
| `apps/studio/server/src/filesystem/tools.ts` | 6 tools (`fs_list/read/write/move/delete/search`) | `fs_write`: tambah `expected_version`. `fs_read`: tambah `version` + `cached` di response |
| `apps/studio/server/src/filesystem/utils.ts` | `normalizePath`, `isAllowedFile`, `extractImmediateSubfolders`, `getMimeType` | Tambah `getAncestorPaths()`, `getParentPath()`, `getDepth()` |
| `apps/studio/server/src/routes/filesystem.ts` | 14 routes (config, files, upload, proxy, migrate) | Migrate endpoint → async. PATCH config → invalidate cache |
| `apps/studio/server/src/runtime/manager.ts` | `resolveSharedTools()` checks `getFilesystemConfig()` | Minimal — call invalidate on sleep/sync |
| `apps/studio/server/src/index.ts` | Server bootstrap | Start cleanup worker interval |

### Files baru

| File | Peran |
|------|-------|
| `apps/studio/server/src/filesystem/factory.ts` | LRU-cached `getFilesystemService()` + invalidation |
| `apps/studio/server/src/filesystem/worker.ts` | `StorageCleanupWorker` — background 30s loop |
| `apps/studio/server/src/filesystem/migration-job.ts` | Async migration job runner |
| `apps/studio/db/src/schema/filesystem-folders.ts` | `project_folders` Drizzle schema |
| `apps/studio/db/src/schema/filesystem-cleanup.ts` | `storage_cleanup_queue` Drizzle schema |
| `apps/studio/db/src/schema/filesystem-migrations.ts` | `filesystem_migrations` Drizzle schema |

### Pola kode yang sudah ada dan harus diikuti

- **ORM:** Drizzle (bukan raw SQL). Schema di `schema/*.ts`, queries di `queries/*.ts`.
- **Migration:** `bun run db:push` atau generated SQL di `migrations/*.sql`.
- **Adapter pattern:** `S3FilesystemAdapter` class di `adapter.ts`, factory `buildS3Adapter(fields, metadata)`.
- **Tool pattern:** `buildFilesystemTools(projectId)` returns `ToolDefinition[]` with Zod input schema + `execute()`.
- **Factory pattern:** `getFilesystemService(projectId)` does config → credential → adapter → service.
- **Error handling:** Custom `NotFoundError`, `ValidationError`, `ConflictError` classes with `.status`.
- **Index konvensi:** server imports pakai `.ts` extension.
- **DB export:** semua tabel + query di-export via `apps/studio/db/src/index.ts`.

---

## Implementation Phases

### Phase 1 — DB Schema (Additive, No Downtime)

**Prinsip:** semua additive — kolom baru punya default, tabel baru tidak memutus kode lama.

#### 1A. Tambah kolom baru di `project_files`

File: `apps/studio/db/src/schema/filesystem.ts`

```
Kolom baru:
  content_version:   integer NOT NULL DEFAULT 1
  cache_valid_until: timestamp (nullable)
  version:           integer NOT NULL DEFAULT 1
  content_hash:      text (nullable)
```

**Catatan:** `name_lower` dan `search_vector` sebagai generated columns. Drizzle belum support `GENERATED ALWAYS AS ... STORED` secara native. Opsi:
- (a) Tulis di migration SQL manual (bukan di Drizzle schema) lalu `bun run db:push`
- (b) Pakai Drizzle `.generatedAlwaysAs()` kalau sudah supported di versi kita

**Aksi:** cek versi Drizzle (`drizzle-orm` version di `package.json`). Kalau belum support generated columns, pakai migration SQL manual untuk `name_lower` + `search_vector` + GIN index.

#### 1B. Tabel baru: `project_folders`

File: `apps/studio/db/src/schema/filesystem-folders.ts`

```
project_folders:
  id:          uuid PK
  project_id:  uuid FK → projects (CASCADE)
  path:        text NOT NULL
  parent_path: text (nullable — null untuk root '/')
  depth:       integer NOT NULL DEFAULT 0
  created_at:  timestamp

  UNIQUE(project_id, path)
  INDEX(project_id, parent_path)
```

#### 1C. Tabel baru: `storage_cleanup_queue`

File: `apps/studio/db/src/schema/filesystem-cleanup.ts`

```
storage_cleanup_queue:
  id:            uuid PK
  storage_key:   text NOT NULL
  project_id:    uuid NOT NULL
  status:        text NOT NULL DEFAULT 'pending'
  attempts:      integer NOT NULL DEFAULT 0
  last_error:    text (nullable)
  queued_at:     timestamp
  processed_at:  timestamp (nullable)

  INDEX(queued_at) WHERE status = 'pending'   ← partial index
```

#### 1D. Tabel baru: `filesystem_migrations`

File: `apps/studio/db/src/schema/filesystem-migrations.ts`

```
filesystem_migrations:
  id:                  uuid PK
  project_id:          uuid NOT NULL
  from_credential_id:  uuid (nullable)
  to_credential_id:    uuid NOT NULL
  status:              text NOT NULL DEFAULT 'pending'
  total_files:         integer (nullable)
  migrated_files:      integer NOT NULL DEFAULT 0
  failed_files:        integer NOT NULL DEFAULT 0
  error_message:       text (nullable)
  started_at:          timestamp (nullable)
  completed_at:        timestamp (nullable)
  created_at:          timestamp
```

#### 1E. Backfill `project_folders` dari data existing

Setelah migration di-push, jalankan backfill query:

```sql
INSERT INTO project_folders (project_id, path, parent_path, depth)
SELECT DISTINCT
  project_id,
  folder_path AS path,
  CASE
    WHEN folder_path = '/' THEN NULL
    ELSE regexp_replace(folder_path, '/[^/]+$', '')
  END AS parent_path,
  array_length(string_to_array(folder_path, '/'), 1) - 1 AS depth
FROM project_files
WHERE folder_path IS NOT NULL AND folder_path != '/'
ON CONFLICT (project_id, path) DO NOTHING;
```

Bisa dimasukkan ke migration SQL atau script one-time.

#### 1F. Migration generation + push

```bash
cd apps/studio/db && bun run db:push
```

**Risiko:** generated columns (`name_lower`, `search_vector`) mungkin perlu SQL manual. Kalau Drizzle bisa handle → bagus. Kalau tidak → tulis `.sql` di `migrations/`.

---

### Phase 2 — UUID-Based S3 Key + Lazy Migration

**Goal:** `move()` dan `rename` jadi 0 S3 ops. S3 keys spread ke 256 prefix.

#### 2A. Update `adapter.ts`

Tambah method baru di `S3FilesystemAdapter`:

```typescript
// Method baru — UUID-based key
buildKeyFromId(fileId: string): string {
  const prefix = fileId.replace(/-/g, '').substring(0, 2)
  return `objects/${prefix}/${fileId}`
}

// Legacy detection
static isLegacyKey(storageKey: string): boolean {
  return storageKey.startsWith('projects/')
}
```

**Catatan:** jangan hapus `buildKey(projectId, virtualPath)` dulu — masih dipakai oleh `persistContentToAttachment` di `content/persister.ts` (Plan 33 attachment system). Attachment pakai prefix `jiku/attachments/` yang beda. Saya cek:

**Aksi sebelum implement:** verifikasi `content/persister.ts` pakai method `upload(storageKey, data, mimeType)` langsung, bukan `buildKey()`. Kalau iya → aman, `buildKey()` yang lama bisa di-deprecate.

#### 2B. Update `service.ts` — `write()`

Sebelum (Plan 14):
```typescript
const storageKey = this.adapter.buildKey(this.projectId, normalized)
await this.adapter.upload(storageKey, content, mimeType)
```

Sesudah:
```typescript
const fileId = existing?.id ?? randomUUID()
const storageKey = existing?.storage_key ?? this.adapter.buildKeyFromId(fileId)
// storage_key immutable setelah INSERT — tidak pernah berubah saat update
await this.adapter.upload(storageKey, content, mimeType)
```

Juga: upsert ancestor folders ke `project_folders` (lihat Phase 4).

#### 2C. Update `service.ts` — `move()`

Sebelum (3 S3 ops):
```typescript
const newKey = this.adapter.buildKey(this.projectId, to)
const content = await this.adapter.download(file.storage_key)
await this.adapter.upload(newKey, content, file.mime_type)
await this.adapter.delete(file.storage_key)
// Update DB with new storage_key
```

Sesudah (0 S3 ops):
```typescript
// storage_key TIDAK berubah — file tetap di objects/{ab}/{fileId}
await updateFilePath(file.id, {
  path: to,
  name: basename(to),
  folder_path: dirname(to),
  extension: extname(to),
  // storage_key TIDAK di-update
})
// Upsert ancestor folders for new path
```

**Penting:** `updateFilePath()` di `queries/filesystem.ts` saat ini menerima `storage_key` di parameter. Hapus `storage_key` dari parameter update pada `move()`. Pertahankan field di fungsi untuk migration use case lain.

#### 2D. Update `service.ts` — `delete()` → tombstone

Sebelum:
```typescript
await this.adapter.delete(file.storage_key)
await deleteFileById(file.id)
```

Sesudah:
```typescript
await db.transaction(async (tx) => {
  // Delete from DB
  await tx.delete(projectFiles).where(eq(projectFiles.id, file.id))
  // Enqueue S3 cleanup — background worker handles actual deletion
  await tx.insert(storageCleanupQueue).values({
    storage_key: file.storage_key,
    project_id: this.projectId,
  })
})
```

#### 2E. Lazy S3 key migration

Tambah private method di `FilesystemService`:

```typescript
private async ensureModernKey(file: ProjectFile): Promise<string> {
  if (!S3FilesystemAdapter.isLegacyKey(file.storage_key)) {
    return file.storage_key
  }
  // Download dari key lama
  const content = await this.adapter.download(file.storage_key)
  // Upload ke key baru (UUID-based)
  const newKey = this.adapter.buildKeyFromId(file.id)
  await this.adapter.upload(newKey, content, file.mime_type)
  // Update DB + enqueue old key cleanup
  await updateFileStorageKey(file.id, newKey)
  await db.insert(storageCleanupQueue).values({
    storage_key: file.storage_key,
    project_id: this.projectId,
  })
  return newKey
}
```

Dipanggil di `read()` sebelum download:

```typescript
async read(filePath: string): Promise<string> {
  const file = await this.getFile(normalized)
  if (!file) throw new NotFoundError(...)
  if (file.content_cache) return file.content_cache
  const key = await this.ensureModernKey(file)
  const buffer = await this.adapter.download(key)
  return buffer.toString('utf-8')
}
```

---

### Phase 3 — LRU Cache FilesystemService

**Goal:** eliminasi AES decrypt + S3Client rebuild per tool call.

#### 3A. Extract `factory.ts`

File baru: `apps/studio/server/src/filesystem/factory.ts`

```typescript
import { LRUCache } from 'lru-cache'
// ... imports

interface CachedEntry {
  service: FilesystemService
  adapter: S3FilesystemAdapter
}

const cache = new LRUCache<string, CachedEntry>({
  max: 500,
  ttl: 5 * 60 * 1000,  // 5 menit
})

export async function getFilesystemService(projectId: string): Promise<FilesystemService | null> {
  const cached = cache.get(projectId)
  if (cached) return cached.service

  const config = await getFilesystemConfig(projectId)
  if (!config?.enabled || !config.credential_id) return null

  const credential = await resolveCredential(config.credential_id)
  const adapter = buildS3Adapter(credential.fields, credential.metadata ?? {})
  const service = new FilesystemService(projectId, adapter)

  cache.set(projectId, { service, adapter })
  return service
}

export function invalidateFilesystemCache(projectId: string): void {
  cache.delete(projectId)
}

export function invalidateAllFilesystemCaches(): void {
  cache.clear()
}
```

**Aksi:** cek apakah `lru-cache` sudah ada di dependencies. Kalau belum → `bun add lru-cache` di root atau di `apps/studio/server/package.json`.

#### 3B. Update imports

Semua tempat yang import `getFilesystemService` dari `./service.ts` harus diganti ke `./factory.ts`:

- `tools.ts` — setiap tool call `getFilesystemService(projectId)`
- `routes/filesystem.ts` — route handlers
- `content/persister.ts` — attachment persistence (Plan 33)

**Catatan:** `service.ts` tetap export `FilesystemService` class. Yang pindah hanya factory function.

#### 3C. Invalidation hooks

- `routes/filesystem.ts` PATCH `/config` → panggil `invalidateFilesystemCache(projectId)` setelah update
- `runtime/manager.ts` `sleep(projectId)` → panggil `invalidateFilesystemCache(projectId)`
- Credential rotation event (kalau ada) → `invalidateAllFilesystemCaches()`

---

### Phase 4 — `project_folders` Table + Optimized `list()`

**Goal:** `list()` pakai index lookup, bukan full scan.

#### 4A. Queries baru di `queries/filesystem.ts`

```typescript
// List immediate subfolders
export async function listSubfolders(projectId: string, parentPath: string | null) {
  return db.query.projectFolders.findMany({
    where: and(
      eq(projectFolders.project_id, projectId),
      parentPath === null
        ? isNull(projectFolders.parent_path)
        : eq(projectFolders.parent_path, parentPath),
    ),
    orderBy: [asc(projectFolders.path)],
  })
}

// Upsert ancestor folders
export async function upsertAncestorFolders(projectId: string, filePath: string) {
  const ancestors = getAncestorPaths(filePath)
  for (const ancestor of ancestors) {
    await db.insert(projectFolders).values({
      project_id: projectId,
      path: ancestor,
      parent_path: getParentPath(ancestor),
      depth: getDepth(ancestor),
    }).onConflictDoNothing()
  }
}

// Delete empty folders (cleanup after file delete)
export async function deleteEmptyFolders(projectId: string, folderPath: string) {
  // Walk up from folderPath to root, delete folders that have no files
  // and no child folders
}
```

#### 4B. Helper functions di `utils.ts`

```typescript
export function getAncestorPaths(filePath: string): string[] {
  const parts = filePath.split('/').filter(Boolean)
  const ancestors: string[] = []
  for (let i = 1; i < parts.length; i++) {  // skip filename (last part)
    ancestors.push('/' + parts.slice(0, i).join('/'))
  }
  return ancestors
}

export function getParentPath(folderPath: string): string | null {
  if (folderPath === '/') return null
  const parent = folderPath.replace(/\/[^/]+$/, '')
  return parent || '/'
}

export function getDepth(folderPath: string): number {
  return folderPath.split('/').filter(Boolean).length
}
```

#### 4C. Update `service.ts` — `list()`

Sebelum:
```typescript
// Query 1: files langsung di folder
const files = await listFiles(this.projectId, normalizedFolder)
// Query 2: SEMUA paths di bawah folder → extractImmediateSubfolders() di app layer
const allPaths = await listAllPathsUnderFolder(this.projectId, normalizedFolder)
const subfolders = extractImmediateSubfolders(allPaths.map(f => f.path), normalizedFolder)
```

Sesudah:
```typescript
// Query 1: files langsung di folder (sama, pakai index)
const files = await listFiles(this.projectId, normalizedFolder)
// Query 2: subfolders langsung dari project_folders (index lookup, O(children) bukan O(total_files))
const subfolders = await listSubfolders(this.projectId, normalizedFolder === '/' ? null : normalizedFolder)
```

**Catatan:** `extractImmediateSubfolders()` di `utils.ts` bisa di-deprecate tapi jangan hapus dulu — `FileExplorer` component mungkin pakai di client side. Cek dulu. Kalau hanya dipakai di `service.ts` → deprecate.

#### 4D. Update `service.ts` — `write()` upsert folders

Setelah upsert file:
```typescript
await upsertAncestorFolders(this.projectId, normalized)
```

#### 4E. Update `service.ts` — `deleteFolder()` cleanup folders

Setelah hapus files:
```typescript
// Delete the folder itself + all child folders
await db.delete(projectFolders).where(
  and(
    eq(projectFolders.project_id, this.projectId),
    or(
      eq(projectFolders.path, normalizedFolder),
      like(projectFolders.path, `${normalizedFolder}/%`),
    ),
  ),
)
```

---

### Phase 5 — tsvector Search

**Goal:** search pakai GIN index, bukan ILIKE full scan.

#### 5A. Generated column + GIN index

Ini dilakukan di Phase 1 (schema additive). Kalau Drizzle tidak support → SQL manual:

```sql
ALTER TABLE project_files
  ADD COLUMN search_vector TSVECTOR
  GENERATED ALWAYS AS (
    to_tsvector('simple', coalesce(name, '') || ' ' || coalesce(path, ''))
  ) STORED;

CREATE INDEX CONCURRENTLY idx_pfiles_search ON project_files USING GIN (search_vector);
```

#### 5B. Update `queries/filesystem.ts` — `searchFiles()`

Sebelum:
```typescript
where: and(
  eq(projectFiles.project_id, projectId),
  or(
    ilike(projectFiles.name, `%${query}%`),
    ilike(projectFiles.path, `%${query}%`),
  ),
)
```

Sesudah:
```typescript
// Pakai raw SQL untuk tsvector query — Drizzle belum punya native tsvector support
const result = await db.execute(sql`
  SELECT id, project_id, path, name, extension, size_bytes, mime_type, updated_at
  FROM project_files
  WHERE project_id = ${projectId}
    AND search_vector @@ to_tsquery('simple', ${query.trim()} || ':*')
    ${extension ? sql`AND extension = ${extension}` : sql``}
  ORDER BY updated_at DESC
  LIMIT 100
`)
```

**Fallback:** kalau `search_vector` belum ada (migration belum jalan), fallback ke ILIKE.

---

### Phase 6 — Content Cache Version + TTL

#### 6A. Update `service.ts` — `write()`

Tambah di upsert:
```typescript
content_version: sql`content_version + 1`,
cache_valid_until: new Date(Date.now() + 24 * 60 * 60 * 1000),  // 24 jam
```

#### 6B. Update `service.ts` — `read()`

```typescript
// Cek cache validity
if (file.content_cache && file.cache_valid_until && file.cache_valid_until > new Date()) {
  return file.content_cache  // cache hit
}
// Cache expired atau tidak ada → fetch dari S3
const key = await this.ensureModernKey(file)
const buffer = await this.adapter.download(key)
const content = buffer.toString('utf-8')
// Refresh cache
await db.update(projectFiles).set({
  content_cache: file.size_bytes <= 50_000 ? content : null,
  cache_valid_until: new Date(Date.now() + 24 * 60 * 60 * 1000),
}).where(eq(projectFiles.id, file.id))
return content
```

---

### Phase 7 — Optimistic Locking

#### 7A. Update `tools.ts` — `fs_write`

Input schema tambah:
```typescript
expected_version: z.number().int().optional().describe(
  'Optimistic lock. Pass the version value from a previous fs_read response. ' +
  'If the file was modified since, the write will be rejected with a conflict error.'
),
```

#### 7B. Update `tools.ts` — `fs_read` response

Sebelum: `{ path, content }`
Sesudah: `{ path, content, version, cached }`

#### 7C. Update `service.ts` — `write()` with version check

```typescript
if (expectedVersion !== undefined && existing) {
  if (existing.version !== expectedVersion) {
    throw new ConflictError(
      `File was modified (current version: ${existing.version}, expected: ${expectedVersion}). ` +
      `Read the file again to get the latest version.`
    )
  }
}
```

---

### Phase 8 — Async Migration + Cleanup Worker

#### 8A. `worker.ts` — StorageCleanupWorker

```typescript
export function startStorageCleanupWorker(intervalMs = 30_000): () => void {
  const tick = async () => {
    // SELECT * FROM storage_cleanup_queue WHERE status = 'pending' ORDER BY queued_at LIMIT 50
    // For each: try adapter.delete(storage_key), mark 'done' or increment attempts
    // Mark 'failed' if attempts >= 3
  }
  const handle = setInterval(() => tick().catch(console.warn), intervalMs)
  if (typeof handle === 'object' && 'unref' in handle) (handle as any).unref()
  return () => clearInterval(handle)
}
```

Wire di `apps/studio/server/src/index.ts` alongside `startBrowserTabCleanup()`.

#### 8B. `migration-job.ts` — Async migration

```typescript
export async function runFilesystemMigration(migrationId: string): Promise<void> {
  // 1. Load migration row, set status = 'in_progress', set started_at
  // 2. Load all project files
  // 3. For each file: download from old adapter, upload to new, update storage_key
  // 4. Update migrated_files count per batch
  // 5. On completion: set status = 'completed', set completed_at
  // 6. On failure: set status = 'failed', set error_message
}
```

#### 8C. Update `routes/filesystem.ts` — migration endpoint

Sebelum: sinkron, blocking.

Sesudah:
```typescript
// POST /filesystem/migrate → create job, return immediately
const migration = await db.insert(filesystemMigrations).values({ ... }).returning()
// Fire and forget — run in background
runFilesystemMigration(migration[0].id).catch(console.error)
res.json({ job_id: migration[0].id, status: 'pending' })

// GET /filesystem/migrate/:id → polling endpoint (new)
// Returns { status, total_files, migrated_files, failed_files, error_message }
```

---

## Phase Order & Dependencies

```
Phase 1 (DB Schema)
  ├── no dependencies, purely additive
  └── MUST be first — all other phases depend on new columns/tables

Phase 2 (UUID Key) ← depends on Phase 1
  ├── adapter.buildKeyFromId()
  ├── service.write() → UUID key
  ├── service.move() → DB-only
  ├── service.delete() → tombstone
  └── ensureModernKey() → lazy migration

Phase 3 (LRU Cache) ← independent of Phase 2, depends on Phase 1
  ├── factory.ts extraction
  └── invalidation hooks

Phase 4 (project_folders) ← depends on Phase 1
  ├── new queries
  ├── service.list() → index lookup
  ├── service.write() → upsert folders
  └── service.deleteFolder() → cleanup folders

Phase 5 (tsvector) ← depends on Phase 1 (generated column)
  └── update searchFiles() query

Phase 6 (Cache TTL) ← depends on Phase 1 (new columns)
  ├── service.write() → bump version + TTL
  └── service.read() → check validity

Phase 7 (Optimistic Lock) ← depends on Phase 1 (version column)
  ├── tools.ts → expected_version param
  └── service.write() → version check

Phase 8 (Async Migration + Worker) ← depends on Phase 1 (new tables) + Phase 2 (cleanup queue usage)
  ├── worker.ts
  ├── migration-job.ts
  └── route update
```

**Parallelizable:** Phase 3, 4, 5, 6, 7 bisa dikerjakan paralel setelah Phase 1 selesai. Phase 2 dan 8 harus sequential (8 depends on 2).

**Recommended order:** 1 → 2 → 3 → 4 → 5 → 6 → 7 → 8

---

## Risk Assessment

| Risk | Severity | Mitigation |
|------|----------|------------|
| Drizzle tidak support `GENERATED ALWAYS AS ... STORED` | MEDIUM | Fallback ke manual SQL migration + raw query di `searchFiles()` |
| `lru-cache` package belum ada di repo | LOW | `bun add lru-cache` — zero-config, widely used |
| Lazy key migration bisa lambat untuk file pertama yang diakses | LOW | `ensureModernKey()` cuma jalan sekali per file, lalu key sudah UUID-based |
| Backfill `project_folders` bisa gagal kalau `folder_path` punya data aneh | LOW | Backfill query pakai `ON CONFLICT DO NOTHING` — safe |
| `tsvector` search behavior beda dari ILIKE (prefix-only vs substring) | MEDIUM | Tambah `name_lower LIKE query%` B-tree sebagai complement (sudah direncanakan di plan) |
| Cleanup worker bisa delete S3 object yang masih dibutuhkan (race) | LOW | Worker hanya proses entries yang sudah di-commit ke DB — tombstone pattern safe |
| Async migration timeout untuk project besar | MEDIUM | Batch processing + per-file error tracking; UI shows progress |

---

## Estimated Effort

| Phase | Effort | Files touched |
|-------|--------|---------------|
| Phase 1 (Schema) | ~1 jam | 4 new schema files + migration + backfill |
| Phase 2 (UUID Key) | ~2 jam | adapter.ts, service.ts, queries/filesystem.ts |
| Phase 3 (LRU Cache) | ~1 jam | new factory.ts, update imports in 3+ files |
| Phase 4 (Folders) | ~1.5 jam | utils.ts, queries/filesystem.ts, service.ts |
| Phase 5 (tsvector) | ~30 min | queries/filesystem.ts |
| Phase 6 (Cache TTL) | ~30 min | service.ts |
| Phase 7 (Optimistic Lock) | ~30 min | tools.ts, service.ts |
| Phase 8 (Worker + Async Migrate) | ~1.5 jam | new worker.ts, migration-job.ts, routes/filesystem.ts, index.ts |
| **Total** | **~8.5 jam** | **~15 files** |

---

## Verification Checklist (per phase)

### Phase 1
- [ ] `bun run db:push` succeeds
- [ ] New columns visible in project_files: content_version, cache_valid_until, version, content_hash
- [ ] project_folders table exists with backfilled data
- [ ] storage_cleanup_queue + filesystem_migrations tables exist
- [ ] Existing fs_read/fs_write/fs_list still work (backward compatible)

### Phase 2
- [ ] New files get UUID-based storage_key (format: `objects/{ab}/{uuid}`)
- [ ] `move()` does NOT trigger any S3 operations (check logs)
- [ ] `delete()` enqueues to storage_cleanup_queue instead of immediate S3 delete
- [ ] Legacy files (with `projects/` prefix key) still readable via lazy migration

### Phase 3
- [ ] Second `fs_read` on same project doesn't trigger AES decrypt (check logs)
- [ ] `invalidateFilesystemCache(projectId)` clears the entry
- [ ] PATCH /config triggers cache invalidation

### Phase 4
- [ ] `list('/')` returns subfolders from project_folders table (not full scan)
- [ ] Creating `/a/b/c/d.ts` auto-creates folders `/a`, `/a/b`, `/a/b/c`
- [ ] Deleting a folder also cleans project_folders entries

### Phase 5
- [ ] `search('butt')` finds `Button.tsx` via tsvector prefix match
- [ ] GIN index is used (check EXPLAIN ANALYZE)

### Phase 6
- [ ] File read uses cache if `cache_valid_until > now()`
- [ ] File read fetches from S3 if cache expired
- [ ] Write bumps `content_version` + refreshes `cache_valid_until`

### Phase 7
- [ ] `fs_write` with wrong `expected_version` → ConflictError
- [ ] `fs_read` response includes `version` and `cached` fields

### Phase 8
- [ ] Cleanup worker processes pending entries every 30s
- [ ] Failed S3 deletes are retried up to 3 times
- [ ] Migration endpoint returns `{ job_id }` immediately
- [ ] GET migrate/:id returns progress
- [ ] UI shows migration progress (polling)

---

## What's NOT Changed from Plan 16-FS-Revision-V2

Semua goals, keputusan arsitektur, dan trade-off dari dokumen original tetap utuh:

- ✅ UUID-based S3 key dengan 2-char entropy prefix
- ✅ LRU cache dengan 5 min TTL, max 500 entries
- ✅ `project_folders` table menggantikan `extractImmediateSubfolders()` full scan
- ✅ Content cache with version + 24h TTL
- ✅ tsvector search tanpa pg_trgm (zero extension dependency)
- ✅ Optimistic locking via `version` column
- ✅ Storage cleanup queue (tombstone pattern)
- ✅ Async migration with polling
- ✅ Lazy S3 key migration strategy
- ✅ Tier 3 (audit log, rate limiting) deferred

Yang berubah hanya: **implementasi di-ground-kan ke kode yang benar-benar ada** (Drizzle ORM, file paths, function signatures, import patterns, existing query functions).

---

**WAITING FOR CONFIRMATION**: Proceed with this plan? (yes / no / modify)
