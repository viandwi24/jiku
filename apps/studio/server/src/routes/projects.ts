import { Hono } from 'hono'
import { getProjectsByCompanyId, getProjectById, createProject, updateProject, deleteProject, getProjectBySlug } from '@jiku-studio/db'
import { authMiddleware } from '../middleware/auth.ts'
import { runtimeManager } from '../runtime/manager.ts'
import { uniqueSlug } from '../utils/slug.ts'
import type { AppVariables } from '../types.ts'

const router = new Hono<{ Variables: AppVariables }>()

router.use('/companies/:cid/*', authMiddleware)
router.use('/projects/:pid', authMiddleware)

router.get('/companies/:cid/projects', async (c) => {
  const companyId = c.req.param('cid')
  const projects = await getProjectsByCompanyId(companyId)
  return c.json({ projects })
})

router.post('/companies/:cid/projects', async (c) => {
  const companyId = c.req.param('cid')
  const body = await c.req.json<{ name: string; slug?: string }>()

  const slug = await uniqueSlug(
    body.slug ?? body.name,
    async (s) => !!(await getProjectBySlug(companyId, s)),
  )

  const project = await createProject({ company_id: companyId, name: body.name, slug })
  await runtimeManager.wakeUp(project.id)
  return c.json({ project }, 201)
})

router.patch('/projects/:pid', async (c) => {
  const projectId = c.req.param('pid')
  const project = await getProjectById(projectId)
  if (!project) return c.json({ error: 'Project not found' }, 404)

  const body = await c.req.json<{ name?: string; slug?: string }>()

  // Ensure new slug is unique within company
  if (body.slug && body.slug !== project.slug) {
    const existing = await getProjectBySlug(project.company_id, body.slug)
    if (existing) return c.json({ error: 'Slug already taken' }, 409)
  }

  const updated = await updateProject(projectId, {
    ...(body.name !== undefined ? { name: body.name } : {}),
    ...(body.slug !== undefined ? { slug: body.slug } : {}),
  })

  return c.json({ project: updated })
})

router.delete('/companies/:cid/projects/:pid', async (c) => {
  const projectId = c.req.param('pid')
  await deleteProject(projectId)
  runtimeManager.sleep(projectId)
  return c.json({ ok: true })
})

export { router as projectsRouter }
