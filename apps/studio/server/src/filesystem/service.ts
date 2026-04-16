import nodePath from 'node:path'
import { randomUUID, createHash } from 'node:crypto'
import { eq, and, like, or, sql } from '@jiku-studio/db'
import { db } from '@jiku-studio/db'
import {
  getFilesystemConfig,
  getFileByPath,
  listFiles,
  searchFiles,
  upsertFile,
  getFilesUnderFolder,
  updateFilePath,
  updateFilesystemStats,
  getAllProjectFiles,
  updateFileStorageKey,
  deleteAllProjectFiles,
  getCredentialById,
} from '@jiku-studio/db'
import {
  project_files,
  project_folders,
  storage_cleanup_queue,
} from '@jiku-studio/db'
import { decryptFields } from '../credentials/encryption.ts'
import { S3FilesystemAdapter, buildS3Adapter } from './adapter.ts'
import { normalizePath, isAllowedFile, getMimeType, getAncestorPaths } from './utils.ts'
import type { ProjectFile } from '@jiku-studio/db'
import { audit } from '../audit/logger.ts'

// Cache validity for content_cache (24 hours)
const CACHE_TTL_MS = 24 * 60 * 60 * 1000

export type FilesystemEntry =
  | { type: 'folder'; path: string; name: string }
  | { type: 'file' } & ProjectFile

export interface WriteOptions {
  userId?: string
  /** Pass the version from a previous fs_read to enable optimistic locking. */
  expectedVersion?: number
}

export class FilesystemService {
  constructor(
    private projectId: string,
    private adapter: S3FilesystemAdapter,
  ) {}

  // ─── list ───────────────────────────────────────────────────────────────

  async list(folderPath = '/'): Promise<FilesystemEntry[]> {
    const normalizedFolder = normalizePath(folderPath)

    // Plan 16: two parallel index lookups instead of O(total_files) derivation
    const [files, subfolders] = await Promise.all([
      listFiles(this.projectId, normalizedFolder),
      this.listSubfolders(normalizedFolder),
    ])

    return [
      ...subfolders.map(f => ({
        type: 'folder' as const,
        path: f.path,
        name: nodePath.basename(f.path),
      })),
      ...files.map(f => ({ type: 'file' as const, ...f })),
    ]
  }

  private async listSubfolders(folderPath: string) {
    const parentPath = folderPath === '/' ? null : folderPath
    return db
      .select({ path: project_folders.path })
      .from(project_folders)
      .where(
        and(
          eq(project_folders.project_id, this.projectId),
          parentPath === null
            ? sql`${project_folders.parent_path} IS NULL`
            : eq(project_folders.parent_path, parentPath),
        ),
      )
      .orderBy(project_folders.path)
  }

  // ─── read ───────────────────────────────────────────────────────────────

  async read(filePath: string): Promise<{ content: string; version: number; cached: boolean }> {
    const normalized = normalizePath(filePath)
    const file = await getFileByPath(this.projectId, normalized)
    if (!file) throw new NotFoundError(`File not found: ${filePath}`)

    // Plan 16: check cache validity (version + TTL)
    const cacheValid =
      file.content_cache !== null &&
      file.cache_valid_until !== null &&
      new Date(file.cache_valid_until) > new Date()

    if (cacheValid) {
      return { content: file.content_cache!, version: file.version, cached: true }
    }

    // Cache miss or expired — fetch from S3
    const key = await this.ensureModernKey(file)
    const buffer = await this.adapter.download(key)
    const content = buffer.toString('utf-8')

    // Refresh cache for small files
    if (file.size_bytes <= 50_000) {
      await db.update(project_files).set({
        content_cache: content,
        cache_valid_until: new Date(Date.now() + CACHE_TTL_MS),
      }).where(eq(project_files.id, file.id))
    }

    return { content, version: file.version, cached: false }
  }

  // ─── readBinary ─────────────────────────────────────────────────────────
  // Returns the raw file bytes. For files uploaded as base64 (binary formats
  // like .xlsx, .xls, .ods), decodes the __b64__: prefix and returns the
  // original bytes. For text files, returns UTF-8 encoded bytes.

  async readBinary(filePath: string): Promise<Buffer | null> {
    try {
      const normalized = normalizePath(filePath)
      const file = await getFileByPath(this.projectId, normalized)
      if (!file) return null

      // Check content_cache first for base64-encoded files
      if (file.content_cache?.startsWith('__b64__:')) {
        return Buffer.from(file.content_cache.slice(8), 'base64')
      }

      const key = await this.ensureModernKey(file)
      const buffer = await this.adapter.download(key)

      // Detect base64-encoded binary content
      const prefix = buffer.slice(0, 8).toString('utf-8')
      if (prefix === '__b64__:') {
        const b64 = buffer.slice(8).toString('utf-8')
        return Buffer.from(b64, 'base64')
      }

      return buffer
    } catch {
      return null
    }
  }

  // ─── write ──────────────────────────────────────────────────────────────

  async write(filePath: string, content: string, options: WriteOptions = {}): Promise<ProjectFile> {
    const { userId, expectedVersion } = options
    const normalized = normalizePath(filePath)
    const filename = nodePath.basename(normalized)
    const folder = nodePath.dirname(normalized)
    const ext = nodePath.extname(filename).toLowerCase()
    const sizeBytes = Buffer.byteLength(content, 'utf-8')

    const check = isAllowedFile(filename, sizeBytes)
    if (!check.allowed) throw new ValidationError(check.reason!)

    const mimeType = getMimeType(ext)
    const existing = await getFileByPath(this.projectId, normalized)

    // Plan 16: optimistic locking
    if (expectedVersion !== undefined && existing) {
      if (existing.version !== expectedVersion) {
        throw new ConflictError(
          `File was modified (current version: ${existing.version}, expected: ${expectedVersion}). ` +
          `Read the file again to get the latest version.`,
        )
      }
    }

    // Plan 16: UUID-based key — immutable after creation. On update, reuse
    // the existing storage_key (content is overwritten in-place in S3).
    const fileId = existing?.id ?? randomUUID()
    const storageKey = existing?.storage_key ?? this.adapter.buildKeyFromId(fileId)

    // Upload content to S3 (same key for both create and update)
    await this.adapter.upload(storageKey, content, mimeType)

    // DB upsert
    const file = await upsertFile({
      id: existing ? undefined : fileId,
      project_id: this.projectId,
      path: normalized,
      name: filename,
      folder_path: folder,
      extension: ext,
      storage_key: storageKey,
      size_bytes: sizeBytes,
      mime_type: mimeType,
      content_cache: sizeBytes <= 50_000 ? content : null,
      content_hash: createHash('sha256').update(content).digest('hex'),
      created_by: userId ?? null,
      updated_by: userId ?? null,
    })

    // Plan 16: upsert ancestor folders into project_folders
    await this.upsertAncestorFolders(normalized)

    await updateFilesystemStats(this.projectId)
    audit.fileWrite(
      { actor_id: userId ?? null, actor_type: userId ? 'user' : 'system', project_id: this.projectId },
      normalized,
      sizeBytes,
    )
    return file
  }

  // ─── move ───────────────────────────────────────────────────────────────

  async move(fromPath: string, toPath: string): Promise<void> {
    const from = normalizePath(fromPath)
    const to = normalizePath(toPath)
    if (from === to) return // no-op

    // Try file first; fall back to folder. Distinguishing matters because
    // folder move has to rewrite every descendant file + folder row.
    const file = await getFileByPath(this.projectId, from)
    if (file) {
      const existing = await getFileByPath(this.projectId, to)
      if (existing) throw new ConflictError(`File already exists at: ${toPath}`)

      // Plan 16: zero S3 operations — storage_key is UUID-based and does NOT
      // change on move/rename. Only DB metadata (path, name, folder_path,
      // extension) is updated. This is atomic (single UPDATE statement).
      const filename = nodePath.basename(to)
      await updateFilePath(file.id, {
        path: to,
        name: filename,
        folder_path: nodePath.dirname(to),
        extension: nodePath.extname(filename).toLowerCase(),
        // storage_key intentionally NOT included — immutable after file creation
      })
      await this.upsertAncestorFolders(to)
      return
    }

    // Folder move path. Reject if `from` doesn't exist as a folder either.
    const folderExists = await db
      .select({ id: project_folders.id })
      .from(project_folders)
      .where(and(eq(project_folders.project_id, this.projectId), eq(project_folders.path, from)))
      .limit(1)
    if (folderExists.length === 0) {
      throw new NotFoundError(`Path not found: ${fromPath}`)
    }
    if (to === '/') throw new ValidationError('Cannot move folder onto root')
    if (to === from || to.startsWith(from + '/')) {
      throw new ValidationError('Cannot move a folder into itself or its descendant')
    }
    const conflictFolder = await db
      .select({ id: project_folders.id })
      .from(project_folders)
      .where(and(eq(project_folders.project_id, this.projectId), eq(project_folders.path, to)))
      .limit(1)
    if (conflictFolder.length > 0) {
      throw new ConflictError(`Folder already exists at: ${toPath}`)
    }
    const conflictFile = await getFileByPath(this.projectId, to)
    if (conflictFile) {
      throw new ConflictError(`A file already exists at: ${toPath}`)
    }

    // Walk every descendant file + folder and rewrite the prefix.
    // sql REPLACE-on-prefix would be cleaner but inconsistent across drivers;
    // explicit row updates inside one transaction are safe + portable.
    const descendantFiles = await getFilesUnderFolder(this.projectId, from)
    const descendantFolders = await db
      .select()
      .from(project_folders)
      .where(and(
        eq(project_folders.project_id, this.projectId),
        or(
          eq(project_folders.path, from),
          like(project_folders.path, `${from}/%`),
        ),
      ))

    const rewritePath = (oldPath: string): string => to + oldPath.slice(from.length)

    await db.transaction(async (tx) => {
      for (const f of descendantFiles) {
        const newFilePath = rewritePath(f.path)
        await tx.update(project_files)
          .set({
            path: newFilePath,
            folder_path: nodePath.dirname(newFilePath),
            updated_at: new Date(),
          })
          .where(eq(project_files.id, f.id))
      }
      for (const fd of descendantFolders) {
        const newFolderPath = rewritePath(fd.path)
        // Match upsertAncestorFolders: root-level folders store parent_path = NULL,
        // not '/'. listSubfolders('/') filters on `parent_path IS NULL`, so a
        // string '/' here makes the folder vanish from the root listing.
        const parentDir = newFolderPath === '/' ? null : nodePath.dirname(newFolderPath)
        const newParent = parentDir === '/' ? null : parentDir
        const depth = newFolderPath.split('/').filter(Boolean).length
        await tx.update(project_folders)
          .set({
            path: newFolderPath,
            parent_path: newParent,
            depth,
          })
          .where(eq(project_folders.id, fd.id))
      }
    })

    // Ensure the new ancestor chain exists (target's parent might be a brand-
    // new folder if `to`'s parent isn't already in the table).
    await this.upsertAncestorFolders(to)
  }

  // ─── delete ─────────────────────────────────────────────────────────────

  async delete(filePath: string): Promise<void> {
    const normalized = normalizePath(filePath)
    const file = await getFileByPath(this.projectId, normalized)
    if (!file) throw new NotFoundError(`File not found: ${filePath}`)

    // Plan 16: tombstone pattern — delete DB row immediately, enqueue S3
    // cleanup for the background worker. This decouples the fast user-facing
    // operation from the potentially slow/flaky S3 delete.
    await db.transaction(async (tx) => {
      await tx.delete(project_files).where(eq(project_files.id, file.id))
      await tx.insert(storage_cleanup_queue).values({
        storage_key: file.storage_key,
        project_id: this.projectId,
      })
    })

    await updateFilesystemStats(this.projectId)
    audit.fileDelete(
      { actor_id: null, actor_type: 'system', project_id: this.projectId },
      normalized,
    )
  }

  async deleteFolder(folderPath: string): Promise<number> {
    const normalized = normalizePath(folderPath)
    const files = await getFilesUnderFolder(this.projectId, normalized)
    if (files.length === 0) return 0

    // Enqueue all S3 keys for background cleanup + delete DB rows
    await db.transaction(async (tx) => {
      // Enqueue S3 keys
      for (const f of files) {
        await tx.insert(storage_cleanup_queue).values({
          storage_key: f.storage_key,
          project_id: this.projectId,
        })
      }
      // Delete file rows
      await tx.delete(project_files).where(
        sql`${project_files.id} IN (${sql.join(files.map(f => sql`${f.id}`), sql`, `)})`,
      )
      // Clean up folder entries
      await tx.delete(project_folders).where(
        and(
          eq(project_folders.project_id, this.projectId),
          or(
            eq(project_folders.path, normalized),
            like(project_folders.path, `${normalized}/%`),
          ),
        ),
      )
    })

    await updateFilesystemStats(this.projectId)
    return files.length
  }

  // ─── search ─────────────────────────────────────────────────────────────

  async search(query: string, extension?: string): Promise<ProjectFile[]> {
    // Plan 16: try tsvector first (GIN index), fall back to ILIKE if
    // search_vector column doesn't exist yet (migration not applied).
    try {
      const results = await db.execute<ProjectFile>(sql`
        SELECT id, project_id, path, name, extension, size_bytes, mime_type,
               folder_path, storage_key, content_cache, version, content_version,
               cache_valid_until, content_hash, created_by, updated_by,
               created_at, updated_at
        FROM project_files
        WHERE project_id = ${this.projectId}
          AND search_vector @@ to_tsquery('simple', ${query.trim()} || ':*')
          ${extension ? sql`AND extension = ${extension}` : sql``}
        ORDER BY updated_at DESC
        LIMIT 100
      `)
      return results.rows as unknown as ProjectFile[]
    } catch {
      // Fallback: search_vector column not yet created
      return searchFiles(this.projectId, query, extension)
    }
  }

  /** Return the S3 adapter for direct streaming (used by proxy route). */
  getAdapter(): S3FilesystemAdapter {
    return this.adapter
  }

  // ─── Internals ──────────────────────────────────────────────────────────

  /**
   * Plan 16: lazy S3 key migration. Legacy files have path-encoded keys
   * (`projects/{projectId}{path}`). On first access, we re-upload under a
   * UUID-based key and enqueue the old key for cleanup.
   */
  private async ensureModernKey(file: ProjectFile): Promise<string> {
    if (!S3FilesystemAdapter.isLegacyKey(file.storage_key)) {
      return file.storage_key
    }

    const content = await this.adapter.download(file.storage_key)
    const newKey = this.adapter.buildKeyFromId(file.id)
    await this.adapter.upload(newKey, content, file.mime_type)

    // Update DB + enqueue old key for cleanup
    await updateFileStorageKey(file.id, newKey)
    await db.insert(storage_cleanup_queue).values({
      storage_key: file.storage_key,
      project_id: this.projectId,
    })

    return newKey
  }

  // ─── mkdir ──────────────────────────────────────────────────────────────

  async mkdir(folderPath: string): Promise<void> {
    const normalized = normalizePath(folderPath)
    if (normalized === '/') throw new ValidationError('Cannot create root folder')

    // Collect this folder + all its ancestors
    const segments = normalized.split('/').filter(Boolean)
    for (let i = 0; i < segments.length; i++) {
      const path = '/' + segments.slice(0, i + 1).join('/')
      const parentPath = i === 0 ? null : ('/' + segments.slice(0, i).join('/'))
      await db.insert(project_folders).values({
        project_id: this.projectId,
        path,
        parent_path: parentPath,
        depth: i + 1,
      }).onConflictDoNothing()
    }
  }

  /**
   * Upsert all ancestor folders of a file path into project_folders.
   * Called after write() and move() to keep the folder table in sync.
   */
  private async upsertAncestorFolders(filePath: string): Promise<void> {
    const ancestors = getAncestorPaths(filePath)
    for (const ancestor of ancestors) {
      const parentPath = ancestor === '/' ? null : nodePath.dirname(ancestor) || '/'
      const depth = ancestor.split('/').filter(Boolean).length
      await db.insert(project_folders).values({
        project_id: this.projectId,
        path: ancestor,
        parent_path: parentPath === '/' ? null : parentPath,
        depth,
      }).onConflictDoNothing()
    }
  }
}

// ─── Factory ─────────────────────────────────────────────────────────────────
// Plan 16: the factory with LRU cache lives in `factory.ts`. This re-export
// keeps backward compatibility for all existing consumers that import from
// `service.ts` (routes, skills, attachments, content persister, etc.).

export { getFilesystemService } from './factory.ts'

/**
 * Migrate all files from the current adapter to a new adapter + config.
 * Plan 16: now uses UUID-based keys for new adapter.
 */
export async function migrateFilesystemAdapter(
  projectId: string,
  newCredentialId: string,
  _newAdapterId: string,
): Promise<{ migrated: number; failed: number; errors: string[] }> {
  const oldConfig = await getFilesystemConfig(projectId)
  if (!oldConfig?.credential_id) {
    throw new ValidationError('No existing filesystem configured — nothing to migrate from')
  }

  const [oldCred, newCred] = await Promise.all([
    getCredentialById(oldConfig.credential_id),
    getCredentialById(newCredentialId),
  ])

  if (!oldCred?.fields_encrypted) throw new ValidationError('Old credential not found')
  if (!newCred?.fields_encrypted) throw new ValidationError('New credential not found')

  const oldAdapter = buildS3Adapter(
    decryptFields(oldCred.fields_encrypted),
    (oldCred.metadata ?? {}) as Record<string, string>,
  )
  const newAdapter = buildS3Adapter(
    decryptFields(newCred.fields_encrypted),
    (newCred.metadata ?? {}) as Record<string, string>,
  )

  const allFiles = await getAllProjectFiles(projectId)

  let migrated = 0
  let failed = 0
  const errors: string[] = []

  for (const file of allFiles) {
    try {
      const content = await oldAdapter.download(file.storage_key)
      // Plan 16: use UUID-based key for the new adapter
      const newKey = newAdapter.buildKeyFromId(file.id)
      await newAdapter.upload(newKey, content, file.mime_type)
      await updateFileStorageKey(file.id, newKey)
      migrated++
    } catch (err) {
      failed++
      errors.push(`${file.path}: ${err instanceof Error ? err.message : 'unknown error'}`)
    }
  }

  return { migrated, failed, errors }
}

export async function testFilesystemConnection(projectId: string): Promise<{ ok: boolean; message: string }> {
  const config = await getFilesystemConfig(projectId)
  if (!config?.credential_id) return { ok: false, message: 'No credential configured' }

  const cred = await getCredentialById(config.credential_id)
  if (!cred || !cred.fields_encrypted) return { ok: false, message: 'Credential not found or has no fields' }

  try {
    const fields = decryptFields(cred.fields_encrypted)
    const metadata = (cred.metadata ?? {}) as Record<string, string>
    const adapter = buildS3Adapter(fields, metadata)
    const testKey = `jiku-probe-${projectId}-${Date.now()}`
    await adapter.upload(testKey, 'probe', 'text/plain')
    await adapter.delete(testKey)
    return { ok: true, message: 'Connected successfully' }
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : 'Connection failed' }
  }
}

// ─── Errors ──────────────────────────────────────────────────────────────────

export class NotFoundError extends Error {
  status = 404
  constructor(msg: string) { super(msg) }
}

export class ValidationError extends Error {
  status = 422
  constructor(msg: string) { super(msg) }
}

export class ConflictError extends Error {
  status = 409
  constructor(msg: string) { super(msg) }
}
