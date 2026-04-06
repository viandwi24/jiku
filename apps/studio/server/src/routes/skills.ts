import { Router } from 'express'
import type { Request, Response, NextFunction } from 'express'
import {
  getSkillsByProjectId,
  getSkillById,
  getSkillBySlug,
  createSkill,
  updateSkill,
  deleteSkill,
  getAgentSkills,
  assignSkillToAgent,
  removeSkillFromAgent,
  getAgentById,
} from '@jiku-studio/db'
import type { ProjectSkill } from '@jiku-studio/db'
import { authMiddleware } from '../middleware/auth.ts'
import { requirePermission } from '../middleware/permission.ts'
import { runtimeManager } from '../runtime/manager.ts'
import { getFilesystemService } from '../filesystem/service.ts'
import { skillFsPath } from '../skills/service.ts'

const router = Router()
router.use(authMiddleware)

/**
 * Middleware for /skills/:sid routes — resolves skill → project_id
 * so that requirePermission can find the project context.
 */
async function resolveSkillProject(req: Request, res: Response, next: NextFunction) {
  const skillId = req.params['sid'] as string
  const skill = await getSkillById(skillId)
  if (!skill) { res.status(404).json({ error: 'Skill not found' }); return }
  res.locals['project_id'] = skill.project_id
  res.locals['skill'] = skill
  next()
}

// ── Project Skills CRUD ───────────────────────────────────────────────────────

router.get('/projects/:pid/skills', requirePermission('agents:read'), async (req, res) => {
  const projectId = req.params['pid'] as string
  const skills = await getSkillsByProjectId(projectId)
  res.json({ skills })
})

router.post('/projects/:pid/skills', requirePermission('agents:write'), async (req, res) => {
  const projectId = req.params['pid'] as string
  const body = req.body as { name: string; slug?: string; description?: string; tags?: string[]; entrypoint?: string }

  const slug = body.slug ?? body.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')

  const existing = await getSkillBySlug(projectId, slug)
  if (existing) {
    res.status(409).json({ error: `Skill with slug "${slug}" already exists` })
    return
  }

  const skill = await createSkill({
    project_id: projectId,
    name: body.name,
    slug,
    description: body.description ?? null,
    tags: body.tags ?? [],
    entrypoint: body.entrypoint ?? 'index.md',
  })

  // Seed the entrypoint file in the filesystem so the skill has a starting point
  const fs = await getFilesystemService(projectId)
  if (fs) {
    const initialContent = `# ${skill.name}\n\n${skill.description ? `${skill.description}\n\n` : ''}<!-- Add your skill instructions here -->\n`
    await fs.write(skillFsPath(slug, skill.entrypoint), initialContent).catch(() => {
      // Non-fatal: filesystem may not be configured yet
    })
  }

  res.status(201).json({ skill })
})

router.get('/skills/:sid', resolveSkillProject, requirePermission('agents:read'), async (req, res) => {
  const skill = res.locals['skill'] as ProjectSkill
  res.json({ skill })
})

router.patch('/skills/:sid', resolveSkillProject, requirePermission('agents:write'), async (req, res) => {
  const skillId = req.params['sid'] as string
  const body = req.body as { name?: string; description?: string; tags?: string[]; entrypoint?: string; enabled?: boolean }
  const skill = await updateSkill(skillId, body)
  if (!skill) { res.status(404).json({ error: 'Skill not found' }); return }
  res.json({ skill })
})

router.delete('/skills/:sid', resolveSkillProject, requirePermission('agents:write'), async (req, res) => {
  const skill = res.locals['skill'] as ProjectSkill

  // Delete the skill's folder from the filesystem
  const fs = await getFilesystemService(skill.project_id)
  if (fs) {
    await fs.deleteFolder(skillFsPath(skill.slug)).catch(() => {
      // Non-fatal: files may not exist yet
    })
  }

  await deleteSkill(skill.id)
  res.json({ ok: true })
})

// ── Agent Skill Assignments ───────────────────────────────────────────────────

router.get('/agents/:aid/skills', requirePermission('agents:read'), async (req, res) => {
  const agentId = req.params['aid'] as string
  const assignments = await getAgentSkills(agentId)
  res.json({ assignments })
})

router.post('/agents/:aid/skills', requirePermission('agents:write'), async (req, res) => {
  const agentId = req.params['aid'] as string
  const { skill_id, mode } = req.body as { skill_id: string; mode?: 'always' | 'on_demand' }
  if (!skill_id) { res.status(400).json({ error: 'skill_id required' }); return }

  const agent = await getAgentById(agentId)
  if (!agent) { res.status(404).json({ error: 'Agent not found' }); return }

  const skill = await getSkillById(skill_id)
  if (!skill) { res.status(404).json({ error: 'Skill not found' }); return }

  const assignment = await assignSkillToAgent(agentId, skill_id, mode ?? 'on_demand')

  await runtimeManager.syncAgent(agent.project_id, agentId)

  res.status(201).json({ assignment })
})

router.patch('/agents/:aid/skills/:sid', requirePermission('agents:write'), async (req, res) => {
  const { aid: agentId, sid: skillId } = req.params as { aid: string; sid: string }
  const { mode } = req.body as { mode: 'always' | 'on_demand' }
  if (!mode || !['always', 'on_demand'].includes(mode)) {
    res.status(400).json({ error: 'mode must be "always" or "on_demand"' })
    return
  }

  const assignment = await assignSkillToAgent(agentId, skillId, mode)
  const agent = await getAgentById(agentId)
  if (agent) await runtimeManager.syncAgent(agent.project_id, agentId)

  res.json({ assignment })
})

router.delete('/agents/:aid/skills/:sid', requirePermission('agents:write'), async (req, res) => {
  const { aid: agentId, sid: skillId } = req.params as { aid: string; sid: string }

  await removeSkillFromAgent(agentId, skillId)

  const agent = await getAgentById(agentId)
  if (agent) await runtimeManager.syncAgent(agent.project_id, agentId)

  res.json({ ok: true })
})

export { router as skillsRouter }
