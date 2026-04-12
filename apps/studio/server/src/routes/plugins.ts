import { Router } from 'express'
import {
  getAllPluginRows,
  getPluginById,
  getProjectPlugins,
  getEnabledProjectPlugins,
  enablePlugin,
  disablePlugin,
  updatePluginConfig,
  getProjectById,
} from '@jiku-studio/db'
import { authMiddleware } from '../middleware/auth.ts'
import { requirePermission } from '../middleware/permission.ts'
import { runtimeManager } from '../runtime/manager.ts'

const router = Router()
router.use(authMiddleware)

// ─── Plugin registry ────────────────────────────────────────────────────────

router.get('/plugins', async (_req, res) => {
  const plugins = await getAllPluginRows()
  res.json({ plugins })
})

router.get('/plugins/:id', async (req, res) => {
  const plugin = await getPluginById(req.params['id']!)
  if (!plugin) { res.status(404).json({ error: 'Plugin not found' }); return }
  res.json({ plugin })
})

router.get('/plugins/:id/config-schema', async (req, res) => {
  const plugin = await getPluginById(req.params['id']!)
  if (!plugin) { res.status(404).json({ error: 'Plugin not found' }); return }
  res.json({ schema: plugin.config_schema ?? {} })
})

// ─── Project plugin management ───────────────────────────────────────────────

router.get('/projects/:pid/plugins', requirePermission('plugins:read'), async (req, res) => {
  const projectId = req.params['pid']!
  const project = await getProjectById(projectId)
  if (!project) { res.status(404).json({ error: 'Project not found' }); return }

  // Get all plugins with project status overlaid
  const [allPlugins, projectPlugins] = await Promise.all([
    getAllPluginRows(),
    getProjectPlugins(projectId),
  ])

  const projectPluginMap = new Map(projectPlugins.map(p => [p.plugin_id, p]))

  const plugins = allPlugins.map(p => {
    const pp = projectPluginMap.get(p.id)
    // System plugins (project_scope=false) are always active
    const isSystemPlugin = !p.project_scope
    return {
      ...p,
      enabled: isSystemPlugin ? true : (pp?.enabled ?? false),
      config: pp?.config ?? {},
      activated_at: pp?.activated_at ?? null,
    }
  })

  res.json({ plugins })
})

router.get('/projects/:pid/plugins/active', requirePermission('plugins:read'), async (req, res) => {
  const projectId = req.params['pid']!
  const project = await getProjectById(projectId)
  if (!project) { res.status(404).json({ error: 'Project not found' }); return }

  const [allPlugins, projectPlugins] = await Promise.all([
    getAllPluginRows(),
    getEnabledProjectPlugins(projectId),
  ])

  const projectPluginMap = new Map(projectPlugins.map(p => [p.plugin_id, p]))

  // System plugins (project_scope=false) are always active for every project.
  // Project-scoped plugins are only active if explicitly enabled.
  const active = allPlugins
    .filter(p => !p.project_scope || projectPluginMap.has(p.id))
    .map(p => {
      const pp = projectPluginMap.get(p.id)
      return {
        id: pp?.id ?? `system:${p.id}`,
        project_id: projectId,
        plugin_id: p.id,
        enabled: true,
        config: pp?.config ?? {},
        activated_at: pp?.activated_at ?? null,
      }
    })

  res.json({ plugins: active })
})

router.post('/projects/:pid/plugins/:pluginId/enable', requirePermission('plugins:write'), async (req, res) => {
  const projectId = req.params['pid']!
  const pluginId = req.params['pluginId']!
  const config = (req.body as { config?: Record<string, unknown> }).config ?? {}

  const project = await getProjectById(projectId)
  if (!project) { res.status(404).json({ error: 'Project not found' }); return }

  const plugin = await getPluginById(pluginId)
  if (!plugin) { res.status(404).json({ error: 'Plugin not found' }); return }

  // Validate config against plugin's Zod schema if available
  if (plugin.config_schema && Object.keys(config).length > 0) {
    const loaderPlugin = runtimeManager.getPluginLoader()?.getAllPlugins().find(p => p.meta.id === pluginId)
    if (loaderPlugin?.configSchema) {
      const schema = loaderPlugin.configSchema as { safeParse?: (v: unknown) => { success: boolean; error?: { message: string } } }
      if (typeof schema.safeParse === 'function') {
        const result = schema.safeParse(config)
        if (!result.success) {
          res.status(400).json({ error: result.error?.message ?? 'Invalid config' }); return
        }
      }
    }
  }

  // Upsert enabled state in DB
  const row = await enablePlugin(projectId, pluginId, config)

  // Activate in runtime
  await runtimeManager.activatePlugin(projectId, pluginId, config)

  res.json({ plugin: row })
})

router.post('/projects/:pid/plugins/:pluginId/disable', requirePermission('plugins:write'), async (req, res) => {
  const projectId = req.params['pid']!
  const pluginId = req.params['pluginId']!

  const project = await getProjectById(projectId)
  if (!project) { res.status(404).json({ error: 'Project not found' }); return }

  // Update DB
  const row = await disablePlugin(projectId, pluginId)

  // Deactivate in runtime
  await runtimeManager.deactivatePlugin(projectId, pluginId)

  res.json({ plugin: row })
})

router.patch('/projects/:pid/plugins/:pluginId/config', requirePermission('plugins:write'), async (req, res) => {
  const projectId = req.params['pid']!
  const pluginId = req.params['pluginId']!
  const config = req.body as Record<string, unknown>

  const project = await getProjectById(projectId)
  if (!project) { res.status(404).json({ error: 'Project not found' }); return }

  const plugin = await getPluginById(pluginId)
  if (!plugin) { res.status(404).json({ error: 'Plugin not found' }); return }

  // Validate config against plugin's Zod schema if available
  if (plugin.config_schema) {
    const loaderPlugin = runtimeManager.getPluginLoader()?.getAllPlugins().find(p => p.meta.id === pluginId)
    if (loaderPlugin?.configSchema) {
      const schema = loaderPlugin.configSchema as { safeParse?: (v: unknown) => { success: boolean; error?: { message: string } } }
      if (typeof schema.safeParse === 'function') {
        const result = schema.safeParse(config)
        if (!result.success) {
          res.status(400).json({ error: result.error?.message ?? 'Invalid config' }); return
        }
      }
    }
  }

  const row = await updatePluginConfig(projectId, pluginId, config)

  // Re-activate with new config to trigger onProjectPluginActivated lifecycle
  await runtimeManager.activatePlugin(projectId, pluginId, config)

  res.json({ plugin: row })
})

export { router as pluginsRouter }
