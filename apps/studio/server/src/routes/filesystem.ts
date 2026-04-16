import { Router } from 'express'
import nodePath from 'node:path'
import busboy from 'busboy'
import { authMiddleware } from '../middleware/auth.ts'
import { requirePermission, requireAnyPermission } from '../middleware/permission.ts'
import {
  getFilesystemConfig,
  upsertFilesystemConfig,
  getFileByPath,
  getAllProjectFiles,
  deleteAllProjectFiles,
  updateFilesystemStats,
  resolveFsToolPermission,
  setFsToolPermission,
} from '@jiku-studio/db'
import { audit, auditContext } from '../audit/logger.ts'
import {
  getFilesystemService,
  testFilesystemConnection,
  migrateFilesystemAdapter,
  NotFoundError,
  ValidationError,
  ConflictError,
} from '../filesystem/service.ts'
import { invalidateFilesystemCache } from '../filesystem/factory.ts'
import { runtimeManager } from '../runtime/manager.ts'
import {
  normalizePath,
  isAllowedFile,
  getMimeType,
  isBinaryExtension,
  getMaxSizeForExtension,
  MAX_UPLOAD_BYTES,
} from '../filesystem/utils.ts'
import { uploadRateLimit } from '../middleware/rate-limit.ts'

const router = Router()
router.use(authMiddleware)

// ─── Helpers ──────────────────────────────────────────────────────────────────

function handleFsError(res: import('express').Response, err: unknown) {
  if (err instanceof NotFoundError) return res.status(404).json({ error: err.message })
  if (err instanceof ValidationError) return res.status(422).json({ error: err.message })
  if (err instanceof ConflictError) return res.status(409).json({ error: err.message })
  console.error('[filesystem]', err)
  return res.status(500).json({ error: 'Internal server error' })
}

// ─── Config ───────────────────────────────────────────────────────────────────

// GET /projects/:pid/filesystem/config
// Readable by `disk:read` too — the Disk page needs this to know if the
// virtual disk is configured at all. The returned fields (adapter_id,
// credential_id uuid, enabled) are not sensitive; secrets live in the
// credential record and are only readable via the credential service.
router.get('/projects/:pid/filesystem/config', requireAnyPermission('disk:read', 'settings:read'), async (req, res) => {
  const projectId = req.params['pid']!
  const config = await getFilesystemConfig(projectId)
  res.json({ config: config ?? null })
})

// PATCH /projects/:pid/filesystem/config
// If adapter_id or credential_id changes while files exist, returns migration_needed=true.
// Client should show a migration modal before applying the change.
router.patch('/projects/:pid/filesystem/config', requirePermission('settings:write'), async (req, res) => {
  const projectId = req.params['pid']!
  const body = req.body as { adapter_id?: string; credential_id?: string | null; enabled?: boolean }
  try {
    const existing = await getFilesystemConfig(projectId)

    // Detect if the storage adapter is being switched (has existing config + existing files)
    const adapterChanged = (
      body.adapter_id !== undefined && body.adapter_id !== existing?.adapter_id
    ) || (
      body.credential_id !== undefined && body.credential_id !== existing?.credential_id
    )

    if (adapterChanged && existing?.credential_id) {
      // Check if there are existing files to migrate
      const files = await getAllProjectFiles(projectId)
      if (files.length > 0) {
        const totalBytes = files.reduce((sum, f) => sum + (f.size_bytes ?? 0), 0)
        return res.json({
          config: existing,
          migration_needed: true,
          file_count: files.length,
          total_size_bytes: totalBytes,
          pending_adapter_id: body.adapter_id,
          pending_credential_id: body.credential_id,
        })
      }
    }

    const config = await upsertFilesystemConfig(projectId, {
      ...(body.adapter_id !== undefined ? { adapter_id: body.adapter_id } : {}),
      ...(body.credential_id !== undefined ? { credential_id: body.credential_id } : {}),
      ...(body.enabled !== undefined ? { enabled: body.enabled } : {}),
    })
    // Invalidate the cached FilesystemService (credential/adapter may have changed)
    invalidateFilesystemCache(projectId)
    // Sync project tools so agents pick up filesystem changes immediately
    runtimeManager.syncProjectTools(projectId).catch(() => {})
    return res.json({ config, migration_needed: false })
  } catch (err) {
    return handleFsError(res, err)
  }
})

// POST /projects/:pid/filesystem/test
router.post('/projects/:pid/filesystem/test', requireAnyPermission('disk:read', 'settings:read'), async (req, res) => {
  const projectId = req.params['pid']!
  const result = await testFilesystemConnection(projectId)
  res.json(result)
})

// ─── File listing & content ───────────────────────────────────────────────────

// GET /projects/:pid/files?path=/src
router.get('/projects/:pid/files', requirePermission('disk:read'), async (req, res) => {
  const projectId = req.params['pid']!
  const folderPath = (req.query['path'] as string) ?? '/'

  try {
    const fs = await getFilesystemService(projectId)
    if (!fs) return res.status(503).json({ error: 'Filesystem is not configured for this project' })
    const entries = await fs.list(folderPath)
    return res.json({ entries, count: entries.length })
  } catch (err) {
    return handleFsError(res, err)
  }
})

// GET /projects/:pid/files/content?path=/src/index.ts
router.get('/projects/:pid/files/content', requirePermission('disk:read'), async (req, res) => {
  const projectId = req.params['pid']!
  const filePath = (req.query['path'] as string)
  if (!filePath) return res.status(400).json({ error: 'path query param required' })

  try {
    const fs = await getFilesystemService(projectId)
    if (!fs) return res.status(503).json({ error: 'Filesystem not configured' })
    const result = await fs.read(filePath)
    return res.json({
      path: normalizePath(filePath),
      content: result.content,
      version: result.version,
      cached: result.cached,
    })
  } catch (err) {
    return handleFsError(res, err)
  }
})

// GET /projects/:pid/files/search?q=&ext=
router.get('/projects/:pid/files/search', requirePermission('disk:read'), async (req, res) => {
  const projectId = req.params['pid']!
  const query = (req.query['q'] as string) ?? ''
  const ext = req.query['ext'] as string | undefined

  try {
    const fs = await getFilesystemService(projectId)
    if (!fs) return res.status(503).json({ error: 'Filesystem not configured' })
    const files = await fs.search(query, ext)
    return res.json({ files, count: files.length })
  } catch (err) {
    return handleFsError(res, err)
  }
})

// ─── Proxy / streaming ────────────────────────────────────────────────────────
// GET /projects/:pid/files/proxy?path=/src/index.ts[&mode=inline|download|preview]
//
// mode=inline   (default)  — serves with Content-Disposition: inline
// mode=download            — forces browser download
// mode=preview             — same as inline but sets cache headers

router.get('/projects/:pid/files/proxy', requirePermission('disk:read'), async (req, res) => {
  const projectId = req.params['pid']!
  const filePath = (req.query['path'] as string)
  const mode = (req.query['mode'] as string) ?? 'inline'

  if (!filePath) return res.status(400).json({ error: 'path query param required' })

  try {
    const config = await getFilesystemConfig(projectId)
    if (!config?.enabled || !config.credential_id) {
      return res.status(503).json({ error: 'Filesystem not configured' })
    }

    // Re-use the file record from DB for metadata
    const normalized = normalizePath(filePath)
    const fileRecord = await getFileByPath(projectId, normalized)
    if (!fileRecord) return res.status(404).json({ error: 'File not found' })

    // Build adapter directly for streaming (no content buffering)
    const { getCredentialById } = await import('@jiku-studio/db')
    const { decryptFields } = await import('../credentials/encryption.ts')
    const { buildS3Adapter } = await import('../filesystem/adapter.ts')

    const cred = await getCredentialById(config.credential_id)
    if (!cred || !cred.fields_encrypted) return res.status(503).json({ error: 'Credential unavailable' })

    const fields = decryptFields(cred.fields_encrypted)
    const metadata = (cred.metadata ?? {}) as Record<string, string>
    const adapter = buildS3Adapter(fields, metadata)

    const { stream, contentType, contentLength } = await adapter.getStream(fileRecord.storage_key)

    const filename = nodePath.basename(normalized)
    const disposition = mode === 'download'
      ? `attachment; filename="${filename}"`
      : `inline; filename="${filename}"`

    res.setHeader('Content-Type', fileRecord.mime_type || contentType)
    res.setHeader('Content-Disposition', disposition)
    if (contentLength !== undefined) res.setHeader('Content-Length', contentLength)

    if (mode === 'preview') {
      res.setHeader('Cache-Control', 'public, max-age=60')
    } else {
      res.setHeader('Cache-Control', 'no-cache')
    }

    // Pipe the readable stream into the response
    // @aws-sdk/client-s3 Body in Node.js is a Readable
    const readable = stream as import('node:stream').Readable
    readable.pipe(res)
    readable.on('error', () => {
      if (!res.headersSent) res.status(500).end()
    })
    return
  } catch (err) {
    return handleFsError(res, err)
  }
})

// ─── Write / create ───────────────────────────────────────────────────────────

// POST /projects/:pid/files  { path, content }
router.post('/projects/:pid/files', requirePermission('disk:write'), async (req, res) => {
  const projectId = req.params['pid']!
  const { path: filePath, content } = req.body as { path: string; content: string }

  if (!filePath || content === undefined) {
    return res.status(400).json({ error: 'path and content are required' })
  }

  try {
    const fs = await getFilesystemService(projectId)
    if (!fs) return res.status(503).json({ error: 'Filesystem not configured' })
    const file = await fs.write(filePath, content)
    return res.status(201).json({ file })
  } catch (err) {
    return handleFsError(res, err)
  }
})

// ─── Create folder ───────────────────────────────────────────────────────────

// POST /projects/:pid/files/folder  { path }
router.post('/projects/:pid/files/folder', requirePermission('disk:write'), async (req, res) => {
  const projectId = req.params['pid']!
  const { path: folderPath } = req.body as { path: string }

  if (!folderPath) return res.status(400).json({ error: 'path is required' })

  try {
    const fs = await getFilesystemService(projectId)
    if (!fs) return res.status(503).json({ error: 'Filesystem not configured' })
    await fs.mkdir(folderPath)
    return res.status(201).json({ ok: true, path: folderPath })
  } catch (err) {
    return handleFsError(res, err)
  }
})

// ─── Move ─────────────────────────────────────────────────────────────────────

// PATCH /projects/:pid/files/move  { from, to }
router.patch('/projects/:pid/files/move', requirePermission('disk:write'), async (req, res) => {
  const projectId = req.params['pid']!
  const { from, to } = req.body as { from: string; to: string }

  if (!from || !to) return res.status(400).json({ error: 'from and to are required' })

  try {
    const fs = await getFilesystemService(projectId)
    if (!fs) return res.status(503).json({ error: 'Filesystem not configured' })
    await fs.move(from, to)
    return res.json({ ok: true, from, to })
  } catch (err) {
    return handleFsError(res, err)
  }
})

// ─── Delete ───────────────────────────────────────────────────────────────────

// DELETE /projects/:pid/files?path=/x
router.delete('/projects/:pid/files', requirePermission('disk:write'), async (req, res) => {
  const projectId = req.params['pid']!
  const filePath = req.query['path'] as string
  if (!filePath) return res.status(400).json({ error: 'path query param required' })

  try {
    const fs = await getFilesystemService(projectId)
    if (!fs) return res.status(503).json({ error: 'Filesystem not configured' })
    await fs.delete(filePath)
    return res.json({ ok: true })
  } catch (err) {
    return handleFsError(res, err)
  }
})

// DELETE /projects/:pid/files/folder?path=/src
router.delete('/projects/:pid/files/folder', requirePermission('disk:write'), async (req, res) => {
  const projectId = req.params['pid']!
  const folderPath = req.query['path'] as string
  if (!folderPath) return res.status(400).json({ error: 'path query param required' })

  try {
    const fs = await getFilesystemService(projectId)
    if (!fs) return res.status(503).json({ error: 'Filesystem not configured' })
    const deleted = await fs.deleteFolder(folderPath)
    return res.json({ ok: true, deleted })
  } catch (err) {
    return handleFsError(res, err)
  }
})

// ─── Upload (multipart) ───────────────────────────────────────────────────────

// POST /projects/:pid/files/upload
router.post('/projects/:pid/files/upload', uploadRateLimit, requirePermission('disk:write'), (req, res) => {
  const projectId = req.params['pid']!
  const folderPath = normalizePath((req.query['path'] as string) ?? '/')

  let settled = false
  function done(code: number, body: unknown) {
    if (settled) return
    settled = true
    res.status(code).json(body)
  }

  getFilesystemService(projectId).then(fs => {
    if (!fs) return done(503, { error: 'Filesystem not configured' })

    const bb = busboy({ headers: req.headers, limits: { fileSize: MAX_UPLOAD_BYTES + 1 } })
    const uploads: Array<Promise<{ file: import('@jiku-studio/db').ProjectFile }>> = []

    bb.on('file', (_fieldname, fileStream, info) => {
      const filename = nodePath.basename(info.filename)
      const ext = nodePath.extname(filename).toLowerCase()
      const filePath = folderPath === '/' ? `/${filename}` : `${folderPath}/${filename}`
      const maxBytes = getMaxSizeForExtension(ext)

      const chunks: Buffer[] = []
      let size = 0
      let tooBig = false

      fileStream.on('data', (chunk: Buffer) => {
        size += chunk.length
        if (size > maxBytes) { tooBig = true; fileStream.resume(); return }
        chunks.push(chunk)
      })

      uploads.push(new Promise((resolve, reject) => {
        fileStream.on('end', async () => {
          if (tooBig) {
            const capMb = Math.round(maxBytes / (1024 * 1024))
            return reject(new ValidationError(`File exceeds ${capMb} MB limit for "${ext}" files`))
          }
          const content = Buffer.concat(chunks)
          const check = isAllowedFile(filename, content.length)
          if (!check.allowed) return reject(new ValidationError(check.reason!))
          try {
            // Binary formats (images, video, audio, office docs, pdf, zip) are
            // stored base64-encoded so they survive the text-oriented write
            // pipeline. Text / script files go through as UTF-8.
            const textContent = isBinaryExtension(ext)
              ? `__b64__:${content.toString('base64')}`
              : content.toString('utf-8')
            const file = await fs.write(filePath, textContent)
            resolve({ file })
          } catch (err) {
            reject(err)
          }
        })
      }))
    })

    bb.on('finish', async () => {
      try {
        const results = await Promise.all(uploads)
        done(201, { files: results.map(r => r.file) })
      } catch (err) {
        if (err instanceof ValidationError) done(422, { error: err.message })
        else done(500, { error: 'Upload failed' })
      }
    })

    bb.on('error', () => done(500, { error: 'Upload parsing failed' }))
    req.pipe(bb)
  }).catch(() => done(500, { error: 'Internal server error' }))
})

// ─── Export to ZIP ────────────────────────────────────────────────────────────

// POST /projects/:pid/files/export-zip  body: { paths: string[] }
// Returns the archive as application/zip with a Content-Disposition filename.
// Paths may mix files and folders; folders expand to descendants.
router.post('/projects/:pid/files/export-zip', requirePermission('disk:read'), async (req, res) => {
  const projectId = req.params['pid']!
  const body = req.body as { paths?: string[] }
  const paths = Array.isArray(body?.paths) ? body.paths.filter(p => typeof p === 'string') : []
  if (paths.length === 0) return res.status(400).json({ error: 'paths array required (non-empty)' })

  try {
    const fs = await getFilesystemService(projectId)
    if (!fs) return res.status(503).json({ error: 'Filesystem not configured' })
    const { exportZipWith } = await import('../filesystem/zip.ts')
    const { buffer, fileCount, folderCount } = await exportZipWith(fs, projectId, paths)

    const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, '')
    const filename = `disk-export-${stamp}.zip`
    res.setHeader('Content-Type', 'application/zip')
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`)
    res.setHeader('Content-Length', String(buffer.length))
    res.setHeader('X-File-Count', String(fileCount))
    res.setHeader('X-Folder-Count', String(folderCount))
    return res.end(buffer)
  } catch (err) {
    return handleFsError(res, err)
  }
})

// ─── Import from ZIP ──────────────────────────────────────────────────────────

// POST /projects/:pid/files/import-zip?path=/&conflict=overwrite|skip|rename
// Body: multipart with a single `file` field (the archive). Returns counts +
// per-file failure list so the UI can summarise.
router.post('/projects/:pid/files/import-zip', uploadRateLimit, requirePermission('disk:write'), (req, res) => {
  const projectId = req.params['pid']!
  const targetFolder = normalizePath((req.query['path'] as string) ?? '/')
  const conflictRaw = (req.query['conflict'] as string) ?? 'skip'
  const conflict = (['overwrite', 'skip', 'rename'].includes(conflictRaw) ? conflictRaw : 'skip') as 'overwrite' | 'skip' | 'rename'
  const userId = (res.locals['user_id'] as string | undefined) ?? undefined

  let settled = false
  function done(code: number, body: unknown) {
    if (settled) return
    settled = true
    res.status(code).json(body)
  }

  getFilesystemService(projectId).then(fs => {
    if (!fs) return done(503, { error: 'Filesystem not configured' })

    // Reuse the global upload byte cap as the ZIP byte cap so we don't admit
    // a ZIP larger than the largest single file we'd otherwise accept. The
    // zip helper enforces its own MAX_ZIP_BYTES too — whichever is smaller
    // wins.
    const bb = busboy({ headers: req.headers, limits: { fileSize: MAX_UPLOAD_BYTES + 1 } })
    let zipBuffer: Buffer | null = null
    let tooBig = false

    bb.on('file', (_field, fileStream, _info) => {
      const chunks: Buffer[] = []
      let size = 0
      fileStream.on('data', (chunk: Buffer) => {
        size += chunk.length
        if (size > MAX_UPLOAD_BYTES) { tooBig = true; fileStream.resume(); return }
        chunks.push(chunk)
      })
      fileStream.on('end', () => {
        if (!tooBig) zipBuffer = Buffer.concat(chunks)
      })
    })

    bb.on('finish', async () => {
      if (tooBig) return done(413, { error: `ZIP exceeds ${Math.round(MAX_UPLOAD_BYTES / (1024 * 1024))} MB limit` })
      if (!zipBuffer) return done(400, { error: 'Missing ZIP file in form-data (expected field "file")' })
      try {
        const { importZip } = await import('../filesystem/zip.ts')
        const result = await importZip(fs, projectId, zipBuffer, { targetFolder, conflict, userId })
        return done(200, { ok: true, target_folder: targetFolder, conflict, ...result })
      } catch (err) {
        if (err instanceof ValidationError) return done(422, { error: err.message })
        console.error('[filesystem.import-zip]', err)
        return done(500, { error: err instanceof Error ? err.message : 'Import failed' })
      }
    })

    bb.on('error', () => done(500, { error: 'Upload parsing failed' }))
    req.pipe(bb)
  }).catch(() => done(500, { error: 'Internal server error' }))
})

// ─── Migration ────────────────────────────────────────────────────────────────

// POST /projects/:pid/filesystem/migrate
// Body: { credential_id, adapter_id, action: 'migrate' | 'reset' }
// Plan 16: 'migrate' is now async — returns { job_id } immediately.
// 'reset' is still synchronous (just deletes DB rows).
router.post('/projects/:pid/filesystem/migrate', requirePermission('settings:write'), async (req, res) => {
  const projectId = req.params['pid']!
  const body = req.body as {
    credential_id: string
    adapter_id: string
    action: 'migrate' | 'reset'
  }

  if (!body.credential_id || !body.adapter_id || !body.action) {
    return res.status(400).json({ error: 'credential_id, adapter_id, and action are required' })
  }

  try {
    if (body.action === 'migrate') {
      // Plan 16: async migration — create job row, fire and forget
      const { db: dbClient, filesystem_migrations, getFilesystemConfig: getFsCfg } = await import('@jiku-studio/db')
      const { runFilesystemMigration } = await import('../filesystem/migration-job.ts')

      const oldConfig = await getFsCfg(projectId)
      const [migration] = await dbClient.insert(filesystem_migrations).values({
        project_id: projectId,
        from_credential_id: oldConfig?.credential_id ?? null,
        to_credential_id: body.credential_id,
      }).returning()

      // Update config immediately so the project uses the new adapter
      await upsertFilesystemConfig(projectId, {
        adapter_id: body.adapter_id,
        credential_id: body.credential_id,
      })
      invalidateFilesystemCache(projectId)
      runtimeManager.syncProjectTools(projectId).catch(() => {})

      // Run migration in background
      runFilesystemMigration(migration.id).catch(err =>
        console.error(`[fs-migration] background job failed:`, err),
      )

      return res.json({ ok: true, job_id: migration.id, status: 'pending' })
    } else {
      // Reset — synchronous, just wipe
      const deleted = await deleteAllProjectFiles(projectId)
      const config = await upsertFilesystemConfig(projectId, {
        adapter_id: body.adapter_id,
        credential_id: body.credential_id,
      })
      await updateFilesystemStats(projectId)
      invalidateFilesystemCache(projectId)
      runtimeManager.syncProjectTools(projectId).catch(() => {})
      return res.json({ ok: true, config, deleted })
    }
  } catch (err) {
    return handleFsError(res, err)
  }
})

// GET /projects/:pid/filesystem/migrate/:id — poll migration progress
router.get('/projects/:pid/filesystem/migrate/:id', requirePermission('settings:read'), async (req, res) => {
  try {
    const { db: dbClient, filesystem_migrations } = await import('@jiku-studio/db')
    const { eq } = await import('drizzle-orm')
    const migration = await dbClient.query.filesystem_migrations.findFirst({
      where: eq(filesystem_migrations.id, req.params['id']!),
    })
    if (!migration) {
      return res.status(404).json({ error: 'Migration not found' })
    }
    return res.json({
      id: migration.id,
      status: migration.status,
      total_files: migration.total_files,
      migrated_files: migration.migrated_files,
      failed_files: migration.failed_files,
      error_message: migration.error_message,
      started_at: migration.started_at,
      completed_at: migration.completed_at,
    })
  } catch (err) {
    return handleFsError(res, err)
  }
})

// ─── Plan 26 — FS tool permission ─────────────────────────────────────────────

// GET /projects/:pid/files/permission?path=/plans
router.get('/projects/:pid/files/permission', requirePermission('disk:read'), async (req, res) => {
  const projectId = req.params['pid']!
  const p = req.query['path'] as string
  if (!p) return res.status(400).json({ error: 'path query param required' })
  const resolved = await resolveFsToolPermission(projectId, p)
  return res.json(resolved)
})

// PATCH /projects/:pid/files/permission  body: { path, type: 'file'|'folder', permission: 'read'|'read+write'|null }
router.patch('/projects/:pid/files/permission', requirePermission('disk:write'), async (req, res) => {
  const projectId = req.params['pid']!
  const body = req.body as { path?: string; type?: 'file' | 'folder'; permission?: 'read' | 'read+write' | null }
  if (!body.path) return res.status(400).json({ error: 'path required' })
  if (body.type !== 'file' && body.type !== 'folder') return res.status(400).json({ error: "type must be 'file' or 'folder'" })
  const perm = body.permission === null ? null : body.permission
  if (perm !== null && perm !== 'read' && perm !== 'read+write') {
    return res.status(400).json({ error: "permission must be 'read', 'read+write', or null" })
  }
  await setFsToolPermission(projectId, body.path, perm, body.type)
  audit.fsPermissionSet(
    { ...auditContext(req), project_id: projectId },
    body.path,
    { type: body.type, permission: perm },
  )
  const resolved = await resolveFsToolPermission(projectId, body.path)
  return res.json({ ok: true, resolved })
})

export { router as filesystemRouter }
