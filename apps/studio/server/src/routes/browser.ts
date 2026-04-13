// Legacy /api/projects/:pid/browser routes (pre-Plan-20).
//
// These endpoints operate on the "default" profile so existing API clients
// keep working during the migration window. New clients should use the
// browser-profiles endpoints directly.

import { Router } from 'express'
import { z } from 'zod'
import { authMiddleware } from '../middleware/auth.ts'
import { requirePermission } from '../middleware/permission.ts'
import {
  getProjectBrowserProfiles,
  getDefaultBrowserProfile,
  createBrowserProfile,
  updateBrowserProfile,
  getAgentsByProjectId,
} from '@jiku-studio/db'
import { runtimeManager } from '../runtime/manager.ts'
import { browserAdapterRegistry } from '../browser/adapter-registry.ts'
import { browserMutex } from '../browser/concurrency.ts'
import {
  browserTabManager,
  DEFAULT_MAX_TABS_PER_PROFILE,
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

// Helper: resolve-or-create the default jiku.browser.vercel profile.
async function ensureDefaultProfile(projectId: string, enabledInitially: boolean) {
  let existing = await getDefaultBrowserProfile(projectId)
  if (existing) return existing
  const all = await getProjectBrowserProfiles(projectId)
  if (all.length > 0) return all[0]!
  return createBrowserProfile({
    project_id: projectId,
    name: 'Default',
    adapter_id: 'jiku.browser.vercel',
    config: {},
    enabled: enabledInitially,
    is_default: true,
  })
}

router.get('/projects/:pid/browser', requirePermission('settings:read'), async (req, res) => {
  try {
    const projectId = req.params['pid']!
    const profiles = await getProjectBrowserProfiles(projectId)
    const defaultProfile = profiles.find(p => p.is_default) ?? profiles[0] ?? null
    res.json({
      enabled: profiles.some(p => p.enabled),
      config: (defaultProfile?.config ?? {}),
      profiles,
    })
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : 'Unknown error' })
  }
})

router.patch('/projects/:pid/browser/enabled', requirePermission('settings:write'), async (req, res) => {
  try {
    const projectId = req.params['pid']!
    const body = z.object({ enabled: z.boolean() }).safeParse(req.body)
    if (!body.success) { res.status(400).json({ error: body.error.flatten() }); return }

    const profile = await ensureDefaultProfile(projectId, body.data.enabled)
    if (profile.enabled !== body.data.enabled) {
      await updateBrowserProfile(profile.id, { enabled: body.data.enabled })
    }
    browserTabManager.dropProfile(profile.id)
    await runtimeManager.syncProjectTools(projectId)
    res.json({ ok: true, deprecated: 'Use /api/projects/:pid/browser/profiles endpoints.' })
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : 'Unknown error' })
  }
})

router.patch('/projects/:pid/browser/config', requirePermission('settings:write'), async (req, res) => {
  try {
    const projectId = req.params['pid']!
    const parsed = BrowserConfigSchema.safeParse(req.body)
    if (!parsed.success) { res.status(400).json({ error: parsed.error.flatten() }); return }

    const profile = await ensureDefaultProfile(projectId, true)
    await updateBrowserProfile(profile.id, { config: parsed.data })
    browserTabManager.dropProfile(profile.id)
    await runtimeManager.syncProjectTools(projectId)
    res.json({ ok: true, config: parsed.data, deprecated: 'Use /api/projects/:pid/browser/profiles endpoints.' })
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : 'Unknown error' })
  }
})

router.post('/projects/:pid/browser/ping', requirePermission('settings:read'), async (req, res) => {
  try {
    const projectId = req.params['pid']!
    const profile = await getDefaultBrowserProfile(projectId)
    if (!profile || !profile.enabled) {
      res.json({ ok: false, error: 'Browser is not enabled for this project' }); return
    }
    const adapter = browserAdapterRegistry.get(profile.adapter_id)
    if (!adapter) { res.json({ ok: false, error: `Adapter ${profile.adapter_id} not registered` }); return }
    res.json(await adapter.ping(profile.config))
  } catch (err) {
    res.status(500).json({ ok: false, error: err instanceof Error ? err.message : 'Unknown error' })
  }
})

router.post('/projects/:pid/browser/preview', requirePermission('settings:read'), async (req, res) => {
  try {
    const projectId = req.params['pid']!
    const profile = await getDefaultBrowserProfile(projectId)
    if (!profile || !profile.enabled) { res.json({ ok: false, error: 'Browser is not enabled for this project' }); return }
    const adapter = browserAdapterRegistry.get(profile.adapter_id)
    if (!adapter) { res.json({ ok: false, error: `Adapter ${profile.adapter_id} not registered` }); return }
    const result = await browserMutex.acquire(profile.id, async () => adapter.preview(profile.config))
    res.json(result)
  } catch (err) {
    res.status(500).json({ ok: false, error: err instanceof Error ? err.message : 'Unknown error' })
  }
})

router.get('/projects/:pid/browser/status', requirePermission('settings:read'), async (req, res) => {
  try {
    const projectId = req.params['pid']!
    const profile = await getDefaultBrowserProfile(projectId)
    const agents = await getAgentsByProjectId(projectId)
    const agentNames = new Map(agents.map(a => [a.id, a.name]))
    const now = Date.now()
    const profileId = profile?.id ?? ''
    const tabs = (profile ? browserTabManager.snapshot(profileId) : []).map((t, index) => ({
      index,
      agent_id: t.agentId,
      agent_name: t.agentId ? agentNames.get(t.agentId) ?? null : null,
      kind: t.agentId === null ? 'system' : 'agent',
      last_used_at: t.lastUsedAt,
      idle_ms: now - t.lastUsedAt,
    }))
    const totalTabs = tabs.length
    const agentTabs = tabs.filter(t => t.kind === 'agent').length
    const cfg = (profile?.config ?? {}) as { max_tabs?: number }
    const maxTabs = (profile && browserTabManager.getMaxTabs(profileId)) ?? cfg.max_tabs ?? DEFAULT_MAX_TABS_PER_PROFILE

    res.json({
      enabled: Boolean(profile?.enabled),
      mutex: { busy: profile ? browserMutex.isBusy(profileId) : false },
      tabs,
      capacity: { used: totalTabs, agent_used: agentTabs, max: maxTabs },
      idle_timeout_ms: IDLE_TAB_TIMEOUT_MS,
    })
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : 'Unknown error' })
  }
})

export { router as browserRouter }
