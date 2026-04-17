import { Router } from 'express'
import { authMiddleware } from '../middleware/auth.ts'
import { requirePermission } from '../middleware/permission.ts'
import { runtimeManager } from '../runtime/manager.ts'
import { mcpManager } from '../mcp/client.ts'
import { getMcpServersByProject } from '@jiku-studio/db'

const router = Router()
router.use(authMiddleware)

/**
 * GET /projects/:pid/tools — list all resolved tools available in this project.
 *
 * Merges two sources:
 *   1. Plugin tools — from PluginLoader.getResolvedTools (system-scoped +
 *      project-activated plugins).
 *   2. MCP tools — from connected MCP servers scoped to this project.
 *
 * Each tool includes: id, name, description, group, modes, source (plugin_id
 * or mcp server name), permission, side_effectful flag. Read-only — no CRUD;
 * enable/disable is managed via project_tool_states (separate endpoint).
 */
router.get('/projects/:pid/tools', requirePermission('agents:read'), async (req, res) => {
  const projectId = req.params['pid']!
  const loader = runtimeManager.getPluginLoader()

  // Built-in tools (system, connector, filesystem, browser, memory, cron, etc.)
  const builtInTools = runtimeManager.getBuiltInTools(projectId).map(t => ({
    id: t.meta.id,
    tool_name: t.meta.id,
    name: t.meta.name,
    description: t.meta.description,
    group: t.meta.group ?? null,
    modes: t.modes,
    permission: t.permission ?? '*',
    plugin_id: null as string | null,
    source_type: 'builtin' as const,
    source_label: 'Built-in',
    side_effectful: (t.meta as { side_effectful?: boolean }).side_effectful ?? false,
  }))

  // Plugin tools
  const pluginTools = (loader?.getResolvedTools(projectId) ?? []).map(t => ({
    id: t.resolved_id,
    tool_name: t.tool_name,
    name: t.meta.name,
    description: t.meta.description,
    group: t.meta.group ?? null,
    modes: t.modes,
    permission: t.resolved_permission,
    plugin_id: t.plugin_id,
    source_type: 'plugin' as const,
    source_label: t.plugin_id,
    side_effectful: (t.meta as { side_effectful?: boolean }).side_effectful ?? false,
  }))

  // MCP tools from servers belonging to this project
  const mcpServers = await getMcpServersByProject(projectId)
  const mcpTools = mcpServers
    .filter(s => s.enabled)
    .flatMap(s => {
      const tools = mcpManager.getServerTools(s.id)
      return tools.map(t => ({
        id: `mcp:${s.id}:${t.meta.id}`,
        tool_name: t.meta.id,
        name: t.meta.name,
        description: t.meta.description,
        group: t.meta.group ?? 'mcp',
        modes: t.modes ?? ['chat', 'task'],
        permission: '*',
        plugin_id: null as string | null,
        source_type: 'mcp' as const,
        source_label: s.name,
        side_effectful: false,
      }))
    })

  res.json({ tools: [...builtInTools, ...pluginTools, ...mcpTools] })
})

export { router as toolsRouter }
