import { Router } from 'express'
import { getConversationsByAgent, createConversation, getConversationsByProject, getConversationWithAgent, getMessages, getAgentById, getProjectById, updateConversationTitle, softDeleteConversation, getConversationById, getActivePath, getLatestLeafInSubtree, setActiveTip, getMessageById } from '@jiku-studio/db'
import { runtimeManager } from '../runtime/manager.ts'
import { resolveCaller } from '../runtime/caller.ts'
import { streamRegistry } from '../runtime/stream-registry.ts'
import { pipeUIMessageStreamToResponse } from 'ai'
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
  // Plan 23 — prefer active branch path with sibling metadata. Falls back
  // to the flat list when the conversation has no tip set (legacy/empty).
  const convRow = await getConversationById(req.params['id']!)
  if (convRow?.active_tip_message_id) {
    const messages = await getActivePath(req.params['id']!)
    res.json({
      conversation_id: convRow.id,
      active_tip_message_id: convRow.active_tip_message_id,
      messages,
    })
    return
  }
  const messages = await getMessages(req.params['id']!)
  res.json({
    conversation_id: req.params['id']!,
    active_tip_message_id: convRow?.active_tip_message_id ?? null,
    messages,
  })
})

// ─── Plan 23 — branch navigation endpoints ───────────────────────────────────

/**
 * GET /conversations/:id/sibling-tip?sibling_id=<msg_id>
 * Walk down from `sibling_id` along the highest-branch_index child at each
 * step to find the latest leaf (ADR-064). Used by the UI before switching.
 */
router.get('/conversations/:id/sibling-tip', async (req, res) => {
  const convId = req.params['id']!
  const siblingId = String(req.query['sibling_id'] ?? '')
  if (!siblingId) { res.status(400).json({ error: 'sibling_id required' }); return }

  const sibling = await getMessageById(siblingId)
  if (!sibling || sibling.conversation_id !== convId) {
    res.status(404).json({ error: 'Sibling not found in this conversation' }); return
  }
  const tip = await getLatestLeafInSubtree(siblingId)
  res.json({ tip_message_id: tip })
})

/**
 * PATCH /conversations/:id/active-tip
 * Body: { tip_message_id: string }
 * Switches the active branch tip and returns the new active path.
 */
router.patch('/conversations/:id/active-tip', async (req, res) => {
  const convId = req.params['id']!
  const { tip_message_id } = req.body as { tip_message_id?: string }
  if (!tip_message_id) { res.status(400).json({ error: 'tip_message_id required' }); return }

  if (streamRegistry.isRunning(convId)) {
    res.status(503).json({ error: 'conversation_running', message: 'Cannot switch branch while a run is in progress.' }); return
  }

  const tip = await getMessageById(tip_message_id)
  if (!tip || tip.conversation_id !== convId) {
    res.status(400).json({ error: 'Invalid tip_message_id for this conversation' }); return
  }

  await setActiveTip(convId, tip_message_id)
  const messages = await getActivePath(convId)
  res.json({ ok: true, active_tip_message_id: tip_message_id, messages })
})

/**
 * POST /conversations/:id/regenerate
 * Body: { user_message_id: string }
 * Re-runs the model using `user_message_id` as the active tip so the new
 * assistant response is saved as a sibling of the previous reply.
 */
router.post('/conversations/:id/regenerate', async (req, res) => {
  const convId = req.params['id']!
  const userId = res.locals['user_id'] as string
  const { user_message_id } = req.body as { user_message_id?: string }
  if (!user_message_id) { res.status(400).json({ error: 'user_message_id required' }); return }

  if (streamRegistry.isRunning(convId)) {
    res.status(409).json({ error: 'conversation_running', message: 'Already processing — please wait.' }); return
  }

  const conv = await getConversationById(convId)
  if (!conv) { res.status(404).json({ error: 'Conversation not found' }); return }

  const userMsg = await getMessageById(user_message_id)
  if (!userMsg || userMsg.conversation_id !== convId || userMsg.role !== 'user') {
    res.status(400).json({ error: 'Invalid user_message_id' }); return
  }

  const agent = await getAgentById(conv.agent_id)
  if (!agent) { res.status(404).json({ error: 'Agent not found' }); return }

  const project = await getProjectById(agent.project_id)
  if (!project) { res.status(404).json({ error: 'Project not found' }); return }
  let caller
  try {
    caller = await resolveCaller(userId, project.company_id, agent.id)
  } catch (err) {
    res.status(403).json({ error: err instanceof Error ? err.message : 'Access denied' }); return
  }

  // Point active tip at the user message so the runner loads the path ending
  // at it and the new assistant message becomes a sibling of existing replies.
  await setActiveTip(convId, user_message_id)

  // Extract the user text for `input` (runner still needs the string).
  const parts = (userMsg.parts as Array<{ type: string; text?: string }> | null) ?? []
  const textPart = parts.find(p => p.type === 'text')
  const input = textPart?.text ?? ''

  let result
  try {
    result = await runtimeManager.run(agent.project_id, {
      agent_id: agent.id,
      caller,
      mode: 'chat',
      input,
      conversation_id: convId,
      parent_message_id: user_message_id,
      regenerate: true,
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error'
    res.status(500).json({ error: message }); return
  }

  const { broadcast, bufferChunk, done } = streamRegistry.startRun(convId)
  const [callerStream, broadcastStream] = result.stream.tee()
  ;(async () => {
    try {
      const reader = broadcastStream.getReader()
      while (true) {
        const { done: streamDone, value } = await reader.read()
        if (streamDone) break
        bufferChunk(value as Record<string, unknown>)
        broadcast(`data: ${JSON.stringify(value)}\n\n`)
      }
    } finally { done() }
  })()

  pipeUIMessageStreamToResponse({
    response: res,
    stream: callerStream as Parameters<typeof pipeUIMessageStreamToResponse>[0]['stream'],
  })
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

router.patch('/conversations/:id/title', async (req, res) => {
  const convId = req.params['id']!
  const { title } = (req.body ?? {}) as { title?: string }

  if (!title || typeof title !== 'string' || title.trim().length === 0) {
    res.status(400).json({ error: 'title is required and must be a non-empty string' })
    return
  }
  if (title.trim().length > 255) {
    res.status(400).json({ error: 'title must be 255 characters or fewer' })
    return
  }

  const conversation = await getConversationWithAgent(convId)
  if (!conversation) { res.status(404).json({ error: 'Conversation not found' }); return }

  const agent = await getAgentById(conversation.agent_id)
  if (agent) {
    res.locals['project_id'] = agent.project_id
    const result = await loadPerms(req, res)
    if (result && !result.resolved.granted) { res.status(403).json({ error: 'Not a member' }); return }
    if (result && !result.resolved.isSuperadmin && !result.resolved.permissions.includes('chats:create')) {
      res.status(403).json({ error: 'Missing permission: chats:create' }); return
    }
  }

  await updateConversationTitle(convId, title.trim())
  res.json({ ok: true })
})

router.delete('/conversations/:id', async (req, res) => {
  const convId = req.params['id']!
  const conversation = await getConversationWithAgent(convId)
  if (!conversation) { res.status(404).json({ error: 'Conversation not found' }); return }

  const agent = await getAgentById(conversation.agent_id)
  if (agent) {
    res.locals['project_id'] = agent.project_id
    const result = await loadPerms(req, res)
    if (result && !result.resolved.granted) { res.status(403).json({ error: 'Not a member' }); return }
    if (result && !result.resolved.isSuperadmin && !result.resolved.permissions.includes('chats:create')) {
      res.status(403).json({ error: 'Missing permission: chats:create' }); return
    }
  }

  await softDeleteConversation(convId)
  res.json({ ok: true })
})

export { router as conversationsRouter }
