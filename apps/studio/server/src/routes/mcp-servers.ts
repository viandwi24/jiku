import { Router } from 'express'
import { authMiddleware } from '../middleware/auth.ts'
import { requirePermission } from '../middleware/permission.ts'
import {
  getMcpServersByProject, getMcpServerById, createMcpServer,
  updateMcpServer, deleteMcpServer,
} from '@jiku-studio/db'
import { mcpManager } from '../mcp/client.ts'

const router = Router()
router.use(authMiddleware)

/** GET /projects/:pid/mcp-servers */
router.get('/projects/:pid/mcp-servers', requirePermission('settings:read'), async (req, res) => {
  const projectId = req.params['pid']!
  const servers = await getMcpServersByProject(projectId)
  const statuses = mcpManager.getStatus()
  const statusMap = new Map(statuses.map(s => [s.id, s]))

  res.json({
    servers: servers.map(s => ({
      ...s,
      connected: statusMap.get(s.id)?.connected ?? false,
      tool_count: statusMap.get(s.id)?.toolCount ?? 0,
    })),
  })
})

/** POST /projects/:pid/mcp-servers */
router.post('/projects/:pid/mcp-servers', requirePermission('settings:write'), async (req, res) => {
  const projectId = req.params['pid']!
  const { name, transport, config, agent_id, enabled } = req.body as {
    name: string; transport: string; config: Record<string, unknown>; agent_id?: string; enabled?: boolean
  }

  const server = await createMcpServer({
    project_id: projectId, name, transport, config, agent_id, enabled,
  })

  // Auto-connect if enabled
  if (server.enabled) {
    mcpManager.connect({
      id: server.id, name: server.name,
      transport: server.transport as 'stdio' | 'sse' | 'streamable-http',
      config: server.config as Record<string, unknown>,
    }).catch(err => console.error('[mcp] auto-connect failed:', err))
  }

  res.status(201).json({ server })
})

/** PATCH /mcp-servers/:id */
router.patch('/mcp-servers/:id', requirePermission('settings:write'), async (req, res) => {
  const id = req.params['id']!
  const server = await updateMcpServer(id, req.body)
  if (!server) { res.status(404).json({ error: 'Not found' }); return }

  // Reconnect if config changed
  if (server.enabled) {
    mcpManager.connect({
      id: server.id, name: server.name,
      transport: server.transport as 'stdio' | 'sse' | 'streamable-http',
      config: server.config as Record<string, unknown>,
    }).catch(err => console.error('[mcp] reconnect failed:', err))
  } else {
    mcpManager.disconnect(server.id).catch(() => {})
  }

  res.json({ server })
})

/** DELETE /mcp-servers/:id */
router.delete('/mcp-servers/:id', requirePermission('settings:write'), async (req, res) => {
  const id = req.params['id']!
  await mcpManager.disconnect(id)
  await deleteMcpServer(id)
  res.json({ ok: true })
})

/** POST /mcp-servers/:id/test — test connection */
router.post('/mcp-servers/:id/test', requirePermission('settings:write'), async (req, res) => {
  const id = req.params['id']!
  const server = await getMcpServerById(id)
  if (!server) { res.status(404).json({ error: 'Not found' }); return }

  try {
    await mcpManager.connect({
      id: server.id, name: server.name,
      transport: server.transport as 'stdio' | 'sse' | 'streamable-http',
      config: server.config as Record<string, unknown>,
    })
    const tools = mcpManager.getServerTools(server.id)
    res.json({ success: true, tool_count: tools.length, tools: tools.map(t => ({ id: t.meta.id, name: t.meta.name })) })
  } catch (err) {
    res.json({ success: false, error: err instanceof Error ? err.message : 'Connection failed' })
  }
})

export { router as mcpServersRouter }
