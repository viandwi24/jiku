import { Router } from 'express'
import { authMiddleware } from '../middleware/auth.ts'
import { requirePermission, loadPerms } from '../middleware/permission.ts'
import {
  listProjectMemories,
  deleteMemory,
  updateMemory,
  getMemoryById,
  getAgentById,
  getProjectById,
  updateProjectMemoryConfig,
  updateAgentMemoryConfig,
} from '@jiku-studio/db'
import { DEFAULT_PROJECT_MEMORY_CONFIG, resolveMemoryConfig } from '@jiku/core'
import type { AgentMemoryConfig, ProjectMemoryConfig } from '@jiku/types'

const router = Router()

// ──────────────────────────────────────────────────────────────
// Memory CRUD
// ──────────────────────────────────────────────────────────────

/**
 * GET /projects/:pid/memories
 * List all memories for a project with optional filters.
 */
router.get('/projects/:pid/memories', authMiddleware, requirePermission('memory:read'), async (req, res) => {
  const projectId = req.params['pid']! as string
  const { agent_id, user_id, scope, tier, limit, offset } = req.query as Record<string, string>

  try {
    const memories = await listProjectMemories({
      project_id: projectId,
      agent_id: agent_id || undefined,
      caller_id: user_id || undefined,
      scope: scope || undefined,
      tier: tier || undefined,
      limit: limit ? parseInt(limit) : 100,
      offset: offset ? parseInt(offset) : 0,
    })
    res.json({ memories })
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : 'Failed to list memories' })
  }
})

/**
 * DELETE /memories/:id
 * Delete a memory by ID.
 */
router.delete('/memories/:id', authMiddleware, async (req, res) => {
  const memoryId = req.params['id']! as string

  try {
    const memory = await getMemoryById(memoryId)
    if (!memory) {
      res.status(404).json({ error: 'Memory not found' })
      return
    }
    // Inject project context so requirePermission can resolve it
    res.locals['project_id'] = memory.project_id
    const result = await loadPerms(req, res)
    if (!result) { res.status(400).json({ error: 'Project context required' }); return }
    const { resolved } = result
    if (!resolved.granted) { res.status(403).json({ error: 'Not a member' }); return }
    if (!resolved.isSuperadmin && !resolved.permissions.includes('memory:delete')) {
      res.status(403).json({ error: 'Missing permission: memory:delete' }); return
    }

    await deleteMemory(memoryId)
    res.json({ success: true })
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : 'Failed to delete memory' })
  }
})

/**
 * PATCH /memories/:id
 * Update editable fields of a memory row. Plan 19: content, importance, visibility.
 */
router.patch('/memories/:id', authMiddleware, async (req, res) => {
  const memoryId = req.params['id']! as string
  const body = req.body as {
    content?: string
    importance?: 'low' | 'medium' | 'high'
    visibility?: 'private' | 'agent_shared' | 'project_shared'
  }
  try {
    const memory = await getMemoryById(memoryId)
    if (!memory) { res.status(404).json({ error: 'Memory not found' }); return }
    res.locals['project_id'] = memory.project_id
    const result = await loadPerms(req, res)
    if (!result) { res.status(400).json({ error: 'Project context required' }); return }
    const { resolved } = result
    if (!resolved.granted) { res.status(403).json({ error: 'Not a member' }); return }
    if (!resolved.isSuperadmin && !resolved.permissions.includes('memory:write')) {
      res.status(403).json({ error: 'Missing permission: memory:write' }); return
    }

    const updates: Record<string, unknown> = {}
    if (typeof body.content === 'string' && body.content.trim().length > 0) updates['content'] = body.content.trim()
    if (body.importance) updates['importance'] = body.importance
    if (body.visibility) updates['visibility'] = body.visibility
    if (Object.keys(updates).length === 0) { res.status(400).json({ error: 'No updatable fields provided' }); return }

    await updateMemory(memoryId, updates)
    const fresh = await getMemoryById(memoryId)
    res.json({ memory: fresh })
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : 'Failed to update memory' })
  }
})

// ──────────────────────────────────────────────────────────────
// Memory Config — Project level
// ──────────────────────────────────────────────────────────────

/**
 * GET /projects/:pid/memory-config
 */
router.get('/projects/:pid/memory-config', authMiddleware, requirePermission('memory:read'), async (req, res) => {
  const projectId = req.params['pid']! as string
  try {
    const project = await getProjectById(projectId)
    if (!project) { res.status(404).json({ error: 'Project not found' }); return }
    // Deep-merge DB data with defaults so new fields (embedding, semantic weight) always exist
    const raw = project.memory_config as Record<string, unknown> | null
    const config = raw
      ? deepMerge(DEFAULT_PROJECT_MEMORY_CONFIG as unknown as Record<string, unknown>, raw) as ProjectMemoryConfig
      : DEFAULT_PROJECT_MEMORY_CONFIG
    res.json({ config })
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : 'Failed to get memory config' })
  }
})

/**
 * PATCH /projects/:pid/memory-config
 */
router.patch('/projects/:pid/memory-config', authMiddleware, requirePermission('settings:write'), async (req, res) => {
  const projectId = req.params['pid']! as string
  const updates = req.body as Partial<ProjectMemoryConfig>
  try {
    const project = await getProjectById(projectId)
    if (!project) { res.status(404).json({ error: 'Project not found' }); return }

    const current = (project.memory_config as ProjectMemoryConfig | null) ?? DEFAULT_PROJECT_MEMORY_CONFIG
    const merged = deepMerge(current as Record<string, unknown>, updates as Record<string, unknown>) as ProjectMemoryConfig

    await updateProjectMemoryConfig(projectId, merged)

    // Clear embedding service cache so next memory save picks up new config
    const { clearEmbeddingCache } = await import('../memory/embedding.ts')
    clearEmbeddingCache(projectId)

    // Plan 19 — reschedule dreaming cron if config changed
    const { dreamScheduler } = await import('../jobs/dream-scheduler.ts')
    dreamScheduler.reschedule(projectId).catch(err =>
      console.warn('[memory] dream scheduler reschedule failed:', err),
    )

    res.json({ config: merged })
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : 'Failed to update memory config' })
  }
})

// ──────────────────────────────────────────────────────────────
// Memory Config — Agent level
// ──────────────────────────────────────────────────────────────

/**
 * GET /agents/:aid/memory-config
 */
router.get('/agents/:aid/memory-config', authMiddleware, requirePermission('agents:read'), async (req, res) => {
  const agentId = req.params['aid']! as string
  try {
    const agent = await getAgentById(agentId)
    if (!agent) { res.status(404).json({ error: 'Agent not found' }); return }
    const config = (agent.memory_config as AgentMemoryConfig | null) ?? null
    res.json({ config })
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : 'Failed to get agent memory config' })
  }
})

/**
 * PATCH /agents/:aid/memory-config
 */
router.patch('/agents/:aid/memory-config', authMiddleware, requirePermission('agents:write'), async (req, res) => {
  const agentId = req.params['aid']! as string
  const updates = req.body as AgentMemoryConfig | null
  try {
    const agent = await getAgentById(agentId)
    if (!agent) { res.status(404).json({ error: 'Agent not found' }); return }
    await updateAgentMemoryConfig(agentId, updates as Record<string, unknown> | null)
    res.json({ config: updates })
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : 'Failed to update agent memory config' })
  }
})

/**
 * GET /agents/:aid/memory-config/resolved
 * Returns the fully resolved config (project defaults merged with agent override).
 */
router.get('/agents/:aid/memory-config/resolved', authMiddleware, requirePermission('agents:read'), async (req, res) => {
  const agentId = req.params['aid']! as string
  try {
    const agent = await getAgentById(agentId)
    if (!agent) { res.status(404).json({ error: 'Agent not found' }); return }

    const project = await getProjectById(agent.project_id)
    const projectConfig = (project?.memory_config as ProjectMemoryConfig | null) ?? DEFAULT_PROJECT_MEMORY_CONFIG
    const agentConfig = (agent.memory_config as AgentMemoryConfig | null) ?? null
    const resolved = resolveMemoryConfig(projectConfig, agentConfig)

    res.json({ resolved, project_config: projectConfig, agent_config: agentConfig })
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : 'Failed to get resolved memory config' })
  }
})

function deepMerge(target: Record<string, unknown>, source: Record<string, unknown>): Record<string, unknown> {
  const result = { ...target }
  for (const key of Object.keys(source)) {
    const sv = source[key]
    const tv = target[key]
    if (sv && typeof sv === 'object' && !Array.isArray(sv) && tv && typeof tv === 'object' && !Array.isArray(tv)) {
      result[key] = deepMerge(tv as Record<string, unknown>, sv as Record<string, unknown>)
    } else if (sv !== undefined) {
      result[key] = sv
    }
  }
  return result
}

// ──────────────────────────────────────────────────────────────
// Plan 19 — Dreaming manual trigger
// ──────────────────────────────────────────────────────────────

/**
 * POST /projects/:pid/memory/dream
 * Body: { phase: 'light' | 'deep' | 'rem' }
 */
router.post('/projects/:pid/memory/dream', authMiddleware, requirePermission('settings:write'), async (req, res) => {
  const projectId = req.params['pid']! as string
  const phase = (req.body as { phase?: string } | null)?.phase
  if (phase !== 'light' && phase !== 'deep' && phase !== 'rem') {
    res.status(400).json({ error: 'phase must be one of: light, deep, rem' })
    return
  }
  try {
    const { triggerDreamNow } = await import('../jobs/dream-scheduler.ts')
    await triggerDreamNow(projectId, phase)
    res.json({ ok: true, phase })
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : 'Failed to trigger dream' })
  }
})

/**
 * GET /projects/:pid/jobs
 * List recent background jobs for this project (debug).
 */
router.get('/projects/:pid/jobs', authMiddleware, requirePermission('settings:read'), async (req, res) => {
  const projectId = req.params['pid']! as string
  const status = (req.query['status'] as string | undefined) ?? undefined
  const type = (req.query['type'] as string | undefined) ?? undefined
  try {
    const { listJobs } = await import('@jiku-studio/db')
    const jobs = await listJobs({ project_id: projectId, status, type, limit: 100 })
    res.json({ jobs })
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : 'Failed to list jobs' })
  }
})

export { router as memoryRouter }
