import { Router } from 'express'
import { z } from 'zod'
import { execBrowserCommand } from '@jiku/browser'
import type { ScreenshotData } from '@jiku/browser'
import { authMiddleware } from '../middleware/auth.ts'
import { requirePermission } from '../middleware/permission.ts'
import { getProjectBrowserConfig, setProjectBrowserEnabled, setProjectBrowserConfig } from '@jiku-studio/db'
import { runtimeManager } from '../runtime/manager.ts'
import { resolveCdpEndpoint } from '../browser/config.ts'

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

// POST /projects/:pid/browser/preview — capture a one-shot screenshot of the
// current browser state. Returned inline as base64; never persisted. Used by
// the Browser settings page to show a live "viewer" of the project's browser.
router.post('/projects/:pid/browser/preview', requirePermission('settings:read'), async (req, res) => {
  try {
    const projectId = req.params['pid']!
    const cfg = await getProjectBrowserConfig(projectId)

    if (!cfg.enabled) {
      res.json({ ok: false, error: 'Browser is not enabled for this project' })
      return
    }

    const cdpEndpoint = resolveCdpEndpoint(cfg.config)
    const timeoutMs = cfg.config.timeout_ms ?? 30_000

    // Run screenshot, title, and url in sequence — we want to show the user
    // what page they're looking at, not just an unlabeled image.
    const screenshot = await execBrowserCommand<ScreenshotData>(
      cdpEndpoint,
      { action: 'screenshot' },
      { timeoutMs },
    )

    if (!screenshot.success || !screenshot.data) {
      res.json({
        ok: false,
        error: screenshot.error ?? 'Screenshot failed',
        hint: screenshot.hint ?? null,
      })
      return
    }

    // Best-effort metadata; never fail the preview if these don't return.
    const [titleResult, urlResult] = await Promise.all([
      execBrowserCommand<{ title: string }>(cdpEndpoint, { action: 'get', subcommand: 'title' }, { timeoutMs }).catch(() => null),
      execBrowserCommand<{ url: string }>(cdpEndpoint, { action: 'get', subcommand: 'url' }, { timeoutMs }).catch(() => null),
    ])

    res.json({
      ok: true,
      data: {
        base64: screenshot.data.base64,
        format: screenshot.data.format ?? 'png',
        title: titleResult?.success ? titleResult.data?.title ?? null : null,
        url: urlResult?.success ? urlResult.data?.url ?? null : null,
      },
    })
  } catch (err) {
    res.status(500).json({ ok: false, error: err instanceof Error ? err.message : 'Unknown error' })
  }
})

export { router as browserRouter }
