import { Router } from 'express'
import type { Request, Response, NextFunction } from 'express'
import { listActionRequests, listActionRequestEvents } from '@jiku-studio/db'
import type { ActionRequestStatusValue } from '@jiku-studio/db'
import { authMiddleware } from '../middleware/auth.ts'
import { requirePermission } from '../middleware/permission.ts'
import {
  createActionRequest,
  getActionRequest,
  respondToActionRequest,
  dropActionRequest,
  ActionRequestError,
} from '../action-requests/service.ts'
import { attachProjectActionRequestStream } from '../action-requests/sse-hub.ts'
import type {
  ActionRequestType,
  ActionRequestSpec,
  ActionRequestSourceRef,
  ActionRequestDestinationRef,
  ActionRequestDestinationType,
  ActionRequestResponse,
} from '@jiku/types'

const router = Router()
router.use(authMiddleware)

async function resolveARProject(req: Request, res: Response, next: NextFunction) {
  const id = req.params['id'] as string
  const ar = await getActionRequest(id)
  if (!ar) { res.status(404).json({ error: 'Action request not found' }); return }
  res.locals['project_id'] = ar.project_id
  res.locals['action_request'] = ar
  next()
}

// ── List + Stream ────────────────────────────────────────────────────────────

router.get('/projects/:pid/action-requests', requirePermission('action_requests:read'), async (req, res) => {
  const projectId = req.params['pid'] as string
  const q = req.query as Record<string, string | undefined>
  const statusParam = typeof q['status'] === 'string' ? q['status'] : undefined
  const status = statusParam ? (statusParam.split(',') as ActionRequestStatusValue[]) : undefined
  const items = await listActionRequests({
    project_id: projectId,
    status: status && status.length === 1 ? status[0] : status,
    agent_id: q['agent_id'] || undefined,
    type: q['type'] || undefined,
    limit: q['limit'] ? Number(q['limit']) : undefined,
    offset: q['offset'] ? Number(q['offset']) : undefined,
  })
  res.json({ items })
})

router.get('/projects/:pid/action-requests/stream', requirePermission('action_requests:read'), (req, res) => {
  const teardown = attachProjectActionRequestStream(req.params['pid'] as string, res)
  req.on('close', teardown)
})

// ── Single AR ────────────────────────────────────────────────────────────────

router.get('/action-requests/:id', resolveARProject, requirePermission('action_requests:read'), async (_req, res) => {
  const ar = res.locals['action_request']
  const events = await listActionRequestEvents(ar.id)
  res.json({ action_request: ar, events })
})

// ── Create (manual / admin) ──────────────────────────────────────────────────

interface CreateBody {
  agent_id?: string
  conversation_id?: string
  task_id?: string
  type: ActionRequestType
  title: string
  description?: string
  context?: Record<string, unknown>
  spec: ActionRequestSpec
  source_type?: 'manual'
  source_ref?: ActionRequestSourceRef
  destination_type?: ActionRequestDestinationType | null
  destination_ref?: ActionRequestDestinationRef | null
  expires_in_seconds?: number
}

router.post('/projects/:pid/action-requests', requirePermission('action_requests:write'), async (req, res) => {
  const projectId = req.params['pid'] as string
  const body = req.body as CreateBody
  const userId = res.locals['user_id'] as string | undefined
  if (!body || !body.type || !body.title || !body.spec) {
    res.status(400).json({ error: 'type, title, spec required' }); return
  }
  try {
    const ar = await createActionRequest({
      project_id: projectId,
      agent_id: body.agent_id ?? null,
      conversation_id: body.conversation_id ?? null,
      task_id: body.task_id ?? null,
      type: body.type,
      title: body.title,
      description: body.description ?? null,
      context: body.context ?? {},
      spec: body.spec,
      source_type: body.source_type ?? 'manual',
      source_ref: body.source_ref ?? { kind: 'manual', created_by: userId ?? 'system' },
      destination_type: body.destination_type ?? null,
      destination_ref: body.destination_ref ?? null,
      expires_in_seconds: body.expires_in_seconds ?? null,
      created_by: userId ?? null,
      actor_id: userId ?? null,
      actor_type: 'user',
    })
    res.status(201).json({ action_request: ar })
  } catch (err) {
    if (err instanceof ActionRequestError) {
      res.status(400).json({ error: err.message, code: err.code }); return
    }
    throw err
  }
})

// ── Respond ──────────────────────────────────────────────────────────────────

router.post('/action-requests/:id/respond', resolveARProject, requirePermission('action_requests:respond'), async (req, res) => {
  const id = req.params['id'] as string
  const userId = res.locals['user_id'] as string | undefined
  const body = req.body as { response: ActionRequestResponse }
  if (!body || !body.response) { res.status(400).json({ error: 'response required' }); return }
  try {
    const ar = await respondToActionRequest({
      id,
      response: body.response,
      responder_id: userId ?? null,
      actor_type: 'user',
      ip_address: req.ip ?? null,
      user_agent: req.get('user-agent') ?? null,
    })
    res.json({ action_request: ar })
  } catch (err) {
    if (err instanceof ActionRequestError) {
      const status = err.code === 'not_found' ? 404 : err.code === 'not_pending' ? 409 : 400
      res.status(status).json({ error: err.message, code: err.code }); return
    }
    throw err
  }
})

router.post('/action-requests/:id/drop', resolveARProject, requirePermission('action_requests:respond'), async (req, res) => {
  const id = req.params['id'] as string
  const userId = res.locals['user_id'] as string | undefined
  const body = req.body as { reason?: string } | undefined
  try {
    const ar = await dropActionRequest({
      id,
      responder_id: userId ?? null,
      actor_type: 'user',
      reason: body?.reason,
      ip_address: req.ip ?? null,
      user_agent: req.get('user-agent') ?? null,
    })
    res.json({ action_request: ar })
  } catch (err) {
    if (err instanceof ActionRequestError) {
      const status = err.code === 'not_found' ? 404 : err.code === 'not_pending' ? 409 : 400
      res.status(status).json({ error: err.message, code: err.code }); return
    }
    throw err
  }
})

export { router as actionRequestsRouter }
