import { Router } from 'express'
import { z } from 'zod'
import { authMiddleware } from '../middleware/auth.ts'
import { requirePermission } from '../middleware/permission.ts'
import { getProjectBrowserConfig, setProjectBrowserEnabled, setProjectBrowserConfig } from '@jiku-studio/db'
import { runtimeManager } from '../runtime/manager.ts'
import { getBrowserServerHandle } from '../browser/index.js'

const router = Router()
router.use(authMiddleware)

const BrowserConfigSchema = z.object({
  mode: z.enum(['managed', 'remote']).optional(),
  cdp_url: z.string().url().optional(),
  headless: z.boolean().optional(),
  executable_path: z.string().optional(),
  control_port: z.number().int().min(1024).max(65535).optional(),
  timeout_ms: z.number().int().min(1000).max(120000).optional(),
  no_sandbox: z.boolean().optional(),
  evaluate_enabled: z.boolean().optional(),
})

// GET /projects/:pid/browser — config + status
router.get('/projects/:pid/browser', requirePermission('settings:read'), async (req, res) => {
  try {
    const projectId = req.params['pid']!
    const cfg = await getProjectBrowserConfig(projectId)
    const handle = getBrowserServerHandle(projectId)
    res.json({
      enabled: cfg.enabled,
      config: cfg.config,
      status: handle ? { running: true, port: handle.port } : { running: false },
    })
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : 'Unknown error' })
  }
})

// PATCH /projects/:pid/browser/enabled — toggle on/off
router.patch('/projects/:pid/browser/enabled', requirePermission('settings:write'), async (req, res) => {
  try {
    const projectId = req.params['pid']!
    const body = z.object({ enabled: z.boolean() }).safeParse(req.body)
    if (!body.success) { res.status(400).json({ error: body.error.flatten() }); return }

    await setProjectBrowserEnabled(projectId, body.data.enabled)
    await runtimeManager.syncProjectTools(projectId)

    const handle = getBrowserServerHandle(projectId)
    res.json({ ok: true, status: handle ? { running: true, port: handle.port } : { running: false } })
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : 'Unknown error' })
  }
})

// PATCH /projects/:pid/browser/config — update config
router.patch('/projects/:pid/browser/config', requirePermission('settings:write'), async (req, res) => {
  try {
    const projectId = req.params['pid']!
    const parsed = BrowserConfigSchema.safeParse(req.body)
    if (!parsed.success) { res.status(400).json({ error: parsed.error.flatten() }); return }

    await setProjectBrowserConfig(projectId, parsed.data)

    await runtimeManager.syncProjectTools(projectId)

    const handle = getBrowserServerHandle(projectId)
    res.json({ ok: true, config: parsed.data, status: handle ? { running: true, port: handle.port } : { running: false } })
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : 'Unknown error' })
  }
})

// POST /projects/:pid/browser/ping — test connection to the browser server
router.post('/projects/:pid/browser/ping', requirePermission('settings:read'), async (req, res) => {
  try {
    const projectId = req.params['pid']!
    const cfg = await getProjectBrowserConfig(projectId)

    if (!cfg.enabled) {
      res.json({ ok: false, error: 'Browser is not enabled for this project' })
      return
    }

    const handle = getBrowserServerHandle(projectId)
    if (!handle) {
      res.json({ ok: false, error: 'Browser server is not running' })
      return
    }

    // Query the browser control server status endpoint (GET /)
    const t0 = Date.now()
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 5000)

    let statusJson: Record<string, unknown> = {}
    try {
      const r = await fetch(`${handle.baseUrl}/`, { signal: controller.signal })
      clearTimeout(timeout)
      const latencyMs = Date.now() - t0

      if (!r.ok) {
        res.json({ ok: false, error: `Control server returned HTTP ${r.status}`, latency_ms: latencyMs })
        return
      }

      statusJson = await r.json() as Record<string, unknown>

      // For remote mode, also verify CDP is reachable
      const isRemote = cfg.config?.mode === 'remote' && Boolean(cfg.config?.cdp_url)
      const cdpUrl = isRemote ? cfg.config!.cdp_url! : null

      if (cdpUrl) {
        const t1 = Date.now()
        const cdpController = new AbortController()
        const cdpTimeout = setTimeout(() => cdpController.abort(), 5000)
        try {
          const cdpRes = await fetch(`${cdpUrl}/json/version`, { signal: cdpController.signal })
          clearTimeout(cdpTimeout)
          const cdpLatencyMs = Date.now() - t1

          if (cdpRes.ok) {
            const info = await cdpRes.json() as Record<string, string>
            res.json({
              ok: true,
              latency_ms: latencyMs,
              cdp_latency_ms: cdpLatencyMs,
              browser: info['Browser'] ?? info['product'] ?? (statusJson['chosenBrowser'] as string) ?? 'unknown',
              cdp_url: cdpUrl,
              port: handle.port,
            })
          } else {
            res.json({ ok: false, error: `CDP endpoint returned HTTP ${cdpRes.status}`, latency_ms: latencyMs })
          }
        } catch {
          clearTimeout(cdpTimeout)
          res.json({ ok: false, error: `Cannot reach CDP at ${cdpUrl} — is the browser container running?`, latency_ms: latencyMs })
        }
      } else {
        // Managed mode — report what the status endpoint told us
        const cdpReady = statusJson['cdpReady'] as boolean | undefined
        const chosenBrowser = statusJson['chosenBrowser'] as string | undefined
        res.json({
          ok: true,
          latency_ms: latencyMs,
          port: handle.port,
          browser: chosenBrowser ?? 'managed',
          cdp_ready: cdpReady,
        })
      }
    } catch {
      clearTimeout(timeout)
      res.json({ ok: false, error: 'Browser control server is not responding (timeout)' })
    }
  } catch (err) {
    res.status(500).json({ ok: false, error: err instanceof Error ? err.message : 'Unknown error' })
  }
})

export { router as browserRouter }
