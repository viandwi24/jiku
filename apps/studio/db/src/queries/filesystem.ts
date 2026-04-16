import { eq, and, like, or, count, sum, asc, desc, ilike, inArray } from 'drizzle-orm'
import { db } from '../client.ts'
import { project_filesystem_config, project_files } from '../schema/filesystem.ts'
import type { ProjectFilesystemConfig, ProjectFile, NewProjectFile } from '../schema/filesystem.ts'
import { project_folders } from '../schema/filesystem-folders.ts'
import type { ProjectFolder } from '../schema/filesystem-folders.ts'

// ─── Config queries ──────────────────────────────────────────────────────────

export async function getFilesystemConfig(projectId: string): Promise<ProjectFilesystemConfig | null> {
  const row = await db.query.project_filesystem_config.findFirst({
    where: eq(project_filesystem_config.project_id, projectId),
  })
  return row ?? null
}

export async function upsertFilesystemConfig(
  projectId: string,
  data: { adapter_id?: string; credential_id?: string | null; enabled?: boolean },
): Promise<ProjectFilesystemConfig> {
  const existing = await getFilesystemConfig(projectId)
  if (existing) {
    const [updated] = await db.update(project_filesystem_config)
      .set({ ...data, updated_at: new Date() })
      .where(eq(project_filesystem_config.project_id, projectId))
      .returning()
    return updated!
  }
  const [created] = await db.insert(project_filesystem_config)
    .values({ project_id: projectId, ...data })
    .returning()
  return created!
}

export async function updateFilesystemStats(projectId: string): Promise<void> {
  const [result] = await db
    .select({
      total_files: count(),
      total_size_bytes: sum(project_files.size_bytes),
    })
    .from(project_files)
    .where(eq(project_files.project_id, projectId))

  await db.update(project_filesystem_config)
    .set({
      total_files: result?.total_files ?? 0,
      total_size_bytes: Number(result?.total_size_bytes ?? 0),
      updated_at: new Date(),
    })
    .where(eq(project_filesystem_config.project_id, projectId))
}

// ─── File queries ────────────────────────────────────────────────────────────

export async function getFileByPath(projectId: string, filePath: string): Promise<ProjectFile | null> {
  const row = await db.query.project_files.findFirst({
    where: and(
      eq(project_files.project_id, projectId),
      eq(project_files.path, filePath),
    ),
  })
  return row ?? null
}

/** Look up a folder row by exact virtual path. Returns null if not present. */
export async function getFolderByPath(projectId: string, folderPath: string): Promise<ProjectFolder | null> {
  const row = await db.query.project_folders.findFirst({
    where: and(
      eq(project_folders.project_id, projectId),
      eq(project_folders.path, folderPath),
    ),
  })
  return row ?? null
}

export async function listFiles(projectId: string, folderPath: string): Promise<ProjectFile[]> {
  return db.query.project_files.findMany({
    where: and(
      eq(project_files.project_id, projectId),
      eq(project_files.folder_path, folderPath),
    ),
    orderBy: [asc(project_files.name)],
  })
}

/** Get all file paths that are under the given folder (for virtual subfolder extraction). */
export async function listAllPathsUnderFolder(
  projectId: string,
  folderPath: string,
): Promise<{ path: string }[]> {
  const prefix = folderPath === '/' ? '/' : `${folderPath}/`
  return db
    .select({ path: project_files.path })
    .from(project_files)
    .where(and(
      eq(project_files.project_id, projectId),
      like(project_files.path, `${prefix}%`),
    ))
}

export async function searchFiles(
  projectId: string,
  query: string,
  extension?: string,
): Promise<ProjectFile[]> {
  const conditions = [
    eq(project_files.project_id, projectId),
    or(
      ilike(project_files.name, `%${query}%`),
      ilike(project_files.path, `%${query}%`),
    ),
  ]
  if (extension) {
    conditions.push(eq(project_files.extension, extension.startsWith('.') ? extension : `.${extension}`))
  }
  return db.query.project_files.findMany({
    where: and(...conditions),
    orderBy: [desc(project_files.updated_at)],
    limit: 100,
  })
}

export async function upsertFile(data: NewProjectFile & { project_id: string; path: string }): Promise<ProjectFile> {
  const existing = await getFileByPath(data.project_id, data.path)
  if (existing) {
    // Optimistic-lock version bumps on every write; content_version bumps when
    // the bytes actually changed (enables downstream cache invalidation).
    const contentChanged = data.content_hash != null && data.content_hash !== existing.content_hash
    const [updated] = await db.update(project_files)
      .set({
        size_bytes: data.size_bytes,
        mime_type: data.mime_type,
        content_cache: data.content_cache ?? null,
        content_hash: data.content_hash ?? existing.content_hash,
        content_version: contentChanged ? existing.content_version + 1 : existing.content_version,
        version: existing.version + 1,
        updated_by: data.updated_by ?? null,
        updated_at: new Date(),
      })
      .where(eq(project_files.id, existing.id))
      .returning()
    return updated!
  }
  const [created] = await db.insert(project_files).values(data).returning()
  return created!
}

export async function deleteFileById(id: string): Promise<void> {
  await db.delete(project_files).where(eq(project_files.id, id))
}

export async function deleteFilesByIds(ids: string[]): Promise<void> {
  if (ids.length === 0) return
  await db.delete(project_files).where(inArray(project_files.id, ids))
}

export async function getFilesUnderFolder(projectId: string, folderPath: string): Promise<ProjectFile[]> {
  const normalizedFolder = folderPath === '/' ? '' : folderPath
  return db.query.project_files.findMany({
    where: and(
      eq(project_files.project_id, projectId),
      or(
        eq(project_files.folder_path, folderPath),
        like(project_files.path, `${normalizedFolder}/%`),
      ),
    ),
  })
}

export async function updateFilePath(
  fileId: string,
  updates: { path: string; name: string; folder_path: string; extension: string; storage_key: string },
): Promise<ProjectFile> {
  const [updated] = await db.update(project_files)
    .set({ ...updates, updated_at: new Date() })
    .where(eq(project_files.id, fileId))
    .returning()
  return updated!
}

export async function getAllProjectFiles(projectId: string): Promise<ProjectFile[]> {
  return db.query.project_files.findMany({
    where: eq(project_files.project_id, projectId),
  })
}

export async function updateFileStorageKey(fileId: string, storageKey: string): Promise<void> {
  await db.update(project_files)
    .set({ storage_key: storageKey, updated_at: new Date() })
    .where(eq(project_files.id, fileId))
}

export async function deleteAllProjectFiles(projectId: string): Promise<number> {
  const files = await getAllProjectFiles(projectId)
  if (files.length === 0) return 0
  await db.delete(project_files).where(eq(project_files.project_id, projectId))
  return files.length
}
