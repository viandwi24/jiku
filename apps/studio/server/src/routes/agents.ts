import { Router } from 'express'
import { getAgentsByProjectId, createAgent, updateAgent, deleteAgent, getProjectById, getAgentById, getAgentBySlug, getUsageLogsByAgent, getUsageSummaryByAgent, getUsageCountByAgent } from '@jiku-studio/db'
import { authMiddleware } from '../middleware/auth.ts'
import { requirePermission, requireAnyPermission } from '../middleware/permission.ts'
import { runtimeManager } from '../runtime/manager.ts'
import { generateSlug, uniqueSlug } from '../utils/slug.ts'

const router = Router()
router.use(authMiddleware)

// agents:read for management, but chats:read/runs:read also grant agent listing (needed to start a chat/run)
router.get('/projects/:pid/agents', requireAnyPermission('agents:read', 'chats:read', 'runs:read'), async (req, res) => {
  const projectId = req.params['pid']!
  const allAgents = await getAgentsByProjectId(projectId)

  // Superadmins and users with agents:write always see all agents (full management access).
  // Everyone else gets filtered by their agent_restrictions: { "agent-id": false } = hidden.
  const resolved = res.locals['resolved_permissions'] as import('@jiku/types').ResolvedPermissions | undefined
  if (resolved && !resolved.isSuperadmin && !resolved.permissions.includes('agents:write')) {
    const restrictions = resolved.agentRestrictions
    const visible = allAgents.filter(a => restrictions[a.id] !== false)
    return res.json({ agents: visible })
  }

  res.json({ agents: allAgents })
})

router.post('/projects/:pid/agents', requirePermission('agents:create'), async (req, res) => {
  const projectId = req.params['pid']!
  const body = req.body as { name: string; description?: string; base_prompt: string; allowed_modes?: string[]; slug?: string }

  const project = await getProjectById(projectId)
  if (!project) { res.status(404).json({ error: 'Project not found' }); return }

  const slug = await uniqueSlug(body.slug ?? body.name, async (s) => !!(await getAgentBySlug(projectId, s)))
  const agent = await createAgent({
    project_id: projectId,
    name: body.name,
    slug,
    description: body.description ?? null,
    base_prompt: body.base_prompt,
    allowed_modes: body.allowed_modes ?? ['chat', 'task'],
  })

  await runtimeManager.syncAgent(projectId, agent.id)
  res.status(201).json({ agent })
})

router.patch('/agents/:aid', requirePermission('agents:write'), async (req, res) => {
  const agentId = req.params['aid']!
  const body = req.body as Partial<{ name: string; description: string; base_prompt: string; allowed_modes: string[]; slug: string; compaction_threshold: number; max_tool_calls: number; task_allowed_agents: string[] | null }>

  const agent = await updateAgent(agentId, body)
  await runtimeManager.syncAgent(agent.project_id, agentId)
  res.json({ agent })
})

router.get('/agents/:aid/usage', requirePermission('settings:read'), async (req, res) => {
  const agentId = req.params['aid']!
  const limit = Math.min(Number(req.query['limit'] ?? 100), 500)
  const offset = Number(req.query['offset'] ?? 0)
  const [logs, summary, total] = await Promise.all([
    getUsageLogsByAgent(agentId, limit, offset),
    getUsageSummaryByAgent(agentId),
    getUsageCountByAgent(agentId),
  ])
  res.json({ logs, summary, total })
})

router.delete('/agents/:aid', requirePermission('agents:delete'), async (req, res) => {
  const agentId = req.params['aid']!
  const agent = await getAgentById(agentId)
  if (!agent) { res.status(404).json({ error: 'Agent not found' }); return }

  await deleteAgent(agentId)
  runtimeManager.removeAgent(agent.project_id, agentId)
  res.json({ ok: true })
})

export { router as agentsRouter }
