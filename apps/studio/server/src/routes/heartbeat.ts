import { Router } from 'express'
import { getAgentById, updateAgent } from '@jiku-studio/db'
import { authMiddleware } from '../middleware/auth.ts'
import { requirePermission } from '../middleware/permission.ts'
import { heartbeatScheduler } from '../task/heartbeat.ts'
import { runtimeManager } from '../runtime/manager.ts'

const router = Router()
router.use(authMiddleware)

// GET /agents/:aid/heartbeat — get heartbeat status for an agent
router.get('/agents/:aid/heartbeat', requirePermission('agents:read'), async (req, res) => {
  const agent = await getAgentById(req.params['aid']!)
  if (!agent) { res.status(404).json({ error: 'Agent not found' }); return }

  res.json({
    heartbeat_enabled: agent.heartbeat_enabled,
    heartbeat_cron: agent.heartbeat_cron ?? null,
    heartbeat_prompt: agent.heartbeat_prompt ?? null,
    heartbeat_last_run_at: agent.heartbeat_last_run_at ?? null,
    heartbeat_next_run_at: agent.heartbeat_next_run_at ?? null,
  })
})

// PATCH /agents/:aid/heartbeat — update heartbeat config
router.patch('/agents/:aid/heartbeat', requirePermission('agents:write'), async (req, res) => {
  const agentId = req.params['aid']!
  const agent = await getAgentById(agentId)
  if (!agent) { res.status(404).json({ error: 'Agent not found' }); return }

  const body = req.body as {
    heartbeat_enabled?: boolean
    heartbeat_cron?: string | null
    heartbeat_prompt?: string | null
  }

  const updated = await updateAgent(agentId, {
    heartbeat_enabled: body.heartbeat_enabled ?? agent.heartbeat_enabled,
    heartbeat_cron: body.heartbeat_cron !== undefined ? (body.heartbeat_cron ?? undefined) : agent.heartbeat_cron ?? undefined,
    heartbeat_prompt: body.heartbeat_prompt !== undefined ? (body.heartbeat_prompt ?? undefined) : agent.heartbeat_prompt ?? undefined,
  })

  // Reschedule in runtime
  await heartbeatScheduler.rescheduleAgent(agentId, agent.project_id)

  res.json({
    heartbeat_enabled: updated.heartbeat_enabled,
    heartbeat_cron: updated.heartbeat_cron ?? null,
    heartbeat_prompt: updated.heartbeat_prompt ?? null,
    heartbeat_last_run_at: updated.heartbeat_last_run_at ?? null,
    heartbeat_next_run_at: updated.heartbeat_next_run_at ?? null,
  })
})

// POST /agents/:aid/heartbeat/trigger — manual trigger
router.post('/agents/:aid/heartbeat/trigger', requirePermission('agents:write'), async (req, res) => {
  const agentId = req.params['aid']!
  const agent = await getAgentById(agentId)
  if (!agent) { res.status(404).json({ error: 'Agent not found' }); return }

  // Ensure runtime is awake
  await runtimeManager.getRuntime(agent.project_id)

  const conversationId = await heartbeatScheduler.triggerHeartbeat(agentId, agent.project_id)
  res.json({ ok: true, conversation_id: conversationId })
})

export { router as heartbeatRouter }
