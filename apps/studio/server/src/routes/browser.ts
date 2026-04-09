import { Router } from 'express'
import { z } from 'zod'
import { execBrowserCommand } from '@jiku/browser'
import type { ScreenshotData } from '@jiku/browser'
import { authMiddleware } from '../middleware/auth.ts'
import { requirePermission } from '../middleware/permission.ts'
import {
  getProjectBrowserConfig,
  setProjectBrowserEnabled,
  setProjectBrowserConfig,
  getAgentsByProjectId,
} from '@jiku-studio/db'
import { runtimeManager } from '../runtime/manager.ts'
import { resolveCdpEndpoint } from '../browser/config.ts'
import { browserMutex } from '../browser/concurrency.ts'
import {
  browserTabManager,
  DEFAULT_MAX_TABS_PER_PROJECT,
  MIN_MAX_TABS,
  MAX_MAX_TABS,
  IDLE_TAB_TIMEOUT_MS,
} from '../browser/tab-manager.ts'

const router = Router()
router.use(authMiddleware)

const BrowserConfigSchema = z.object({
  cdp_url: z.string().optional(),
  timeout_ms: z.number().int().min(1000).max(120000).optional(),
  evaluate_enabled: z.boolean().optional(),
  screenshot_as_attachment: z.boolean().optional(),
  max_tabs: z.number().int().min(MIN_MAX_TABS).max(MAX_MAX_TABS).optional(),
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
    // Drop tab tracking — config or wiring may have changed; next call rebuilds.
    browserTabManager.dropProject(projectId)

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
    // CDP endpoint may have changed — drop tracked tabs (they pointed at the old chromium).
    browserTabManager.dropProject(projectId)

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
//
// The preview acquires the same per-project mutex as the agent tools so it
// cannot race with an in-flight agent command. It does NOT switch tabs —
// it always shows whichever tab is currently active in chromium (typically
// the most recently used agent's tab).
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

    const result = await browserMutex.acquire(projectId, async () => {
      const screenshot = await execBrowserCommand<ScreenshotData>(
        cdpEndpoint,
        { action: 'screenshot' },
        { timeoutMs },
      )
      if (!screenshot.success || !screenshot.data) {
        return { ok: false as const, error: screenshot.error ?? 'Screenshot failed', hint: screenshot.hint ?? null }
      }

      // Best-effort metadata; never fail the preview if these don't return.
      const [titleResult, urlResult] = await Promise.all([
        execBrowserCommand<{ title: string }>(cdpEndpoint, { action: 'get', subcommand: 'title' }, { timeoutMs }).catch(() => null),
        execBrowserCommand<{ url: string }>(cdpEndpoint, { action: 'get', subcommand: 'url' }, { timeoutMs }).catch(() => null),
      ])

      return {
        ok: true as const,
        data: {
          base64: screenshot.data.base64,
          format: screenshot.data.format ?? 'png',
          title: titleResult?.success ? titleResult.data?.title ?? null : null,
          url: urlResult?.success ? urlResult.data?.url ?? null : null,
        },
      }
    })

    res.json(result)
  } catch (err) {
    res.status(500).json({ ok: false, error: err instanceof Error ? err.message : 'Unknown error' })
  }
})

// GET /projects/:pid/browser/status — diagnostics for the settings page
// debug panel. Returns the current state of the per-project tab manager and
// the mutex (busy / idle). Names of agents are joined in so the UI can show
// human-readable rows instead of UUIDs.
router.get('/projects/:pid/browser/status', requirePermission('settings:read'), async (req, res) => {
  try {
    const projectId = req.params['pid']!
    const cfg = await getProjectBrowserConfig(projectId)

    // Build a UUID → name lookup so the UI doesn't have to do it.
    const agents = await getAgentsByProjectId(projectId)
    const agentNames = new Map(agents.map(a => [a.id, a.name]))

    const now = Date.now()
    const tabs = browserTabManager.snapshot(projectId).map((t, index) => ({
      index,
      agent_id: t.agentId,
      agent_name: t.agentId ? agentNames.get(t.agentId) ?? null : null,
      kind: t.agentId === null ? 'system' : 'agent',
      last_used_at: t.lastUsedAt,
      idle_ms: now - t.lastUsedAt,
    }))

    const totalTabs = tabs.length
    const agentTabs = tabs.filter(t => t.kind === 'agent').length

    // Resolve max: prefer the value the manager has actually applied to the
    // running state, fall back to the saved config, finally to the default.
    // This way the UI shows what the runtime is *currently using*, even if
    // the user just changed the config and hasn't triggered a re-init yet.
    const maxTabs =
      browserTabManager.getMaxTabs(projectId) ??
      cfg.config.max_tabs ??
      DEFAULT_MAX_TABS_PER_PROJECT

    res.json({
      enabled: cfg.enabled,
      mutex: { busy: browserMutex.isBusy(projectId) },
      tabs,
      capacity: {
        used: totalTabs,
        agent_used: agentTabs,
        max: maxTabs,
      },
      idle_timeout_ms: IDLE_TAB_TIMEOUT_MS,
    })
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : 'Unknown error' })
  }
})

export { router as browserRouter }
