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
  updateIdentity,
  getConnectorEvents,
  getConnectorMessages,
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
      res.status(201).json({ connector: updated ?? connector })
    } else {
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

/** DELETE /connectors/:id */
router.delete('/connectors/:id', authMiddleware, requireConnectorPermission('channels:write'), async (req, res) => {
  try {
    await deleteConnector(req.params['id']!)
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

/** POST /connectors/:id/pairing-requests/:iid/approve — approve + auto-create binding */
router.post('/connectors/:id/pairing-requests/:iid/approve', authMiddleware, requireConnectorPermission('channels:write'), async (req, res) => {
  const { output_adapter, output_config, display_name } = req.body as {
    output_adapter?: string
    output_config?: Record<string, unknown>
    display_name?: string
  }
  if (!output_config?.agent_id) { res.status(400).json({ error: 'output_config.agent_id required' }); return }
  try {
    const binding = await createBinding({
      connector_id: req.params['id']!,
      display_name: display_name ?? 'Auto (pairing)',
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
