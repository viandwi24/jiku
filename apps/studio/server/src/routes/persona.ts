import { Router } from 'express'
import { authMiddleware } from '../middleware/auth.ts'
import { requirePermission } from '../middleware/permission.ts'
import {
  getAgentById,
  updateAgentPersonaSeed,
  updateAgentPersonaPrompt,
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
router.get('/agents/:aid/persona/memories', authMiddleware, requirePermission('agents:read'), async (req, res) => {
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
router.get('/agents/:aid/persona/seed', authMiddleware, requirePermission('agents:read'), async (req, res) => {
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
router.patch('/agents/:aid/persona/seed', authMiddleware, requirePermission('agents:write'), async (req, res) => {
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
router.post('/agents/:aid/persona/reset', authMiddleware, requirePermission('agents:write'), async (req, res) => {
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

/**
 * GET /agents/:aid/persona/prompt
 * Get the plain-text persona prompt.
 */
router.get('/agents/:aid/persona/prompt', authMiddleware, requirePermission('agents:read'), async (req, res) => {
  const agentId = req.params['aid']! as string
  try {
    const agent = await getAgentById(agentId)
    if (!agent) { res.status(404).json({ error: 'Agent not found' }); return }
    res.json({ prompt: (agent as Record<string, unknown>).persona_prompt ?? null })
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : 'Failed to get persona prompt' })
  }
})

/**
 * PATCH /agents/:aid/persona/prompt
 * Update the plain-text persona prompt.
 */
router.patch('/agents/:aid/persona/prompt', authMiddleware, requirePermission('agents:write'), async (req, res) => {
  const agentId = req.params['aid']! as string
  const { prompt } = req.body as { prompt: string | null }
  try {
    const agent = await getAgentById(agentId)
    if (!agent) { res.status(404).json({ error: 'Agent not found' }); return }
    await updateAgentPersonaPrompt(agentId, prompt ?? null)
    await runtimeManager.syncAgent(agent.project_id, agentId)
    res.json({ prompt })
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : 'Failed to update persona prompt' })
  }
})

export { router as personaRouter }
