import { Router } from 'express'
import { authMiddleware } from '../middleware/auth.ts'
import { requirePermission, loadPerms } from '../middleware/permission.ts'
import { resolveCaller } from '../runtime/caller.ts'
import { runtimeManager } from '../runtime/manager.ts'
import { getAgentById, getConversationById, getProjectById } from '@jiku-studio/db'
import { resolveAgentModel } from '../credentials/service.ts'
import { getAdapter } from '../credentials/adapters.ts'
import { agentAdapterRegistry } from '../agent/adapter-registry.ts'

function buildAdapterInfo(agentRow: { mode_configs?: unknown }, mode: 'chat' | 'task') {
  const modeConfigs = (agentRow.mode_configs ?? {}) as Record<string, { adapter?: string; config?: Record<string, unknown> }>
  const cfg = modeConfigs[mode]
  const adapterId = cfg?.adapter ?? 'jiku.agent.default'
  const adapter = agentAdapterRegistry.get(adapterId) ?? agentAdapterRegistry.get('jiku.agent.default')
  if (!adapter) return undefined
  return {
    id: adapter.id,
    display_name: adapter.displayName,
    description: adapter.description,
    config: cfg?.config,
  }
}

const router = Router()
router.use(authMiddleware)

/**
 * POST /agents/:aid/preview
 * Preview context for an agent without an existing conversation.
 */
router.post('/agents/:aid/preview', requirePermission('agents:read'), async (req, res) => {
  const agentId = req.params['aid']!
  const userId = res.locals['user_id'] as string
  const { mode = 'chat' } = req.body as { mode?: 'chat' | 'task' }

  const agent = await getAgentById(agentId)
  if (!agent) { res.status(404).json({ error: 'Agent not found' }); return }

  const project = await getProjectById(agent.project_id)
  if (!project) { res.status(404).json({ error: 'Project not found' }); return }

  let caller
  try {
    caller = await resolveCaller(userId, project.company_id, agentId)
  } catch (err) {
    res.status(403).json({ error: err instanceof Error ? err.message : 'Access denied' })
    return
  }

  try {
    const [preview, modelInfo] = await Promise.all([
      runtimeManager.previewRun(agent.project_id, { agent_id: agentId, caller, mode }),
      resolveAgentModel(agentId),
    ])
    const adapter = modelInfo ? getAdapter(modelInfo.adapter_id) : undefined
    res.json({
      ...preview,
      model_info: modelInfo ? {
        provider_id: modelInfo.adapter_id,
        provider_name: adapter?.name ?? modelInfo.adapter_id,
        model_id: modelInfo.model_id ?? 'unknown',
      } : undefined,
      mode,
      adapter_info: buildAdapterInfo(agent, mode),
    })
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : 'Preview failed' })
  }
})

/**
 * POST /conversations/:id/preview
 * Preview context for an existing conversation (includes history token count).
 */
router.post('/conversations/:id/preview', async (req, res) => {
  const conversationId = req.params['id']!
  const userId = res.locals['user_id'] as string
  const { mode = 'chat' } = req.body as { mode?: 'chat' | 'task' }

  const conversation = await getConversationById(conversationId)
  if (!conversation) { res.status(404).json({ error: 'Conversation not found' }); return }

  const agent = await getAgentById(conversation.agent_id)
  if (!agent) { res.status(404).json({ error: 'Agent not found' }); return }

  // Set project context and verify membership
  res.locals['project_id'] = agent.project_id
  const permResult = await loadPerms(req, res)
  if (!permResult) { res.status(400).json({ error: 'Project context required' }); return }
  if (!permResult.resolved.granted) { res.status(403).json({ error: 'Not a member' }); return }
  if (!permResult.resolved.isSuperadmin && !permResult.resolved.permissions.includes('chats:read')) {
    res.status(403).json({ error: 'Missing permission: chats:read' }); return
  }

  const project = await getProjectById(agent.project_id)
  if (!project) { res.status(404).json({ error: 'Project not found' }); return }

  let caller
  try {
    caller = await resolveCaller(userId, project.company_id, agent.id)
  } catch (err) {
    res.status(403).json({ error: err instanceof Error ? err.message : 'Access denied' })
    return
  }

  try {
    const [preview, modelInfo] = await Promise.all([
      runtimeManager.previewRun(agent.project_id, { agent_id: agent.id, caller, mode, conversation_id: conversationId }),
      resolveAgentModel(agent.id),
    ])
    const adapter = modelInfo ? getAdapter(modelInfo.adapter_id) : undefined
    res.json({
      ...preview,
      model_info: modelInfo ? {
        provider_id: modelInfo.adapter_id,
        provider_name: adapter?.name ?? modelInfo.adapter_id,
        model_id: modelInfo.model_id ?? 'unknown',
      } : undefined,
      mode,
      adapter_info: buildAdapterInfo(agent, mode),
    })
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : 'Preview failed' })
  }
})

export { router as previewRouter }
