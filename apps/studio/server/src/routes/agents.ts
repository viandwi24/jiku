import { Router } from 'express'
import { getAgentsByProjectId, createAgent, updateAgent, deleteAgent, getProjectById, getAgentById, getAgentBySlug } from '@jiku-studio/db'
import { authMiddleware } from '../middleware/auth.ts'
import { runtimeManager } from '../runtime/manager.ts'
import { generateSlug, uniqueSlug } from '../utils/slug.ts'

const router = Router()
router.use(authMiddleware)

router.get('/projects/:pid/agents', async (req, res) => {
  const agents = await getAgentsByProjectId(req.params['pid']!)
  res.json({ agents })
})

router.post('/projects/:pid/agents', async (req, res) => {
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
    allowed_modes: body.allowed_modes ?? ['chat'],
  })

  await runtimeManager.syncAgent(projectId, agent.id)
  res.status(201).json({ agent })
})

router.patch('/agents/:aid', async (req, res) => {
  const agentId = req.params['aid']!
  const body = req.body as Partial<{ name: string; description: string; base_prompt: string; allowed_modes: string[]; slug: string; compaction_threshold: number }>

  const agent = await updateAgent(agentId, body)
  await runtimeManager.syncAgent(agent.project_id, agentId)
  res.json({ agent })
})

router.delete('/agents/:aid', async (req, res) => {
  const agentId = req.params['aid']!
  const agent = await getAgentById(agentId)
  if (!agent) { res.status(404).json({ error: 'Agent not found' }); return }

  await deleteAgent(agentId)
  runtimeManager.removeAgent(agent.project_id, agentId)
  res.json({ ok: true })
})

export { router as agentsRouter }
