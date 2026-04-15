import { Router } from 'express'
import { getProjectsByCompanyId, getProjectById, createProject, updateProject, deleteProject, getProjectBySlug, getUsageLogsByProject, getUsageSummaryByProject, getUsageCountByProject, createProjectMembership } from '@jiku-studio/db'
import { authMiddleware } from '../middleware/auth.ts'
import { requirePermission, requireSuperadmin } from '../middleware/permission.ts'
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

  const userId = res.locals['user_id'] as string
  const slug = await uniqueSlug(rawSlug ?? name, async (s) => !!(await getProjectBySlug(companyId, s)))
  const project = await createProject({ company_id: companyId, name, slug })

  // Auto-create superadmin membership for the project creator
  await createProjectMembership({
    project_id: project.id,
    user_id: userId,
    role_id: null,
    is_superadmin: true,
    agent_restrictions: {},
    tool_restrictions: {},
  })

  await runtimeManager.wakeUp(project.id)
  res.status(201).json({ project })
})

router.patch('/projects/:pid', requirePermission('settings:write'), async (req, res) => {
  const projectId = req.params['pid']!
  const project = await getProjectById(projectId)
  if (!project) { res.status(404).json({ error: 'Project not found' }); return }

  const { name, slug, default_timezone } = req.body as { name?: string; slug?: string; default_timezone?: string }
  if (slug && slug !== project.slug) {
    const existing = await getProjectBySlug(project.company_id, slug)
    if (existing) { res.status(409).json({ error: 'Slug already taken' }); return }
  }
  if (default_timezone !== undefined) {
    // Validate IANA — Intl.supportedValuesOf when available, fallback to formatter probe.
    const valid = (() => {
      try { new Intl.DateTimeFormat('en-US', { timeZone: default_timezone }); return true }
      catch { return false }
    })()
    if (!valid) { res.status(400).json({ error: `Invalid IANA timezone: ${default_timezone}` }); return }
  }

  const updated = await updateProject(projectId, {
    ...(name !== undefined ? { name } : {}),
    ...(slug !== undefined ? { slug } : {}),
    ...(default_timezone !== undefined ? { default_timezone } : {}),
  })
  res.json({ project: updated })
})

router.get('/projects/:pid/usage', requirePermission('usage:read'), async (req, res) => {
  const projectId = req.params['pid']!
  const limit = Math.min(Number(req.query['limit'] ?? 50), 500)
  const offset = Number(req.query['offset'] ?? 0)
  const sinceParam = req.query['since'] as string | undefined
  const since = sinceParam ? new Date(sinceParam) : undefined
  const [logs, summary, total] = await Promise.all([
    getUsageLogsByProject(projectId, limit, offset, since),
    getUsageSummaryByProject(projectId, since),
    getUsageCountByProject(projectId, since),
  ])
  res.json({ logs, summary, total })
})

router.delete('/companies/:cid/projects/:pid', async (req, res) => {
  const projectId = req.params['pid']!
  await deleteProject(projectId)
  runtimeManager.sleep(projectId)
  res.json({ ok: true })
})

export { router as projectsRouter }
