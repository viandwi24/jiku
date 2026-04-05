import { Router } from 'express'
import { authMiddleware } from '../middleware/auth.ts'
import { resolveCaller } from '../runtime/caller.ts'
import { runtimeManager } from '../runtime/manager.ts'
import { streamRegistry } from '../runtime/stream-registry.ts'
import { getConversationById, getAgentById, getProjectById } from '@jiku-studio/db'
import { pipeUIMessageStreamToResponse } from 'ai'
import type { UIMessage } from 'ai'

const router = Router()

// POST /chat requires full auth
router.post('/conversations/:id/chat', authMiddleware, async (req, res) => {
  const conversationId = String(req.params['id'])
  const userId = res.locals['user_id'] as string
  const { messages } = req.body as { messages: UIMessage[] }

  // Reject if already running
  if (streamRegistry.isRunning(conversationId)) {
    res.status(409).json({ error: 'conversation_running', message: 'This conversation is already processing a message. Please wait.' })
    return
  }

  const conversation = await getConversationById(conversationId)
  if (!conversation) { res.status(404).json({ error: 'Conversation not found' }); return }

  const agent = await getAgentById(conversation.agent_id)
  if (!agent) { res.status(404).json({ error: 'Agent not found' }); return }

  const project = await getProjectById(agent.project_id)
  if (!project) { res.status(404).json({ error: 'Project not found' }); return }

  let caller
  try {
    caller = await resolveCaller(userId, project.company_id, agent.id)
  } catch (err) {
    res.status(403).json({ error: err instanceof Error ? err.message : 'Access denied' })
    return
  }

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

  // Register run and get broadcast/done handles
  const { broadcast, done } = streamRegistry.startRun(conversationId)

  // Tee the stream: one branch for the original caller, one for broadcasting
  const [callerStream, broadcastStream] = result.stream.tee()

  // Drain broadcast branch in background — forward raw bytes to observers
  ;(async () => {
    try {
      const reader = broadcastStream.getReader()
      while (true) {
        const { done: streamDone, value } = await reader.read()
        if (streamDone) break
        // Serialize the chunk as SSE data line
        const line = `data: ${JSON.stringify(value)}\n\n`
        broadcast(line)
      }
    } finally {
      done()
    }
  })()

  // Pipe caller branch directly to response
  pipeUIMessageStreamToResponse({
    response: res,
    stream: callerStream as Parameters<typeof pipeUIMessageStreamToResponse>[0]['stream'],
  })
})

/**
 * GET /conversations/:id/stream
 * SSE endpoint for observers — attach to an in-progress run.
 * Returns 404 if no run is active for this conversation.
 */
router.get('/conversations/:id/stream', async (req, res) => {
  const conversationId = String(req.params['id'])

  if (!streamRegistry.isRunning(conversationId)) {
    res.status(404).json({ error: 'no_active_run', message: 'No active run for this conversation.' })
    return
  }

  res.setHeader('Content-Type', 'text/event-stream')
  res.setHeader('Cache-Control', 'no-cache')
  res.setHeader('Connection', 'keep-alive')
  res.flushHeaders()

  streamRegistry.subscribe(conversationId, res)
})

/**
 * GET /conversations/:id/status
 * Check whether a conversation currently has an active run.
 */
router.get('/conversations/:id/status', async (req, res) => {
  const conversationId = String(req.params['id'])
  res.json({ running: streamRegistry.isRunning(conversationId) })
})

export { router as chatRouter }
