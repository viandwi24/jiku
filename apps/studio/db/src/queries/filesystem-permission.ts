import { eq, and, inArray } from 'drizzle-orm'
import { db } from '../client.ts'
import { project_files } from '../schema/filesystem.ts'
import { project_folders } from '../schema/filesystem-folders.ts'

/**
 * Plan 26 — FS tool permission resolver.
 *
 * Effective permission for a path:
 *   1. If the entry itself (file or folder at `path`) has explicit `tool_permission`, use it.
 *   2. Otherwise walk parent folders toward root; first explicit value wins.
 *   3. If nothing is set anywhere up the tree, default = 'read+write'.
 *
 * Human users editing via the UI are NOT gated — this only governs agent tool calls.
 */

export type FsToolPermission = 'read+write' | 'read'

export interface ResolvedFsPermission {
  effective: FsToolPermission
  source: 'default' | 'self' | 'inherited'
  source_path: string | null
}

/** Return all ancestor folder paths for a given file/folder path, from immediate parent up to root. */
function parentChain(p: string): string[] {
  const norm = p.replace(/\/+$/, '')
  if (!norm || norm === '/') return []
  const parts = norm.split('/').filter(Boolean)
  const out: string[] = []
  for (let i = parts.length - 1; i >= 1; i--) {
    out.push('/' + parts.slice(0, i).join('/'))
  }
  out.push('/')
  return out
}

export async function resolveFsToolPermission(
  projectId: string,
  path: string,
): Promise<ResolvedFsPermission> {
  // 1. Try exact file match.
  const fileRow = await db.select({ tp: project_files.tool_permission })
    .from(project_files)
    .where(and(eq(project_files.project_id, projectId), eq(project_files.path, path)))
    .limit(1)
  const selfFile = fileRow[0]?.tp
  if (selfFile === 'read' || selfFile === 'read+write') {
    return { effective: selfFile, source: 'self', source_path: path }
  }

  // 2. Try exact folder match (if path is a folder).
  const folderSelf = await db.select({ tp: project_folders.tool_permission })
    .from(project_folders)
    .where(and(eq(project_folders.project_id, projectId), eq(project_folders.path, path)))
    .limit(1)
  const selfFolder = folderSelf[0]?.tp
  if (selfFolder === 'read' || selfFolder === 'read+write') {
    return { effective: selfFolder, source: 'self', source_path: path }
  }

  // 3. Walk ancestor folders from nearest to root; first explicit wins.
  const chain = parentChain(path)
  if (chain.length === 0) return { effective: 'read+write', source: 'default', source_path: null }

  const rows = await db.select({ path: project_folders.path, tp: project_folders.tool_permission })
    .from(project_folders)
    .where(and(eq(project_folders.project_id, projectId), inArray(project_folders.path, chain)))
  const byPath = new Map(rows.map(r => [r.path, r.tp]))
  for (const ancestor of chain) {
    const tp = byPath.get(ancestor)
    if (tp === 'read' || tp === 'read+write') {
      return { effective: tp, source: 'inherited', source_path: ancestor }
    }
  }
  return { effective: 'read+write', source: 'default', source_path: null }
}

/** Set the explicit permission on a file or folder. Pass null to clear (= inherit). */
export async function setFsToolPermission(
  projectId: string,
  path: string,
  permission: FsToolPermission | null,
  entityType: 'file' | 'folder',
): Promise<void> {
  if (entityType === 'file') {
    await db.update(project_files)
      .set({ tool_permission: permission })
      .where(and(eq(project_files.project_id, projectId), eq(project_files.path, path)))
  } else {
    await db.update(project_folders)
      .set({ tool_permission: permission })
      .where(and(eq(project_folders.project_id, projectId), eq(project_folders.path, path)))
  }
}
