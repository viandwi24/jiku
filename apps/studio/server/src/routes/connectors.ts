import { Router } from 'express'
import { authMiddleware } from '../middleware/auth.ts'
import { requirePermission } from '../middleware/permission.ts'
import {
  getConnectors,
  getConnectorById,
  createConnector,
  updateConnector,
  deleteConnector,
  getBindings,
  getBindingById,
  createBinding,
  updateBinding,
  deleteBinding,
  getIdentitiesForBinding,
  getPairingRequestsForConnector,
  getPendingGroupPairings,
  getBlockedIdentitiesForConnector,
  getIdentityById,
  updateIdentity,
  deleteIdentity,
  getConnectorEvents,
  getConnectorMessages,
  listConnectorEventsForProject,
  listConnectorMessagesForProject,
  getInviteCodesForConnector,
  createInviteCode,
  revokeInviteCode,
  deleteInviteCode,
  getConnectorTargetsForConnector,
  getConnectorTargetById,
  createConnectorTarget,
  updateConnectorTarget,
  deleteConnectorTarget,
  getConnectorScopes,
} from '@jiku-studio/db'
import { connectorRegistry } from '../connectors/registry.ts'
import { routeConnectorEvent } from '../connectors/event-router.ts'
import { activateConnector, deactivateConnector } from '../connectors/activation.ts'
import { subscribeProjectEvents, subscribeProjectMessages } from '../connectors/sse-hub.ts'
import { runtimeManager } from '../runtime/manager.ts'
import { loadPerms } from '../middleware/permission.ts'
import type { ConnectorEvent } from '@jiku/types'
import type { Request, Response, NextFunction } from 'express'

const router = Router()

/** Middleware: resolve connector → project_id, then check permission */
function requireConnectorPermission(permission: 'channels:read' | 'channels:write') {
  return async (req: Request, res: Response, next: NextFunction) => {
    const connector = await getConnectorById(req.params['id']!)
    if (!connector) { res.status(404).json({ error: 'Not found' }); return }
    res.locals['project_id'] = connector.project_id
    const result = await loadPerms(req, res)
    if (!result) { res.status(400).json({ error: 'Project context required' }); return }
    const { resolved } = result
    if (!resolved.granted) { res.status(403).json({ error: 'Not a member' }); return }
    if (!resolved.isSuperadmin && !resolved.permissions.includes(permission)) {
      res.status(403).json({ error: `Missing permission: ${permission}` }); return
    }
    next()
  }
}

// ─── Connectors CRUD ─────────────────────────────────────────────────────────

/** GET /projects/:pid/connectors */
router.get('/projects/:pid/connectors', authMiddleware, requirePermission('channels:read'), async (req, res) => {
  try {
    const rows = await getConnectors(req.params['pid']!)
    res.json({ connectors: rows })
  } catch (err) {
    res.status(500).json({ error: String(err) })
  }
})

/** POST /projects/:pid/connectors */
router.post('/projects/:pid/connectors', authMiddleware, requirePermission('channels:write'), async (req, res) => {
  const { plugin_id, display_name, credential_id, config } = req.body as {
    plugin_id: string
    display_name: string
    credential_id?: string
    config?: Record<string, unknown>
  }

  try {
    const adapter = connectorRegistry.get(plugin_id)
    if (!adapter) {
      res.status(400).json({ error: `Connector plugin not found: ${plugin_id}` })
      return
    }

    const connector = await createConnector({
      project_id: req.params['pid']!,
      plugin_id,
      display_name: display_name ?? adapter.displayName,
      credential_id: credential_id ?? null,
      config: config ?? {},
    })

    // Auto-activate if credential provided
    if (credential_id) {
      await activateConnector(connector.id).catch(async (err) => {
        console.error('[connector] auto-activate failed:', err)
        await updateConnector(connector.id, { status: 'error', error_message: String(err) })
      })
      // Re-fetch to get updated status
      const updated = await getConnectorById(connector.id)
      // Invalidate shared tools cache so agents pick up connector_send etc.
      // (Without this, first-connector-of-a-project would never register connector tools
      //  until server restart — cron/task runs would then have no delivery tool.)
      runtimeManager.syncProjectTools(req.params['pid']!).catch(err =>
        console.warn('[connector] syncProjectTools failed:', err)
      )
      res.status(201).json({ connector: updated ?? connector })
    } else {
      runtimeManager.syncProjectTools(req.params['pid']!).catch(err =>
        console.warn('[connector] syncProjectTools failed:', err)
      )
      res.status(201).json({ connector })
    }
  } catch (err) {
    res.status(500).json({ error: String(err) })
  }
})

/** GET /connectors/:id */
router.get('/connectors/:id', authMiddleware, requireConnectorPermission('channels:read'), async (req, res) => {
  try {
    const connector = await getConnectorById(req.params['id']!)
    if (!connector) { res.status(404).json({ error: 'Not found' }); return }
    res.json({ connector })
  } catch (err) {
    res.status(500).json({ error: String(err) })
  }
})

/** PATCH /connectors/:id */
router.patch('/connectors/:id', authMiddleware, requireConnectorPermission('channels:write'), async (req, res) => {
  try {
    const connector = await updateConnector(req.params['id']!, req.body)
    if (!connector) { res.status(404).json({ error: 'Not found' }); return }
    res.json({ connector })
  } catch (err) {
    res.status(500).json({ error: String(err) })
  }
})

/** DELETE /connectors/:id
 *
 * IMPORTANT: must deactivate the in-memory adapter BEFORE deleting the DB row.
 * Otherwise the bot's polling loop stays orphaned (getUpdates keeps running
 * against Telegram) and the next connector created with the same bot token
 * triggers a 409 Conflict ("terminated by other getUpdates request") because
 * two long-polling loops compete.
 */
router.delete('/connectors/:id', authMiddleware, requireConnectorPermission('channels:write'), async (req, res) => {
  const connectorId = req.params['id']!
  try {
    const projectId = res.locals['project_id'] as string | undefined
    // Stop the adapter first — this tears down polling / webhooks / timers.
    // Swallow errors so a half-broken adapter doesn't block row deletion.
    await deactivateConnector(connectorId).catch(err =>
      console.warn(`[connector] deactivate before delete failed (${connectorId}):`, err)
    )
    await deleteConnector(connectorId)
    if (projectId) {
      runtimeManager.syncProjectTools(projectId).catch(err =>
        console.warn('[connector] syncProjectTools failed:', err)
      )
    }
    res.json({ ok: true })
  } catch (err) {
    res.status(500).json({ error: String(err) })
  }
})

/** POST /connectors/:id/activate */
router.post('/connectors/:id/activate', authMiddleware, requireConnectorPermission('channels:write'), async (req, res) => {
  try {
    await activateConnector(req.params['id']!)
    const connector = await getConnectorById(req.params['id']!)
    res.json({ ok: true, connector })
  } catch (err) {
    await updateConnector(req.params['id']!, { status: 'error', error_message: String(err) }).catch(() => {})
    res.status(500).json({ error: String(err) })
  }
})

/** POST /connectors/:id/deactivate */
router.post('/connectors/:id/deactivate', authMiddleware, requireConnectorPermission('channels:write'), async (req, res) => {
  try {
    await deactivateConnector(req.params['id']!)
    const connector = await getConnectorById(req.params['id']!)
    res.json({ ok: true, connector })
  } catch (err) {
    res.status(500).json({ error: String(err) })
  }
})

/**
 * POST /connectors/:id/restart
 *
 * Admin self-service recovery for stuck connectors. Deactivates the adapter
 * (which stops any active polling / releases resources), then re-activates it.
 * Adapters that hold server-side state — Telegram's long-poll slot — enforce
 * their own post-deactivate wait inside `onActivate`, so callers don't need to
 * sleep between the two steps.
 */
router.post('/connectors/:id/restart', authMiddleware, requireConnectorPermission('channels:write'), async (req, res) => {
  const id = req.params['id']!
  try {
    await deactivateConnector(id).catch(err =>
      console.warn(`[connector] restart: deactivate step failed (continuing): ${err}`)
    )
    await activateConnector(id)
    const connector = await getConnectorById(id)
    res.json({ ok: true, connector })
  } catch (err) {
    await updateConnector(id, { status: 'error', error_message: String(err) }).catch(() => {})
    res.status(500).json({ error: String(err) })
  }
})

/**
 * GET /connectors/:id/health
 *
 * Lightweight liveness view. Adapters that implement `getHealth()` (Telegram)
 * return their runtime state: polling active, last-event timestamp, bot id.
 * For adapters without it, we return a minimal shape from the connector row.
 */
router.get('/connectors/:id/health', authMiddleware, requireConnectorPermission('channels:read'), async (req, res) => {
  const id = req.params['id']!
  try {
    const connector = await getConnectorById(id)
    if (!connector) return res.status(404).json({ error: 'Connector not found' })
    const adapter = connectorRegistry.getAdapterForConnector(id) as unknown as { getHealth?: () => unknown } | null
    const adapterHealth = adapter?.getHealth?.() ?? null
    res.json({
      ok: true,
      status: connector.status,
      error_message: connector.error_message,
      adapter: adapterHealth,
    })
  } catch (err) {
    res.status(500).json({ error: String(err) })
  }
})

/**
 * GET /connectors/:id/identity
 *
 * Returns the platform identity of the active connector instance — for Telegram
 * bot: `{ name: 'mybot', username: '@mybot', user_id: '12345' }`; for userbot:
 * the logged-in user. Surfaced in the connector detail UI as a "Running as: …"
 * badge so the operator can verify EXACTLY which platform identity is acting
 * (critical for diagnosing "chat not found"-style mismatches).
 */
router.get('/connectors/:id/identity', authMiddleware, requireConnectorPermission('channels:read'), async (req, res) => {
  const id = req.params['id']!
  try {
    const connector = await getConnectorById(id)
    if (!connector) return res.status(404).json({ error: 'Connector not found' })
    const adapter = connectorRegistry.getAdapterForConnector(id) as unknown as { getIdentity?: () => unknown } | null
    if (!adapter) return res.json({ ok: true, identity: null, reason: 'connector_not_active' })
    if (typeof adapter.getIdentity !== 'function') return res.json({ ok: true, identity: null, reason: 'adapter_not_identity_capable' })
    return res.json({ ok: true, identity: adapter.getIdentity() ?? null })
  } catch (err) {
    res.status(500).json({ error: String(err) })
  }
})

// ─── Bindings CRUD ───────────────────────────────────────────────────────────

/** GET /connectors/:id/bindings */
router.get('/connectors/:id/bindings', authMiddleware, requireConnectorPermission('channels:read'), async (req, res) => {
  try {
    const bindings = await getBindings(req.params['id']!)
    res.json({ bindings })
  } catch (err) {
    res.status(500).json({ error: String(err) })
  }
})

/** POST /connectors/:id/bindings */
router.post('/connectors/:id/bindings', authMiddleware, requireConnectorPermission('channels:write'), async (req, res) => {
  try {
    const binding = await createBinding({ connector_id: req.params['id']!, ...req.body })
    res.status(201).json({ binding })
  } catch (err) {
    res.status(500).json({ error: String(err) })
  }
})

/** PATCH /connectors/:id/bindings/:bid */
router.patch('/connectors/:id/bindings/:bid', authMiddleware, requireConnectorPermission('channels:write'), async (req, res) => {
  try {
    const binding = await updateBinding(req.params['bid']!, req.body)
    if (!binding) { res.status(404).json({ error: 'Not found' }); return }
    res.json({ binding })
  } catch (err) {
    res.status(500).json({ error: String(err) })
  }
})

/** DELETE /connectors/:id/bindings/:bid */
router.delete('/connectors/:id/bindings/:bid', authMiddleware, requireConnectorPermission('channels:write'), async (req, res) => {
  try {
    await deleteBinding(req.params['bid']!)
    res.json({ ok: true })
  } catch (err) {
    res.status(500).json({ error: String(err) })
  }
})

// ─── Identities ───────────────────────────────────────────────────────────────

/** GET /connectors/:id/bindings/:bid/identities */
router.get('/connectors/:id/bindings/:bid/identities', authMiddleware, requireConnectorPermission('channels:read'), async (req, res) => {
  try {
    const identities = await getIdentitiesForBinding(req.params['bid']!)
    res.json({ identities })
  } catch (err) {
    res.status(500).json({ error: String(err) })
  }
})

/** PATCH /connectors/:id/bindings/:bid/identities/:iid */
router.patch('/connectors/:id/bindings/:bid/identities/:iid', authMiddleware, requireConnectorPermission('channels:write'), async (req, res) => {
  const { status, mapped_user_id } = req.body as { status?: string; mapped_user_id?: string }
  try {
    const updates: Record<string, unknown> = {}
    if (status) updates['status'] = status
    if (status === 'approved') updates['approved_at'] = new Date()
    if (mapped_user_id) updates['mapped_user_id'] = mapped_user_id
    const identity = await updateIdentity(req.params['iid']!, updates)
    if (!identity) { res.status(404).json({ error: 'Not found' }); return }
    res.json({ identity })
  } catch (err) {
    res.status(500).json({ error: String(err) })
  }
})

// ─── Pairing Requests ────────────────────────────────────────────────────────

/** GET /connectors/:id/pairing-requests — list pending identities with no binding */
router.get('/connectors/:id/pairing-requests', authMiddleware, requireConnectorPermission('channels:read'), async (req, res) => {
  try {
    const requests = await getPairingRequestsForConnector(req.params['id']!)
    res.json({ pairing_requests: requests })
  } catch (err) {
    res.status(500).json({ error: String(err) })
  }
})

/** POST /connectors/:id/pairing-requests/:iid/approve — approve + auto-create binding
 *
 * The new binding is scoped STRICTLY to this identity's DM:
 *   source_type      = 'private'
 *   source_ref_keys  = { user_id: identity.external_ref_keys.user_id }
 * so it cannot match other users' messages or group messages that happen to
 * share the same connector. Previously bindings were created without a scope
 * which caused cross-user/cross-scope leakage.
 */
router.post('/connectors/:id/pairing-requests/:iid/approve', authMiddleware, requireConnectorPermission('channels:write'), async (req, res) => {
  const { output_adapter, output_config, display_name } = req.body as {
    output_adapter?: string
    output_config?: Record<string, unknown>
    display_name?: string
  }
  if (!output_config?.agent_id) { res.status(400).json({ error: 'output_config.agent_id required' }); return }
  try {
    const identityRow = await getIdentityById(req.params['iid']!)
    if (!identityRow) { res.status(404).json({ error: 'Identity not found' }); return }
    if (identityRow.connector_id !== req.params['id']) {
      res.status(400).json({ error: 'Identity does not belong to this connector' }); return
    }

    const externalUserId = (identityRow.external_ref_keys as Record<string, string> | null)?.user_id
    if (!externalUserId) {
      res.status(400).json({ error: 'Identity is missing external_ref_keys.user_id — cannot scope binding' }); return
    }

    const binding = await createBinding({
      connector_id: req.params['id']!,
      display_name: display_name ?? `DM: ${identityRow.display_name ?? externalUserId}`,
      source_type: 'private',
      source_ref_keys: { user_id: externalUserId },
      output_adapter: output_adapter ?? 'conversation',
      output_config: output_config ?? {},
    })
    const identity = await updateIdentity(req.params['iid']!, {
      binding_id: binding.id,
      status: 'approved',
      approved_at: new Date(),
    })
    if (!identity) { res.status(404).json({ error: 'Identity not found' }); return }
    res.json({ identity, binding })
  } catch (err) {
    res.status(500).json({ error: String(err) })
  }
})

/** POST /connectors/:id/pairing-requests/:iid/reject */
router.post('/connectors/:id/pairing-requests/:iid/reject', authMiddleware, requireConnectorPermission('channels:write'), async (req, res) => {
  try {
    const identity = await updateIdentity(req.params['iid']!, { status: 'blocked' })
    if (!identity) { res.status(404).json({ error: 'Identity not found' }); return }
    res.json({ identity })
  } catch (err) {
    res.status(500).json({ error: String(err) })
  }
})

// ─── Group pairing drafts (2026-04-14) ──────────────────────────────────────
// When the bot is added to a group, the adapter auto-creates a disabled
// binding with scope_key_pattern='group:<chat_id>' and no agent_id. Admin
// approves from the UI: picks an agent + member_mode, tool flips enabled=true.

/** GET /connectors/:id/group-pairings — list pending group pairing drafts */
router.get('/connectors/:id/group-pairings', authMiddleware, requireConnectorPermission('channels:read'), async (req, res) => {
  try {
    const drafts = await getPendingGroupPairings(req.params['id']!)
    res.json({ group_pairings: drafts })
  } catch (err) {
    res.status(500).json({ error: String(err) })
  }
})

/** POST /connectors/:id/group-pairings/:bid/approve — assign agent + enable */
router.post('/connectors/:id/group-pairings/:bid/approve', authMiddleware, requireConnectorPermission('channels:write'), async (req, res) => {
  const { agent_id, member_mode, display_name } = req.body as {
    agent_id: string
    member_mode?: 'require_approval' | 'allow_all'
    display_name?: string
  }
  if (!agent_id) { res.status(400).json({ error: 'agent_id required' }); return }
  try {
    const binding = await getBindingById(req.params['bid']!)
    if (!binding || binding.connector_id !== req.params['id']) {
      res.status(404).json({ error: 'Binding not found' }); return
    }
    const mergedConfig = { ...(binding.output_config as Record<string, unknown>), agent_id }
    const cleanDisplayName = display_name
      ?? (binding.display_name?.startsWith('Pending group pairing:')
        ? binding.display_name.replace(/^Pending group pairing:\s*/, 'Group: ')
        : binding.display_name)
    const updated = await updateBinding(req.params['bid']!, {
      output_config: mergedConfig,
      member_mode: member_mode ?? 'require_approval',
      enabled: true,
      display_name: cleanDisplayName ?? undefined,
    })
    res.json({ binding: updated })
  } catch (err) {
    res.status(500).json({ error: String(err) })
  }
})

/** POST /connectors/:id/group-pairings/:bid/reject — delete the draft */
router.post('/connectors/:id/group-pairings/:bid/reject', authMiddleware, requireConnectorPermission('channels:write'), async (req, res) => {
  try {
    const binding = await getBindingById(req.params['bid']!)
    if (!binding || binding.connector_id !== req.params['id']) {
      res.status(404).json({ error: 'Binding not found' }); return
    }
    await deleteBinding(req.params['bid']!)
    res.json({ ok: true })
  } catch (err) {
    res.status(500).json({ error: String(err) })
  }
})

// ─── Blocked identities cleanup (2026-04-14) ───────────────────────────────
// Blocked identities are orphaned rows (binding_id=null, status='blocked').
// Previously the only way to clear them was to delete the whole connector —
// now admin can inspect + unblock (send back to pending) or hard-delete.

/** GET /connectors/:id/blocked-identities */
router.get('/connectors/:id/blocked-identities', authMiddleware, requireConnectorPermission('channels:read'), async (req, res) => {
  try {
    const rows = await getBlockedIdentitiesForConnector(req.params['id']!)
    res.json({ identities: rows })
  } catch (err) {
    res.status(500).json({ error: String(err) })
  }
})

/** POST /connectors/:id/blocked-identities/:iid/unblock — send back to pending queue */
router.post('/connectors/:id/blocked-identities/:iid/unblock', authMiddleware, requireConnectorPermission('channels:write'), async (req, res) => {
  try {
    const identityRow = await getIdentityById(req.params['iid']!)
    if (!identityRow || identityRow.connector_id !== req.params['id']) {
      res.status(404).json({ error: 'Identity not found' }); return
    }
    const updated = await updateIdentity(req.params['iid']!, { status: 'pending' })
    res.json({ identity: updated })
  } catch (err) {
    res.status(500).json({ error: String(err) })
  }
})

/** DELETE /connectors/:id/identities/:iid — hard delete */
router.delete('/connectors/:id/identities/:iid', authMiddleware, requireConnectorPermission('channels:write'), async (req, res) => {
  try {
    const identityRow = await getIdentityById(req.params['iid']!)
    if (!identityRow || identityRow.connector_id !== req.params['id']) {
      res.status(404).json({ error: 'Identity not found' }); return
    }
    await deleteIdentity(req.params['iid']!)
    res.json({ ok: true })
  } catch (err) {
    res.status(500).json({ error: String(err) })
  }
})

// ─── Invite Codes (connector-level) ─────────────────────────────────────────

/** GET /connectors/:id/invite-codes */
router.get('/connectors/:id/invite-codes', authMiddleware, requireConnectorPermission('channels:read'), async (req, res) => {
  try {
    const codes = await getInviteCodesForConnector(req.params['id']!)
    res.json({ invite_codes: codes })
  } catch (err) {
    res.status(500).json({ error: String(err) })
  }
})

/** POST /connectors/:id/invite-codes */
router.post('/connectors/:id/invite-codes', authMiddleware, requireConnectorPermission('channels:write'), async (req, res) => {
  const userId = res.locals['user_id'] as string
  const { label, max_uses, expires_at } = req.body as { label?: string; max_uses?: number; expires_at?: string }
  try {
    const code = Math.random().toString(36).slice(2, 8).toUpperCase()
      + Math.random().toString(36).slice(2, 6).toUpperCase()
    const invite = await createInviteCode({
      connector_id: req.params['id']!,
      code,
      label: label ?? null,
      max_uses: max_uses ?? null,
      expires_at: expires_at ? new Date(expires_at) : null,
      created_by: userId,
    })
    res.status(201).json({ invite_code: invite })
  } catch (err) {
    res.status(500).json({ error: String(err) })
  }
})

/** POST /connectors/:id/invite-codes/:cid/revoke */
router.post('/connectors/:id/invite-codes/:cid/revoke', authMiddleware, requireConnectorPermission('channels:write'), async (req, res) => {
  try {
    const invite = await revokeInviteCode(req.params['cid']!)
    if (!invite) { res.status(404).json({ error: 'Not found' }); return }
    res.json({ invite_code: invite })
  } catch (err) {
    res.status(500).json({ error: String(err) })
  }
})

/** DELETE /connectors/:id/invite-codes/:cid */
router.delete('/connectors/:id/invite-codes/:cid', authMiddleware, requireConnectorPermission('channels:write'), async (req, res) => {
  try {
    await deleteInviteCode(req.params['cid']!)
    res.json({ ok: true })
  } catch (err) {
    res.status(500).json({ error: String(err) })
  }
})

// ─── Events & Messages (read-only) ───────────────────────────────────────────

/** GET /connectors/:id/events */
router.get('/connectors/:id/events', authMiddleware, requireConnectorPermission('channels:read'), async (req, res) => {
  try {
    const limit = parseInt(String(req.query['limit'] ?? '50'))
    const events = await getConnectorEvents(req.params['id']!, limit)
    res.json({ events })
  } catch (err) {
    res.status(500).json({ error: String(err) })
  }
})

/** GET /connectors/:id/messages */
router.get('/connectors/:id/messages', authMiddleware, requireConnectorPermission('channels:read'), async (req, res) => {
  try {
    const limit = parseInt(String(req.query['limit'] ?? '50'))
    const messages = await getConnectorMessages(req.params['id']!, limit)
    res.json({ messages })
  } catch (err) {
    res.status(500).json({ error: String(err) })
  }
})

/** GET /connectors/:id/events/stream — SSE live event stream */
router.get('/connectors/:id/events/stream', authMiddleware, requireConnectorPermission('channels:read'), async (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream')
  res.setHeader('Cache-Control', 'no-cache')
  res.setHeader('Connection', 'keep-alive')
  res.flushHeaders()

  // Keep alive ping
  const ping = setInterval(() => res.write(':ping\n\n'), 15_000)
  req.on('close', () => clearInterval(ping))

  // Register in SSE map for this connector
  const connectorId = req.params['id']!
  const listeners = connectorSseMap.get(connectorId) ?? new Set()
  listeners.add(res)
  connectorSseMap.set(connectorId, listeners)

  req.on('close', () => {
    listeners.delete(res)
    clearInterval(ping)
  })
})

// ─── Plan 22 — Channel Targets ───────────────────────────────────────────────

/** GET /connectors/:id/targets */
router.get('/connectors/:id/targets', authMiddleware, requireConnectorPermission('channels:read'), async (req, res) => {
  try {
    const targets = await getConnectorTargetsForConnector(req.params['id']!)
    res.json({ targets })
  } catch (err) {
    res.status(500).json({ error: String(err) })
  }
})

/** POST /connectors/:id/targets */
router.post('/connectors/:id/targets', authMiddleware, requireConnectorPermission('channels:write'), async (req, res) => {
  const { name, display_name, description, ref_keys, scope_key, metadata } = req.body as {
    name: string; display_name?: string; description?: string
    ref_keys: Record<string, string>; scope_key?: string; metadata?: Record<string, unknown>
  }
  if (!name || !ref_keys) { res.status(400).json({ error: 'name and ref_keys required' }); return }
  try {
    const target = await createConnectorTarget({
      connector_id: req.params['id']!,
      name,
      display_name: display_name ?? null,
      description: description ?? null,
      ref_keys,
      scope_key: scope_key ?? null,
      metadata: metadata ?? {},
    })
    res.status(201).json({ target })
  } catch (err) {
    res.status(500).json({ error: String(err) })
  }
})

/** PATCH /connectors/:id/targets/:tid */
router.patch('/connectors/:id/targets/:tid', authMiddleware, requireConnectorPermission('channels:write'), async (req, res) => {
  try {
    const existing = await getConnectorTargetById(req.params['tid']!)
    if (!existing || existing.connector_id !== req.params['id']) { res.status(404).json({ error: 'Not found' }); return }
    const target = await updateConnectorTarget(req.params['tid']!, req.body)
    res.json({ target })
  } catch (err) {
    res.status(500).json({ error: String(err) })
  }
})

/** DELETE /connectors/:id/targets/:tid */
router.delete('/connectors/:id/targets/:tid', authMiddleware, requireConnectorPermission('channels:write'), async (req, res) => {
  try {
    await deleteConnectorTarget(req.params['tid']!)
    res.json({ ok: true })
  } catch (err) {
    res.status(500).json({ error: String(err) })
  }
})

/** GET /connectors/:id/scopes — list active conversation scopes */
router.get('/connectors/:id/scopes', authMiddleware, requireConnectorPermission('channels:read'), async (req, res) => {
  try {
    const limit = parseInt(String(req.query['limit'] ?? '50'))
    const scopes = await getConnectorScopes(req.params['id']!, limit)
    res.json({ scopes })
  } catch (err) {
    res.status(500).json({ error: String(err) })
  }
})

// ─── Webhook inbound ──────────────────────────────────────────────────────────

// SSE subscriber map: connectorId → Set<Response>
export const connectorSseMap = new Map<string, Set<import('express').Response>>()

/**
 * POST /webhook/:project_id/connector/:connector_id
 * Called by platform webhooks (Telegram, Discord, etc.)
 * The connector plugin parses the raw payload into a ConnectorEvent and emits it.
 */
router.post('/webhook/:project_id/connector/:connector_id', async (req, res) => {
  const { project_id, connector_id } = req.params as { project_id: string; connector_id: string }

  try {
    const adapter = connectorRegistry.getAdapterForConnector(connector_id)
    if (!adapter) {
      res.status(404).json({ error: 'Connector not active' })
      return
    }

    const event = adapter.parseEvent(req.body)
    if (!event) {
      res.status(200).json({ ok: true, skipped: true })
      return
    }
    // Attach the original webhook body so it can be inspected from channels UI
    if (event.raw_payload === undefined) event.raw_payload = req.body

    // Broadcast to SSE listeners
    const listeners = connectorSseMap.get(connector_id)
    if (listeners && listeners.size > 0) {
      const data = JSON.stringify({ ...event, timestamp: event.timestamp.toISOString() })
      for (const sseRes of listeners) {
        sseRes.write(`data: ${data}\n\n`)
      }
    }

    // Route the event (async — respond immediately)
    const { runtimeManager } = await import('../runtime/manager.ts').then(m => ({ runtimeManager: m.runtimeManager }))
    routeConnectorEvent(event, project_id, runtimeManager).catch(err =>
      console.error('[webhook] route error:', err)
    )

    res.status(200).json({ ok: true })
  } catch (err) {
    console.error('[webhook] error:', err)
    res.status(500).json({ error: String(err) })
  }
})

// ─── Project-level Events & Messages (paginated + filtered + SSE) ──────────

function parseDateParam(v: unknown): Date | undefined {
  if (typeof v !== 'string' || !v) return undefined
  const d = new Date(v)
  return isNaN(d.getTime()) ? undefined : d
}

function parseCursorParam(v: unknown): { created_at: Date; id: string } | undefined {
  if (typeof v !== 'string' || !v) return undefined
  try {
    const decoded = Buffer.from(v, 'base64').toString('utf-8')
    const [iso, id] = decoded.split('|')
    if (!iso || !id) return undefined
    const created_at = new Date(iso)
    if (isNaN(created_at.getTime())) return undefined
    return { created_at, id }
  } catch { return undefined }
}

function encodeCursor(c: { created_at: Date; id: string } | null): string | null {
  if (!c) return null
  return Buffer.from(`${c.created_at.toISOString()}|${c.id}`).toString('base64')
}

/** GET /projects/:pid/connector-events */
router.get('/projects/:pid/connector-events', authMiddleware, requirePermission('channels:read'), async (req, res) => {
  try {
    const q = req.query as Record<string, string | undefined>
    const dir = q['direction']
    const result = await listConnectorEventsForProject({
      project_id: req.params['pid']!,
      connector_id: q['connector_id'] || undefined,
      event_type: q['event_type'] || undefined,
      direction: dir === 'inbound' || dir === 'outbound' ? dir : undefined,
      status: q['status'] || undefined,
      from: parseDateParam(q['from']),
      to: parseDateParam(q['to']),
      cursor: parseCursorParam(q['cursor']) ?? null,
      limit: q['limit'] ? parseInt(q['limit'], 10) : 50,
    })
    res.json({ events: result.items, next_cursor: encodeCursor(result.next_cursor) })
  } catch (err) {
    res.status(500).json({ error: String(err) })
  }
})

/** GET /projects/:pid/connector-messages */
router.get('/projects/:pid/connector-messages', authMiddleware, requirePermission('channels:read'), async (req, res) => {
  try {
    const q = req.query as Record<string, string | undefined>
    const direction = q['direction']
    const result = await listConnectorMessagesForProject({
      project_id: req.params['pid']!,
      connector_id: q['connector_id'] || undefined,
      direction: direction === 'inbound' || direction === 'outbound' ? direction : undefined,
      status: q['status'] || undefined,
      from: parseDateParam(q['from']),
      to: parseDateParam(q['to']),
      cursor: parseCursorParam(q['cursor']) ?? null,
      limit: q['limit'] ? parseInt(q['limit'], 10) : 50,
    })
    res.json({ messages: result.items, next_cursor: encodeCursor(result.next_cursor) })
  } catch (err) {
    res.status(500).json({ error: String(err) })
  }
})

/** GET /projects/:pid/connector-events/stream — SSE live stream for project events */
router.get('/projects/:pid/connector-events/stream', authMiddleware, requirePermission('channels:read'), (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream')
  res.setHeader('Cache-Control', 'no-cache')
  res.setHeader('Connection', 'keep-alive')
  res.flushHeaders()

  const ping = setInterval(() => res.write(':ping\n\n'), 15_000)
  const q = req.query as Record<string, string | undefined>
  const unsubscribe = subscribeProjectEvents(req.params['pid']!, {
    res,
    filter: {
      connector_id: q['connector_id'] || undefined,
      event_type: q['event_type'] || undefined,
      direction: q['direction'] || undefined,
      status: q['status'] || undefined,
    },
  })
  req.on('close', () => { clearInterval(ping); unsubscribe() })
})

/** GET /projects/:pid/connector-messages/stream — SSE live stream for project messages */
router.get('/projects/:pid/connector-messages/stream', authMiddleware, requirePermission('channels:read'), (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream')
  res.setHeader('Cache-Control', 'no-cache')
  res.setHeader('Connection', 'keep-alive')
  res.flushHeaders()

  const ping = setInterval(() => res.write(':ping\n\n'), 15_000)
  const q = req.query as Record<string, string | undefined>
  const unsubscribe = subscribeProjectMessages(req.params['pid']!, {
    res,
    filter: {
      connector_id: q['connector_id'] || undefined,
      direction: q['direction'] || undefined,
      status: q['status'] || undefined,
    },
  })
  req.on('close', () => { clearInterval(ping); unsubscribe() })
})

// ─── Available connector plugins ─────────────────────────────────────────────

/** GET /connector-plugins — list registered connector adapter types */
router.get('/connector-plugins', authMiddleware, (_req, res) => {
  const plugins = connectorRegistry.list().map(a => ({
    id: a.id,
    display_name: a.displayName,
    credential_adapter_id: a.credentialAdapterId,
    ref_keys: a.refKeys,
    supported_events: a.supportedEvents,
  }))
  res.json({ plugins })
})

export default router
