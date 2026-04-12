# Plan 16-FS-Revision-V2 — Filesystem Production-Scale Revision

**Date:** 2026-04-10  
**Status:** 📋 PROPOSED  
**Revises:** Plan 14 (Filesystem Implementation)  
**Priority:** HIGH — foundational layer, bottlenecks compound over time  
**Author:** Architecture Review

---

## Executive Summary

Plan 14 delivered a working virtual filesystem. Untuk skala developer tunggal atau small team, arsitektur saat ini sudah cukup fungsional. Namun beberapa keputusan desain akan menjadi **bottleneck serius** saat project count, file count, dan concurrent agent load bertambah. Dokumen ini menganalisis setiap titik rawan dan menetapkan revision target yang production-safe.

**Tidak semua harus diubah sekaligus.** Revision ini dibagi dalam 3 tier berdasarkan urgensi:

- 🔴 **Tier 1 — Critical:** Harus difix sebelum scaling dimulai
- 🟡 **Tier 2 — Important:** Difix dalam 1-2 sprint setelah launch
- 🟢 **Tier 3 — Future:** Dipertimbangkan setelah product-market fit

---

## Analysis: Apa yang Sudah Benar di Plan 14

Sebelum membahas masalah, penting untuk mengakui keputusan yang sudah tepat:

| Keputusan | Alasan Bagus |
|---|---|
| Virtual folders (no folder table) | Eliminasi orphan bugs, derived at query time |
| Content cache ≤50KB di Postgres | Smart optimization untuk file kecil |
| Adapter pattern (S3FilesystemAdapter) | Abstraksi yang benar untuk multi-backend |
| Path traversal guard (`normalizePath`) | Security-first mindset |
| Text-only whitelist | Prevents binary payload abuse |

Ini fondasi yang sudah solid. Yang perlu direvisi adalah **lapisan di atasnya**.

---

## Critical Issues Analysis

### 🔴 Issue 1: S3 Key Encode Path — Move/Rename Jadi Mahal

**Current behavior:**
```
storage_key = projects/{projectId}{virtualPath}
contoh: projects/uuid-123/src/components/Button.ts
```

**Masalah fundamental:** S3 key mengandung path virtual file. Akibatnya:

- **Rename `/a.ts` → `/b.ts`**: harus download dari S3 → upload ke key baru → delete key lama. 3 S3 operations untuk operasi yang seharusnya gratis.
- **Move `/src/a.ts` → `/lib/a.ts`**: sama, 3 S3 operations.
- **Rename folder** (misal `/src` → `/source`): harus copy + delete **setiap file** di dalam folder tersebut. O(n files) S3 operations.
- **Atomicity risk**: kalau crash di tengah copy, ada stale objects di S3.

Padahal di metadata layer, nama dan path sudah tersimpan di Postgres. S3 seharusnya hanya tahu **"ada objek dengan ID ini"**, tidak perlu tahu namanya apa.

**Fix — UUID-based Key dengan Entropy Prefix:**

```
objects/{2-char-prefix}/{fileId}

contoh:
objects/a1/a1b2c3d4-5678-90ab-cdef-012345678901
objects/f3/f3e4d5c6-7890-12ab-cdef-234567890123
```

Prefix 2 karakter diambil dari 2 karakter pertama UUID file (yang sudah random). Ini menghasilkan 256 kemungkinan prefix → 256 S3 partition → throughput naik signifikan dan tidak ada hot partition.

**Kenapa perlu entropy prefix?**

AWS S3 melakukan automatic partitioning berdasarkan key prefix. Limitnya:
```
3,500 PUT/DELETE per detik  per prefix
5,500 GET/HEAD per detik    per prefix
```

Kalau semua object di `objects/` tanpa sub-prefix → semua request share satu partition → throttling saat high traffic. Dengan 256 prefix, limit efektif naik 256x.

**Kenapa TIDAK pakai date prefix (`objects/2026/04/10/`)?**

Date prefix cocok untuk log files atau analytics events, bukan file storage. Masalahnya:
- **Hot partition**: semua write hari ini ke prefix yang sama, besok prefix baru. Partition hari ini overheat, partition kemarin idle.
- **Tidak ada benefit praktis**: kamu tidak pernah ListObjectsV2 by date. Listing file tetap lewat Postgres.
- **Lifecycle policy**: kalau butuh auto-expire, pakai S3 object tags, bukan date prefix.

**Dampak perubahan ini:**

| Operasi | Plan 14 (path-key) | Revision (UUID-key) |
|---|---|---|
| Rename file | 3 S3 ops (download, upload, delete) | **0 S3 ops** — update DB only |
| Move file | 3 S3 ops | **0 S3 ops** — update DB only |
| Rename folder | O(n) × 3 S3 ops | **0 S3 ops** — update DB only |
| Read file | S3 GetObject | S3 GetObject (sama) |
| Delete file | S3 DeleteObject | S3 DeleteObject (sama) |

**Implementasi `buildKey`:**

```typescript
// adapter.ts
buildKey(fileId: string): string {
  // Ambil 2 char pertama dari UUID (strip dash) sebagai entropy prefix
  // UUID sudah random, distribusi natural dan even → 256 prefix
  const prefix = fileId.replace(/-/g, '').substring(0, 2);
  return `objects/${prefix}/${fileId}`;
}

// Contoh:
// fileId: 'a1b2c3d4-5678-90ab-cdef-012345678901'
// key:    'objects/a1/a1b2c3d4-5678-90ab-cdef-012345678901'
```

**Schema change:** kolom `storage_key` di `project_files` sekarang menyimpan `objects/{ab}/{fileId}`. Rename dan move hanya update kolom `path`, `name`, `folder_path` — `storage_key` tidak pernah berubah setelah file dibuat.

---

### 🔴 Issue 2: `getFilesystemService()` Rebuilt Every Tool Call

**Current behavior:**
```
Every agent tool call:
  → query project_filesystem_config (DB hit)
  → decrypt credential via resolveCredential() (CPU: AES-GCM)
  → construct S3Client (new HTTP connection pool)
  → construct FilesystemService
```

**Masalah:** Setiap `fs_read`, `fs_write`, dll. memicu 3 operasi mahal ini. Kalau satu agent conversation melakukan 20 tool calls, itu 20x config query + 20x AES decrypt + 20x S3Client construction.

**Dampak skala:** 100 concurrent agents × 10 tool calls/menit → 1000 config queries/menit + 1000 AES decrypts/menit. Config table jadi hot spot.

**Fix — LRU Cache dengan TTL:**

```typescript
// factory.ts
const serviceCache = new LRUCache<string, CachedService>({
  max: 500,           // max 500 projects cached simultaneously
  ttl: 5 * 60 * 1000 // 5 menit TTL
});

// Invalidasi manual saat config berubah:
// - PATCH /filesystem/config → invalidateFilesystemCache(projectId)
// - credential rotation → invalidate semua project yang pakai credential itu
```

**Catatan:** TTL 5 menit adalah trade-off. Kalau credential dirotate, worst case ada 5 menit window pakai credential lama. Bisa diperketat ke 1 menit untuk security-sensitive deployment.

---

### 🔴 Issue 3: `list()` Full Scan untuk Derive Subfolders

**Current behavior:**
```sql
-- Query 1: file langsung di folder
SELECT * FROM project_files 
WHERE project_id = $1 AND folder_path = $2;

-- Query 2: SEMUA file di bawah folder untuk extract subfolders
SELECT path FROM project_files
WHERE project_id = $1 AND path LIKE $2 || '%';
-- → hasilnya diolah di application layer oleh extractImmediateSubfolders()
```

**Masalah:** Query 2 fetch semua file di bawah folder path, lalu filter di application layer. Pada project dengan 50k files, ini mengambil ribuan rows hanya untuk mencari subfolder langsung.

**Fix — `project_folders` Table:**

```sql
CREATE TABLE project_folders (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id  UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  path        TEXT NOT NULL,
  parent_path TEXT,          -- null untuk root '/'
  depth       INT NOT NULL DEFAULT 0,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (project_id, path)
);

CREATE INDEX idx_pfolders_parent ON project_folders (project_id, parent_path);
```

`list()` menjadi dua query paralel yang keduanya pakai index:

```typescript
async list(folderPath: string) {
  const [files, subfolders] = await Promise.all([
    db.query(`SELECT * FROM project_files WHERE project_id = $1 AND folder_path = $2`, ...),
    db.query(`SELECT path FROM project_folders WHERE project_id = $1 AND parent_path = $2`, ...)
  ]);
  return { files, subfolders };
}
```

`write()` upsert semua ancestor folders — O(depth), bukan O(total_files):

```typescript
const ancestors = getAncestorPaths(filePath); // ['/src', '/src/components']
for (const ancestor of ancestors) {
  await tx.query(`
    INSERT INTO project_folders (project_id, path, parent_path, depth)
    VALUES ($1, $2, $3, $4)
    ON CONFLICT (project_id, path) DO NOTHING
  `, [projectId, ancestor, getParentPath(ancestor), getDepth(ancestor)]);
}
```

---

### 🔴 Issue 4: `move()` Tidak Atomic — Terselesaikan oleh Issue 1

**Plan 14 (path-based key):**
```
move('/a/old.ts', '/a/new.ts'):
  1. S3: download old key
  2. S3: upload to new key
  3. S3: delete old key  ← crash = duplicate object
  4. DB: update row      ← crash = DB nunjuk key yang sudah dihapus
```

**Dengan UUID-based key, move menjadi trivial dan fully atomic:**

```typescript
async move(fromPath: string, toPath: string): Promise<void> {
  // S3 key TIDAK BERUBAH — file tetap di objects/{prefix}/{fileId}
  // Hanya update metadata di DB — ini atomic by nature (single UPDATE)
  await db.query(`
    UPDATE project_files
    SET path        = $1,
        folder_path = $2,
        name        = $3,
        updated_at  = now()
    WHERE project_id = $4 AND path = $5
  `, [toPath, getParentPath(toPath), getFileName(toPath), projectId, fromPath]);

  // Update project_folders untuk ancestors path baru
}
```

Tidak ada S3 operation. Tidak ada risk inconsistency. Issue 1 fix menyelesaikan ini secara gratis.

**Catatan:** `storage_cleanup_queue` tetap diperlukan, tapi hanya untuk operasi `delete()` dan `deleteFolder()`.

---

### 🔴 Issue 5: Content Cache Tidak Ada Invalidation Strategy

**Current behavior:** `content_cache` di-set saat write, dibaca setiap `read()`. Tidak ada invalidation selain overwrite lewat API.

**Masalah:** Kalau ada bypass write langsung ke S3 (via migration, admin tool, atau bug), `content_cache` di Postgres stale selamanya.

**Fix — Cache dengan Version + TTL:**

```sql
ALTER TABLE project_files 
  ADD COLUMN content_version    INT NOT NULL DEFAULT 1,
  ADD COLUMN cache_valid_until  TIMESTAMPTZ;
```

```typescript
// Saat write: bump version + set TTL
UPDATE project_files SET 
  content_cache     = $1,
  content_version   = content_version + 1,
  cache_valid_until = now() + interval '24 hours'
WHERE ...;

// Saat read: cek validity
if (file.content_cache && file.cache_valid_until > new Date()) {
  return file.content_cache; // cache hit
}
// cache miss → fetch dari S3, update cache
```

---

### 🟡 Issue 6: `search()` Pakai `ILIKE` — Full Table Scan

**Current behavior:**
```sql
SELECT * FROM project_files
WHERE project_id = $1
AND (name ILIKE '%query%' OR path ILIKE '%query%')
LIMIT 100;
```

`ILIKE '%query%'` dengan leading wildcard tidak bisa pakai B-tree index → full scan.

**Fix — `tsvector` Generated Column (Zero Extension Required):**

Tidak pakai `pg_trgm` karena butuh edit Docker/superuser. Postgres sudah punya full-text search built-in tanpa extension apapun.

```sql
-- Generated column, otomatis update saat name/path berubah
ALTER TABLE project_files
  ADD COLUMN search_vector TSVECTOR
  GENERATED ALWAYS AS (
    to_tsvector('simple',
      coalesce(name, '') || ' ' || coalesce(path, '')
    )
  ) STORED;

-- GIN index built-in, tanpa extension apapun
CREATE INDEX idx_pfiles_search ON project_files USING GIN (search_vector);
```

Query search:
```sql
-- ':*' untuk prefix matching — ketik 'butt' → match 'Button', 'button.ts', dll.
SELECT * FROM project_files
WHERE project_id = $1
  AND search_vector @@ to_tsquery('simple', $2 || ':*')
  AND ($3::text IS NULL OR extension = $3)
ORDER BY updated_at DESC
LIMIT 100;
```

Tambahan — generated column untuk prefix B-tree (complement):
```sql
ALTER TABLE project_files
  ADD COLUMN name_lower TEXT GENERATED ALWAYS AS (lower(name)) STORED;

CREATE INDEX idx_pfiles_name_lower ON project_files (project_id, name_lower);
-- Dipakai untuk: WHERE name_lower LIKE lower($query) || '%'
-- Sangat cepat, B-tree index normal
```

**Trade-off vs pg_trgm:**

| Aspek | pg_trgm | tsvector (dipilih) |
|---|---|---|
| Extension required | Ya (Docker edit, superuser) | **Tidak** |
| `%contains%` search | Ya | Prefix only (`starts%`) |
| Cocok untuk file search | Overkill | **Cukup** — user ketik dari awal nama |
| Setup complexity | Tinggi | Zero |

---

### 🟡 Issue 7: Upload Route Tidak Ada Rate Limiting

```typescript
const uploadRateLimiter = rateLimit({
  keyGenerator: (req) => `upload:${req.params.pid}`,
  max: 20,
  windowMs: 60_000,
});

const MAX_FILES_PER_UPLOAD_REQUEST = 10;
```

---

### 🟡 Issue 8: Migration Berjalan Synchronous

**Fix — Background Job dengan Polling:**

```sql
CREATE TABLE filesystem_migrations (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id        UUID NOT NULL,
  from_credential_id UUID,
  to_credential_id  UUID NOT NULL,
  status            TEXT NOT NULL DEFAULT 'pending',
  total_files       INT,
  migrated_files    INT NOT NULL DEFAULT 0,
  failed_files      INT NOT NULL DEFAULT 0,
  error_message     TEXT,
  started_at        TIMESTAMPTZ,
  completed_at      TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

```typescript
// POST /filesystem/migrate → return immediately
res.json({ job_id: migration.id, status: 'pending' });

// GET /filesystem/migrate/:id → client polling progress
// { status, total_files, migrated_files, failed_files }
```

---

### 🟡 Issue 9: Concurrent Write Silent Overwrite

```sql
ALTER TABLE project_files ADD COLUMN version INT NOT NULL DEFAULT 1;
```

```typescript
// fs_write dengan expected_version
if (expectedVersion !== undefined) {
  const result = await db.query(`
    UPDATE project_files SET
      content_cache = $1, version = version + 1, updated_at = now()
    WHERE project_id = $2 AND path = $3 AND version = $4
    RETURNING id
  `, [content, projectId, filePath, expectedVersion]);

  if (result.rowCount === 0) {
    throw new ConflictError('File modified by another process. Refresh and retry.');
  }
}
```

---

### 🟢 Issue 10: Tidak Ada Audit Log

```sql
CREATE TABLE fs_audit_log (
  id          BIGSERIAL PRIMARY KEY,
  project_id  UUID NOT NULL,
  actor_id    UUID,
  actor_type  TEXT NOT NULL DEFAULT 'user', -- 'user' | 'agent'
  action      TEXT NOT NULL,                -- 'write' | 'delete' | 'move' | 'read'
  file_path   TEXT NOT NULL,
  metadata    JSONB,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_fs_audit_project_time ON fs_audit_log (project_id, created_at DESC);
```

---

## Revised Database Schema

### `project_files` — Full Revised

```sql
CREATE TABLE project_files (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id      UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,

  -- Virtual path (metadata only — tidak encode ke S3 key)
  path            TEXT NOT NULL,
  name            VARCHAR NOT NULL,
  folder_path     TEXT NOT NULL DEFAULT '/',
  extension       VARCHAR,

  -- Storage (UUID-based key, tidak pernah berubah setelah file dibuat)
  storage_key     TEXT NOT NULL,  -- format: 'objects/{ab}/{fileId}'
  size_bytes      INT NOT NULL DEFAULT 0,
  mime_type       VARCHAR NOT NULL DEFAULT 'text/plain',
  content_hash    TEXT,           -- SHA-256, untuk dedup check

  -- Content cache
  content_cache       TEXT,
  content_version     INT NOT NULL DEFAULT 1,
  cache_valid_until   TIMESTAMPTZ,

  -- Search (generated columns, zero maintenance)
  name_lower      TEXT GENERATED ALWAYS AS (lower(name)) STORED,
  search_vector   TSVECTOR GENERATED ALWAYS AS (
    to_tsvector('simple', coalesce(name, '') || ' ' || coalesce(path, ''))
  ) STORED,

  -- Optimistic locking
  version         INT NOT NULL DEFAULT 1,

  -- Audit
  created_by      UUID REFERENCES users(id) ON DELETE SET NULL,
  updated_by      UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT uq_project_files_path UNIQUE (project_id, path)
);

CREATE INDEX idx_pfiles_project         ON project_files (project_id);
CREATE INDEX idx_pfiles_project_folder  ON project_files (project_id, folder_path);
CREATE INDEX idx_pfiles_project_ext     ON project_files (project_id, extension);
CREATE INDEX idx_pfiles_project_updated ON project_files (project_id, updated_at DESC);
CREATE INDEX idx_pfiles_name_lower      ON project_files (project_id, name_lower);
CREATE INDEX idx_pfiles_search          ON project_files USING GIN (search_vector);
```

### `project_folders` — Baru

```sql
CREATE TABLE project_folders (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id  UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  path        TEXT NOT NULL,
  parent_path TEXT,   -- null untuk root '/'
  depth       INT NOT NULL DEFAULT 0,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (project_id, path)
);

CREATE INDEX idx_pfolders_parent ON project_folders (project_id, parent_path);
```

### `storage_cleanup_queue` — Baru

Untuk deferred S3 delete setelah file dihapus. Move tidak perlu cleanup karena key tidak berubah.

```sql
CREATE TABLE storage_cleanup_queue (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  storage_key   TEXT NOT NULL,
  project_id    UUID NOT NULL,
  status        TEXT NOT NULL DEFAULT 'pending',
  attempts      INT NOT NULL DEFAULT 0,
  last_error    TEXT,
  queued_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  processed_at  TIMESTAMPTZ
);

-- Partial index — hanya index pending jobs
CREATE INDEX idx_cleanup_pending ON storage_cleanup_queue (queued_at)
  WHERE status = 'pending';
```

### `filesystem_migrations` — Baru

```sql
CREATE TABLE filesystem_migrations (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id        UUID NOT NULL,
  from_credential_id UUID,
  to_credential_id  UUID NOT NULL,
  status            TEXT NOT NULL DEFAULT 'pending',
  total_files       INT,
  migrated_files    INT NOT NULL DEFAULT 0,
  failed_files      INT NOT NULL DEFAULT 0,
  error_message     TEXT,
  started_at        TIMESTAMPTZ,
  completed_at      TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

### `fs_audit_log` — Baru (Tier 3)

```sql
CREATE TABLE fs_audit_log (
  id          BIGSERIAL PRIMARY KEY,
  project_id  UUID NOT NULL,
  actor_id    UUID,
  actor_type  TEXT NOT NULL DEFAULT 'user',
  action      TEXT NOT NULL,
  file_path   TEXT NOT NULL,
  metadata    JSONB,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_fs_audit_project_time ON fs_audit_log (project_id, created_at DESC);
```

---

## Revised Adapter

```typescript
// adapter.ts

export class S3FilesystemAdapter implements IStorageAdapter {

  // Key berdasarkan fileId UUID, bukan path
  // Tidak pernah berubah setelah file dibuat
  buildKey(fileId: string): string {
    const prefix = fileId.replace(/-/g, '').substring(0, 2);
    return `objects/${prefix}/${fileId}`;
  }

  async upload(fileId: string, content: string | Buffer, mimeType: string): Promise<string> {
    const key = this.buildKey(fileId);
    await this.client.send(new PutObjectCommand({
      Bucket: this.bucket,
      Key: key,
      Body: content,
      ContentType: mimeType,
    }));
    return key;
  }

  async download(storageKey: string): Promise<Buffer> { ... }
  async delete(storageKey: string): Promise<void> { ... }
  async exists(storageKey: string): Promise<boolean> { ... }
  async getStream(storageKey: string): Promise<StreamResult> { ... }
}
```

---

## Revised Service — Key Changes

```typescript
// service.ts

class FilesystemService {

  async write(filePath: string, content: string, options?: WriteOptions): Promise<WriteResult> {
    const fileId = options?.existingId ?? randomUUID();
    const storageKey = this.adapter.buildKey(fileId);

    // S3 upload dulu
    await this.adapter.upload(fileId, content, mimeType);

    // Lalu atomic DB upsert
    await this.db.transaction(async (tx) => {
      // Upsert ancestor folders
      for (const ancestor of getAncestorPaths(filePath)) {
        await tx.query(`
          INSERT INTO project_folders (project_id, path, parent_path, depth)
          VALUES ($1, $2, $3, $4)
          ON CONFLICT (project_id, path) DO NOTHING
        `, [...]);
      }

      // Upsert file — storage_key hanya di-set saat INSERT, tidak di-update
      await tx.query(`
        INSERT INTO project_files
          (id, project_id, path, name, folder_path, extension,
           storage_key, size_bytes, mime_type, content_cache,
           content_version, cache_valid_until, version)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 1, now() + interval '24 hours', 1)
        ON CONFLICT (project_id, path) DO UPDATE SET
          content_cache     = EXCLUDED.content_cache,
          content_version   = project_files.content_version + 1,
          cache_valid_until = now() + interval '24 hours',
          size_bytes        = EXCLUDED.size_bytes,
          version           = project_files.version + 1,
          updated_at        = now()
          -- storage_key TIDAK di-update — immutable setelah INSERT
      `, [...]);
    });
  }

  async move(fromPath: string, toPath: string): Promise<void> {
    // Zero S3 operations — hanya update DB
    await this.db.transaction(async (tx) => {
      await tx.query(`
        UPDATE project_files
        SET path        = $1,
            folder_path = $2,
            name        = $3,
            updated_at  = now()
        WHERE project_id = $4 AND path = $5
      `, [toPath, getParentPath(toPath), getFileName(toPath), this.projectId, fromPath]);

      // Upsert folders untuk path baru
      for (const ancestor of getAncestorPaths(toPath)) {
        await tx.query(`
          INSERT INTO project_folders (project_id, path, parent_path, depth)
          VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING
        `, [...]);
      }
    });
  }

  async delete(filePath: string): Promise<void> {
    await this.db.transaction(async (tx) => {
      const result = await tx.query(
        `DELETE FROM project_files WHERE project_id = $1 AND path = $2 RETURNING storage_key`,
        [this.projectId, filePath]
      );

      if (result.rows[0]) {
        // Enqueue S3 delete — tombstone pattern
        await tx.query(`
          INSERT INTO storage_cleanup_queue (storage_key, project_id)
          VALUES ($1, $2)
        `, [result.rows[0].storage_key, this.projectId]);
      }
    });
    // S3 delete dilakukan background worker
  }

  async search(query: string, extension?: string): Promise<SearchResult[]> {
    // tsvector — zero extension dependency
    return this.db.query(`
      SELECT id, path, name, extension, size_bytes, updated_at
      FROM project_files
      WHERE project_id = $1
        AND search_vector @@ to_tsquery('simple', $2 || ':*')
        AND ($3::text IS NULL OR extension = $3)
      ORDER BY updated_at DESC
      LIMIT 100
    `, [this.projectId, query.trim(), extension ?? null]);
  }
}
```

---

## Revised Agent Tools

```typescript
// fs_write: tambah optional expected_version
{
  name: 'fs_write',
  input_schema: {
    path:             { type: 'string' },
    content:          { type: 'string' },
    expected_version: { type: 'number', description: 'Optimistic lock. Pass version dari fs_read untuk safe concurrent write.' }
  }
}

// fs_read: include version dalam response
// BEFORE: { path, content }
// AFTER:  { path, content, version, cached: boolean }

// fs_move: interface sama, internal jauh lebih cepat (zero S3 ops)
// fs_search: interface sama, internal pakai tsvector
```

---

## Migration Path dari Plan 14

### Phase 1 — DB Schema (Additive, No Downtime)

```sql
-- Kolom baru di project_files (semua additive)
ALTER TABLE project_files 
  ADD COLUMN content_version    INT NOT NULL DEFAULT 1,
  ADD COLUMN cache_valid_until  TIMESTAMPTZ,
  ADD COLUMN version            INT NOT NULL DEFAULT 1,
  ADD COLUMN content_hash       TEXT,
  ADD COLUMN name_lower         TEXT GENERATED ALWAYS AS (lower(name)) STORED,
  ADD COLUMN search_vector      TSVECTOR GENERATED ALWAYS AS (
    to_tsvector('simple', coalesce(name, '') || ' ' || coalesce(path, ''))
  ) STORED;

-- Indexes baru (CONCURRENTLY = tidak lock table)
CREATE INDEX CONCURRENTLY idx_pfiles_name_lower ON project_files (project_id, name_lower);
CREATE INDEX CONCURRENTLY idx_pfiles_search ON project_files USING GIN (search_vector);

-- Tabel baru
CREATE TABLE project_folders ( ... );
CREATE TABLE storage_cleanup_queue ( ... );
CREATE TABLE filesystem_migrations ( ... );
CREATE TABLE fs_audit_log ( ... );

-- Backfill project_folders dari data existing
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
WHERE folder_path IS NOT NULL
ON CONFLICT (project_id, path) DO NOTHING;
```

### Phase 2 — S3 Key Migration (Lazy Strategy)

Existing files punya `storage_key = projects/{projectId}{path}` (format lama). Strategi: **lazy migration** — migrate saat file diakses, bukan sekaligus.

```typescript
function isLegacyKey(storageKey: string): boolean {
  return storageKey.startsWith('projects/');
}

// Dipanggil di read() dan write() sebelum akses S3
async function ensureModernKey(file: ProjectFile): Promise<string> {
  if (!isLegacyKey(file.storage_key)) return file.storage_key;

  // Download dari key lama
  const content = await adapter.download(file.storage_key);
  
  // Upload ke key baru (UUID-based)
  const newKey = adapter.buildKey(file.id);
  await adapter.upload(file.id, content, file.mime_type);

  // Update DB + queue delete key lama
  await db.transaction(async (tx) => {
    await tx.query(
      `UPDATE project_files SET storage_key = $1 WHERE id = $2`,
      [newKey, file.id]
    );
    await tx.query(
      `INSERT INTO storage_cleanup_queue (storage_key, project_id) VALUES ($1, $2)`,
      [file.storage_key, file.project_id]
    );
  });

  return newKey;
}
```

Atau kalau prefer eager: jalankan script one-time saat maintenance window.

### Phase 3 — Service Layer

1. Extract `FilesystemServiceFactory` dengan LRU cache → `factory.ts`
2. Update `adapter.ts`: `buildKey(fileId)` — UUID-based
3. Update `write()`: UUID key, upsert `project_folders`
4. Update `move()`: DB-only, zero S3 ops
5. Update `delete()`: tombstone → `storage_cleanup_queue`
6. Update `search()`: tsvector query
7. Deploy `StorageCleanupWorker` → `worker.ts`

### Phase 4 — API & Tools

1. Migration endpoint → async + job polling
2. `fs_write` tool: tambah `expected_version`
3. `fs_read` response: tambah `version`, `cached`
4. `PATCH /config`: call `invalidateFilesystemCache()`

### Phase 5 — Monitoring

1. Alert: `storage_cleanup_queue` stuck (attempts ≥ 3)
2. Alert: `filesystem_migrations` status = 'failed'
3. Metric: file count per project
4. Metric: legacy key count (untuk track migration progress)

---

## Bottleneck Risk Assessment

| Risiko | Plan 14 | Setelah Revision | Severity |
|---|---|---|---|
| S3 key encode path → move/rename mahal | 🔴 O(n) S3 ops, atomicity risk | ✅ Zero S3 ops, DB-only | Critical |
| S3 request rate throttling | 🔴 Semua key ke satu prefix space | ✅ 256 prefix → 256 partisi | Critical |
| Service rebuild per tool call | 🔴 AES decrypt + S3Client tiap call | ✅ LRU cached, amortized | Critical |
| `list()` full scan untuk subfolders | 🔴 O(total_files) ke application | ✅ Index lookup via `project_folders` | Critical |
| `move()` atomicity risk | 🟡 3 S3 ops, crash = inconsistency | ✅ Resolved by UUID-key (no S3 op) | Resolved |
| Search full table scan | 🟡 ILIKE tanpa index | ✅ tsvector GIN, zero extension | Important |
| Migration timeout | 🟡 Blocks API thread | ✅ Async job + polling | Important |
| Concurrent write silent overwrite | 🟡 Last-write-wins | ✅ Optimistic locking | Important |
| Content cache stale | 🟢 Possible | ✅ TTL + version bump | Low |
| No audit trail | 🟢 Missing | ✅ `fs_audit_log` | Future |

---

## Files to Create/Modify

### New Files

```
apps/studio/server/src/filesystem/
├── factory.ts        # LRU-cached FilesystemServiceFactory (extracted)
├── worker.ts         # StorageCleanupWorker — background, every 30s
└── migration-job.ts  # Async filesystem migration job

apps/studio/db/src/schema/
├── filesystem-folders.ts     # project_folders
├── filesystem-cleanup.ts     # storage_cleanup_queue
├── filesystem-migrations.ts  # filesystem_migrations (async)
└── filesystem-audit.ts       # fs_audit_log
```

### Modified Files

```
apps/studio/server/src/filesystem/adapter.ts
  - buildKey(fileId: string): 'objects/{ab}/{fileId}'
  - Parameter berubah dari (projectId, virtualPath) ke (fileId)

apps/studio/server/src/filesystem/service.ts
  - write(): UUID key, upsert project_folders, optimistic lock support
  - move(): DB-only update, zero S3 operations
  - delete(): tombstone → storage_cleanup_queue
  - search(): tsvector query (no pg_trgm)

apps/studio/server/src/filesystem/tools.ts
  - fs_write: add expected_version param
  - fs_read: return version + cached in response

apps/studio/server/src/routes/filesystem.ts
  - POST migrate: async, return { job_id }
  - GET migrate/:id: new — polling endpoint
  - PATCH config: call invalidateFilesystemCache()

apps/studio/db/src/schema/filesystem.ts
  - project_files: add version, content_version, cache_valid_until,
                   content_hash, name_lower, search_vector
```

---

## Summary

Dari semua isu yang dianalisis, **Issue 1 (UUID-based S3 key)** adalah perubahan paling fundamental dan paling menguntungkan karena menyelesaikan dua masalah sekaligus: move/rename jadi zero S3 operation (sekaligus membunuh atomicity risk), dan distribusi key ke 256 prefix alami untuk mencegah S3 throttling.

**Tiga perubahan paling penting sebelum scaling:**

1. **UUID-based S3 key** — move/rename gratis, tidak ada atomicity risk, siap throttling
2. **LRU cache FilesystemService** — eliminasi AES decrypt + S3Client rebuild per tool call
3. **`project_folders` table** — eliminasi full scan saat `list()`

Semua perubahan bersifat additive dan incremental — tidak perlu downtime, tidak perlu rewrite penuh.