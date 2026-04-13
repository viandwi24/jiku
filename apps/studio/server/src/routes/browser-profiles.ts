// Plan 20 — Browser profile REST endpoints.
//
// All endpoints live under `/api/projects/:pid/browser/...`. Read endpoints
// require `settings:read`; mutating endpoints require `settings:write`.

import { Router } from 'express'
import { z } from 'zod'
import { authMiddleware } from '../middleware/auth.ts'
import { requirePermission } from '../middleware/permission.ts'
import {
  getProjectBrowserProfiles,
  getBrowserProfile,
  createBrowserProfile,
  updateBrowserProfile,
  deleteBrowserProfile,
  setDefaultBrowserProfile,
  getAgentsByProjectId,
} from '@jiku-studio/db'
import { runtimeManager } from '../runtime/manager.ts'
import { browserAdapterRegistry } from '../browser/adapter-registry.ts'
import { browserMutex } from '../browser/concurrency.ts'
import {
  browserTabManager,
  DEFAULT_MAX_TABS_PER_PROFILE,
  IDLE_TAB_TIMEOUT_MS,
} from '../browser/tab-manager.ts'

const router = Router()
router.use(authMiddleware)

// ── Helpers ────────────────────────────────────────────────────────────────

export interface SerializedConfigField {
  type: 'string' | 'number' | 'integer' | 'boolean' | 'enum' | 'unknown'
  optional: boolean
  description?: string
  default?: unknown
  min?: number
  max?: number
  options?: string[]
  placeholder?: string
}

// Walk Zod wrapper nodes (Optional/Default/Nullable/Effects) to the leaf.
// Returns the inner def plus any metadata gathered along the way.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function unwrapZod(node: any): {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  inner: any
  optional: boolean
  defaultValue: unknown
} {
  let optional = false
  let defaultValue: unknown = undefined
  let cur = node
  for (let i = 0; i < 10 && cur; i++) {
    const t: string = cur?._def?.typeName ?? ''
    if (t === 'ZodOptional') {
      optional = true
      cur = cur._def.innerType
    } else if (t === 'ZodDefault') {
      const dv = cur._def.defaultValue
      defaultValue = typeof dv === 'function' ? dv() : dv
      cur = cur._def.innerType
    } else if (t === 'ZodNullable') {
      cur = cur._def.innerType
    } else if (t === 'ZodEffects') {
      cur = cur._def.schema
    } else {
      break
    }
  }
  return { inner: cur, optional, defaultValue }
}

function serializeAdapter(a: import('@jiku/kit').BrowserAdapter) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const schema = a.configSchema as any
  const shape = schema?.shape ?? schema?._def?.shape?.() ?? null
  const fields: Record<string, SerializedConfigField> = {}

  if (shape && typeof shape === 'object') {
    for (const [key, val] of Object.entries(shape as Record<string, unknown>)) {
      const { inner, optional, defaultValue } = unwrapZod(val)
      const typeName: string = inner?._def?.typeName ?? 'ZodUnknown'
      const description: string | undefined =
        inner?._def?.description ?? (val as { _def?: { description?: string } })?._def?.description

      const field: SerializedConfigField = {
        type: 'unknown',
        optional,
        ...(description && { description }),
        ...(defaultValue !== undefined && { default: defaultValue }),
      }

      if (typeName === 'ZodString') {
        field.type = 'string'
        // Capture min/max length if present (checks array).
        const checks: Array<{ kind: string; value?: number }> = inner._def.checks ?? []
        const minC = checks.find(c => c.kind === 'min')
        const maxC = checks.find(c => c.kind === 'max')
        if (minC?.value !== undefined) field.min = minC.value
        if (maxC?.value !== undefined) field.max = maxC.value
      } else if (typeName === 'ZodNumber') {
        const checks: Array<{ kind: string; value?: number }> = inner._def.checks ?? []
        const isInt = checks.some(c => c.kind === 'int')
        field.type = isInt ? 'integer' : 'number'
        const minC = checks.find(c => c.kind === 'min')
        const maxC = checks.find(c => c.kind === 'max')
        if (minC?.value !== undefined) field.min = minC.value
        if (maxC?.value !== undefined) field.max = maxC.value
      } else if (typeName === 'ZodBoolean') {
        field.type = 'boolean'
      } else if (typeName === 'ZodEnum' || typeName === 'ZodNativeEnum') {
        field.type = 'enum'
        const values = inner._def.values
        field.options = Array.isArray(values) ? values.map(String) : Object.values(values as object).map(String)
      }

      fields[key] = field
    }
  }

  return {
    id: a.id,
    display_name: a.displayName,
    description: a.description,
    config_fields: fields,
  }
}

// ── GET /projects/:pid/browser/adapters ────────────────────────────────────
router.get('/projects/:pid/browser/adapters', requirePermission('settings:read'), async (_req, res) => {
  const adapters = browserAdapterRegistry.list().map(serializeAdapter)
  res.json({ adapters })
})

// ── GET /projects/:pid/browser/profiles ────────────────────────────────────
router.get('/projects/:pid/browser/profiles', requirePermission('settings:read'), async (req, res) => {
  try {
    const projectId = req.params['pid']!
    const profiles = await getProjectBrowserProfiles(projectId)
    res.json({ profiles })
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : 'Unknown error' })
  }
})

// ── POST /projects/:pid/browser/profiles ───────────────────────────────────
const CreateSchema = z.object({
  name: z.string().min(1).max(255),
  adapter_id: z.string().min(1),
  config: z.record(z.string(), z.unknown()).optional(),
  enabled: z.boolean().optional(),
  is_default: z.boolean().optional(),
})

router.post('/projects/:pid/browser/profiles', requirePermission('settings:write'), async (req, res) => {
  try {
    const projectId = req.params['pid']!
    const parsed = CreateSchema.safeParse(req.body)
    if (!parsed.success) { res.status(400).json({ error: parsed.error.flatten() }); return }

    const adapter = browserAdapterRegistry.get(parsed.data.adapter_id)
    if (!adapter) {
      res.status(400).json({ error: `Unknown adapter_id: ${parsed.data.adapter_id}` })
      return
    }

    // Validate config via the adapter's schema.
    const cfgParse = adapter.configSchema.safeParse(parsed.data.config ?? {})
    if (!cfgParse.success) {
      res.status(400).json({ error: 'Invalid config for adapter', details: cfgParse.error })
      return
    }
    const existingProfiles = await getProjectBrowserProfiles(projectId)
    const isFirst = existingProfiles.length === 0
    const profile = await createBrowserProfile({
      project_id: projectId,
      name: parsed.data.name,
      adapter_id: parsed.data.adapter_id,
      config: (cfgParse.data ?? {}) as Record<string, unknown>,
      enabled: parsed.data.enabled ?? true,
      is_default: parsed.data.is_default ?? isFirst,
    })

    if (profile.enabled) {
      try { await adapter.onProfileActivated?.(profile.id, profile.config) } catch (e) {
        console.warn('[browser-profiles] onProfileActivated failed:', e)
      }
    }
    await runtimeManager.syncProjectTools(projectId)
    res.json({ profile })
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : 'Unknown error' })
  }
})

// ── GET /projects/:pid/browser/profiles/:profileId ─────────────────────────
router.get('/projects/:pid/browser/profiles/:profileId', requirePermission('settings:read'), async (req, res) => {
  try {
    const profileId = req.params['profileId']!
    const profile = await getBrowserProfile(profileId)
    if (!profile) { res.status(404).json({ error: 'Profile not found' }); return }
    res.json({ profile })
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : 'Unknown error' })
  }
})

// ── PATCH /projects/:pid/browser/profiles/:profileId ───────────────────────
const PatchSchema = z.object({
  name: z.string().min(1).max(255).optional(),
  config: z.record(z.string(), z.unknown()).optional(),
  enabled: z.boolean().optional(),
  is_default: z.boolean().optional(),
})

router.patch('/projects/:pid/browser/profiles/:profileId', requirePermission('settings:write'), async (req, res) => {
  try {
    const projectId = req.params['pid']!
    const profileId = req.params['profileId']!
    const parsed = PatchSchema.safeParse(req.body)
    if (!parsed.success) { res.status(400).json({ error: parsed.error.flatten() }); return }

    const existing = await getBrowserProfile(profileId)
    if (!existing) { res.status(404).json({ error: 'Profile not found' }); return }

    const adapter = browserAdapterRegistry.get(existing.adapter_id)
    // If config is being updated, validate against the adapter's schema.
    let nextConfig = existing.config as Record<string, unknown>
    if (parsed.data.config !== undefined) {
      if (!adapter) { res.status(400).json({ error: `Adapter ${existing.adapter_id} not registered` }); return }
      const cfgParse = adapter.configSchema.safeParse(parsed.data.config)
      if (!cfgParse.success) {
        res.status(400).json({ error: 'Invalid config', details: cfgParse.error }); return
      }
      nextConfig = (cfgParse.data ?? {}) as Record<string, unknown>
    }

    const wasEnabled = existing.enabled
    const nowEnabled = parsed.data.enabled ?? wasEnabled

    const patch: Partial<{ name: string; config: Record<string, unknown>; enabled: boolean; is_default: boolean }> = {}
    if (parsed.data.name !== undefined) patch.name = parsed.data.name
    if (parsed.data.config !== undefined) patch.config = nextConfig
    if (parsed.data.enabled !== undefined) patch.enabled = parsed.data.enabled
    if (parsed.data.is_default !== undefined) patch.is_default = parsed.data.is_default
    const updated = await updateBrowserProfile(profileId, patch)

    // Adapter lifecycle hooks.
    if (adapter) {
      if (!wasEnabled && nowEnabled) {
        await adapter.onProfileActivated?.(profileId, updated.config).catch(e =>
          console.warn('[browser-profiles] onProfileActivated failed:', e))
      } else if (wasEnabled && !nowEnabled) {
        await adapter.onProfileDeactivated?.(profileId).catch(e =>
          console.warn('[browser-profiles] onProfileDeactivated failed:', e))
        browserTabManager.dropProfile(profileId)
      } else if (parsed.data.config !== undefined) {
        // Config changed — drop tab tracking since endpoint may have changed.
        browserTabManager.dropProfile(profileId)
      }
    }

    await runtimeManager.syncProjectTools(projectId)
    res.json({ profile: updated })
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : 'Unknown error' })
  }
})

// ── DELETE /projects/:pid/browser/profiles/:profileId ──────────────────────
router.delete('/projects/:pid/browser/profiles/:profileId', requirePermission('settings:write'), async (req, res) => {
  try {
    const projectId = req.params['pid']!
    const profileId = req.params['profileId']!
    const existing = await getBrowserProfile(profileId)
    if (!existing) { res.status(404).json({ error: 'Profile not found' }); return }

    const adapter = browserAdapterRegistry.get(existing.adapter_id)
    await adapter?.onProfileDeactivated?.(profileId).catch(e =>
      console.warn('[browser-profiles] onProfileDeactivated failed:', e))
    browserTabManager.dropProfile(profileId)

    await deleteBrowserProfile(profileId)
    await runtimeManager.syncProjectTools(projectId)
    res.json({ ok: true })
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : 'Unknown error' })
  }
})

// ── POST /projects/:pid/browser/profiles/:profileId/default ────────────────
router.post('/projects/:pid/browser/profiles/:profileId/default', requirePermission('settings:write'), async (req, res) => {
  try {
    const projectId = req.params['pid']!
    const profileId = req.params['profileId']!
    await setDefaultBrowserProfile(profileId, projectId)
    await runtimeManager.syncProjectTools(projectId)
    res.json({ ok: true })
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : 'Unknown error' })
  }
})

// ── POST /projects/:pid/browser/profiles/:profileId/ping ───────────────────
router.post('/projects/:pid/browser/profiles/:profileId/ping', requirePermission('settings:read'), async (req, res) => {
  try {
    const profileId = req.params['profileId']!
    const profile = await getBrowserProfile(profileId)
    if (!profile) { res.status(404).json({ error: 'Profile not found' }); return }
    const adapter = browserAdapterRegistry.get(profile.adapter_id)
    if (!adapter) { res.status(400).json({ ok: false, error: `Adapter ${profile.adapter_id} not registered` }); return }
    const result = await adapter.ping(profile.config)
    res.json(result)
  } catch (err) {
    res.status(500).json({ ok: false, error: err instanceof Error ? err.message : 'Unknown error' })
  }
})

// ── POST /projects/:pid/browser/profiles/:profileId/preview ────────────────
router.post('/projects/:pid/browser/profiles/:profileId/preview', requirePermission('settings:read'), async (req, res) => {
  try {
    const profileId = req.params['profileId']!
    const profile = await getBrowserProfile(profileId)
    if (!profile) { res.status(404).json({ error: 'Profile not found' }); return }
    if (!profile.enabled) { res.json({ ok: false, error: 'Profile is disabled' }); return }
    const adapter = browserAdapterRegistry.get(profile.adapter_id)
    if (!adapter) { res.status(400).json({ ok: false, error: `Adapter ${profile.adapter_id} not registered` }); return }

    const result = await browserMutex.acquire(profileId, async () => adapter.preview(profile.config))
    res.json(result)
  } catch (err) {
    res.status(500).json({ ok: false, error: err instanceof Error ? err.message : 'Unknown error' })
  }
})

// ── GET /projects/:pid/browser/profiles/:profileId/status ──────────────────
router.get('/projects/:pid/browser/profiles/:profileId/status', requirePermission('settings:read'), async (req, res) => {
  try {
    const projectId = req.params['pid']!
    const profileId = req.params['profileId']!
    const profile = await getBrowserProfile(profileId)
    if (!profile) { res.status(404).json({ error: 'Profile not found' }); return }

    const agents = await getAgentsByProjectId(projectId)
    const agentNames = new Map(agents.map(a => [a.id, a.name]))

    const now = Date.now()
    const tabs = browserTabManager.snapshot(profileId).map((t, index) => ({
      index,
      agent_id: t.agentId,
      agent_name: t.agentId ? agentNames.get(t.agentId) ?? null : null,
      kind: t.agentId === null ? 'system' : 'agent',
      last_used_at: t.lastUsedAt,
      idle_ms: now - t.lastUsedAt,
    }))

    const totalTabs = tabs.length
    const agentTabs = tabs.filter(t => t.kind === 'agent').length
    const cfg = (profile.config ?? {}) as { max_tabs?: number }
    const maxTabs = browserTabManager.getMaxTabs(profileId) ?? cfg.max_tabs ?? DEFAULT_MAX_TABS_PER_PROFILE

    res.json({
      enabled: profile.enabled,
      mutex: { busy: browserMutex.isBusy(profileId) },
      tabs,
      capacity: { used: totalTabs, agent_used: agentTabs, max: maxTabs },
      idle_timeout_ms: IDLE_TAB_TIMEOUT_MS,
    })
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : 'Unknown error' })
  }
})

export { router as browserProfilesRouter }
