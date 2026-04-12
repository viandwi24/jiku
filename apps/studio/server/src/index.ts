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
import { memoryRouter } from './routes/memory.ts'
import { personaRouter } from './routes/persona.ts'
import connectorsRouter from './routes/connectors.ts'
import { runsRouter } from './routes/runs.ts'
import { heartbeatRouter } from './routes/heartbeat.ts'
import { browserRouter } from './routes/browser.ts'
import { filesystemRouter } from './routes/filesystem.ts'
import { attachmentsRouter } from './routes/attachments.ts'
import { aclRolesRouter } from './routes/acl-roles.ts'
import { aclMembersRouter } from './routes/acl-members.ts'
import { aclInvitationsRouter } from './routes/acl-invitations.ts'
import { skillsRouter } from './routes/skills.ts'
import { cronTasksRouter } from './routes/cron-tasks.ts'
import { mcpServersRouter } from './routes/mcp-servers.ts'
import { toolStatesRouter } from './routes/tool-states.ts'
import { runtimeManager } from './runtime/manager.ts'
import { startBrowserTabCleanup } from './browser/tab-manager.ts'
import { startStorageCleanupWorker } from './filesystem/worker.ts'
import { seedPluginRegistry } from './plugins/seed.ts'
import { JikuStudioPlugin } from './plugins/jiku.studio.ts'
import { connectorRegistry } from './connectors/registry.ts'
import { PluginLoader } from '@jiku/core'
import ConnectorPlugin from '@jiku/plugin-connector'
import TelegramPlugin from '@jiku/plugin-telegram'
import { checkDbConnection, seedPermissions, getAllProjects, deleteExpiredMemories } from '@jiku-studio/db'
import { env } from './env.ts'

const app = express()

app.use(cors())
app.use(express.json())

// Attachments router must be registered FIRST — the inline endpoint (/api/attachments/:id/inline)
// uses a query-string token instead of Authorization header, so it must not be intercepted by
// any router that calls router.use(authMiddleware) without a matching route.
app.use('/api', attachmentsRouter)
app.use('/', attachmentsRouter)  // /files/view proxy is at root level

app.use('/api/auth', authRouter)
app.use('/api/companies', companiesRouter)
app.use('/api', projectsRouter)
app.use('/api', agentsRouter)
app.use('/api', policiesRouter)
app.use('/api', conversationsRouter)
app.use('/api', credentialsRouter)
app.use('/api', chatRouter)
app.use('/api', previewRouter)
app.use('/api', pluginsRouter)
app.use('/api', memoryRouter)
app.use('/api', personaRouter)
app.use('/api', connectorsRouter)
app.use('/', connectorsRouter)  // webhook routes are at /webhook/:project_id/...
app.use('/api', runsRouter)
app.use('/api', heartbeatRouter)
app.use('/api', browserRouter)
app.use('/api', filesystemRouter)
app.use('/api', aclRolesRouter)
app.use('/api', aclMembersRouter)
app.use('/api', aclInvitationsRouter)
app.use('/api', skillsRouter)
app.use('/api', cronTasksRouter)
app.use('/api', mcpServersRouter)
app.use('/api', toolStatesRouter)

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

  // Listen for connector:register hook — any plugin calling this registers its adapter
  sharedLoader.onHook('connector:register', async (adapter) => {
    connectorRegistry.register(adapter as import('@jiku/kit').ConnectorAdapter)
  })

  sharedLoader.register(JikuStudioPlugin)
  sharedLoader.register(ConnectorPlugin)
  sharedLoader.register(TelegramPlugin)
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

  process.on('SIGTERM', shutdown)
  process.on('SIGINT', shutdown)
}

async function shutdown() {
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
