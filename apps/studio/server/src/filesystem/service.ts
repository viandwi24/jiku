import nodePath from 'node:path'
import {
  getFilesystemConfig,
  getFileByPath,
  listFiles,
  listAllPathsUnderFolder,
  searchFiles,
  upsertFile,
  deleteFileById,
  deleteFilesByIds,
  getFilesUnderFolder,
  updateFilePath,
  updateFilesystemStats,
  getAllProjectFiles,
  updateFileStorageKey,
  deleteAllProjectFiles,
  getCredentialById,
} from '@jiku-studio/db'
import { decryptFields } from '../credentials/encryption.ts'
import { S3FilesystemAdapter, buildS3Adapter } from './adapter.ts'
import { normalizePath, extractImmediateSubfolders, isAllowedFile, getMimeType } from './utils.ts'
import type { ProjectFile } from '@jiku-studio/db'

export type FilesystemEntry =
  | { type: 'folder'; path: string; name: string }
  | { type: 'file' } & ProjectFile

export class FilesystemService {
  constructor(
    private projectId: string,
    private adapter: S3FilesystemAdapter,
  ) {}

  async list(folderPath = '/'): Promise<FilesystemEntry[]> {
    const normalizedFolder = normalizePath(folderPath)

    const [files, allPaths] = await Promise.all([
      listFiles(this.projectId, normalizedFolder),
      listAllPathsUnderFolder(this.projectId, normalizedFolder),
    ])

    const subfolders = extractImmediateSubfolders(
      allPaths.map(p => p.path),
      normalizedFolder,
    )

    return [
      ...subfolders.map(f => ({
        type: 'folder' as const,
        path: f,
        name: nodePath.basename(f),
      })),
      ...files.map(f => ({ type: 'file' as const, ...f })),
    ]
  }

  async read(filePath: string): Promise<string> {
    const normalized = normalizePath(filePath)
    const file = await getFileByPath(this.projectId, normalized)
    if (!file) throw new NotFoundError(`File not found: ${filePath}`)
    if (file.content_cache !== null) return file.content_cache
    const buffer = await this.adapter.download(file.storage_key)
    return buffer.toString('utf-8')
  }

  async write(filePath: string, content: string, userId?: string): Promise<ProjectFile> {
    const normalized = normalizePath(filePath)
    const filename = nodePath.basename(normalized)
    const folder = nodePath.dirname(normalized)
    const ext = nodePath.extname(filename).toLowerCase()
    const sizeBytes = Buffer.byteLength(content, 'utf-8')

    const check = isAllowedFile(filename, sizeBytes)
    if (!check.allowed) throw new ValidationError(check.reason!)

    const storageKey = this.adapter.buildKey(this.projectId, normalized)
    const mimeType = getMimeType(ext)

    await this.adapter.upload(storageKey, content, mimeType)

    const file = await upsertFile({
      project_id: this.projectId,
      path: normalized,
      name: filename,
      folder_path: folder,
      extension: ext,
      storage_key: storageKey,
      size_bytes: sizeBytes,
      mime_type: mimeType,
      content_cache: sizeBytes <= 50_000 ? content : null,
      created_by: userId ?? null,
      updated_by: userId ?? null,
    })

    await updateFilesystemStats(this.projectId)
    return file
  }

  async move(fromPath: string, toPath: string): Promise<void> {
    const from = normalizePath(fromPath)
    const to = normalizePath(toPath)

    const file = await getFileByPath(this.projectId, from)
    if (!file) throw new NotFoundError(`File not found: ${fromPath}`)

    const existing = await getFileByPath(this.projectId, to)
    if (existing) throw new ConflictError(`File already exists at: ${toPath}`)

    const newKey = this.adapter.buildKey(this.projectId, to)
    const content = await this.adapter.download(file.storage_key)
    await this.adapter.upload(newKey, content, file.mime_type)
    await this.adapter.delete(file.storage_key)

    const filename = nodePath.basename(to)
    await updateFilePath(file.id, {
      path: to,
      name: filename,
      folder_path: nodePath.dirname(to),
      extension: nodePath.extname(filename).toLowerCase(),
      storage_key: newKey,
    })
  }

  async delete(filePath: string): Promise<void> {
    const normalized = normalizePath(filePath)
    const file = await getFileByPath(this.projectId, normalized)
    if (!file) throw new NotFoundError(`File not found: ${filePath}`)
    await this.adapter.delete(file.storage_key)
    await deleteFileById(file.id)
    await updateFilesystemStats(this.projectId)
  }

  async deleteFolder(folderPath: string): Promise<number> {
    const normalized = normalizePath(folderPath)
    const files = await getFilesUnderFolder(this.projectId, normalized)
    await Promise.all(files.map(f => this.adapter.delete(f.storage_key)))
    await deleteFilesByIds(files.map(f => f.id))
    await updateFilesystemStats(this.projectId)
    return files.length
  }

  async search(query: string, extension?: string): Promise<ProjectFile[]> {
    return searchFiles(this.projectId, query, extension)
  }

  /** Return the S3 adapter for direct streaming (used by proxy route). */
  getAdapter(): S3FilesystemAdapter {
    return this.adapter
  }
}

// ─── Factory ─────────────────────────────────────────────────────────────────

export async function getFilesystemService(projectId: string): Promise<FilesystemService | null> {
  const config = await getFilesystemConfig(projectId)
  if (!config?.enabled || !config.credential_id) return null

  const cred = await getCredentialById(config.credential_id)
  if (!cred || !cred.fields_encrypted) return null

  const fields = decryptFields(cred.fields_encrypted)
  const metadata = (cred.metadata ?? {}) as Record<string, string>
  const adapter = buildS3Adapter(fields, metadata)

  return new FilesystemService(projectId, adapter)
}

/**
 * Migrate all files from the current adapter to a new adapter + config.
 * Copies objects from old S3 adapter to new S3 adapter, then updates
 * the storage_key in DB to point at the new adapter's keys.
 *
 * Returns counts of migrated / failed files.
 */
export async function migrateFilesystemAdapter(
  projectId: string,
  newCredentialId: string,
  newAdapterId: string,
): Promise<{ migrated: number; failed: number; errors: string[] }> {
  // Build old adapter from current config
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

  // Get all files for the project
  const allFiles = await getAllProjectFiles(projectId)

  let migrated = 0
  let failed = 0
  const errors: string[] = []

  for (const file of allFiles) {
    try {
      const content = await oldAdapter.download(file.storage_key)
      const newKey = newAdapter.buildKey(projectId, file.path)
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
    // Write a small probe object then delete it
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
