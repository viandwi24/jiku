import { Router } from 'express'
import {
  listAuditLogs,
  getAuditLog,
  exportAuditLogs,
  type ListAuditLogParams,
} from '@jiku-studio/db'
import { authMiddleware } from '../middleware/auth.ts'
import { requirePermission } from '../middleware/permission.ts'

const router = Router()
router.use(authMiddleware)

function parseParams(query: Record<string, unknown>): ListAuditLogParams {
  const q = query as Record<string, string | undefined>
  const params: ListAuditLogParams = {}
  if (q['event_type']) params.eventType = q['event_type']
  if (q['actor_id']) params.actorId = q['actor_id']
  if (q['resource_type']) params.resourceType = q['resource_type']
  if (q['from']) {
    const d = new Date(q['from'])
    if (!Number.isNaN(d.getTime())) params.from = d
  }
  if (q['to']) {
    const d = new Date(q['to'])
    if (!Number.isNaN(d.getTime())) params.to = d
  }
  return params
}

/** GET /api/projects/:pid/audit-logs — paginated list */
router.get('/projects/:pid/audit-logs', requirePermission('settings:read'), async (req, res) => {
  const projectId = req.params['pid'] as string
  const q = req.query as Record<string, string | undefined>
  const page = Math.max(parseInt(q['page'] ?? '0', 10) || 0, 0)
  const perPage = Math.min(Math.max(parseInt(q['per_page'] ?? '20', 10) || 20, 1), 200)

  const params: ListAuditLogParams = {
    projectId,
    ...parseParams(req.query as Record<string, unknown>),
    limit: perPage,
    offset: page * perPage,
  }

  const { rows, total } = await listAuditLogs(params)
  res.json({ logs: rows, total, page, per_page: perPage })
})

/** GET /api/projects/:pid/audit-logs/export — CSV download */
router.get('/projects/:pid/audit-logs/export', requirePermission('settings:read'), async (req, res) => {
  const projectId = req.params['pid'] as string
  const params: ListAuditLogParams = {
    projectId,
    ...parseParams(req.query as Record<string, unknown>),
  }
  const rows = await exportAuditLogs(params)

  const headers = [
    'created_at', 'event_type', 'actor_id', 'actor_name', 'actor_email',
    'resource_type', 'resource_id', 'resource_name', 'ip_address', 'metadata',
  ]
  const esc = (v: unknown) => {
    if (v === null || v === undefined) return ''
    const s = typeof v === 'string' ? v : JSON.stringify(v)
    return s.includes(',') || s.includes('"') || s.includes('\n')
      ? `"${s.replace(/"/g, '""')}"`
      : s
  }
  const lines = [headers.join(',')]
  for (const r of rows) {
    lines.push([
      r.created_at.toISOString(),
      r.event_type,
      r.actor_id ?? '',
      r.actor?.name ?? '',
      r.actor?.email ?? '',
      r.resource_type,
      r.resource_id ?? '',
      r.resource_name ?? '',
      r.ip_address ?? '',
      esc(r.metadata),
    ].map(esc).join(','))
  }

  res.setHeader('Content-Type', 'text/csv; charset=utf-8')
  res.setHeader('Content-Disposition', `attachment; filename="audit-${projectId}-${Date.now()}.csv"`)
  res.send(lines.join('\n'))
})

/** GET /api/projects/:pid/audit-logs/:id — single entry detail */
router.get('/projects/:pid/audit-logs/:id', requirePermission('settings:read'), async (req, res) => {
  const log = await getAuditLog(req.params['id'] as string)
  if (!log) { res.status(404).json({ error: 'Audit log not found' }); return }
  if (log.project_id !== req.params['pid']) {
    res.status(404).json({ error: 'Audit log not found' }); return
  }
  res.json({ log })
})

export { router as auditRouter }
