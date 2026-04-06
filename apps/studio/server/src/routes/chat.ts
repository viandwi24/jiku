import { Router } from 'express'
import { authMiddleware } from '../middleware/auth.ts'
import { resolveCaller } from '../runtime/caller.ts'
import { runtimeManager } from '../runtime/manager.ts'
import { streamRegistry } from '../runtime/stream-registry.ts'
import { getConversationById, getAgentById, getProjectById, createUsageLog } from '@jiku-studio/db'
import { resolveAgentModel } from '../credentials/service.ts'
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

  // Resolve model snapshot for usage log (non-blocking, best-effort)
  const modelInfo = await resolveAgentModel(agent.id).catch(() => null)
  const snapshotProviderId = modelInfo?.adapter_id ?? null
  const snapshotModelId = modelInfo?.model_id ?? null

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

  // Register run and get broadcast/buffer/done handles
  const { broadcast, bufferChunk, done } = streamRegistry.startRun(conversationId)

  // Tee the stream: one branch for the original caller, one for broadcasting + buffering
  const [callerStream, broadcastStream] = result.stream.tee()

  // Drain broadcast branch in background — buffer chunks + forward to SSE observers
  ;(async () => {
    let runSnapshot: { system_prompt: string; messages: unknown[] } | null = null
    try {
      const reader = broadcastStream.getReader()
      while (true) {
        const { done: streamDone, value } = await reader.read()
        if (streamDone) break
        // Accumulate in memory for polling consumers
        bufferChunk(value as Record<string, unknown>)
        // Forward to SSE observers
        const line = `data: ${JSON.stringify(value)}\n\n`
        broadcast(line)

        const chunk = value as Record<string, unknown>
        // Buffer the raw snapshot so it's available when usage arrives
        if (chunk?.type === 'data-jiku-run-snapshot') {
          runSnapshot = chunk.data as { system_prompt: string; messages: unknown[] }
        }
        // Persist usage log when we see the final usage chunk
        if (chunk?.type === 'data-jiku-usage') {
          const data = (chunk.data as { input_tokens?: number; output_tokens?: number } | undefined)
          if (data) {
            createUsageLog({
              agent_id: agent.id,
              conversation_id: conversationId,
              user_id: userId,
              mode: 'chat',
              provider_id: snapshotProviderId,
              model_id: snapshotModelId,
              input_tokens: data.input_tokens ?? 0,
              output_tokens: data.output_tokens ?? 0,
              raw_system_prompt: runSnapshot?.system_prompt ?? null,
              raw_messages: runSnapshot?.messages ?? null,
            }).catch(err => console.error('[chat] Failed to persist usage log:', err))
          }
        }
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

/**
 * GET /conversations/:id/live-parts
 * Returns the in-memory chunk buffer for an active run — for polling observers.
 * Returns { running: false } if no active run (stream finished or never started).
 * Consumers should poll this at ~500ms and stop when running=false, then reload messages from DB.
 */
router.get('/conversations/:id/live-parts', async (req, res) => {
  const conversationId = String(req.params['id'])
  const buffer = streamRegistry.getBuffer(conversationId)
  if (buffer === null) {
    res.json({ running: false, chunks: [] })
    return
  }
  res.json({ running: true, chunks: buffer })
})

export { router as chatRouter }
