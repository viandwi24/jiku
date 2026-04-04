import { Hono } from 'hono'
import { getProjectsByCompanyId, createProject, deleteProject } from '@jiku-studio/db'
import { authMiddleware } from '../middleware/auth.ts'
import { runtimeManager } from '../runtime/manager.ts'
import type { AppVariables } from '../types.ts'

const router = new Hono<{ Variables: AppVariables }>()

router.use('/companies/:cid/*', authMiddleware)

router.get('/companies/:cid/projects', async (c) => {
  const companyId = c.req.param('cid')
  const projects = await getProjectsByCompanyId(companyId)
  return c.json({ projects })
})

router.post('/companies/:cid/projects', async (c) => {
  const companyId = c.req.param('cid')
  const body = await c.req.json<{ name: string; slug: string }>()
  const project = await createProject({ company_id: companyId, name: body.name, slug: body.slug })
  // Boot runtime immediately so the first agent request doesn't pay the cold-start cost
  await runtimeManager.wakeUp(project.id)
  return c.json({ project }, 201)
})

router.delete('/companies/:cid/projects/:pid', async (c) => {
  const projectId = c.req.param('pid')
  await deleteProject(projectId)
  runtimeManager.sleep(projectId)
  return c.json({ ok: true })
})

export { router as projectsRouter }
