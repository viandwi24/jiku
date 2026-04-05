import { Router } from 'express'
import { authMiddleware } from '../middleware/auth.ts'
import {
  getAgentById,
  updateAgentPersonaSeed,
  resetAgentPersona,
  getAgentSelfMemories,
} from '@jiku-studio/db'
import { runtimeManager } from '../runtime/manager.ts'
import type { PersonaSeed } from '@jiku/types'

const router = Router()

/**
 * GET /agents/:aid/persona/memories
 * List all agent_self memories (live persona managed by agent).
 */
router.get('/agents/:aid/persona/memories', authMiddleware, async (req, res) => {
  const agentId = req.params['aid']! as string
  try {
    const memories = await getAgentSelfMemories(agentId)
    res.json({ memories })
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : 'Failed to get persona memories' })
  }
})

/**
 * GET /agents/:aid/persona/seed
 * Get the current persona seed config.
 */
router.get('/agents/:aid/persona/seed', authMiddleware, async (req, res) => {
  const agentId = req.params['aid']! as string
  try {
    const agent = await getAgentById(agentId)
    if (!agent) { res.status(404).json({ error: 'Agent not found' }); return }
    res.json({
      seed: (agent.persona_seed as PersonaSeed | null) ?? null,
      seeded_at: agent.persona_seeded_at ?? null,
    })
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : 'Failed to get persona seed' })
  }
})

/**
 * PATCH /agents/:aid/persona/seed
 * Update the persona seed. Does not affect already-seeded persona memories.
 */
router.patch('/agents/:aid/persona/seed', authMiddleware, async (req, res) => {
  const agentId = req.params['aid']! as string
  const seed = req.body as PersonaSeed | null
  try {
    const agent = await getAgentById(agentId)
    if (!agent) { res.status(404).json({ error: 'Agent not found' }); return }
    await updateAgentPersonaSeed(agentId, seed as Record<string, unknown> | null)
    // Sync the agent in the runtime so the updated seed is reflected
    await runtimeManager.syncAgent(agent.project_id, agentId)
    res.json({ seed })
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : 'Failed to update persona seed' })
  }
})

/**
 * POST /agents/:aid/persona/reset
 * Delete all agent_self memories and clear persona_seeded_at.
 * Next run will re-seed from persona_seed.
 */
router.post('/agents/:aid/persona/reset', authMiddleware, async (req, res) => {
  const agentId = req.params['aid']! as string
  try {
    const agent = await getAgentById(agentId)
    if (!agent) { res.status(404).json({ error: 'Agent not found' }); return }
    await resetAgentPersona(agentId)
    // Sync the agent in the runtime
    await runtimeManager.syncAgent(agent.project_id, agentId)
    res.json({ success: true })
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : 'Failed to reset persona' })
  }
})

export { router as personaRouter }
