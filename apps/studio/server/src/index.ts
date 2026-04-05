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
import { runtimeManager } from './runtime/manager.ts'
import { seedPluginRegistry } from './plugins/seed.ts'
import { JikuStudioPlugin } from './plugins/jiku.studio.ts'
import { PluginLoader } from '@jiku/core'
import { checkDbConnection, seedPermissions, getAllProjects } from '@jiku-studio/db'
import { env } from './env.ts'

const app = express()

app.use(cors())
app.use(express.json())

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

  // Create shared plugin loader and register built-in studio plugins.
  const sharedLoader = new PluginLoader()
  sharedLoader.register(JikuStudioPlugin)
  await seedPluginRegistry(sharedLoader)
  runtimeManager.setPluginLoader(sharedLoader)

  const projects = await getAllProjects()
  await Promise.all(projects.map(p => runtimeManager.wakeUp(p.id)))
  console.log(`[jiku] Booted ${projects.length} project runtimes`)

  app.listen(env.PORT, () => {
    console.log('[jiku] Studio Server ready on :' + env.PORT)
  })

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
