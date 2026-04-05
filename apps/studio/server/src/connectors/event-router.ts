import type { ConnectorEvent, ConnectorBinding, ConnectorIdentity, CallerContext, ConnectorCallerContext } from '@jiku/types'
import {
  getActiveBindingsForProject,
  findIdentityByExternalId,
  createIdentity,
  updateIdentity,
  logConnectorEvent,
  logConnectorMessage,
  createConversation,
  redeemInviteCode,
  getConnectorById,
} from '@jiku-studio/db'
import { connectorRegistry } from './registry.ts'

/**
 * Try to handle an invite code redemption for a message event.
 * Detects `/start <code>` or `/join <code>` patterns.
 * If valid code → auto-approve the identity for the matching binding.
 * Returns true if the event was handled as a code redemption (should not be routed further).
 */
async function tryRedeemInviteCode(event: ConnectorEvent, connectorUuid: string): Promise<boolean> {
  if (event.type !== 'message') return false
  const text = (event.content?.text ?? '').trim()
  const match = text.match(/^\/(?:start|join)\s+([A-Za-z0-9_-]{4,64})$/)
  if (!match) return false

  const code = match[1]!
  const redeemedConnectorId = await redeemInviteCode(code)
  // Code must belong to this connector
  if (!redeemedConnectorId || redeemedConnectorId !== connectorUuid) return false

  const externalUserId = event.sender.external_id
  let identity = await findIdentityByExternalId(connectorUuid, externalUserId)

  if (!identity) {
    identity = await createIdentity({
      connector_id: connectorUuid,
      binding_id: null,
      external_ref_keys: { user_id: externalUserId, username: event.sender.username ?? '', ...event.ref_keys },
      display_name: event.sender.display_name ?? event.sender.username,
      status: 'approved',
    })
    await updateIdentity(identity.id, { approved_at: new Date() })
  } else if (identity.status !== 'approved') {
    await updateIdentity(identity.id, { status: 'approved', approved_at: new Date() })
  }

  const adapter = connectorRegistry.getAdapterForConnector(connectorUuid)
  if (adapter) {
    adapter.sendMessage(
      { ref_keys: event.ref_keys, reply_to_ref_keys: event.ref_keys },
      { text: '✅ Access granted! You can now chat with the agent.' },
    ).catch(() => {})
  }

  return true
}

type RouteResult = 'routed' | 'dropped' | 'pending_approval' | 'rate_limited'

// In-memory rate limit tracking: identity_id → [timestamps]
const rateLimitMap = new Map<string, number[]>()

function checkRateLimit(identityId: string, rpm: number): boolean {
  const now = Date.now()
  const windowMs = 60_000
  let timestamps = rateLimitMap.get(identityId) ?? []
  timestamps = timestamps.filter(t => now - t < windowMs)
  if (timestamps.length >= rpm) return false
  timestamps.push(now)
  rateLimitMap.set(identityId, timestamps)
  return true
}

function matchesTrigger(event: ConnectorEvent, binding: ConnectorBinding): boolean {
  // Source check
  if (binding.source_ref_keys && typeof binding.source_ref_keys === 'object') {
    const required = binding.source_ref_keys as Record<string, string>
    for (const [k, v] of Object.entries(required)) {
      if (event.ref_keys[k] !== v) return false
    }
  }

  // Trigger source check
  if (binding.trigger_source === 'event' && event.type === 'message') return false
  if (binding.trigger_source === 'message' && event.type !== 'message') return false

  // Trigger event type (when trigger_source = 'event')
  if (binding.trigger_event_type && event.type !== binding.trigger_event_type) return false

  // Trigger mode checks (message only)
  if (event.type === 'message' && binding.trigger_mode !== 'always') {
    const text = event.content?.text?.toLowerCase() ?? ''
    switch (binding.trigger_mode) {
      case 'command':
        if (!text.startsWith('/')) return false
        break
      case 'keyword':
        if (!binding.trigger_keywords?.some(k => text.includes(k.toLowerCase()))) return false
        break
      case 'mention':
        // Simple heuristic: text contains @mention
        if (!text.includes('@')) return false
        break
      default:
        break
    }
  }

  return true
}

function buildConnectorContextString(
  event: ConnectorEvent,
  binding: ConnectorBinding,
  identity: ConnectorIdentity,
): string {
  const parts: string[] = []
  parts.push('[Connector Context]')
  parts.push(`Platform: ${event.connector_id.replace('jiku.connector.', '')}`)

  if (binding.include_sender_info) {
    parts.push(`Sender: ${identity.display_name ?? event.sender.display_name ?? event.sender.external_id}`)
    parts.push(`Identity: ${JSON.stringify(identity.external_ref_keys)}`)
  }

  if (event.type !== 'message') {
    parts.push(`Event type: ${event.type}`)
    if (event.content?.raw) {
      parts.push(`Event data: ${JSON.stringify(event.content.raw)}`)
    }
    if (event.target_ref_keys) {
      parts.push(`Target ref: ${JSON.stringify(event.target_ref_keys)}`)
    }
  }

  return parts.join('\n')
}

export function buildConnectorCaller(
  identity: ConnectorIdentity,
  binding: ConnectorBinding,
  event: ConnectorEvent,
): CallerContext {
  const connectorCtx: ConnectorCallerContext = {
    connector_id: event.connector_id,
    binding_id: binding.id,
    identity_id: identity.id,
    external_ref_keys: identity.external_ref_keys as Record<string, string>,
    event_ref_keys: event.ref_keys,
    event_type: event.type,
    platform: event.connector_id.replace('jiku.connector.', ''),
  }

  return {
    user_id: identity.mapped_user_id ?? `connector:${identity.id}`,
    roles: [],
    permissions: ['*'],  // connectors get full access by default
    user_data: {
      display_name: identity.display_name ?? event.sender.display_name ?? event.sender.external_id,
      external_id: event.sender.external_id,
      username: event.sender.username,
    },
    attributes: {
      channel: 'connector',
      platform: event.connector_id.replace('jiku.connector.', ''),
    },
    connector_context: connectorCtx,
  }
}

export async function routeConnectorEvent(
  event: ConnectorEvent,
  projectId: string,
  runtimeManager: import('../runtime/manager.ts').JikuRuntimeManager,
): Promise<RouteResult> {
  const start = Date.now()

  // Resolve the connector UUID from the active context (event.connector_id is plugin_id)
  const activeCtx = connectorRegistry.getActiveContextForPlugin(event.connector_id, projectId)
  const connectorUuid = activeCtx?.connectorId ?? null

  // 0. Invite code redemption — intercept /start <code> or /join <code>
  if (connectorUuid) {
    const redeemed = await tryRedeemInviteCode(event, connectorUuid)
    if (redeemed) return 'routed'
  }

  // 1. Find matching bindings
  const bindingRows = await getActiveBindingsForProject(projectId)
  const matchingBindings = bindingRows.filter(({ binding, connector }) =>
    connector.plugin_id === event.connector_id && matchesTrigger(event, binding as ConnectorBinding)
  )

  // 1b. No matching binding → create pairing request and notify user
  if (matchingBindings.length === 0) {
    if (connectorUuid && event.type === 'message') {
      const externalUserId = event.sender.external_id
      let identity = await findIdentityByExternalId(connectorUuid, externalUserId)
      if (!identity) {
        identity = await createIdentity({
          connector_id: connectorUuid,
          binding_id: null,
          external_ref_keys: { user_id: externalUserId, username: event.sender.username ?? '', ...event.ref_keys },
          display_name: event.sender.display_name ?? event.sender.username,
          status: 'pending',
        })
        const adapter = connectorRegistry.getAdapterForConnector(connectorUuid)
        if (adapter) {
          adapter.sendMessage(
            { ref_keys: event.ref_keys, reply_to_ref_keys: event.ref_keys },
            { text: '👋 Your access request has been sent. Please wait for admin approval.' },
          ).catch(() => {})
        }
      }
      await logConnectorEvent({
        connector_id: connectorUuid,
        identity_id: identity.id,
        event_type: event.type,
        ref_keys: event.ref_keys,
        payload: event as unknown as Record<string, unknown>,
        status: 'pending_approval',
        drop_reason: 'no_binding',
        processing_ms: Date.now() - start,
      })
    }
    return 'pending_approval'
  }

  let result: RouteResult = 'dropped'

  for (const { binding, connector } of matchingBindings) {
    const typedBinding = binding as ConnectorBinding

    // 2. Find or create identity — now keyed by connector_id
    const externalUserId = event.sender.external_id
    let identity = await findIdentityByExternalId(connector.id, externalUserId)
    let isNewIdentity = false

    if (!identity) {
      isNewIdentity = true
      identity = await createIdentity({
        connector_id: connector.id,
        binding_id: typedBinding.id,
        external_ref_keys: { user_id: externalUserId, username: event.sender.username ?? '', ...event.ref_keys },
        display_name: event.sender.display_name ?? event.sender.username,
        status: 'approved',
      })
    } else {
      // Assign binding if identity was a pairing request (no binding yet)
      if (!identity.binding_id) {
        await updateIdentity(identity.id, { binding_id: typedBinding.id, last_seen_at: new Date() })
        identity = { ...identity, binding_id: typedBinding.id }
      } else {
        await updateIdentity(identity.id, { last_seen_at: new Date() })
      }
    }

    const typedIdentity = identity as ConnectorIdentity

    // 3. Approval check
    if (typedIdentity.status === 'blocked') {
      await logConnectorEvent({
        connector_id: connector.id,
        binding_id: typedBinding.id,
        identity_id: typedIdentity.id,
        event_type: event.type,
        ref_keys: event.ref_keys,
        payload: event as unknown as Record<string, unknown>,
        status: 'dropped',
        drop_reason: 'blocked',
        processing_ms: Date.now() - start,
      })
      continue
    }

    if (typedIdentity.status === 'pending') {
      await logConnectorEvent({
        connector_id: connector.id,
        binding_id: typedBinding.id,
        identity_id: typedIdentity.id,
        event_type: event.type,
        ref_keys: event.ref_keys,
        payload: event as unknown as Record<string, unknown>,
        status: 'pending_approval',
        processing_ms: Date.now() - start,
      })
      if (isNewIdentity) {
        const adapter = connectorRegistry.getAdapterForConnector(connector.id)
        if (adapter) {
          adapter.sendMessage(
            { ref_keys: event.ref_keys, reply_to_ref_keys: event.ref_keys },
            { text: '👋 Your access request has been sent. Please wait for admin approval.' },
          ).catch(() => {})
        }
      }
      result = 'pending_approval'
      continue
    }

    // 4. Rate limit
    if (typedBinding.rate_limit_rpm) {
      const ok = checkRateLimit(typedIdentity.id, typedBinding.rate_limit_rpm)
      if (!ok) {
        await logConnectorEvent({
          connector_id: connector.id,
          binding_id: typedBinding.id,
          identity_id: typedIdentity.id,
          event_type: event.type,
          ref_keys: event.ref_keys,
          payload: event as unknown as Record<string, unknown>,
          status: 'rate_limited',
          processing_ms: Date.now() - start,
        })
        result = 'rate_limited'
        continue
      }
    }

    // 5. Log event
    await logConnectorEvent({
      connector_id: connector.id,
      binding_id: typedBinding.id,
      identity_id: typedIdentity.id,
      event_type: event.type,
      ref_keys: event.ref_keys,
      target_ref_keys: event.target_ref_keys,
      payload: event as unknown as Record<string, unknown>,
      metadata: event.metadata,
      status: 'routed',
      processing_ms: Date.now() - start,
    })

    // 6. Build caller
    const caller = buildConnectorCaller(typedIdentity, typedBinding, event)

    // 7. Execute output adapter
    if (typedBinding.output_adapter === 'conversation') {
      executeConversationAdapter(event, typedBinding, typedIdentity, caller, connector.id, projectId, runtimeManager).catch(err =>
        console.error('[connector] conversation adapter error:', err)
      )
    } else if (typedBinding.output_adapter === 'task') {
      executeTaskAdapter(event, typedBinding, caller, projectId, runtimeManager).catch(err =>
        console.error('[connector] task adapter error:', err)
      )
    }

    result = 'routed'
  }

  return result
}

// In-memory set of conversation IDs currently being processed
const runningConversations = new Set<string>()

async function executeConversationAdapter(
  event: ConnectorEvent,
  binding: ConnectorBinding,
  identity: ConnectorIdentity,
  caller: CallerContext,
  connectorId: string,
  projectId: string,
  runtimeManager: import('../runtime/manager.ts').JikuRuntimeManager,
): Promise<void> {
  const cfg = binding.output_config as { agent_id?: string; conversation_mode?: string }
  const agentId = cfg.agent_id
  const conversationMode = cfg.conversation_mode ?? 'persistent'
  if (!agentId) { console.error('[connector] conversation adapter: missing agent_id in output_config'); return }

  const connectorAdapter = connectorRegistry.getAdapterForConnector(connectorId)

  let conversationId: string
  if (conversationMode === 'persistent') {
    if (identity.conversation_id) {
      conversationId = identity.conversation_id
    } else {
      const conv = await createConversation({
        project_id: projectId,
        agent_id: agentId,
        title: `${event.sender.display_name ?? event.sender.external_id} (connector)`,
      })
      conversationId = conv.id
      await updateIdentity(identity.id, { conversation_id: conversationId })
    }
  } else {
    const conv = await createConversation({
      project_id: projectId,
      agent_id: agentId,
      title: `${event.sender.display_name ?? event.sender.external_id} (connector)`,
    })
    conversationId = conv.id
  }

  // Guard: already running → notify and skip
  if (runningConversations.has(conversationId)) {
    connectorAdapter?.sendMessage(
      { ref_keys: event.ref_keys, reply_to_ref_keys: event.ref_keys },
      { text: '⏳ Agent is still processing your previous message. Please wait a moment.' },
    ).catch(() => {})
    return
  }

  runningConversations.add(conversationId)

  // Send typing indicator; repeat every 4s while processing (Telegram typing lasts ~5s)
  connectorAdapter?.sendTyping?.({ ref_keys: event.ref_keys }).catch(() => {})
  const typingInterval = connectorAdapter?.sendTyping
    ? setInterval(() => {
        connectorAdapter.sendTyping!({ ref_keys: event.ref_keys }).catch(() => {})
      }, 4000)
    : null

  try {
    const contextString = buildConnectorContextString(event, binding, identity)
    await logConnectorMessage({
      connector_id: connectorId,
      conversation_id: conversationId,
      direction: 'inbound',
      ref_keys: event.ref_keys,
      content_snapshot: event.content?.text,
      status: 'sent',
    })

    const inputText = event.type === 'message'
      ? (event.content?.text ?? '(no text content)')
      : `[${event.type}] ${JSON.stringify(event.content?.raw ?? event.ref_keys)}`
    const input = contextString ? `${contextString}\n\n${inputText}` : inputText

    const stream = await runtimeManager.run(projectId, {
      agent_id: agentId,
      conversation_id: conversationId,
      caller,
      mode: 'chat',
      input,
    })

    let responseText = ''
    const reader = stream.stream.getReader()
    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        if (value.type === 'text-delta') responseText += (value as { delta?: string; textDelta?: string }).delta ?? (value as { delta?: string; textDelta?: string }).textDelta ?? ''
      }
    } finally {
      reader.releaseLock()
    }

    if (!responseText) return

    if (connectorAdapter) {
      const sendResult = await connectorAdapter.sendMessage(
        { ref_keys: event.ref_keys, reply_to_ref_keys: event.ref_keys },
        { text: responseText, markdown: true }
      )
      await logConnectorMessage({
        connector_id: connectorId,
        conversation_id: conversationId,
        direction: 'outbound',
        ref_keys: sendResult.ref_keys ?? event.ref_keys,
        content_snapshot: responseText,
        status: sendResult.success ? 'sent' : 'failed',
      })
    }
  } finally {
    if (typingInterval) clearInterval(typingInterval)
    runningConversations.delete(conversationId)
  }
}

async function executeTaskAdapter(
  event: ConnectorEvent,
  binding: ConnectorBinding,
  caller: CallerContext,
  projectId: string,
  runtimeManager: import('../runtime/manager.ts').JikuRuntimeManager,
): Promise<void> {
  const cfg = binding.output_config as { agent_id?: string }
  const agentId = cfg.agent_id
  if (!agentId) { console.error('[connector] task adapter: missing agent_id in output_config'); return }

  const conv = await createConversation({
    project_id: projectId,
    agent_id: agentId,
    title: `Task from ${event.sender.display_name ?? event.sender.external_id}`,
  })

  await runtimeManager.run(projectId, {
    agent_id: agentId,
    conversation_id: conv.id,
    caller,
    mode: 'task',
    input: event.content?.text ?? `[${event.type}]`,
  })
}
