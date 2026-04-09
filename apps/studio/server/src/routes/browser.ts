import { Router } from 'express'
import { z } from 'zod'
import { authMiddleware } from '../middleware/auth.ts'
import { requirePermission } from '../middleware/permission.ts'
import { getProjectBrowserConfig, setProjectBrowserEnabled, setProjectBrowserConfig } from '@jiku-studio/db'
import { runtimeManager } from '../runtime/manager.ts'

const router = Router()
router.use(authMiddleware)

const BrowserConfigSchema = z.object({
  cdp_url: z.string().optional(),
  timeout_ms: z.number().int().min(1000).max(120000).optional(),
  evaluate_enabled: z.boolean().optional(),
  screenshot_as_attachment: z.boolean().optional(),
})

// GET /projects/:pid/browser — config + status
router.get('/projects/:pid/browser', requirePermission('settings:read'), async (req, res) => {
  try {
    const projectId = req.params['pid']!
    const cfg = await getProjectBrowserConfig(projectId)
    res.json({
      enabled: cfg.enabled,
      config: cfg.config,
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

    res.json({ ok: true })
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

    res.json({ ok: true, config: parsed.data })
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : 'Unknown error' })
  }
})

// POST /projects/:pid/browser/ping — test CDP endpoint reachability
router.post('/projects/:pid/browser/ping', requirePermission('settings:read'), async (req, res) => {
  try {
    const projectId = req.params['pid']!
    const cfg = await getProjectBrowserConfig(projectId)

    if (!cfg.enabled) {
      res.json({ ok: false, error: 'Browser is not enabled for this project' })
      return
    }

    const cdpUrl = cfg.config?.cdp_url ?? 'ws://localhost:9222'

    // Test CDP connection via /json/version endpoint
    const t0 = Date.now()
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 5000)

    try {
      const r = await fetch(`${cdpUrl.replace(/^ws/, 'http')}/json/version`, { signal: controller.signal })
      clearTimeout(timeout)
      const latencyMs = Date.now() - t0

      if (r.ok) {
        const info = await r.json() as Record<string, string>
        res.json({
          ok: true,
          cdp_url: cdpUrl,
          latency_ms: latencyMs,
          browser: info['Browser'] ?? info['product'] ?? 'unknown',
        })
      } else {
        res.json({ ok: false, error: `CDP endpoint returned HTTP ${r.status}`, latency_ms: latencyMs })
      }
    } catch {
      clearTimeout(timeout)
      res.json({ ok: false, error: `Cannot reach CDP at ${cdpUrl} — is the browser container running?` })
    }
  } catch (err) {
    res.status(500).json({ ok: false, error: err instanceof Error ? err.message : 'Unknown error' })
  }
})

export { router as browserRouter }
