import { Router } from 'express'
import { authMiddleware } from '../middleware/auth.ts'
import { resolveCaller } from '../runtime/caller.ts'
import { runtimeManager } from '../runtime/manager.ts'
import { getConversationById, getAgentById, getProjectById } from '@jiku-studio/db'
import { pipeUIMessageStreamToResponse } from 'ai'
import type { UIMessage } from 'ai'

const router = Router()
router.use(authMiddleware)

router.post('/conversations/:id/chat', async (req, res) => {
  const conversationId = req.params['id']!
  const userId = res.locals['user_id'] as string
  const { messages } = req.body as { messages: UIMessage[] }

  // Resolve all context from DB — never trust client-supplied IDs for auth
  const conversation = await getConversationById(conversationId)
  if (!conversation) { res.status(404).json({ error: 'Conversation not found' }); return }

  const agent = await getAgentById(conversation.agent_id)
  if (!agent) { res.status(404).json({ error: 'Agent not found' }); return }

  const project = await getProjectById(agent.project_id)
  if (!project) { res.status(404).json({ error: 'Project not found' }); return }

  // Resolve caller context (permissions, roles)
  let caller
  try {
    caller = await resolveCaller(userId, project.company_id, agent.id)
  } catch (err) {
    res.status(403).json({ error: err instanceof Error ? err.message : 'Access denied' })
    return
  }

  // Get input text from last user message
  const lastUser = [...messages].reverse().find(m => m.role === 'user')
  const lastPart = lastUser?.parts.find(p => p.type === 'text')
  const input = lastPart?.type === 'text' ? lastPart.text : ''
  if (!input) { res.status(400).json({ error: 'No input message found' }); return }

  let result
  try {
    result = await runtimeManager.run(agent.project_id, {
      agent_id: agent.id,
      caller,
      mode: 'chat',
      input,
      conversation_id: conversationId,
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error'
    console.error('[chat] runtimeManager.run error:', message)
    res.status(500).json({ error: message })
    return
  }

  // Pipe stream directly to Express response — clean and straightforward
  pipeUIMessageStreamToResponse({
    response: res,
    stream: result.stream as Parameters<typeof pipeUIMessageStreamToResponse>[0]['stream'],
  })
})

export { router as chatRouter }
