import express, { Router } from 'express'
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
import { audit, auditContext } from '../audit/logger.ts'
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
    entrypoint: body.entrypoint ?? 'SKILL.md',
  })

  // Seed the entrypoint file in the filesystem so the skill has a starting point
  const fs = await getFilesystemService(projectId)
  if (fs) {
    const initialContent = `---\nname: ${skill.name}\ndescription: fill this with skill description\n---\n`
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

// ── Plan 19 — Skills Loader v2 endpoints ─────────────────────────────────────

/** Refresh the SkillLoader FS cache for a project. */
router.post('/projects/:pid/skills/refresh', requirePermission('agents:write'), async (req, res) => {
  const projectId = req.params['pid'] as string
  try {
    const { getSkillLoader } = await import('../skills/loader.ts')
    const snapshot = await getSkillLoader(projectId).syncFilesystem()
    res.json({ ok: true, count: snapshot.length })
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : 'Refresh failed' })
  }
})

/**
 * Import a skill from a public GitHub repo or an uploaded ZIP.
 * Body:
 *   { source: 'github', package: 'owner/repo[/subpath][@ref]', overwrite?: boolean }
 *   { source: 'zip', overwrite?: boolean } + multipart "file" field
 */
router.post('/projects/:pid/skills/import', requirePermission('agents:write'), async (req, res) => {
  const projectId = req.params['pid'] as string
  try {
    const { importSkillFromGithub, importSkillFromZipBuffer, parseGithubPackageSpec } = await import('../skills/importer.ts')
    const body = req.body as { source?: string; package?: string; overwrite?: boolean }

    if (body.source === 'github') {
      if (!body.package) { res.status(400).json({ error: '`package` is required for github source' }); return }
      const spec = parseGithubPackageSpec(body.package)
      const result = await importSkillFromGithub(projectId, { ...spec, overwrite: body.overwrite })
      audit.skillImport(
        { ...auditContext(req), project_id: projectId },
        result.slug,
        { source: 'github', package: body.package, files_count: result.files_count },
      )
      res.json({ result })
      return
    }

    res.status(400).json({ error: 'source must be "github" (use /skills/import-zip for ZIP upload)' })
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : 'Import failed' })
  }
})

/**
 * Plan 19 — ZIP upload variant. Expects raw application/zip body up to 20MB.
 * Separate endpoint so the JSON parser on `/import` is not confused.
 */
router.post(
  '/projects/:pid/skills/import-zip',
  requirePermission('agents:write'),
  express.raw({ type: ['application/zip', 'application/octet-stream'], limit: '20mb' }),
  async (req, res) => {
    const projectId = req.params['pid'] as string
    try {
      const buffer = req.body as Buffer
      if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
        res.status(400).json({ error: 'ZIP body is empty — set Content-Type: application/zip' })
        return
      }
      const overwrite = req.query['overwrite'] === 'true'
      const { importSkillFromZipBuffer } = await import('../skills/importer.ts')
      const result = await importSkillFromZipBuffer(projectId, buffer, { overwrite, sourceLabel: 'zip-upload' })
      audit.skillImport(
        { ...auditContext(req), project_id: projectId },
        result.slug,
        { source: 'zip', files_count: result.files_count },
      )
      res.json({ result })
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : 'Import failed' })
    }
  },
)

/** Plan 19 — update agent.skill_access_mode. */
router.patch('/agents/:aid/skill-access-mode', requirePermission('agents:write'), async (req, res) => {
  const agentId = req.params['aid'] as string
  const body = req.body as { mode?: 'manual' | 'all_on_demand' }
  if (body.mode !== 'manual' && body.mode !== 'all_on_demand') {
    res.status(400).json({ error: 'mode must be "manual" or "all_on_demand"' })
    return
  }
  const agent = await getAgentById(agentId)
  if (!agent) { res.status(404).json({ error: 'Agent not found' }); return }
  res.locals['project_id'] = agent.project_id
  try {
    const { db, agents, eq } = await import('@jiku-studio/db')
    await db.update(agents).set({ skill_access_mode: body.mode }).where(eq(agents.id, agentId))
    await runtimeManager.syncAgent(agent.project_id, agentId)
    audit.skillAssignmentChanged(
      { ...auditContext(req), project_id: agent.project_id },
      agentId,
      { access_mode: body.mode },
    )
    res.json({ ok: true, mode: body.mode })
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : 'Failed to update access mode' })
  }
})

export { router as skillsRouter }
