import { Router } from 'express'
import { listRunsByProject, updateConversation, getConversationById } from '@jiku-studio/db'
import { authMiddleware } from '../middleware/auth.ts'

const router = Router()
router.use(authMiddleware)

// GET /projects/:pid/runs — list all conversations for a project (paginated)
router.get('/projects/:pid/runs', async (req, res) => {
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
  res.json({ conversation: conv })
})

// POST /conversations/:id/cancel — cancel a running task/heartbeat
router.post('/conversations/:id/cancel', async (req, res) => {
  const conv = await getConversationById(req.params['id']!)
  if (!conv) { res.status(404).json({ error: 'Conversation not found' }); return }

  if (conv.run_status !== 'running' && conv.run_status !== 'idle') {
    res.status(400).json({ error: `Cannot cancel conversation in status "${conv.run_status}"` })
    return
  }

  await updateConversation(conv.id, {
    run_status: 'cancelled',
    finished_at: new Date(),
  })

  res.json({ ok: true })
})

export { router as runsRouter }
