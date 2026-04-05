import type { ConnectorEvent, ConnectorBinding, ConnectorIdentity, CallerContext, ConnectorCallerContext } from '@jiku/types'
import {
  getActiveBindingsForProject,
  findIdentityByExternalId,
  createIdentity,
  updateIdentity,
  logConnectorEvent,
  logConnectorMessage,
  createConversation,
} from '@jiku-studio/db'
import { connectorRegistry } from './registry.ts'

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

  // 1. Find matching bindings
  const bindingRows = await getActiveBindingsForProject(projectId)
  const matchingBindings = bindingRows.filter(({ binding, connector }) =>
    connector.plugin_id === event.connector_id && matchesTrigger(event, binding as ConnectorBinding)
  )

  if (matchingBindings.length === 0) {
    await logConnectorEvent({
      connector_id: event.connector_id,
      event_type: event.type,
      ref_keys: event.ref_keys,
      payload: event as unknown as Record<string, unknown>,
      status: 'dropped',
      drop_reason: 'no_matching_binding',
    })
    return 'dropped'
  }

  let result: RouteResult = 'dropped'

  for (const { binding, connector } of matchingBindings) {
    const typedBinding = binding as ConnectorBinding

    // 2. Find or create identity
    const externalUserId = event.sender.external_id
    let identity = await findIdentityByExternalId(typedBinding.id, externalUserId)

    if (!identity) {
      identity = await createIdentity({
        binding_id: typedBinding.id,
        external_ref_keys: { user_id: externalUserId, username: event.sender.username ?? '', ...event.ref_keys },
        display_name: event.sender.display_name ?? event.sender.username,
        status: typedBinding.require_approval ? 'pending' : 'approved',
      })
    } else {
      // Update last seen
      await updateIdentity(identity.id, { last_seen_at: new Date() })
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

    // 7. Execute adapter
    if (typedBinding.adapter_type === 'conversation') {
      executeConversationAdapter(event, typedBinding, typedIdentity, caller, connector.id, projectId, runtimeManager).catch(err =>
        console.error('[connector] conversation adapter error:', err)
      )
    } else if (typedBinding.adapter_type === 'task') {
      executeTaskAdapter(event, typedBinding, caller, projectId, runtimeManager).catch(err =>
        console.error('[connector] task adapter error:', err)
      )
    }

    result = 'routed'
  }

  return result
}

async function executeConversationAdapter(
  event: ConnectorEvent,
  binding: ConnectorBinding,
  identity: ConnectorIdentity,
  caller: CallerContext,
  connectorId: string,
  projectId: string,
  runtimeManager: import('../runtime/manager.ts').JikuRuntimeManager,
): Promise<void> {
  // Get or create conversation for this identity
  let conversationId = identity.conversation_id ?? undefined
  if (!conversationId) {
    const conv = await createConversation({
      project_id: projectId,
      agent_id: binding.agent_id,
      title: `${event.sender.display_name ?? event.sender.external_id} (connector)`,
    })
    conversationId = conv.id
    await updateIdentity(identity.id, { conversation_id: conversationId })
  }

  // Build context injection
  const contextString = buildConnectorContextString(event, binding, identity)

  // Log inbound message
  await logConnectorMessage({
    connector_id: connectorId,
    conversation_id: conversationId,
    direction: 'inbound',
    ref_keys: event.ref_keys,
    content_snapshot: event.content?.text,
    status: 'sent',
  })

  // Build the input message — prepend connector context
  const inputText = event.type === 'message'
    ? (event.content?.text ?? '(no text content)')
    : `[${event.type}] ${JSON.stringify(event.content?.raw ?? event.ref_keys)}`

  const input = contextString
    ? `${contextString}\n\n${inputText}`
    : inputText

  // Run the agent
  const stream = await runtimeManager.run(projectId, {
    agent_id: binding.agent_id,
    conversation_id: conversationId,
    caller,
    mode: 'chat',
    input,
  })

  // Drain stream and collect text
  let responseText = ''
  const reader = stream.stream.getReader()
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      if (value.type === 'text-delta') {
        responseText += value.textDelta
      }
    }
  } finally {
    reader.releaseLock()
  }

  if (!responseText) return

  // Send response via connector adapter
  const adapter = connectorRegistry.getAdapterForConnector(connectorId)
  if (adapter) {
    const sendResult = await adapter.sendMessage(
      { ref_keys: event.ref_keys, reply_to_ref_keys: event.ref_keys },
      { text: responseText, markdown: true }
    )

    // Log outbound message
    await logConnectorMessage({
      connector_id: connectorId,
      conversation_id: conversationId,
      direction: 'outbound',
      ref_keys: sendResult.ref_keys ?? event.ref_keys,
      content_snapshot: responseText,
      status: sendResult.success ? 'sent' : 'failed',
    })
  }
}

async function executeTaskAdapter(
  event: ConnectorEvent,
  binding: ConnectorBinding,
  caller: CallerContext,
  projectId: string,
  runtimeManager: import('../runtime/manager.ts').JikuRuntimeManager,
): Promise<void> {
  const conv = await createConversation({
    project_id: projectId,
    agent_id: binding.agent_id,
    title: `Task from ${event.sender.display_name ?? event.sender.external_id}`,
  })

  const inputText = event.content?.text ?? `[${event.type}]`

  await runtimeManager.run(projectId, {
    agent_id: binding.agent_id,
    conversation_id: conv.id,
    caller,
    mode: 'task',
    input: inputText,
  })
}
