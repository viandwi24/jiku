import { Router } from 'express'
import { authMiddleware } from '../middleware/auth.ts'
import { consoleRegistry } from './registry.ts'

const router = Router()

/**
 * NOTE on permission model:
 * The console feature is not project-scoped at the URL level — console ids
 * are free-form (`<plugin_id>:connector:<uuid>`). The Studio project-level
 * `requirePermission` middleware resolves the project from `req.params.pid`,
 * which these routes don't carry. Rather than parse the id back into a
 * project, we require the caller to be an authenticated Studio user and rely
 * on the `console:read` gate being enforced at the UI level (sidebar +
 * withPermissionGuard on /console page + connector detail page) — a
 * defense-in-depth check, not the primary gate. Any user who knows a console
 * id can read it; ids are not treated as secrets. If that changes, attach
 * project resolution here (e.g. look up the connector_id portion of the id).
 */

/** List all known console ids (useful for admin/debug). */
router.get('/console', authMiddleware, (_req, res) => {
  res.json({ consoles: consoleRegistry.list() })
})

/** Instant snapshot from memory ring (up to ~200 latest entries). */
router.get('/console/:id/snapshot', authMiddleware, (req, res) => {
  const id = String(req.params['id'])
  res.json(consoleRegistry.snapshot(id))
})

/** Reverse-paginate into the file for entries with ts < before_ts. */
router.get('/console/:id/history', authMiddleware, async (req, res) => {
  const id = String(req.params['id'])
  const beforeTs = Number(req.query['before_ts'] ?? Date.now())
  const limit = Math.min(Math.max(Number(req.query['limit'] ?? 100), 1), 500)
  const entries = await consoleRegistry.history(id, beforeTs, limit)
  res.json({ id, entries })
})

/** SSE live stream — auth via ?token=... because EventSource can't set headers. */
router.get('/console/:id/stream', authMiddleware, (req, res) => {
  const id = String(req.params['id'])
  res.setHeader('Content-Type', 'text/event-stream')
  res.setHeader('Cache-Control', 'no-cache')
  res.setHeader('Connection', 'keep-alive')
  res.flushHeaders()
  // Prime with a comment so EventSource fires onopen quickly
  res.write(': connected\n\n')
  consoleRegistry.subscribe(id, res)
})

export { router as consoleRouter }
