import { Router } from 'express'
import nodePath from 'node:path'
import busboy from 'busboy'
import { authMiddleware } from '../middleware/auth.ts'
import { requirePermission } from '../middleware/permission.ts'
import {
  getFilesystemConfig,
  upsertFilesystemConfig,
  getFileByPath,
  getAllProjectFiles,
  deleteAllProjectFiles,
  updateFilesystemStats,
} from '@jiku-studio/db'
import {
  getFilesystemService,
  testFilesystemConnection,
  migrateFilesystemAdapter,
  NotFoundError,
  ValidationError,
  ConflictError,
} from '../filesystem/service.ts'
import { runtimeManager } from '../runtime/manager.ts'
import { normalizePath, isAllowedFile, getMimeType } from '../filesystem/utils.ts'

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
router.get('/projects/:pid/filesystem/config', requirePermission('settings:read'), async (req, res) => {
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
    // Sync project tools so agents pick up filesystem changes immediately
    runtimeManager.syncProjectTools(projectId).catch(() => {})
    return res.json({ config, migration_needed: false })
  } catch (err) {
    return handleFsError(res, err)
  }
})

// POST /projects/:pid/filesystem/test
router.post('/projects/:pid/filesystem/test', requirePermission('settings:read'), async (req, res) => {
  const projectId = req.params['pid']!
  const result = await testFilesystemConnection(projectId)
  res.json(result)
})

// ─── File listing & content ───────────────────────────────────────────────────

// GET /projects/:pid/files?path=/src
router.get('/projects/:pid/files', requirePermission('agents:read'), async (req, res) => {
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
router.get('/projects/:pid/files/content', requirePermission('agents:read'), async (req, res) => {
  const projectId = req.params['pid']!
  const filePath = (req.query['path'] as string)
  if (!filePath) return res.status(400).json({ error: 'path query param required' })

  try {
    const fs = await getFilesystemService(projectId)
    if (!fs) return res.status(503).json({ error: 'Filesystem not configured' })
    const content = await fs.read(filePath)
    return res.json({ path: normalizePath(filePath), content })
  } catch (err) {
    return handleFsError(res, err)
  }
})

// GET /projects/:pid/files/search?q=&ext=
router.get('/projects/:pid/files/search', requirePermission('agents:read'), async (req, res) => {
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

router.get('/projects/:pid/files/proxy', requirePermission('agents:read'), async (req, res) => {
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
router.post('/projects/:pid/files', requirePermission('agents:read'), async (req, res) => {
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

// ─── Move ─────────────────────────────────────────────────────────────────────

// PATCH /projects/:pid/files/move  { from, to }
router.patch('/projects/:pid/files/move', requirePermission('agents:read'), async (req, res) => {
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
router.delete('/projects/:pid/files', requirePermission('agents:read'), async (req, res) => {
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
router.delete('/projects/:pid/files/folder', requirePermission('agents:read'), async (req, res) => {
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
router.post('/projects/:pid/files/upload', requirePermission('agents:read'), (req, res) => {
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

    const bb = busboy({ headers: req.headers, limits: { fileSize: 5 * 1024 * 1024 + 1 } })
    const uploads: Array<Promise<{ file: import('@jiku-studio/db').ProjectFile }>> = []

    bb.on('file', (_fieldname, fileStream, info) => {
      const filename = nodePath.basename(info.filename)
      const ext = nodePath.extname(filename).toLowerCase()
      const filePath = folderPath === '/' ? `/${filename}` : `${folderPath}/${filename}`

      const chunks: Buffer[] = []
      let size = 0
      let tooBig = false

      fileStream.on('data', (chunk: Buffer) => {
        size += chunk.length
        if (size > 5 * 1024 * 1024) { tooBig = true; fileStream.resume(); return }
        chunks.push(chunk)
      })

      uploads.push(new Promise((resolve, reject) => {
        fileStream.on('end', async () => {
          if (tooBig) return reject(new ValidationError('File exceeds 5 MB limit'))
          const content = Buffer.concat(chunks)
          const check = isAllowedFile(filename, content.length)
          if (!check.allowed) return reject(new ValidationError(check.reason!))
          try {
            const file = await fs.write(filePath, content.toString('utf-8'))
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

// ─── Migration ────────────────────────────────────────────────────────────────

// POST /projects/:pid/filesystem/migrate
// Body: { credential_id, adapter_id, action: 'migrate' | 'reset' }
// Copies all files to new adapter (or resets DB), then applies new config.
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
    let config, result
    if (body.action === 'migrate') {
      result = await migrateFilesystemAdapter(projectId, body.credential_id, body.adapter_id)
      config = await upsertFilesystemConfig(projectId, {
        adapter_id: body.adapter_id,
        credential_id: body.credential_id,
      })
    } else {
      const deleted = await deleteAllProjectFiles(projectId)
      config = await upsertFilesystemConfig(projectId, {
        adapter_id: body.adapter_id,
        credential_id: body.credential_id,
      })
      await updateFilesystemStats(projectId)
      result = { migrated: 0, failed: 0, errors: [], deleted }
    }
    // Sync project tools so agents pick up new adapter immediately
    runtimeManager.syncProjectTools(projectId).catch(() => {})
    return res.json({ ok: true, config, ...result })
  } catch (err) {
    return handleFsError(res, err)
  }
})

export { router as filesystemRouter }
