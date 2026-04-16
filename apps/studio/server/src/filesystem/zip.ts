/**
 * ZIP export / import for the project virtual disk.
 *
 * Export: caller picks a set of paths (files OR folders); we walk the matching
 * `project_files` rows, decode any `__b64__:` binary content back to raw bytes,
 * pack into a JSZip archive, and stream the resulting buffer back to the
 * caller. Folder paths in the archive mirror the virtual paths under disk
 * root (leading slash stripped — the archive is "rooted" at `/`).
 *
 * Import: caller uploads a ZIP buffer + target folder + conflict policy. We
 * walk every entry in the archive, prefix it under the target folder, and
 * write each via `FilesystemService.write()`. Conflict policy decides what
 * happens when a target path already exists:
 *   - `overwrite` → write through (uses normal upsert path; bumps version)
 *   - `skip`      → leave the existing file alone, count it as skipped
 *   - `rename`    → suffix the new file with ` (1)`, ` (2)`, … until free
 *
 * The service uses `FilesystemService.write()` for each file so existing
 * validation (path/extension allow-list, size cap, ancestor folder upsert,
 * audit, stats) stays in one place. Binary detection mirrors the multipart
 * upload path in `routes/filesystem.ts` — `isBinaryExtension(ext)` triggers
 * the `__b64__:` prefix.
 */
import nodePath from 'node:path'
import JSZip from 'jszip'
import type { FilesystemService } from './service.ts'
import {
  getFilesUnderFolder,
  getFileByPath,
  db,
  project_folders,
  eq,
  and,
  or,
  like,
} from '@jiku-studio/db'
import type { ProjectFile } from '@jiku-studio/db'
import { isBinaryExtension, isAllowedFile, normalizePath } from './utils.ts'
import { ValidationError } from './service.ts'

export type ConflictPolicy = 'overwrite' | 'skip' | 'rename'

export interface ImportResult {
  imported: number
  overwritten: number
  skipped: number
  renamed: number
  failed: number
  /** Count of platform-junk entries (macOS `__MACOSX/*` / `._*`, Windows `Thumbs.db`, etc.) dropped silently. */
  skipped_junk: number
  /** Count of folder entries created from archive directory markers (includes empty folders). */
  folders_created: number
  errors: Array<{ path: string; reason: string }>
}

// Hard cap on a single ZIP upload — prevents OOM from a malicious or
// unreasonably large archive. 50 MB matches "ten max-size files".
export const MAX_ZIP_BYTES = 50 * 1024 * 1024

// Hard cap on entries per archive — prevents zip-bomb-style attacks.
export const MAX_ZIP_ENTRIES = 5000

/**
 * Platform-emitted junk we silently drop during import.
 *
 *  - `__MACOSX/...`    — macOS AppleDouble resource forks added when zipping
 *                        on Finder / Archive Utility. Not real files; content
 *                        is binary and contains null bytes which Postgres TEXT
 *                        columns reject (reported bug 2026-04-15).
 *  - `.DS_Store`       — macOS Finder metadata.
 *  - `._<anything>`    — AppleDouble sibling files (same as __MACOSX but
 *                        emitted alongside the real file by older zippers).
 *  - `Thumbs.db`       — Windows Explorer thumbnail cache.
 *  - `desktop.ini`     — Windows folder-customization metadata.
 *
 * Matched against any path segment (so nested dotfiles are caught too).
 * Silent drop — not counted as imported/skipped/failed.
 */
function isPlatformJunk(entryPath: string): boolean {
  const segments = entryPath.split('/').filter(Boolean)
  if (segments.length === 0) return false
  if (segments[0] === '__MACOSX') return true
  return segments.some(seg =>
    seg === '.DS_Store' ||
    seg === 'Thumbs.db' ||
    seg === 'desktop.ini' ||
    seg.startsWith('._'),
  )
}

/**
 * Export a set of file/folder paths into a single ZIP buffer.
 * Paths can mix files and folders; folders expand to all files under them.
 * Empty result throws — the caller should validate selection first.
 */
export async function exportZipWith(
  fs: FilesystemService,
  projectId: string,
  paths: string[],
): Promise<{ buffer: Buffer; fileCount: number; folderCount: number }> {
  if (paths.length === 0) {
    throw new ValidationError('No paths selected for export')
  }
  const collected = new Map<string, ProjectFile>()
  const folderRoots: string[] = []
  for (const raw of paths) {
    const p = normalizePath(raw)
    const file = await getFileByPath(projectId, p)
    if (file) {
      collected.set(file.path, file)
      continue
    }
    const descendants = await getFilesUnderFolder(projectId, p)
    for (const f of descendants) collected.set(f.path, f)
    // Track folder roots so we can separately pull folder markers (including
    // empty subfolders) that `getFilesUnderFolder` wouldn't return.
    folderRoots.push(p)
  }

  // Collect folder entries under each folder root (including the root itself
  // if it's a real folder). This preserves empty subfolders in the archive;
  // non-empty ones are redundant with their files' implicit folder markers
  // but JSZip handles duplicates gracefully.
  const folderPaths = new Set<string>()
  for (const root of folderRoots) {
    if (root === '/') {
      // Exporting the whole disk — grab every folder row.
      const all = await db.select({ path: project_folders.path })
        .from(project_folders)
        .where(eq(project_folders.project_id, projectId))
      for (const r of all) folderPaths.add(r.path)
    } else {
      const rows = await db.select({ path: project_folders.path })
        .from(project_folders)
        .where(and(
          eq(project_folders.project_id, projectId),
          or(
            eq(project_folders.path, root),
            like(project_folders.path, `${root}/%`),
          ),
        ))
      for (const r of rows) folderPaths.add(r.path)
    }
  }

  if (collected.size === 0 && folderPaths.size === 0) {
    throw new ValidationError('No matching files or folders found for the selected paths')
  }

  const zip = new JSZip()

  // Folder markers first — entries with a trailing `/` are treated by JSZip
  // (and unzippers) as directory-only records.
  for (const folderPath of folderPaths) {
    const entryPath = folderPath.startsWith('/') ? folderPath.slice(1) : folderPath
    if (!entryPath) continue
    zip.folder(entryPath)
  }

  const files = Array.from(collected.values())
  await Promise.all(
    files.map(async (file) => {
      let bytes: Buffer | null = null
      if (file.content_cache?.startsWith('__b64__:')) {
        bytes = Buffer.from(file.content_cache.slice(8), 'base64')
      } else if (file.content_cache) {
        bytes = Buffer.from(file.content_cache, 'utf-8')
      } else {
        bytes = await fs.readBinary(file.path)
      }
      if (!bytes) return
      const entryPath = file.path.startsWith('/') ? file.path.slice(1) : file.path
      zip.file(entryPath, bytes)
    }),
  )

  const buffer = await zip.generateAsync({
    type: 'nodebuffer',
    compression: 'DEFLATE',
    compressionOptions: { level: 6 },
  })
  return { buffer, fileCount: files.length, folderCount: folderPaths.size }
}

/**
 * Import a ZIP archive into the project virtual disk under `targetFolder`.
 * Each entry is validated against the file allow-list / size cap before write.
 * Returns per-policy counters and a list of failures.
 */
export async function importZip(
  fs: FilesystemService,
  projectId: string,
  zipBuffer: Buffer,
  opts: { targetFolder: string; conflict: ConflictPolicy; userId?: string },
): Promise<ImportResult> {
  if (zipBuffer.length > MAX_ZIP_BYTES) {
    throw new ValidationError(`ZIP exceeds ${Math.round(MAX_ZIP_BYTES / (1024 * 1024))} MB limit`)
  }

  let zip: JSZip
  try {
    zip = await JSZip.loadAsync(zipBuffer)
  } catch {
    throw new ValidationError('Invalid ZIP file — could not parse archive')
  }

  // Split entries into directories and files. Directory entries (trailing
  // slash / `.dir === true`) are processed first so empty folders survive
  // the round-trip — otherwise only the files would import and empty dirs
  // would be silently dropped. Non-empty folders get implicit folder rows
  // from `upsertAncestorFolders` when their files are written; an explicit
  // mkdir on them is idempotent (onConflictDoNothing).
  const allEntries = Object.values(zip.files)
  const dirEntries = allEntries.filter(e => e.dir)
  const fileEntries = allEntries.filter(e => !e.dir)
  if (fileEntries.length === 0 && dirEntries.length === 0) {
    throw new ValidationError('ZIP archive contains no entries')
  }
  if (allEntries.length > MAX_ZIP_ENTRIES) {
    throw new ValidationError(`ZIP contains ${allEntries.length} entries — exceeds limit of ${MAX_ZIP_ENTRIES}`)
  }

  const result: ImportResult = {
    imported: 0, overwritten: 0, skipped: 0, renamed: 0, failed: 0, skipped_junk: 0, folders_created: 0, errors: [],
  }

  const targetRoot = normalizePath(opts.targetFolder || '/')

  // ─── Directory entries (including empty folders) ──────────────────────
  for (const entry of dirEntries) {
    const rawName = entry.name.replace(/\\/g, '/')
    if (rawName.split('/').some(seg => seg === '..' || seg.startsWith('..'))) {
      result.failed++
      result.errors.push({ path: rawName, reason: 'Path traversal segment rejected' })
      continue
    }
    if (isPlatformJunk(rawName)) {
      result.skipped_junk++
      continue
    }
    const relPath = rawName.replace(/^\/+/, '').replace(/\/+$/, '')
    if (!relPath) continue
    const targetPath = targetRoot === '/' ? `/${relPath}` : `${targetRoot}/${relPath}`
    const normalized = normalizePath(targetPath)
    try {
      await fs.mkdir(normalized)
      result.folders_created++
    } catch (err) {
      // mkdir rejects root; per-path failures shouldn't kill the whole import.
      result.failed++
      result.errors.push({
        path: normalized,
        reason: err instanceof Error ? err.message : 'mkdir failed',
      })
    }
  }

  // ─── File entries ──────────────────────────────────────────────────────
  for (const entry of fileEntries) {
    // Sanitize entry name — strip leading `/`, reject `..`, normalise.
    const rawName = entry.name.replace(/\\/g, '/')
    if (rawName.split('/').some(seg => seg === '..' || seg.startsWith('..'))) {
      result.failed++
      result.errors.push({ path: rawName, reason: 'Path traversal segment rejected' })
      continue
    }
    // Platform junk (macOS resource forks, .DS_Store, Thumbs.db, etc.) — drop
    // silently before the allow-list check so they don't surface as errors.
    // The AppleDouble "._" sibling files contain null bytes that Postgres TEXT
    // columns reject, so importing them would fail anyway.
    if (isPlatformJunk(rawName)) {
      result.skipped_junk++
      continue
    }
    const relPath = rawName.replace(/^\/+/, '')
    const targetPath = targetRoot === '/' ? `/${relPath}` : `${targetRoot}/${relPath}`
    const normalized = normalizePath(targetPath)

    const filename = nodePath.basename(normalized)
    const ext = nodePath.extname(filename).toLowerCase()

    let bytes: Buffer
    try {
      bytes = await entry.async('nodebuffer')
    } catch {
      result.failed++
      result.errors.push({ path: relPath, reason: 'Could not extract entry from archive' })
      continue
    }

    // Allow-list check (extension + size) before any write attempt — same
    // rules as multipart upload so the disk doesn't admit forbidden file
    // types via the import side-channel.
    const allowed = isAllowedFile(filename, bytes.length)
    if (!allowed.allowed) {
      result.failed++
      result.errors.push({ path: relPath, reason: allowed.reason ?? 'File rejected by allow-list' })
      continue
    }

    // Encode + defensive null-byte check BEFORE conflict resolution so we
    // don't have to roll back counters if the content is rejected.
    // Postgres TEXT columns reject `\u0000`; binary-mode extensions are base64
    // encoded so they can't carry null bytes in the stored string. For
    // text-mode extensions that somehow carry binary content (e.g. a `.csv`
    // that's actually a macOS resource fork slipping the junk filter), fail
    // fast with a readable error rather than a cryptic DB error.
    const isBinary = isBinaryExtension(ext)
    const content = isBinary
      ? `__b64__:${bytes.toString('base64')}`
      : bytes.toString('utf-8')
    if (!isBinary && content.includes('\u0000')) {
      result.failed++
      result.errors.push({
        path: relPath,
        reason: 'File contains null bytes — binary content in a text-mode extension',
      })
      continue
    }

    // Conflict resolution.
    let writePath = normalized
    const existing = await getFileByPath(projectId, normalized)
    if (existing) {
      if (opts.conflict === 'skip') {
        result.skipped++
        continue
      }
      if (opts.conflict === 'rename') {
        writePath = await findFreePath(projectId, normalized)
        result.renamed++
      } else {
        // overwrite — falls through to write; counts as overwritten
        result.overwritten++
      }
    } else {
      result.imported++
    }

    try {
      await fs.write(writePath, content, { userId: opts.userId })
    } catch (err) {
      // Roll back the counter we incremented above so the totals stay honest.
      if (existing) {
        if (opts.conflict === 'rename') result.renamed--
        else result.overwritten--
      } else {
        result.imported--
      }
      result.failed++
      result.errors.push({
        path: writePath,
        reason: err instanceof Error ? err.message : 'Write failed',
      })
    }
  }

  return result
}

/**
 * Find the next available path for the `rename` conflict policy.
 * `/foo/bar.md` with collision → `/foo/bar (1).md`, then `/foo/bar (2).md`, …
 * Caps at 999 attempts to avoid runaway loops on truly broken state.
 */
async function findFreePath(projectId: string, taken: string): Promise<string> {
  const dir = nodePath.dirname(taken)
  const ext = nodePath.extname(taken)
  const base = nodePath.basename(taken, ext)
  for (let i = 1; i < 1000; i++) {
    const candidate = dir === '/' ? `/${base} (${i})${ext}` : `${dir}/${base} (${i})${ext}`
    const norm = normalizePath(candidate)
    const exists = await getFileByPath(projectId, norm)
    if (!exists) return norm
  }
  throw new ValidationError(`Could not find a free name for ${taken} after 999 attempts`)
}
