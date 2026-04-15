import { Router } from 'express'
import type { Request, Response, NextFunction } from 'express'
import {
  getCommandsByProjectId,
  getCommandById,
  getCommandBySlug,
  deleteCommand,
  getAgentCommands,
  assignCommandToAgent,
  removeCommandFromAgent,
  getAgentById,
} from '@jiku-studio/db'
import type { ProjectCommand } from '@jiku-studio/db'
import { authMiddleware } from '../middleware/auth.ts'
import { requirePermission } from '../middleware/permission.ts'
import { audit, auditContext } from '../audit/logger.ts'
import { getFilesystemService } from '../filesystem/service.ts'
import { getCommandLoader } from '../commands/loader.ts'

const router = Router()
router.use(authMiddleware)

async function resolveCommandProject(req: Request, res: Response, next: NextFunction) {
  const id = req.params['cid'] as string
  const cmd = await getCommandById(id)
  if (!cmd) { res.status(404).json({ error: 'Command not found' }); return }
  res.locals['project_id'] = cmd.project_id
  res.locals['command'] = cmd
  next()
}

// ── Project Commands CRUD ─────────────────────────────────────────────────────

router.get('/projects/:pid/commands', requirePermission('commands:read'), async (req, res) => {
  const projectId = req.params['pid'] as string
  const commands = await getCommandsByProjectId(projectId)
  res.json({ commands })
})

router.post('/projects/:pid/commands', requirePermission('commands:write'), async (req, res) => {
  const projectId = req.params['pid'] as string
  const body = req.body as { name: string; slug?: string; description?: string }

  const slug = body.slug ?? body.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
  if (!slug) { res.status(400).json({ error: 'slug is required (name could not be slugified)' }); return }

  const existing = await getCommandBySlug(projectId, slug)
  if (existing) {
    res.status(409).json({ error: `Command with slug "${slug}" already exists` })
    return
  }

  const fs = await getFilesystemService(projectId)
  if (!fs) { res.status(400).json({ error: 'filesystem not configured' }); return }

  // Seed /commands/<slug>/COMMAND.md with a scaffold.
  const scaffold = `---\nname: "${body.name}"\ndescription: "${body.description ?? 'Describe what this command does.'}"\ntags: []\nargs:\n  - name: raw\n    description: "Free-form instruction from the user"\n---\n\n# ${body.name}\n\nInstruksi untuk agent saat command ini dijalankan.\n`
  await fs.write(`/commands/${slug}/COMMAND.md`, scaffold).catch(() => {})

  // Sync loader to register the new command immediately.
  await getCommandLoader(projectId).syncFilesystem().catch(() => {})

  const cmd = await getCommandBySlug(projectId, slug)
  if (!cmd) { res.status(500).json({ error: 'command created on disk but not registered' }); return }
  res.status(201).json({ command: cmd })
})

router.get('/commands/:cid', resolveCommandProject, requirePermission('commands:read'), async (req, res) => {
  res.json({ command: res.locals['command'] as ProjectCommand })
})

router.delete('/commands/:cid', resolveCommandProject, requirePermission('commands:write'), async (req, res) => {
  const cmd = res.locals['command'] as ProjectCommand
  const fs = await getFilesystemService(cmd.project_id)
  if (fs) {
    await fs.deleteFolder(`/commands/${cmd.slug}`).catch(() => {})
    await fs.delete(`/commands/${cmd.slug}.md`).catch(() => {})
  }
  await deleteCommand(cmd.id)
  await getCommandLoader(cmd.project_id).syncFilesystem().catch(() => {})
  res.json({ ok: true })
})

router.post('/projects/:pid/commands/refresh', requirePermission('commands:write'), async (req, res) => {
  const projectId = req.params['pid'] as string
  try {
    const snapshot = await getCommandLoader(projectId).syncFilesystem()
    res.json({ ok: true, count: snapshot.length })
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : 'Refresh failed' })
  }
})

// ── Agent Command Allow-List ─────────────────────────────────────────────────

router.get('/agents/:aid/commands', requirePermission('commands:read'), async (req, res) => {
  const agentId = req.params['aid'] as string
  const assignments = await getAgentCommands(agentId)
  res.json({ assignments })
})

router.post('/agents/:aid/commands', requirePermission('commands:write'), async (req, res) => {
  const agentId = req.params['aid'] as string
  const { command_id, pinned } = req.body as { command_id: string; pinned?: boolean }
  if (!command_id) { res.status(400).json({ error: 'command_id required' }); return }

  const agent = await getAgentById(agentId)
  if (!agent) { res.status(404).json({ error: 'Agent not found' }); return }
  const cmd = await getCommandById(command_id)
  if (!cmd) { res.status(404).json({ error: 'Command not found' }); return }

  const assignment = await assignCommandToAgent(agentId, command_id, pinned ?? false)
  audit.commandAssignmentChanged(
    { ...auditContext(req), project_id: agent.project_id },
    agentId,
    { command_slug: cmd.slug, action: 'assign', pinned: pinned ?? false },
  )
  res.status(201).json({ assignment })
})

router.delete('/agents/:aid/commands/:cid', requirePermission('commands:write'), async (req, res) => {
  const { aid: agentId, cid: commandId } = req.params as { aid: string; cid: string }
  const agent = await getAgentById(agentId)
  const cmd = await getCommandById(commandId)
  await removeCommandFromAgent(agentId, commandId)
  if (agent && cmd) {
    audit.commandAssignmentChanged(
      { ...auditContext(req), project_id: agent.project_id },
      agentId,
      { command_slug: cmd.slug, action: 'remove' },
    )
  }
  res.json({ ok: true })
})

router.patch('/agents/:aid/command-access-mode', requirePermission('commands:write'), async (req, res) => {
  const agentId = req.params['aid'] as string
  const body = req.body as { mode?: 'manual' | 'all' }
  if (body.mode !== 'manual' && body.mode !== 'all') {
    res.status(400).json({ error: 'mode must be "manual" or "all"' })
    return
  }
  const agent = await getAgentById(agentId)
  if (!agent) { res.status(404).json({ error: 'Agent not found' }); return }
  const { db, agents, eq } = await import('@jiku-studio/db')
  await db.update(agents).set({ command_access_mode: body.mode }).where(eq(agents.id, agentId))
  audit.commandAssignmentChanged(
    { ...auditContext(req), project_id: agent.project_id },
    agentId,
    { access_mode: body.mode },
  )
  res.json({ ok: true, mode: body.mode })
})

export { router as commandsRouter }
