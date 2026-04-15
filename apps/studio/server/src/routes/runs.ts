import { Router } from 'express'
import { listRunsByProject, updateConversation, getConversationById, getAgentById } from '@jiku-studio/db'
import { authMiddleware } from '../middleware/auth.ts'
import { requirePermission, loadPerms } from '../middleware/permission.ts'
import { streamRegistry } from '../runtime/stream-registry.ts'

const router = Router()
router.use(authMiddleware)

// GET /projects/:pid/runs — list all conversations for a project (paginated)
router.get('/projects/:pid/runs', requirePermission('runs:read'), async (req, res) => {
  const projectId = req.params['pid']!
  const q = req.query as Record<string, string>

  const result = await listRunsByProject({
    project_id: projectId,
    type: q['type'],
    agent_id: q['agent_id'],
    run_status: q['run_status'],
    page: q['page'] ? parseInt(q['page'], 10) : 1,
    per_page: q['per_page'] ? parseInt(q['per_page'], 10) : 20,
    sort: (q['sort'] as 'created_at' | 'started_at' | 'finished_at') || 'created_at',
    order: (q['order'] as 'asc' | 'desc') || 'desc',
  })

  res.json(result)
})

// GET /conversations/:id — get a single conversation by ID
router.get('/conversations/:id', async (req, res) => {
  const conv = await getConversationById(req.params['id']!)
  if (!conv) { res.status(404).json({ error: 'Conversation not found' }); return }
  const agent = await getAgentById(conv.agent_id)
  if (agent) {
    res.locals['project_id'] = agent.project_id
    const result = await loadPerms(req, res)
    if (!result) { res.status(400).json({ error: 'Project context required' }); return }
    if (!result.resolved.granted) { res.status(403).json({ error: 'Not a member' }); return }
    if (!result.resolved.isSuperadmin && !result.resolved.permissions.includes('runs:read')) {
      res.status(403).json({ error: 'Missing permission: runs:read' }); return
    }
  }
  res.json({ conversation: conv })
})

// POST /conversations/:id/cancel — cancel a running conversation.
//
// Permission model:
//   chat runs: ONLY the original caller (conv.caller_id === userId) or a
//     project superadmin. Plain `runs:cancel` is NOT enough — chat streams
//     are personal; letting any team member stop someone else's chat would
//     be a foot-gun / abuse vector.
//   task + heartbeat runs: caller (if any) or superadmin or member with
//     `runs:cancel`. These are typically autonomous or cron-triggered so a
//     team perm makes sense for ops (stopping runaway tasks).
//
// Effect:
//   Sets run_status='cancelled' + finished_at=now() in DB.
//   Calls streamRegistry.abort() so the active reader loop unwinds and the
//   LLM stream stops (chat path only — task/heartbeat runners don't register
//   with streamRegistry yet; for those the DB label still wins and the
//   runner will observe it on its next DB poll, but the current iteration
//   may finish before observing the flag. Future: register task runs too).
router.post('/conversations/:id/cancel', async (req, res) => {
  const userId = res.locals['user_id'] as string
  const conv = await getConversationById(req.params['id']!)
  if (!conv) { res.status(404).json({ error: 'Conversation not found' }); return }
  const agent = await getAgentById(conv.agent_id)
  if (!agent) { res.status(404).json({ error: 'Agent not found' }); return }

  res.locals['project_id'] = agent.project_id
  const result = await loadPerms(req, res)
  if (!result) { res.status(400).json({ error: 'Project context required' }); return }
  if (!result.resolved.granted) { res.status(403).json({ error: 'Not a member' }); return }

  const { resolved } = result
  const isOwner = conv.caller_id !== null && conv.caller_id === userId
  const isSuperadmin = resolved.isSuperadmin
  const hasRunsCancel = resolved.permissions.includes('runs:cancel')

  // chat: owner-only (or superadmin). runs:cancel does NOT apply.
  // task/heartbeat: owner OR superadmin OR runs:cancel.
  const isChat = conv.type === 'chat'
  const authorized = isChat
    ? (isOwner || isSuperadmin)
    : (isOwner || isSuperadmin || hasRunsCancel)

  if (!authorized) {
    const msg = isChat
      ? 'Chat runs can only be cancelled by the user who started them.'
      : 'Missing permission: requires runs:cancel, ownership, or superadmin.'
    res.status(403).json({ error: msg })
    return
  }

  if (conv.run_status !== 'running' && conv.run_status !== 'idle') {
    res.status(400).json({ error: `Cannot cancel conversation in status "${conv.run_status}"` })
    return
  }

  // Flip DB status first so subsequent writes (e.g. the stream's finally
  // block) don't race us back to 'completed'.
  await updateConversation(conv.id, {
    run_status: 'cancelled',
    finished_at: new Date(),
  })

  // Signal the active stream to stop. No-op if no active run.
  streamRegistry.abort(conv.id)

  res.json({ ok: true })
})

export { router as runsRouter }
