import { Router } from 'express'
import { authMiddleware } from '../middleware/auth.ts'
import {
  listProjectMemories,
  deleteMemory,
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
router.get('/projects/:pid/memories', authMiddleware, async (req, res) => {
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
    await deleteMemory(memoryId)
    res.json({ success: true })
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : 'Failed to delete memory' })
  }
})

// ──────────────────────────────────────────────────────────────
// Memory Config — Project level
// ──────────────────────────────────────────────────────────────

/**
 * GET /projects/:pid/memory-config
 */
router.get('/projects/:pid/memory-config', authMiddleware, async (req, res) => {
  const projectId = req.params['pid']! as string
  try {
    const project = await getProjectById(projectId)
    if (!project) { res.status(404).json({ error: 'Project not found' }); return }
    const config = (project.memory_config as ProjectMemoryConfig | null) ?? DEFAULT_PROJECT_MEMORY_CONFIG
    res.json({ config })
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : 'Failed to get memory config' })
  }
})

/**
 * PATCH /projects/:pid/memory-config
 */
router.patch('/projects/:pid/memory-config', authMiddleware, async (req, res) => {
  const projectId = req.params['pid']! as string
  const updates = req.body as Partial<ProjectMemoryConfig>
  try {
    const project = await getProjectById(projectId)
    if (!project) { res.status(404).json({ error: 'Project not found' }); return }

    const current = (project.memory_config as ProjectMemoryConfig | null) ?? DEFAULT_PROJECT_MEMORY_CONFIG
    const merged = deepMerge(current as Record<string, unknown>, updates as Record<string, unknown>) as ProjectMemoryConfig

    await updateProjectMemoryConfig(projectId, merged)
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
router.get('/agents/:aid/memory-config', authMiddleware, async (req, res) => {
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
router.patch('/agents/:aid/memory-config', authMiddleware, async (req, res) => {
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
router.get('/agents/:aid/memory-config/resolved', authMiddleware, async (req, res) => {
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

export { router as memoryRouter }
