import { Hono } from 'hono'
import { getConversationsByAgent, createConversation } from '@jiku-studio/db'
import { authMiddleware } from '../middleware/auth.ts'
import type { AppVariables } from '../types.ts'

const router = new Hono<{ Variables: AppVariables }>()

router.use('*', authMiddleware)

router.get('/agents/:aid/conversations', async (c) => {
  const agentId = c.req.param('aid')
  const userId = c.get('user_id')
  const conversations = await getConversationsByAgent(agentId, userId)
  return c.json({ conversations })
})

router.post('/agents/:aid/conversations', async (c) => {
  const agentId = c.req.param('aid')
  const userId = c.get('user_id')
  const body = await c.req.json<{ mode?: string }>().catch(() => ({}))
  const conversation = await createConversation({
    agent_id: agentId,
    user_id: userId,
    mode: (body as { mode?: string }).mode ?? 'chat',
  })
  return c.json({ conversation }, 201)
})

export { router as conversationsRouter }
