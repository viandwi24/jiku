import { Hono } from 'hono'
import {
  getAgentsByProjectId,
  createAgent,
  updateAgent,
  deleteAgent,
  getProjectById,
  getAgentById,
  getAgentBySlug,
} from '@jiku-studio/db'
import { authMiddleware } from '../middleware/auth.ts'
import { runtimeManager } from '../runtime/manager.ts'
import { generateSlug, uniqueSlug } from '../utils/slug.ts'
import type { AppVariables } from '../types.ts'

const router = new Hono<{ Variables: AppVariables }>()

router.use('*', authMiddleware)

router.get('/projects/:pid/agents', async (c) => {
  const projectId = c.req.param('pid')
  const agents = await getAgentsByProjectId(projectId)
  return c.json({ agents })
})

router.post('/projects/:pid/agents', async (c) => {
  const projectId = c.req.param('pid')
  const body = await c.req.json<{
    name: string
    description?: string
    base_prompt: string
    allowed_modes?: string[]
    slug?: string
  }>()

  const project = await getProjectById(projectId)
  if (!project) return c.json({ error: 'Project not found' }, 404)

  const slug = await uniqueSlug(
    body.slug ?? body.name,
    async (s) => !!(await getAgentBySlug(projectId, s)),
  )

  const agent = await createAgent({
    project_id: projectId,
    name: body.name,
    slug,
    description: body.description ?? null,
    base_prompt: body.base_prompt,
    allowed_modes: body.allowed_modes ?? ['chat'],
  })

  await runtimeManager.syncAgent(projectId, agent.id)

  return c.json({ agent }, 201)
})

router.patch('/agents/:aid', async (c) => {
  const agentId = c.req.param('aid')
  const body = await c.req.json<Partial<{
    name: string
    description: string
    base_prompt: string
    allowed_modes: string[]
    slug: string
  }>>()

  const agent = await updateAgent(agentId, body)
  await runtimeManager.syncAgent(agent.project_id, agentId)

  return c.json({ agent })
})

router.delete('/agents/:aid', async (c) => {
  const agentId = c.req.param('aid')
  const agent = await getAgentById(agentId)
  if (!agent) return c.json({ error: 'Agent not found' }, 404)

  await deleteAgent(agentId)
  runtimeManager.removeAgent(agent.project_id, agentId)

  return c.json({ ok: true })
})

export { router as agentsRouter }
