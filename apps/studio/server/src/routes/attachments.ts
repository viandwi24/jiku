import { Router } from 'express'
import { authMiddleware, verifyJwt } from '../middleware/auth.ts'
import { requirePermission } from '../middleware/permission.ts'
import { getFilesystemService } from '../filesystem/service.ts'
import {
  createAttachment,
  getAttachmentById,
  listAttachmentsByProject,
  deleteAttachment,
  getAgentById,
} from '@jiku-studio/db'
import { createHmac, randomUUID } from 'crypto'
import { env } from '../env.ts'
import busboy from 'busboy'
import { uploadRateLimit } from '../middleware/rate-limit.ts'

const router = Router()

// ─── Token helpers ────────────────────────────────────────────────────────────
// Short-lived HMAC token for proxy URL. No DB lookup needed.
// Format: {storageKey}|{expiresAt} — signed with JWT_SECRET.

const TOKEN_TTL_MS = 60 * 60 * 1000 // 1 hour

function signProxyToken(storageKey: string): string {
  const expiresAt = Date.now() + TOKEN_TTL_MS
  const payload = `${storageKey}|${expiresAt}`
  const sig = createHmac('sha256', env.JWT_SECRET).update(payload).digest('hex')
  return Buffer.from(`${payload}|${sig}`).toString('base64url')
}

function verifyProxyToken(token: string): string | null {
  try {
    const decoded = Buffer.from(token, 'base64url').toString('utf-8')
    const parts = decoded.split('|')
    if (parts.length !== 3) return null
    const [storageKey, expiresAtStr, sig] = parts
    if (Date.now() > Number(expiresAtStr)) return null
    const payload = `${storageKey}|${expiresAtStr}`
    const expected = createHmac('sha256', env.JWT_SECRET).update(payload).digest('hex')
    if (sig !== expected) return null
    return storageKey
  } catch {
    return null
  }
}

// ─── Upload ───────────────────────────────────────────────────────────────────
// POST /projects/:pid/attachments/upload
// Multipart upload. Returns { attachment_id, storage_key, proxy_url }.

router.post('/projects/:pid/attachments/upload', uploadRateLimit, authMiddleware, requirePermission('chats:create'), async (req, res) => {
  const projectId = req.params['pid']
  const userId = res.locals['user_id'] as string
  const { agent_id, conversation_id } = req.query as { agent_id?: string; conversation_id?: string }

  const fs = await getFilesystemService(projectId)
  if (!fs) {
    res.status(400).json({ error: 'Filesystem not configured for this project. Set up storage in Disk → Storage Config first.' })
    return
  }
  const adapter = fs.getAdapter()

  let agentScope: 'per_user' | 'shared' = 'per_user'
  if (agent_id) {
    const agent = await getAgentById(agent_id)
    if (agent) agentScope = (agent.attachment_scope ?? 'per_user') as 'per_user' | 'shared'
  }

  // Parse multipart
  const bb = busboy({ headers: req.headers, limits: { fileSize: 20 * 1024 * 1024 } }) // 20 MB max
  const uploads: Array<Promise<{
    attachment_id: string
    storage_key: string
    filename: string
    mime_type: string
    size_bytes: number
  }>> = []

  bb.on('file', (fieldname, stream, info) => {
    const { filename, mimeType } = info
    const ext = filename.split('.').pop() ?? 'bin'
    const convSegment = conversation_id ?? '_'
    const storageKey = `jiku/attachments/${projectId}/${convSegment}/${randomUUID()}.${ext}`

    const chunks: Buffer[] = []
    stream.on('data', (chunk: Buffer) => chunks.push(chunk))

    const uploadPromise = new Promise<{
      attachment_id: string
      storage_key: string
      filename: string
      mime_type: string
      size_bytes: number
    }>((resolve, reject) => {
      stream.on('end', async () => {
        try {
          const buffer = Buffer.concat(chunks)
          await adapter.upload(storageKey, buffer, mimeType)

          const record = await createAttachment({
            project_id: projectId,
            agent_id: agent_id ?? null,
            conversation_id: conversation_id ?? null,
            user_id: userId,
            storage_key: storageKey,
            filename: filename || 'attachment',
            mime_type: mimeType,
            size_bytes: buffer.length,
            scope: agentScope,
          })

          resolve({
            attachment_id: record.id,
            storage_key: storageKey,
            filename: record.filename,
            mime_type: record.mime_type,
            size_bytes: record.size_bytes,
          })
        } catch (err) {
          reject(err)
        }
      })
      stream.on('error', reject)
    })

    uploads.push(uploadPromise)
  })

  bb.on('finish', async () => {
    try {
      const results = await Promise.all(uploads)
      res.json({ attachments: results })
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Upload failed' })
    }
  })

  bb.on('error', (err: unknown) => {
    res.status(400).json({ error: err instanceof Error ? err.message : 'Parse error' })
  })

  req.pipe(bb)
})

// ─── List ─────────────────────────────────────────────────────────────────────
// GET /projects/:pid/attachments

router.get('/projects/:pid/attachments', authMiddleware, requirePermission('chats:read'), async (req, res) => {
  const projectId = req.params['pid']
  const limit = Math.min(Number(req.query['limit'] ?? 50), 100)
  const offset = Number(req.query['offset'] ?? 0)
  const attachments = await listAttachmentsByProject(projectId, { limit, offset })
  res.json({ attachments })
})

// ─── Delete ───────────────────────────────────────────────────────────────────
// DELETE /projects/:pid/attachments/:id

router.delete('/projects/:pid/attachments/:id', authMiddleware, requirePermission('chats:create'), async (req, res) => {
  const projectId = req.params['pid']
  const id = req.params['id']

  const record = await getAttachmentById(id)
  if (!record || record.project_id !== projectId) {
    res.status(404).json({ error: 'Attachment not found' })
    return
  }

  const fs = await getFilesystemService(projectId)
  if (fs) {
    await fs.getAdapter().delete(record.storage_key).catch(() => {})
  }

  await deleteAttachment(id)
  res.json({ success: true })
})

// ─── Proxy token ─────────────────────────────────────────────────────────────
// POST /projects/:pid/attachments/:id/token
// Returns a short-lived signed token to use in proxy URL.

router.post('/projects/:pid/attachments/:id/token', authMiddleware, requirePermission('chats:read'), async (req, res) => {
  const projectId = req.params['pid']
  const id = req.params['id']

  const record = await getAttachmentById(id)
  if (!record || record.project_id !== projectId) {
    res.status(404).json({ error: 'Attachment not found' })
    return
  }

  const token = signProxyToken(record.storage_key)
  res.json({ token, expires_in: TOKEN_TTL_MS / 1000 })
})

// ─── Inline serve (auth-gated, for in-app rendering) ─────────────────────────
// GET /api/attachments/:id/inline?token=:jwt
// Serves the file directly. Uses JWT token in query string so <img src> works.

router.get('/attachments/:id/inline', async (req, res) => {
  const id = req.params['id']
  const token = req.query['token'] as string | undefined

  if (!token) { res.status(401).json({ error: 'Missing token' }); return }

  const payload = await verifyJwt(token)
  if (!payload) { res.status(401).json({ error: 'Invalid token' }); return }

  const record = await getAttachmentById(id)
  if (!record) { res.status(404).json({ error: 'Attachment not found' }); return }

  const fs = await getFilesystemService(record.project_id)
  if (!fs) { res.status(503).json({ error: 'Storage not configured' }); return }

  try {
    const { stream, contentType, contentLength } = await fs.getAdapter().getStream(record.storage_key)
    res.setHeader('Content-Type', contentType)
    res.setHeader('Cache-Control', 'private, max-age=3600')
    if (contentLength) res.setHeader('Content-Length', contentLength)
    ;(stream as NodeJS.ReadableStream).pipe(res)
  } catch {
    res.status(404).json({ error: 'File not found' })
  }
})

// ─── Proxy serve (public-ish, token-gated) ────────────────────────────────────
// GET /files/view?key=:storageKey&token=:token
// No authMiddleware — uses HMAC token instead so model providers can fetch it.

router.get('/files/view', async (req, res) => {
  const { key, token } = req.query as { key?: string; token?: string }
  if (!key || !token) { res.status(400).json({ error: 'Missing key or token' }); return }

  const verified = verifyProxyToken(token)
  if (!verified || verified !== key) {
    res.status(401).json({ error: 'Invalid or expired token' })
    return
  }

  // Find a filesystem service for any project that owns this key.
  // key format: jiku/attachments/{projectId}/...
  const projectId = key.split('/')[2]
  if (!projectId) { res.status(400).json({ error: 'Malformed key' }); return }

  const fs = await getFilesystemService(projectId)
  if (!fs) { res.status(503).json({ error: 'Storage not configured' }); return }

  try {
    const { stream, contentType, contentLength } = await fs.getAdapter().getStream(key)
    res.setHeader('Content-Type', contentType)
    res.setHeader('Cache-Control', 'private, max-age=3600')
    if (contentLength) res.setHeader('Content-Length', contentLength)
    ;(stream as NodeJS.ReadableStream).pipe(res)
  } catch {
    res.status(404).json({ error: 'File not found' })
  }
})

export const attachmentsRouter = router
export { signProxyToken, verifyProxyToken }
