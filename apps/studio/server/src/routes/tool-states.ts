import { Router } from 'express'
import { authMiddleware } from '../middleware/auth.ts'
import { requirePermission } from '../middleware/permission.ts'
import { getToolStates, setAgentToolState, deleteAgentToolState } from '@jiku-studio/db'
import { getAgentById } from '@jiku-studio/db'

const router = Router()
router.use(authMiddleware)

/** GET /agents/:aid/tools — list all tools with their on/off state */
router.get('/agents/:aid/tools/states', requirePermission('agents:read'), async (req, res) => {
  const agentId = req.params['aid']!
  const agent = await getAgentById(agentId)
  if (!agent) { res.status(404).json({ error: 'Agent not found' }); return }

  const states = await getToolStates(agent.project_id, agentId)
  res.json({ states })
})

/** PATCH /agents/:aid/tools/:toolId — toggle tool on/off */
router.patch('/agents/:aid/tools/:toolId/state', requirePermission('agents:write'), async (req, res) => {
  const agentId = req.params['aid']!
  const toolId = decodeURIComponent(req.params['toolId']!)
  const { enabled } = req.body as { enabled: boolean }

  if (typeof enabled !== 'boolean') {
    res.status(400).json({ error: 'enabled must be a boolean' })
    return
  }

  await setAgentToolState(agentId, toolId, enabled)
  res.json({ ok: true, tool_id: toolId, enabled })
})

/** DELETE /agents/:aid/tools/:toolId/state — reset to default (remove override) */
router.delete('/agents/:aid/tools/:toolId/state', requirePermission('agents:write'), async (req, res) => {
  const agentId = req.params['aid']!
  const toolId = decodeURIComponent(req.params['toolId']!)
  await deleteAgentToolState(agentId, toolId)
  res.json({ ok: true })
})

export { router as toolStatesRouter }
