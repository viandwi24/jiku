import express from 'express'
import cors from 'cors'
import { authRouter } from './routes/auth.ts'
import { companiesRouter } from './routes/companies.ts'
import { projectsRouter } from './routes/projects.ts'
import { agentsRouter } from './routes/agents.ts'
import { policiesRouter } from './routes/policies.ts'
import { conversationsRouter } from './routes/conversations.ts'
import { credentialsRouter } from './routes/credentials.ts'
import { chatRouter } from './routes/chat.ts'
import { previewRouter } from './routes/preview.ts'
import { pluginsRouter } from './routes/plugins.ts'
import { pluginUiRouter } from './routes/plugin-ui.ts'
import { pluginAssetsRouter } from './routes/plugin-assets.ts'
import { extendPluginContext } from './plugins/ui/context-extender.ts'
import { memoryRouter } from './routes/memory.ts'
import { personaRouter } from './routes/persona.ts'
import connectorsRouter from './routes/connectors.ts'
import { runsRouter } from './routes/runs.ts'
import { heartbeatRouter } from './routes/heartbeat.ts'
import { browserRouter } from './routes/browser.ts'
import { browserProfilesRouter } from './routes/browser-profiles.ts'
// Side-effect import: registers the built-in `jiku.browser.vercel` adapter.
import './browser/index.ts'
import { filesystemRouter } from './routes/filesystem.ts'
import { attachmentsRouter } from './routes/attachments.ts'
import { aclRolesRouter } from './routes/acl-roles.ts'
import { aclMembersRouter } from './routes/acl-members.ts'
import { aclInvitationsRouter } from './routes/acl-invitations.ts'
import { skillsRouter } from './routes/skills.ts'
import { cronTasksRouter } from './routes/cron-tasks.ts'
import { mcpServersRouter } from './routes/mcp-servers.ts'
import { toolStatesRouter } from './routes/tool-states.ts'
import { auditRouter } from './routes/audit.ts'
import { pluginPermissionsRouter } from './routes/plugin-permissions.ts'
import { runtimeManager } from './runtime/manager.ts'
import { startBrowserTabCleanup } from './browser/tab-manager.ts'
import { startStorageCleanupWorker } from './filesystem/worker.ts'
import { backgroundWorker } from './jobs/worker.ts'
import { registerAllJobHandlers } from './jobs/register.ts'
import { dreamScheduler } from './jobs/dream-scheduler.ts'
import { seedPluginRegistry } from './plugins/seed.ts'
import { NarrationPlugin } from './plugins/narration.ts'
import { connectorRegistry } from './connectors/registry.ts'
import { PluginLoader, discoverPluginsFromFolder } from '@jiku/core'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { checkDbConnection, seedPermissions, getAllProjects, deleteExpiredMemories } from '@jiku-studio/db'
import { env } from './env.ts'
import { globalRateLimit } from './middleware/rate-limit.ts'

const app = express()

app.use(cors())
app.use(express.json({ limit: '10mb' }))

// Plan 18 — global rate limit on all API routes (keyed by user_id fallback IP).
app.use('/api', globalRateLimit)

// Attachments router must be registered FIRST — the inline endpoint (/api/attachments/:id/inline)
// uses a query-string token instead of Authorization header, so it must not be intercepted by
// any router that calls router.use(authMiddleware) without a matching route.
app.use('/api', attachmentsRouter)
app.use('/', attachmentsRouter)  // /files/view proxy is at root level

// Plan 17 — plugin UI asset router is PUBLIC (no auth) and must be registered
// BEFORE any router that calls `router.use(authMiddleware)` globally, otherwise
// unauth'd dynamic-import requests get 401'd by the first such router they hit
// before they can fall through here.
app.use('/api', pluginAssetsRouter)

app.use('/api/auth', authRouter)
app.use('/api/companies', companiesRouter)
app.use('/api', projectsRouter)
app.use('/api', agentsRouter)
app.use('/api', policiesRouter)
app.use('/api', conversationsRouter)
app.use('/api', credentialsRouter)
app.use('/api', chatRouter)
app.use('/api', previewRouter)
app.use('/api', pluginUiRouter)
app.use('/api', pluginsRouter)
app.use('/api', memoryRouter)
app.use('/api', personaRouter)
app.use('/api', connectorsRouter)
app.use('/', connectorsRouter)  // webhook routes are at /webhook/:project_id/...
app.use('/api', runsRouter)
app.use('/api', heartbeatRouter)
app.use('/api', browserRouter)
app.use('/api', browserProfilesRouter)
app.use('/api', filesystemRouter)
app.use('/api', aclRolesRouter)
app.use('/api', aclMembersRouter)
app.use('/api', aclInvitationsRouter)
app.use('/api', skillsRouter)
app.use('/api', cronTasksRouter)
app.use('/api', mcpServersRouter)
app.use('/api', toolStatesRouter)
app.use('/api', auditRouter)
app.use('/api', pluginPermissionsRouter)

app.get('/health', (_req, res) => res.json({ ok: true }))

// Global error handler
app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  const message = err instanceof Error ? err.message : 'Internal server error'
  const status = (err as { status?: number }).status ?? 500
  console.error(`[jiku] Error ${status}:`, err)
  res.status(status).json({ error: message })
})

process.on('unhandledRejection', (reason) => {
  console.error('[jiku] Unhandled rejection:', reason)
})

process.on('uncaughtException', (err) => {
  console.error('[jiku] Uncaught exception:', err)
})

async function bootstrap() {
  await checkDbConnection()
  await seedPermissions()

  const sharedLoader = new PluginLoader()

  // Plan 17 — attach http + events API to each plugin's setup ctx.
  sharedLoader.setContextExtender(extendPluginContext)

  // Listen for connector:register hook — any plugin calling this registers its adapter
  sharedLoader.onHook('connector:register', async (adapter) => {
    connectorRegistry.register(adapter as import('@jiku/kit').ConnectorAdapter)
  })

  // Plan 17 — plugin auto-discovery gateway. All plugins under `plugins/` are
  // scanned + dynamic-imported, INCLUDING the `jiku.studio` host anchor plugin.
  // Adding a new plugin = drop a folder here with a valid package.json +
  // default-exported PluginDefinition. Server reboot picks it up; UI loads
  // its bundle via /api/plugins/:id/ui/*.
  const __filename = fileURLToPath(import.meta.url)
  const PLUGINS_ROOT = join(dirname(__filename), '..', '..', '..', '..', 'plugins')
  const discovered = await discoverPluginsFromFolder(PLUGINS_ROOT)
  for (const p of discovered) {
    sharedLoader.register(p.def)
    // Plan 19 — record plugin root for skill folder spec resolution
    sharedLoader.setPluginRoot(p.def.meta.id, p.dir)
  }
  console.log(`[jiku] Plugin discovery: ${discovered.length} plugin(s) from ${PLUGINS_ROOT}`)

  // Internal Studio-only plugins (not auto-discovered; these carry Studio
  // product behavior, not generic plugin types).
  sharedLoader.register(NarrationPlugin)
  await seedPluginRegistry(sharedLoader)
  runtimeManager.setPluginLoader(sharedLoader)

  let projects: Awaited<ReturnType<typeof getAllProjects>> = []
  try {
    projects = await getAllProjects()
    console.log(`[jiku] Found ${projects.length} project(s)`)
  } catch (err) {
    console.error('[jiku] Failed to load projects (is the DB migrated?):', err)
    process.exit(1)
  }

  try {
    await Promise.all(projects.map(p => runtimeManager.wakeUp(p.id)))
  } catch (err) {
    console.error('[jiku] Failed to wake up project runtimes:', err)
    process.exit(1)
  }
  console.log(`[jiku] Booted ${projects.length} project runtimes`)

  app.listen(env.PORT, () => {
    console.log('[jiku] Studio Server ready on :' + env.PORT)
  })

  // Daily cleanup: delete expired memories
  const CLEANUP_INTERVAL_MS = 24 * 60 * 60 * 1000
  async function runMemoryCleanup() {
    const deleted = await deleteExpiredMemories()
    if (deleted > 0) console.log(`[jiku] Memory cleanup: deleted ${deleted} expired rows`)
  }
  runMemoryCleanup().catch((err) => console.warn('[jiku] Memory cleanup error:', err))
  setInterval(() => {
    runMemoryCleanup().catch((err) => console.warn('[jiku] Memory cleanup error:', err))
  }, CLEANUP_INTERVAL_MS)

  // Browser idle tab cleanup — runs every 60s, closes agent tabs idle > 10min.
  startBrowserTabCleanup()

  // Filesystem S3 cleanup worker — processes deferred object deletions every 30s.
  startStorageCleanupWorker()

  // Plan 19 — durable background job queue (reflection, dreaming, flush).
  registerAllJobHandlers()
  backgroundWorker.start()
  dreamScheduler.bootstrap().catch((err) =>
    console.warn('[jiku] Dream scheduler bootstrap error:', err),
  )

  process.on('SIGTERM', shutdown)
  process.on('SIGINT', shutdown)
}

async function shutdown() {
  dreamScheduler.stopAll()
  backgroundWorker.stop()
  await runtimeManager.stopAll()
  console.log('[jiku] Studio Server stopped')
  process.exit(0)
}

bootstrap().catch((err) => {
  const msg = err instanceof Error ? err.message : String(err)
  if (msg.includes('port') || msg.includes('EADDRINUSE')) {
    console.error(`[jiku] Port ${env.PORT} already in use`)
  } else {
    console.error('[jiku] Bootstrap failed:', err)
  }
  process.exit(1)
})
