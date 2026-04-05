import { Router } from 'express'
import { getConversationsByAgent, createConversation, getConversationsByProject, getConversationWithAgent, getMessages } from '@jiku-studio/db'
import { authMiddleware } from '../middleware/auth.ts'

const router = Router()
router.use(authMiddleware)

router.get('/projects/:pid/conversations', async (req, res) => {
  const userId = res.locals['user_id'] as string
  const conversations = await getConversationsByProject(req.params['pid']!, userId)
  res.json({ conversations })
})

router.get('/conversations/:id', async (req, res) => {
  const conversation = await getConversationWithAgent(req.params['id']!)
  if (!conversation) { res.status(404).json({ error: 'Conversation not found' }); return }
  res.json({ conversation })
})

router.get('/conversations/:id/messages', async (req, res) => {
  const messages = await getMessages(req.params['id']!)
  res.json({ messages })
})

router.get('/agents/:aid/conversations', async (req, res) => {
  const userId = res.locals['user_id'] as string
  const conversations = await getConversationsByAgent(req.params['aid']!, userId)
  res.json({ conversations })
})

router.post('/agents/:aid/conversations', async (req, res) => {
  const userId = res.locals['user_id'] as string
  const agentId = req.params['aid']!
  const { mode } = (req.body ?? {}) as { mode?: string }

  const conversation = await createConversation({
    agent_id: agentId,
    user_id: userId,
    mode: mode ?? 'chat',
  })
  res.status(201).json({ conversation })
})

export { router as conversationsRouter }
