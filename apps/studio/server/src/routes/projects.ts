import { Router } from 'express'
import { getProjectsByCompanyId, getProjectById, createProject, updateProject, deleteProject, getProjectBySlug } from '@jiku-studio/db'
import { authMiddleware } from '../middleware/auth.ts'
import { runtimeManager } from '../runtime/manager.ts'
import { uniqueSlug } from '../utils/slug.ts'

const router = Router()
router.use(authMiddleware)

router.get('/companies/:cid/projects', async (req, res) => {
  const projects = await getProjectsByCompanyId(req.params['cid']!)
  res.json({ projects })
})

router.post('/companies/:cid/projects', async (req, res) => {
  const companyId = req.params['cid']!
  const { name, slug: rawSlug } = req.body as { name: string; slug?: string }

  const slug = await uniqueSlug(rawSlug ?? name, async (s) => !!(await getProjectBySlug(companyId, s)))
  const project = await createProject({ company_id: companyId, name, slug })
  await runtimeManager.wakeUp(project.id)
  res.status(201).json({ project })
})

router.patch('/projects/:pid', async (req, res) => {
  const projectId = req.params['pid']!
  const project = await getProjectById(projectId)
  if (!project) { res.status(404).json({ error: 'Project not found' }); return }

  const { name, slug } = req.body as { name?: string; slug?: string }
  if (slug && slug !== project.slug) {
    const existing = await getProjectBySlug(project.company_id, slug)
    if (existing) { res.status(409).json({ error: 'Slug already taken' }); return }
  }

  const updated = await updateProject(projectId, {
    ...(name !== undefined ? { name } : {}),
    ...(slug !== undefined ? { slug } : {}),
  })
  res.json({ project: updated })
})

router.delete('/companies/:cid/projects/:pid', async (req, res) => {
  const projectId = req.params['pid']!
  await deleteProject(projectId)
  runtimeManager.sleep(projectId)
  res.json({ ok: true })
})

export { router as projectsRouter }
