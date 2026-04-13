import type { ConnectorEvent, ConnectorBinding, ConnectorIdentity, CallerContext, ConnectorCallerContext, AutoReplyRule, AvailabilitySchedule as AvailabilityScheduleType, AgentQueueMode } from '@jiku/types'
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
  getAgentById,
  getScopeConversation,
  createScopeConversation,
  touchScopeConversation,
  setScopeConversationId,
} from '@jiku-studio/db'
import { connectorRegistry } from './registry.ts'
import { streamRegistry } from '../runtime/stream-registry.ts'
import { conversationQueue } from '../runtime/conversation-queue.ts'
import { evaluateAutoReply } from '../auto-reply/evaluator.ts'
import { isWithinSchedule, type AvailabilitySchedule } from '../utils/schedule.ts'

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

/** Plan 22 — match scope_key against pattern. Supports exact, "*" prefix wildcard, null = match all. */
function matchesScopePattern(scopeKey: string | undefined, pattern: string | null | undefined): boolean {
  if (!pattern) return true
  const sk = scopeKey ?? ''
  if (pattern === 'dm:*') return !scopeKey   // dm = undefined scope
  if (pattern.endsWith(':*')) {
    const prefix = pattern.slice(0, -1) // strip trailing '*'
    return sk.startsWith(prefix)
  }
  return sk === pattern
}

function matchesTrigger(event: ConnectorEvent, binding: ConnectorBinding): boolean {
  // Source check
  if (binding.source_ref_keys && typeof binding.source_ref_keys === 'object') {
    const required = binding.source_ref_keys as Record<string, string>
    for (const [k, v] of Object.entries(required)) {
      if (event.ref_keys[k] !== v) return false
    }
  }

  // Plan 22 — scope_key_pattern filter
  if (binding.scope_key_pattern) {
    if (!matchesScopePattern(event.scope_key, binding.scope_key_pattern)) return false
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

  // Plan 15.5: Regex match
  if (binding.trigger_regex && event.type === 'message') {
    const text = event.content?.text ?? ''
    try {
      if (!new RegExp(binding.trigger_regex, 'i').test(text)) return false
    } catch { return false }
  }

  // Plan 15.5: Schedule filter (time-of-day gate)
  if (binding.schedule_filter) {
    const schedule = binding.schedule_filter as unknown as AvailabilitySchedule
    if (schedule.enabled && !isWithinSchedule(schedule)) return false
  }

  return true
}

/** Best-effort language_code → IANA timezone mapping for common locales */
const LANG_TO_TIMEZONE: Record<string, string> = {
  id: 'Asia/Jakarta',
  en: 'America/New_York',
  'en-GB': 'Europe/London',
  ru: 'Europe/Moscow',
  uk: 'Europe/Kiev',
  de: 'Europe/Berlin',
  fr: 'Europe/Paris',
  es: 'Europe/Madrid',
  it: 'Europe/Rome',
  pt: 'America/Sao_Paulo',
  'pt-BR': 'America/Sao_Paulo',
  tr: 'Europe/Istanbul',
  ar: 'Asia/Riyadh',
  fa: 'Asia/Tehran',
  zh: 'Asia/Shanghai',
  'zh-CN': 'Asia/Shanghai',
  'zh-TW': 'Asia/Taipei',
  ja: 'Asia/Tokyo',
  ko: 'Asia/Seoul',
  th: 'Asia/Bangkok',
  vi: 'Asia/Ho_Chi_Minh',
  ms: 'Asia/Kuala_Lumpur',
  hi: 'Asia/Kolkata',
  bn: 'Asia/Dhaka',
  pl: 'Europe/Warsaw',
  nl: 'Europe/Amsterdam',
  sv: 'Europe/Stockholm',
  no: 'Europe/Oslo',
  da: 'Europe/Copenhagen',
  fi: 'Europe/Helsinki',
  cs: 'Europe/Prague',
  ro: 'Europe/Bucharest',
  hu: 'Europe/Budapest',
  he: 'Asia/Jerusalem',
}

function buildConnectorContextString(
  event: ConnectorEvent,
  binding: ConnectorBinding,
  identity: ConnectorIdentity,
  eventId?: string,
  connectorId?: string,
): string {
  const parts: string[] = []
  parts.push('[Connector Context]')
  parts.push(`Platform: ${event.connector_id.replace('jiku.connector.', '')}`)
  if (connectorId) parts.push(`Connector ID: ${connectorId}`)

  // Plan 22 — scope_key + chat info + raw ref_keys so the agent can register targets
  if (event.scope_key) {
    parts.push(`Chat scope: ${event.scope_key}`)
  }
  const chatId = event.ref_keys['chat_id']
  const threadId = event.ref_keys['thread_id']
  if (chatId) {
    const threadHint = threadId ? `, thread_id=${threadId}` : ''
    parts.push(`Chat ref: chat_id=${chatId}${threadHint}`)
  }
  const chatTitle = event.metadata?.['chat_title']
  const chatType = event.metadata?.['chat_type']
  if (chatTitle) parts.push(`Chat: ${chatTitle}${chatType ? ` (${chatType})` : ''}`)

  if (binding.include_sender_info) {
    parts.push(`Sender: ${identity.display_name ?? event.sender.display_name ?? event.sender.external_id}`)
    parts.push(`Identity: ${JSON.stringify(identity.external_ref_keys)}`)
  }

  // Plan 22 — media availability hint (lazy fetch via event_id)
  if (event.content?.media) {
    const m = event.content.media
    const sizeHint = m.file_size ? ` ${Math.round(m.file_size / 1024)}KB` : ''
    const nameHint = m.file_name ? ` "${m.file_name}"` : ''
    const evIdHint = eventId ? `event_id: "${eventId}"` : `message_id=${event.ref_keys['message_id']}, chat_id=${event.ref_keys['chat_id']}`
    parts.push(
      `Media available: ${m.type}${nameHint}${sizeHint} (${evIdHint}) — ` +
      `use connector_run_action("fetch_media", { event_id, save_path: "/your/path" }) to download`,
    )
  }

  // Inject message timestamp and user locale/timezone hint
  const serverTz = Intl.DateTimeFormat().resolvedOptions().timeZone
  const msgTime = event.timestamp
  const langCode = event.metadata?.['language_code'] as string | null | undefined
  const userTz = langCode ? (LANG_TO_TIMEZONE[langCode] ?? LANG_TO_TIMEZONE[langCode.split('-')[0]!] ?? null) : null

  parts.push(`Message received at: ${msgTime.toISOString()} (server timezone: ${serverTz})`)
  if (userTz) {
    const localTime = msgTime.toLocaleString('en-US', { timeZone: userTz, dateStyle: 'full', timeStyle: 'long' })
    parts.push(`User locale: ${langCode} — estimated timezone: ${userTz} — user local time: ${localTime}`)
  } else if (langCode) {
    parts.push(`User locale: ${langCode} (timezone unknown)`)
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

  // Plan 22 — compute scope_key from adapter (multi-chat adapters populate this)
  if (connectorUuid && event.scope_key === undefined) {
    const adapter = connectorRegistry.getAdapterForConnector(connectorUuid)
    if (adapter?.computeScopeKey) {
      const sk = adapter.computeScopeKey({ ref_keys: event.ref_keys, metadata: event.metadata })
      if (sk) event.scope_key = sk
    }
  }

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

  // Plan 15.5: Sort by priority (descending — higher wins)
  const sorted = [...matchingBindings].sort((a, b) =>
    ((b.binding as ConnectorBinding).priority ?? 0) - ((a.binding as ConnectorBinding).priority ?? 0)
  )

  // Determine match mode from the connector (all same connector for a given plugin)
  const firstConnector = sorted[0]?.connector
  const matchMode = (firstConnector as Record<string, unknown>)?.match_mode as string ?? 'all'

  let result: RouteResult = 'dropped'

  for (const { binding, connector } of sorted) {
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
    const loggedEvent = await logConnectorEvent({
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
      executeConversationAdapter(event, typedBinding, typedIdentity, caller, connector.id, projectId, runtimeManager, loggedEvent.id).catch(err =>
        console.error('[connector] conversation adapter error:', err)
      )
    } else if (typedBinding.output_adapter === 'task') {
      executeTaskAdapter(event, typedBinding, caller, projectId, runtimeManager).catch(err =>
        console.error('[connector] task adapter error:', err)
      )
    }

    result = 'routed'

    // Plan 15.5: first-match mode — stop after first successful route
    if (matchMode === 'first') break
  }

  // Plan 15.5: Fallback default agent — if no binding matched and connector has a default
  if (result === 'dropped' && firstConnector && event.type === 'message') {
    const defaultAgentId = (firstConnector as Record<string, unknown>).default_agent_id as string | null
    if (defaultAgentId && connectorUuid) {
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
      }
      const typedIdentity = identity as ConnectorIdentity
      if (typedIdentity.status === 'approved') {
        // Create a synthetic binding for the fallback
        const fallbackBinding: ConnectorBinding = {
          id: 'fallback',
          connector_id: connectorUuid,
          source_type: 'any',
          trigger_source: 'message',
          trigger_mode: 'always',
          output_adapter: 'conversation',
          output_config: { agent_id: defaultAgentId, conversation_mode: 'persistent' },
          include_sender_info: true,
          enabled: true,
          priority: 0,
          created_at: new Date(),
        }
        const caller = buildConnectorCaller(typedIdentity, fallbackBinding, event)
        executeConversationAdapter(event, fallbackBinding, typedIdentity, caller, connectorUuid, projectId, runtimeManager).catch(err =>
          console.error('[connector] fallback adapter error:', err)
        )
        result = 'routed'
      }
    }
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
  eventId?: string,
): Promise<void> {
  const cfg = binding.output_config as { agent_id?: string; conversation_mode?: string }
  const agentId = cfg.agent_id
  const conversationMode = cfg.conversation_mode ?? 'persistent'
  if (!agentId) { console.error('[connector] conversation adapter: missing agent_id in output_config'); return }

  const connectorAdapter = connectorRegistry.getAdapterForConnector(connectorId)

  // --- Auto-reply intercept ---
  const agentRecord = await getAgentById(agentId)
  if (agentRecord && event.type === 'message') {
    const autoReplyRules = (agentRecord.auto_replies ?? []) as AutoReplyRule[]
    const availabilitySchedule = (agentRecord.availability_schedule ?? null) as AvailabilitySchedule | null
    const inputText = event.content?.text ?? ''
    const autoReply = evaluateAutoReply(inputText, autoReplyRules, availabilitySchedule)
    if (autoReply.matched && autoReply.response) {
      connectorAdapter?.sendMessage(
        { ref_keys: event.ref_keys, reply_to_ref_keys: event.ref_keys },
        { text: autoReply.response },
      ).catch(() => {})
      return
    }
  }

  let conversationId: string
  if (conversationMode === 'persistent') {
    // Plan 22 — scope-aware conversation resolution for group/topic/thread
    const scopeKey = event.scope_key
    if (scopeKey) {
      const existing = await getScopeConversation(connectorId, scopeKey, agentId)
      if (existing && existing.conversation_id) {
        conversationId = existing.conversation_id
        await touchScopeConversation(existing.id)
      } else {
        const chatTitle = (event.metadata?.['chat_title'] as string | undefined) ?? scopeKey
        const conv = await createConversation({
          project_id: projectId,
          agent_id: agentId,
          title: `${chatTitle} (${scopeKey})`,
        })
        conversationId = conv.id
        if (existing) {
          await setScopeConversationId(existing.id, conversationId)
        } else {
          await createScopeConversation({
            connector_id: connectorId,
            scope_key: scopeKey,
            agent_id: agentId,
            conversation_id: conversationId,
          })
        }
      }
    } else if (identity.conversation_id) {
      // DM path — existing identity-based mapping
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

  // --- Queue mode intercept: if running + queue enabled, enqueue instead of drop ---
  const queueMode = ((agentRecord?.queue_mode ?? 'off') as AgentQueueMode)
  if (runningConversations.has(conversationId)) {
    if (queueMode === 'off') {
      connectorAdapter?.sendMessage(
        { ref_keys: event.ref_keys, reply_to_ref_keys: event.ref_keys },
        { text: '⏳ Agent is still processing your previous message. Please wait a moment.' },
      ).catch(() => {})
      return
    }

    if (queueMode === 'ack_queue') {
      connectorAdapter?.sendMessage(
        { ref_keys: event.ref_keys, reply_to_ref_keys: event.ref_keys },
        { text: '⏳ Your message has been queued and will be processed shortly.' },
      ).catch(() => {})
    }

    // Enqueue — will be processed when current run finishes
    const contextString = buildConnectorContextString(event, binding, identity, eventId, connectorId)
    const inputText = event.type === 'message'
      ? (event.content?.text ?? '(no text content)')
      : `[${event.type}] ${JSON.stringify(event.content?.raw ?? event.ref_keys)}`
    const queuedInput = contextString ? `${contextString}\n\n${inputText}` : inputText

    conversationQueue.enqueue(conversationId, {
      input: queuedInput,
      caller,
      resolve: async (runResult) => {
        // Drain stream for response text
        let responseText = ''
        const reader = runResult.stream.getReader()
        try {
          while (true) {
            const { done, value } = await reader.read()
            if (done) break
            if (value.type === 'text-delta') responseText += (value as { delta?: string; textDelta?: string }).delta ?? (value as { delta?: string; textDelta?: string }).textDelta ?? ''
          }
        } finally {
          reader.releaseLock()
        }
        if (responseText && connectorAdapter) {
          connectorAdapter.sendMessage(
            { ref_keys: event.ref_keys, reply_to_ref_keys: event.ref_keys },
            { text: responseText, markdown: true },
          ).catch(() => {})
        }
      },
      reject: () => {},
    })
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
    const contextString = buildConnectorContextString(event, binding, identity, eventId, connectorId)
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

    const runResult = await runtimeManager.run(projectId, {
      agent_id: agentId,
      conversation_id: conversationId,
      caller,
      mode: 'chat',
      input,
    })

    // Register in streamRegistry so web observers (other tabs, run detail) get realtime updates
    const { broadcast, bufferChunk, done: registryDone } = streamRegistry.startRun(conversationId)
    const [observerStream, drainStream] = runResult.stream.tee()

    // Drain observer branch — buffer chunks + broadcast to SSE subscribers
    ;(async () => {
      try {
        const obsReader = observerStream.getReader()
        while (true) {
          const { done, value } = await obsReader.read()
          if (done) break
          bufferChunk(value as Record<string, unknown>)
          broadcast(`data: ${JSON.stringify(value)}\n\n`)
        }
      } finally {
        registryDone()
      }
    })()

    // Drain main branch for response text
    let responseText = ''
    const reader = drainStream.getReader()
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

    // Process next queued message if any
    drainConnectorQueue(conversationId, agentId, projectId, connectorId, event, binding, identity, runtimeManager)
      .catch(err => console.error('[connector] queue drain error:', err))
  }
}

/**
 * Drain the connector conversation queue: process next queued message.
 */
async function drainConnectorQueue(
  conversationId: string,
  agentId: string,
  projectId: string,
  connectorId: string,
  originalEvent: ConnectorEvent,
  binding: ConnectorBinding,
  identity: ConnectorIdentity,
  runtimeManager: import('../runtime/manager.ts').JikuRuntimeManager,
): Promise<void> {
  const next = conversationQueue.dequeue(conversationId)
  if (!next) return

  const connectorAdapter = connectorRegistry.getAdapterForConnector(connectorId)

  // Send typing indicator
  connectorAdapter?.sendTyping?.({ ref_keys: originalEvent.ref_keys }).catch(() => {})

  runningConversations.add(conversationId)

  try {
    const runResult = await runtimeManager.run(projectId, {
      agent_id: agentId,
      conversation_id: conversationId,
      caller: next.caller,
      mode: 'chat',
      input: next.input,
    })

    // Register in streamRegistry for web observers
    const { broadcast, bufferChunk, done: registryDone } = streamRegistry.startRun(conversationId)
    const [observerStream, drainStream] = runResult.stream.tee()

    // Drain observer branch
    ;(async () => {
      try {
        const obsReader = observerStream.getReader()
        while (true) {
          const { done, value } = await obsReader.read()
          if (done) break
          bufferChunk(value as Record<string, unknown>)
          broadcast(`data: ${JSON.stringify(value)}\n\n`)
        }
      } finally {
        registryDone()
      }
    })()

    next.resolve({ ...runResult, stream: drainStream })
  } catch (err) {
    next.reject(err instanceof Error ? err : new Error(String(err)))
  } finally {
    runningConversations.delete(conversationId)
    // Recursively drain next
    drainConnectorQueue(conversationId, agentId, projectId, connectorId, originalEvent, binding, identity, runtimeManager)
      .catch(() => {})
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
