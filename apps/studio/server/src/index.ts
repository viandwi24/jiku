import { serve } from '@hono/node-server'
import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { logger } from 'hono/logger'
import { authRouter } from './routes/auth.ts'
import { companiesRouter } from './routes/companies.ts'
import { projectsRouter } from './routes/projects.ts'
import { agentsRouter } from './routes/agents.ts'
import { policiesRouter } from './routes/policies.ts'
import { conversationsRouter } from './routes/conversations.ts'
import { credentialsRouter } from './routes/credentials.ts'
import { chatRouter } from './routes/chat.ts'
import { runtimeManager } from './runtime/manager.ts'
import { checkDbConnection, seedPermissions, getAllProjects } from '@jiku-studio/db'
import { env } from './env.ts'
import type { AppVariables } from './types.ts'

const app = new Hono<{ Variables: AppVariables }>()

app.use('*', cors({ origin: '*' }))
app.use('*', logger())

app.route('/api/auth', authRouter)
app.route('/api/companies', companiesRouter)
app.route('/api', projectsRouter)
app.route('/api', agentsRouter)
app.route('/api', policiesRouter)
app.route('/api', conversationsRouter)
app.route('/api', credentialsRouter)
app.route('/api', chatRouter)

app.get('/health', (c) => c.json({ ok: true }))

async function bootstrap() {
  await checkDbConnection()
  await seedPermissions()

  const projects = await getAllProjects()
  await Promise.all(projects.map(p => runtimeManager.wakeUp(p.id)))
  console.log(`[jiku] Booted ${projects.length} project runtimes`)

  serve({ fetch: app.fetch, port: env.PORT }, () => {
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

export default app
