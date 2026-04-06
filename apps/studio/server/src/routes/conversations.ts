import { Router } from 'express'
import { getConversationsByAgent, createConversation, getConversationsByProject, getConversationWithAgent, getMessages, getAgentById } from '@jiku-studio/db'
import { authMiddleware } from '../middleware/auth.ts'
import { requirePermission, loadPerms } from '../middleware/permission.ts'

const router = Router()
router.use(authMiddleware)

router.get('/projects/:pid/conversations', requirePermission('chats:read'), async (req, res) => {
  const userId = res.locals['user_id'] as string
  const conversations = await getConversationsByProject(req.params['pid']!, userId)
  res.json({ conversations })
})

router.get('/conversations/:id', async (req, res) => {
  const conversation = await getConversationWithAgent(req.params['id']!)
  if (!conversation) { res.status(404).json({ error: 'Conversation not found' }); return }
  // Resolve project from agent for permission check
  const agent = await getAgentById(conversation.agent_id)
  if (agent) {
    res.locals['project_id'] = agent.project_id
    const result = await loadPerms(req, res)
    if (result && result.resolved.granted && (result.resolved.isSuperadmin || result.resolved.permissions.includes('chats:read'))) {
      res.json({ conversation }); return
    } else if (result && !result.resolved.granted) {
      res.status(403).json({ error: 'Not a member' }); return
    } else if (result && !result.resolved.isSuperadmin && !result.resolved.permissions.includes('chats:read')) {
      res.status(403).json({ error: 'Missing permission: chats:read' }); return
    }
  }
  res.json({ conversation })
})

router.get('/conversations/:id/messages', async (req, res) => {
  const conversation = await getConversationWithAgent(req.params['id']!)
  if (!conversation) { res.status(404).json({ error: 'Conversation not found' }); return }
  // Resolve project from agent for permission check
  const agent = await getAgentById(conversation.agent_id)
  if (agent) {
    res.locals['project_id'] = agent.project_id
    const result = await loadPerms(req, res)
    if (!result) { res.status(400).json({ error: 'Project context required' }); return }
    if (!result.resolved.granted) { res.status(403).json({ error: 'Not a member' }); return }
    if (!result.resolved.isSuperadmin && !result.resolved.permissions.includes('chats:read')) {
      res.status(403).json({ error: 'Missing permission: chats:read' }); return
    }
  }
  const messages = await getMessages(req.params['id']!)
  res.json({ messages })
})

router.get('/agents/:aid/conversations', requirePermission('chats:read'), async (req, res) => {
  const userId = res.locals['user_id'] as string
  const conversations = await getConversationsByAgent(req.params['aid']!, userId)
  res.json({ conversations })
})

router.post('/agents/:aid/conversations', requirePermission('chats:create'), async (req, res) => {
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
