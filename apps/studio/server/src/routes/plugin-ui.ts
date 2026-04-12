// Plan 17 — Plugin UI runtime routes.
//   GET    /api/plugins/ui-registry?project=:p             → manifest (slots + entries + meta)
//   GET    /api/plugins/:pid/storage?key=K                 → read KV  (scoped per project × plugin)
//   PUT    /api/plugins/:pid/storage                       → write KV
//   DELETE /api/plugins/:pid/storage?key=K                 → delete KV
//   GET    /api/plugins/:pid/storage/keys?prefix=P         → list keys
//   POST   /api/plugins/:pid/tools/:toolId/invoke          → invoke a resolved tool
//   GET    /api/plugins/:pid/tools                         → list tools (filtered by plugin)
//   ALL    /api/plugins/:pid/api/*                         → plugin-defined route handler passthrough
//   GET    /api/plugins/:pid/events?project=:p             → SSE stream of plugin events
//   GET    /api/plugins/:pid/inspector                     → inspector metrics (routes, tools, last error, stats)
//   GET    /api/plugins/audit                              → audit log viewer feed

import { Router } from 'express'
import type { Request } from 'express'
import { authMiddleware } from '../middleware/auth.ts'
import { loadPerms } from '../middleware/permission.ts'
import {
  pluginKvGet,
  pluginKvSet,
  pluginKvDelete,
  pluginKvKeys,
  writeAuditLog,
  listAuditLog,
  getProjectById,
} from '@jiku-studio/db'
import { buildUIRegistry } from '../plugins/ui/registry.ts'
import { resolvePluginRoute, listPluginRoutes } from '../plugins/ui/http-registry.ts'
import { subscribe } from '../plugins/ui/event-bus.ts'
import { runtimeManager } from '../runtime/manager.ts'
import { recordApiCall, recordToolInvoke, recordError, getPluginMetrics } from '../plugins/ui/metrics.ts'

const router = Router()
router.use(authMiddleware)

// ─── Helper: resolve project from query string / body ──────────────────────

async function resolveProjectFromQuery(req: Request): Promise<string | null> {
  const fromQuery = req.query['project']
  if (typeof fromQuery === 'string' && fromQuery.length > 0) return fromQuery
  const body = req.body as { project?: string } | undefined
  if (body?.project) return body.project
  return null
}

// ─── UI registry ────────────────────────────────────────────────────────────

router.get('/plugins/ui-registry', async (req, res) => {
  const projectId = await resolveProjectFromQuery(req)
  if (!projectId) { res.status(400).json({ error: 'project query param required' }); return }
  const project = await getProjectById(projectId)
  if (!project) { res.status(404).json({ error: 'Project not found' }); return }
  const out = await buildUIRegistry(projectId)
  res.json(out)
})

// ─── Storage ────────────────────────────────────────────────────────────────

router.get('/plugins/:pid/storage', async (req, res) => {
  const pluginId = req.params['pid']!
  const projectId = await resolveProjectFromQuery(req)
  const key = req.query['key']
  if (!projectId) { res.status(400).json({ error: 'project query param required' }); return }
  if (typeof key !== 'string') { res.status(400).json({ error: 'key query param required' }); return }
  const value = await pluginKvGet(projectId, pluginId, key)
  res.json({ value })
})

router.put('/plugins/:pid/storage', async (req, res) => {
  const pluginId = req.params['pid']!
  const body = req.body as { project: string; key: string; value: unknown }
  if (!body.project || !body.key) { res.status(400).json({ error: 'project and key required' }); return }
  await pluginKvSet(body.project, pluginId, body.key, body.value)
  res.json({ ok: true })
})

router.delete('/plugins/:pid/storage', async (req, res) => {
  const pluginId = req.params['pid']!
  const projectId = await resolveProjectFromQuery(req)
  const key = req.query['key']
  if (!projectId) { res.status(400).json({ error: 'project query param required' }); return }
  if (typeof key !== 'string') { res.status(400).json({ error: 'key query param required' }); return }
  await pluginKvDelete(projectId, pluginId, key)
  res.json({ ok: true })
})

router.get('/plugins/:pid/storage/keys', async (req, res) => {
  const pluginId = req.params['pid']!
  const projectId = await resolveProjectFromQuery(req)
  if (!projectId) { res.status(400).json({ error: 'project query param required' }); return }
  const prefix = typeof req.query['prefix'] === 'string' ? req.query['prefix'] : undefined
  const keys = await pluginKvKeys(projectId, pluginId, prefix)
  res.json({ keys })
})

// ─── Tools: list + invoke ───────────────────────────────────────────────────

router.get('/plugins/:pid/tools', async (req, res) => {
  const pluginId = req.params['pid']!
  const projectId = await resolveProjectFromQuery(req)
  if (!projectId) { res.status(400).json({ error: 'project query param required' }); return }
  const loader = runtimeManager.getPluginLoader()
  const all = loader?.getResolvedTools(projectId) ?? []
  const tools = all
    .filter(t => t.plugin_id === pluginId)
    .map(t => ({
      id: t.resolved_id,
      name: t.meta.name,
      description: t.meta.description,
      plugin_id: t.plugin_id,
    }))
  res.json({ tools })
})

router.post('/plugins/:pid/tools/:toolId/invoke', async (req, res) => {
  const pluginId = req.params['pid']!
  const toolId = req.params['toolId']!
  const body = req.body as { project?: string; input?: unknown }
  const projectId = body.project
  if (!projectId) { res.status(400).json({ error: 'project required' }); return }

  const userId = res.locals['user_id'] as string

  try {
    const loader = runtimeManager.getPluginLoader()
    const all = loader?.getResolvedTools(projectId) ?? []
    const tool = all.find(t =>
      (t.resolved_id === toolId || t.resolved_id === `${pluginId}:${toolId}`) &&
      t.plugin_id === pluginId,
    )
    if (!tool) {
      res.status(404).json({ error: `Tool "${toolId}" not found in plugin "${pluginId}"` })
      recordToolInvoke(pluginId, false)
      return
    }

    // Minimal caller/runtime ctx for direct tool invocation from UI.
    const storageShim = {
      get: async (key: string) => pluginKvGet(projectId, pluginId, key),
      set: async (key: string, value: unknown) => pluginKvSet(projectId, pluginId, key, value),
      delete: async (key: string) => pluginKvDelete(projectId, pluginId, key),
      keys: async (prefix?: string) => pluginKvKeys(projectId, pluginId, prefix),
    }
    const result = await tool.execute(body.input ?? {}, {
      runtime: {
        caller: { user_id: userId, roles: [], permissions: [], user_data: {} },
        agent: { id: '__ui__', name: 'plugin-ui', mode: 'chat' },
        conversation_id: '__ui__',
        run_id: `ui-${Date.now()}`,
      },
      storage: storageShim,
      writer: { write: () => {} },
    })
    recordToolInvoke(pluginId, true)
    await writeAuditLog({
      project_id: projectId,
      plugin_id: pluginId,
      user_id: userId,
      action: 'tool.invoke',
      target: tool.resolved_id,
      outcome: 'ok',
      meta: null,
    }).catch(() => {})
    res.json({ result })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    recordToolInvoke(pluginId, false)
    recordError(pluginId, 'tool.invoke', message)
    await writeAuditLog({
      project_id: projectId,
      plugin_id: pluginId,
      user_id: userId,
      action: 'tool.invoke',
      target: toolId,
      outcome: 'error',
      meta: { message },
    }).catch(() => {})
    res.status(500).json({ error: message })
  }
})

// ─── Plugin-defined API passthrough ────────────────────────────────────────
// Matches /api/plugins/:pid/api/<any subpath>. The plugin has registered the
// handler at setup time via ctx.http.*
// Implemented as middleware (not `router.all(regex)`) for Express 5 robustness.

const API_PASSTHROUGH_RX = /^\/plugins\/([^/]+)\/api\/(.+)$/

router.use(async (req, res, next) => {
  const match = req.path.match(API_PASSTHROUGH_RX)
  if (!match) return next()
  const pluginId = match[1]!
  const subPath = `/${match[2]!}`
  const method = req.method.toLowerCase() as 'get' | 'post' | 'put' | 'patch' | 'delete'

  const projectId = (await resolveProjectFromQuery(req)) ?? (req.headers['x-jiku-project'] as string | undefined)
  if (!projectId) { res.status(400).json({ error: 'project required (query param or X-Jiku-Project header)' }); return }

  const handler = resolvePluginRoute(pluginId, method, subPath)
  if (!handler) { res.status(404).json({ error: `No ${method.toUpperCase()} ${subPath} handler for plugin ${pluginId}` }); return }

  const userId = res.locals['user_id'] as string
  const start = Date.now()
  try {
    const out = await handler({ projectId, userId, pluginId, req, res })
    const duration = Date.now() - start
    recordApiCall(pluginId, duration, true)
    // If the handler already responded (called res.send/res.json), don't double-send.
    if (!res.headersSent) {
      res.json(out ?? { ok: true })
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    const duration = Date.now() - start
    recordApiCall(pluginId, duration, false)
    recordError(pluginId, `api ${method} ${subPath}`, message)
    if (!res.headersSent) res.status(500).json({ error: message })
  }
})

// ─── Events SSE ─────────────────────────────────────────────────────────────

router.get('/plugins/:pid/events', async (req, res) => {
  const pluginId = req.params['pid']!
  const projectId = await resolveProjectFromQuery(req)
  if (!projectId) { res.status(400).json({ error: 'project required' }); return }

  res.setHeader('Content-Type', 'text/event-stream')
  res.setHeader('Cache-Control', 'no-cache, no-transform')
  res.setHeader('Connection', 'keep-alive')
  res.flushHeaders?.()
  res.write(`:connected ${Date.now()}\n\n`)

  const sub = { pluginId, projectId, res }
  const unsubscribe = subscribe(sub)

  const keepalive = setInterval(() => {
    try { res.write(`: ping\n\n`) } catch { /* client gone */ }
  }, 25_000)

  req.on('close', () => {
    clearInterval(keepalive)
    unsubscribe()
  })
})

// ─── Inspector ──────────────────────────────────────────────────────────────

router.get('/plugins/:pid/inspector', async (req, res) => {
  await loadPerms(req, res)
  const pluginId = req.params['pid']!
  const routes = listPluginRoutes(pluginId)
  const metrics = getPluginMetrics(pluginId)

  const loader = runtimeManager.getPluginLoader()
  const def = loader?.getAllPlugins().find(p => p.meta.id === pluginId)

  res.json({
    plugin: def ? {
      id: def.meta.id,
      name: def.meta.name,
      version: def.meta.version,
      apiVersion: def.ui?.apiVersion ?? '1',
      ui_entries: def.ui?.entries ?? [],
    } : null,
    routes,
    metrics,
  })
})

router.get('/plugins/audit', async (req, res) => {
  const projectId = typeof req.query['project'] === 'string' ? req.query['project'] : undefined
  const pluginId = typeof req.query['plugin'] === 'string' ? req.query['plugin'] : undefined
  const limit = typeof req.query['limit'] === 'string' ? parseInt(req.query['limit'], 10) : 100
  const rows = await listAuditLog({ projectId, pluginId, limit })
  res.json({ entries: rows })
})

export { router as pluginUiRouter }
