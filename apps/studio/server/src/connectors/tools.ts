import { defineTool } from '@jiku/kit'
import { z } from 'zod'
import {
  getConnectors,
  getConnectorEvents,
  getConnectorMessages,
  listConnectorEventsForProject,
  listConnectorMessagesForProject,
  listConnectorDistinctEntities,
  getProjectConnectorEventById,
  getProjectConnectorMessageById,
  updateBinding,
  getUserIdentities,
  upsertUserIdentity,
  findUserByIdentity,
  getConnectorTargets,
  getConnectorTargetsEnriched,
  getConnectorTargetByName,
  getConnectorTargetsByName,
  getConnectorTargetById,
  getConnectorScopes,
  getConnectorById,
  createConnectorTarget,
  updateConnectorTarget,
  deleteConnectorTarget,
  logConnectorEvent,
  logConnectorMessage,
} from '@jiku-studio/db'
import type { ConnectorTarget } from '@jiku/types'
import { connectorRegistry } from './registry.ts'
import { broadcastProjectEvent, broadcastProjectMessage } from './sse-hub.ts'

// Keyset pagination cursor helpers — shared with the REST routes.
function encodeCursor(c: { created_at: Date; id: string } | null): string | null {
  if (!c) return null
  return Buffer.from(`${c.created_at.toISOString()}|${c.id}`).toString('base64')
}
function decodeCursor(v: string): { created_at: Date; id: string } | null {
  try {
    const [iso, id] = Buffer.from(v, 'base64').toString('utf-8').split('|')
    if (!iso || !id) return null
    const created_at = new Date(iso)
    if (isNaN(created_at.getTime())) return null
    return { created_at, id }
  } catch { return null }
}

/**
 * Build connector built-in tools.
 * These are registered on agents when the project has active connectors.
 * They are NOT plugin tools — they're injected directly as built_in_tools.
 */
export function buildConnectorTools(projectId: string) {
  return [

    // ── List available connectors ────────────────────────────────────

    defineTool({
      meta: {
        id: 'connector_list',
        name: 'List Connectors',
        description:
          'List all connectors (bots/integrations) in this project with their id, plugin_id, display_name, and status. ' +
          'ALWAYS call this FRESH at the start of any iteration that will use connector_* tools — the connector set is ' +
          'dynamic (admins enable/disable/reconfigure). Never rely on a list cached from an earlier turn, and never rely ' +
          'on a connector_id passed in runtime context — verify it still exists + is active before calling send/action tools.',
        group: 'connector',
      },
      permission: '*',
      modes: ['chat', 'task'],
      input: z.object({
        status: z.enum(['active', 'inactive', 'error']).optional().describe('Filter by connector status'),
      }),
      execute: async (args) => {
        const { status } = args as { status?: 'active' | 'inactive' | 'error' }
        const allConnectors = await getConnectors(projectId)
        const filtered = status ? allConnectors.filter(c => c.status === status) : allConnectors
        return {
          connectors: filtered.map(c => {
            const adapter = connectorRegistry.getAdapterForConnector(c.id)
            // Plan 27 — surface platform-specific send params so agents know
            // what `params:{}` keys are valid on connector_send to this connector.
            const param_schema = adapter?.getParamSchema ? adapter.getParamSchema() : []
            return {
              id: c.id,
              plugin_id: c.plugin_id,
              display_name: c.display_name,
              status: c.status,
              param_schema,
            }
          }),
        }
      },
    }),

    // ── Query events on a message ────────────────────────────────────

    defineTool({
      meta: {
        id: 'connector_get_events',
        name: 'Get Connector Events',
        description:
          'Search connector events (message, reaction, edit, send_message, custom actions, etc.) across the project with filters + cursor pagination. ' +
          'These tables get LARGE — NEVER fetch without at least one filter (chat_id / user_id / event_type / date range / content_search). ' +
          '\n\nDISCOVERY-FIRST DISCIPLINE: in any iteration that queries history, first call `connector_list_entities` (and/or `connector_list` if you need a bot id) to refresh what currently exists — connectors, chats, and users change between turns. DO NOT reuse chat_ids / user_ids remembered from earlier turns without re-verifying, and do not assume the connector context block in the current message covers other chats. ' +
          '\n\nFilters: connector_id, chat_id (specific group/channel), thread_id (forum topic), user_id (external sender id), event_type, direction, status, date range (from/to ISO), content_search (ILIKE against payload.content.text). ' +
          'Returns `{ events, next_cursor }` — pass next_cursor back as `cursor` to page forward.',
        group: 'connector',
      },
      permission: '*',
      modes: ['chat', 'task'],
      input: z.object({
        connector_id: z.string().optional().describe('Scope to one connector; omit to search across all connectors in the project.'),
        chat_id: z.string().optional().describe('Filter to one chat/group/channel by platform chat_id (e.g. Telegram "-100...").'),
        thread_id: z.string().optional().describe('Filter to one forum topic / thread inside a chat.'),
        user_id: z.string().optional().describe('Filter by external sender id (e.g. Telegram numeric user_id).'),
        direction: z.enum(['inbound', 'outbound']).optional().describe('"inbound" = from user, "outbound" = from bot.'),
        event_type: z.string().optional().describe('Exact event_type, e.g. "message", "reaction", "send_message".'),
        status: z.string().optional().describe('Exact status, e.g. "routed", "dropped", "pending_approval".'),
        content_search: z.string().optional().describe('Case-insensitive substring match against the message text inside the event payload.'),
        from: z.string().optional().describe('ISO timestamp — lower bound of created_at.'),
        to: z.string().optional().describe('ISO timestamp — upper bound of created_at.'),
        cursor: z.string().optional().describe('Pagination cursor from a previous response (opaque base64 string).'),
        limit: z.number().int().min(1).max(100).default(30),
      }),
      execute: async (args) => {
        const a = args as {
          connector_id?: string; chat_id?: string; thread_id?: string; user_id?: string
          direction?: 'inbound' | 'outbound'; event_type?: string; status?: string
          content_search?: string; from?: string; to?: string; cursor?: string; limit: number
        }
        const cursor = a.cursor ? decodeCursor(a.cursor) : null
        const result = await listConnectorEventsForProject({
          project_id: projectId,
          connector_id: a.connector_id,
          chat_id: a.chat_id,
          thread_id: a.thread_id,
          user_id: a.user_id,
          direction: a.direction,
          event_type: a.event_type,
          status: a.status,
          content_search: a.content_search,
          from: a.from ? new Date(a.from) : undefined,
          to: a.to ? new Date(a.to) : undefined,
          cursor,
          limit: a.limit,
        })
        return {
          events: result.items,
          next_cursor: encodeCursor(result.next_cursor),
        }
      },
    }),

    // ── Get messages from a thread (paginated + searchable) ──────────

    defineTool({
      meta: {
        id: 'connector_get_thread',
        name: 'Get Connector Messages',
        description:
          'Search inbound/outbound connector messages across the project with filters + cursor pagination. ' +
          'This table gets LARGE — NEVER fetch without at least one filter. ' +
          '\n\nDISCOVERY-FIRST DISCIPLINE: before querying, refresh the landscape in THIS iteration by calling `connector_list_entities` for chat_ids/user_ids/threads. Re-fetch every time — chats/users change between turns; data cached from earlier responses is stale. Do not assume the current connector_context block covers other chats. ' +
          '\n\nFilters: connector_id, chat_id, thread_id, direction, status ("handled", "unhandled", "pending", "dropped", "rate_limited", "sent", "failed"), date range (from/to ISO), content_search (ILIKE against content_snapshot). ' +
          'Each row has `raw_payload` (the original platform object) so you can extract entities, custom_emoji, attachments. ' +
          'Returns `{ messages, next_cursor }` — pass next_cursor back to page.',
        group: 'connector',
      },
      permission: '*',
      modes: ['chat', 'task'],
      input: z.object({
        connector_id: z.string().optional(),
        chat_id: z.string().optional().describe('Filter to one chat_id.'),
        thread_id: z.string().optional().describe('Filter to one thread_id inside a chat.'),
        direction: z.enum(['inbound', 'outbound']).optional(),
        status: z.string().optional().describe('e.g. "handled", "unhandled", "pending", "dropped", "rate_limited".'),
        content_search: z.string().optional().describe('Case-insensitive substring match against content_snapshot.'),
        from: z.string().optional().describe('ISO timestamp — lower bound of created_at.'),
        to: z.string().optional().describe('ISO timestamp — upper bound of created_at.'),
        cursor: z.string().optional().describe('Pagination cursor from a previous response.'),
        limit: z.number().int().min(1).max(100).default(30),
      }),
      execute: async (args) => {
        const a = args as {
          connector_id?: string; chat_id?: string; thread_id?: string
          direction?: 'inbound' | 'outbound'; status?: string
          content_search?: string; from?: string; to?: string; cursor?: string; limit: number
        }
        const cursor = a.cursor ? decodeCursor(a.cursor) : null
        const result = await listConnectorMessagesForProject({
          project_id: projectId,
          connector_id: a.connector_id,
          chat_id: a.chat_id,
          thread_id: a.thread_id,
          direction: a.direction,
          status: a.status,
          content_search: a.content_search,
          from: a.from ? new Date(a.from) : undefined,
          to: a.to ? new Date(a.to) : undefined,
          cursor,
          limit: a.limit,
        })
        return {
          messages: result.items,
          next_cursor: encodeCursor(result.next_cursor),
        }
      },
    }),

    // ── Entity discovery: list distinct chat_ids / user_ids / thread_ids ──

    defineTool({
      meta: {
        id: 'connector_list_entities',
        name: 'List Connector Entities',
        description:
          'AUTHORITATIVE discovery tool for chats, users, and forum topics the bot has seen. Always use THIS (not connector_list_targets) when you need to find a real chat_id / user_id / thread_id — list_targets only surfaces ADMIN-REGISTERED aliases and is an incomplete subset. ' +
          '\n\nALWAYS call this at the start of any iteration that will observe traffic (summarise a group, recall a user\'s last messages, audit activity). Treat results as fresh-per-turn; do NOT reuse entity ids from earlier turns without re-listing. Entity set changes between turns (new members, new groups). ' +
          '\n\nscope="chats" → unique chat_ids with chat title + chat_type + event_count + last_seen_at. ' +
          'scope="users" → unique external user_ids with display_name + @username + event_count + last_seen_at. ' +
          'scope="threads" → unique (chat_id, thread_id) pairs for forum topics. ' +
          '\n\nThen narrow with `connector_get_events` / `connector_get_thread` using the discovered ids + content_search + date filters.',
        group: 'connector',
      },
      permission: '*',
      modes: ['chat', 'task'],
      input: z.object({
        scope: z.enum(['chats', 'users', 'threads']).describe('Which entity dimension to list.'),
        connector_id: z.string().optional().describe('Scope to one connector; omit to list across all connectors in the project.'),
        limit: z.number().int().min(1).max(200).default(50),
      }),
      execute: async (args) => {
        const { scope, connector_id, limit } = args as {
          scope: 'chats' | 'users' | 'threads'
          connector_id?: string
          limit: number
        }
        const entities = await listConnectorDistinctEntities({
          project_id: projectId,
          connector_id,
          scope,
          limit,
        })
        return { scope, entities, count: entities.length }
      },
    }),

    // ── Fetch a single event / message by internal id ────────────────

    defineTool({
      meta: {
        id: 'connector_get_event',
        name: 'Get Connector Event by ID',
        description:
          'Fetch the full connector_events row by its internal UUID. The current [connector_context] ' +
          'block injects the inbound message\'s `Internal event_id` — pass that id here to load the ' +
          'complete row including parsed payload, raw_payload (the original platform JSON — Telegram ' +
          'entities, custom_emoji, reply_to_message, etc.), metadata, status, and the owning connector. ' +
          'Scoped to the current project; returns null if not found.',
        group: 'connector',
      },
      permission: '*',
      modes: ['chat', 'task'],
      input: z.object({
        event_id: z.string().describe('Internal UUID from [connector_context].Internal event_id or connector_get_events results.'),
      }),
      execute: async (args) => {
        const { event_id } = args as { event_id: string }
        const row = await getProjectConnectorEventById(projectId, event_id)
        return row ? { event: row } : { event: null, error: 'Not found in this project.' }
      },
    }),

    defineTool({
      meta: {
        id: 'connector_get_message',
        name: 'Get Connector Message by ID',
        description:
          'Fetch the full connector_messages row by its internal UUID. The current [connector_context] ' +
          'block injects the inbound message\'s `Internal message_id` — pass that id here to load the ' +
          'complete row including conversation_id, ref_keys, content_snapshot, raw_payload (original ' +
          'platform object), and the owning connector. Scoped to the current project; returns null if ' +
          'not found.',
        group: 'connector',
      },
      permission: '*',
      modes: ['chat', 'task'],
      input: z.object({
        message_id: z.string().describe('Internal UUID from [connector_context].Internal message_id or connector_get_thread results.'),
      }),
      execute: async (args) => {
        const { message_id } = args as { message_id: string }
        const row = await getProjectConnectorMessageById(projectId, message_id)
        return row ? { message: row } : { message: null, error: 'Not found in this project.' }
      },
    }),

    // ── Send a message to a platform ─────────────────────────────────

    defineTool({
      meta: {
        id: 'connector_send',
        side_effectful: true,
        name: 'Send Connector Message',
        description:
          'Send a message to a platform chat via connector using raw ref_keys (e.g. `{ chat_id, thread_id? }`). ' +
          'Use this when you already have the chat_id — discover chat_ids via `connector_list_entities` ' +
          '(authoritative) or use `connector_send_to_target` if the user asked for a named alias. ' +
          'Always verify the connector is active via a fresh `connector_list` call in the same iteration before sending.',
        group: 'connector',
      },
      permission: '*',
      modes: ['chat', 'task'],
      input: z.object({
        connector_id: z.string(),
        target_ref_keys: z.record(z.string()),
        text: z.string(),
        reply_to_ref_keys: z.record(z.string()).optional(),
        markdown: z.boolean().default(true),
        simulate_typing: z.boolean().default(false).describe('When true, the adapter shows a "typing" effect by sending a placeholder and progressively editing it. Use for chat replies where the user is waiting; leave false for proactive notifications/broadcasts.'),
        params: z.record(z.unknown()).optional().describe('Plan 27 — platform-specific extras (e.g. Telegram: reply_to_message_id, parse_mode, message_thread_id, protect_content, disable_web_page_preview). Check `connector_list` > param_schema per connector for valid keys.'),
      }),
      execute: async (args) => {
        const { connector_id, target_ref_keys, text, reply_to_ref_keys, markdown, simulate_typing, params } = args as {
          connector_id: string
          target_ref_keys: Record<string, string>
          text: string
          reply_to_ref_keys?: Record<string, string>
          markdown: boolean
          simulate_typing: boolean
          params?: Record<string, unknown>
        }
        const adapter = connectorRegistry.getAdapterForConnector(connector_id)
        if (!adapter) return { success: false, error: 'Connector not active' }

        // Plan 27 — validate params against adapter schema (if declared). Unknown
        // keys produce an informative error so the agent fixes the call, not
        // silently passes bogus fields to the platform.
        if (params && adapter.getParamSchema) {
          const schema = adapter.getParamSchema()
          const valid = new Set(schema.map(s => s.name))
          const unknown = Object.keys(params).filter(k => !valid.has(k))
          if (unknown.length > 0) {
            return {
              success: false,
              code: 'INVALID_PARAMS',
              error: `Unknown params for ${adapter.id}: ${unknown.join(', ')}. Check connector_list > param_schema for valid keys.`,
              valid_params: [...valid],
            }
          }
        }

        const sendResult = await adapter.sendMessage(
          { ref_keys: target_ref_keys, reply_to_ref_keys },
          { text, markdown, simulate_typing, params },
        )
        // Log outbound message + outbound event for inspection in channels UI
        const msgRow = await logConnectorMessage({
          connector_id,
          direction: 'outbound',
          ref_keys: sendResult.ref_keys ?? target_ref_keys,
          content_snapshot: text,
          raw_payload: sendResult,
          status: sendResult.success ? 'sent' : 'failed',
        }).catch(() => null)
        if (msgRow) broadcastProjectMessage(projectId, msgRow as unknown as Record<string, unknown>)
        const evRow = await logConnectorEvent({
          connector_id,
          event_type: 'send_message',
          direction: 'outbound',
          ref_keys: sendResult.ref_keys ?? target_ref_keys,
          target_ref_keys: reply_to_ref_keys,
          payload: { text, markdown, simulate_typing },
          raw_payload: sendResult,
          status: sendResult.success ? 'routed' : 'error',
        }).catch(() => null)
        if (evRow) broadcastProjectEvent(projectId, evRow as unknown as Record<string, unknown>)
        return sendResult
      },
    }),

    // ── List adapter-specific actions ────────────────────────────────

    defineTool({
      meta: {
        id: 'connector_list_actions',
        name: 'List Connector Actions',
        description: 'List the platform-specific actions available for a connector (e.g. send_file, send_reaction, pin_message). Call this before connector_run_action to know which actions and params are supported.',
        group: 'connector',
      },
      permission: '*',
      modes: ['chat', 'task'],
      input: z.object({
        connector_id: z.string().describe('Connector ID'),
      }),
      execute: async (args) => {
        const { connector_id } = args as { connector_id: string }
        const adapter = connectorRegistry.getAdapterForConnector(connector_id)
        if (!adapter) return { error: 'Connector not active', actions: [] }
        const actions = adapter.actions ?? []
        return {
          connector_id,
          adapter: adapter.id,
          actions: actions.map(a => ({
            id: a.id,
            name: a.name,
            description: a.description,
            params: a.params,
          })),
        }
      },
    }),

    // Plan 24 Phase 5 — surface userbot rate-limit / queue health to the agent.
    defineTool({
      meta: {
        id: 'connector_get_queue_status',
        name: 'Get Connector Queue Status',
        description:
          'Inspect rate-limit + queue health for a connector. Userbot connectors (jiku.telegram.user) enforce a per-chat min gap, global per-minute quota, FLOOD_WAIT scope-aware pause, and PEER_FLOOD spam-restricted latch — call this BEFORE bursting many sends, especially for marketing / broadcast tasks. Returns `{ pending_per_chat, global_calls_last_minute, global_quota_remaining, global_rate_used_percent, flood_wait_active, spam_restricted, session_expired, policy, estimated_delay_next_ms }`. If `spam_restricted=true` or `session_expired=true`, STOP all auto-send to that connector and surface the issue to the user.',
        group: 'connector',
      },
      permission: '*',
      modes: ['chat', 'task'],
      input: z.object({
        connector_id: z.string().describe('Connector ID'),
      }),
      execute: async (args) => {
        const { connector_id } = args as { connector_id: string }
        const adapter = connectorRegistry.getAdapterForConnector(connector_id) as { getQueueStatus?: () => unknown } | null
        if (!adapter) return { error: 'Connector not active' }
        if (typeof adapter.getQueueStatus !== 'function') {
          return { connector_id, queue_supported: false, message: 'This connector does not implement queue management. Standard adapter rate-limit applies (no introspection).' }
        }
        return { connector_id, queue_supported: true, status: adapter.getQueueStatus() }
      },
    }),

    // ── Run an adapter-specific action ───────────────────────────────

    defineTool({
      meta: {
        id: 'connector_run_action',
        side_effectful: true,
        name: 'Run Connector Action',
        description: 'Execute a platform-specific action on a connector (e.g. send_file, send_reaction, pin_message, delete_message). Use connector_list_actions first to see available actions and their required params.',
        group: 'connector',
      },
      permission: '*',
      modes: ['chat', 'task'],
      input: z.object({
        connector_id: z.string().describe('Connector ID'),
        action_id: z.string().describe('Action ID from connector_list_actions, e.g. "send_file"'),
        params: z.record(z.unknown()).describe('Action parameters as described in connector_list_actions'),
      }),
      execute: async (args) => {
        const { connector_id, action_id, params } = args as {
          connector_id: string
          action_id: string
          params: Record<string, unknown>
        }
        const adapter = connectorRegistry.getAdapterForConnector(connector_id)
        if (!adapter) return { success: false, error: 'Connector not active' }
        if (!adapter.runAction) return { success: false, error: `Connector "${adapter.id}" does not support custom actions` }

        const action = adapter.actions?.find(a => a.id === action_id)
        if (!action) return { success: false, error: `Unknown action "${action_id}". Call connector_list_actions to see available actions.` }

        try {
          const result = await adapter.runAction(action_id, params)
          // Log outbound event so it shows up in the channels Events tab
          const evRow = await logConnectorEvent({
            connector_id,
            event_type: action_id,
            direction: 'outbound',
            ref_keys: (params['target_ref_keys'] as Record<string, string>) ?? {},
            payload: params,
            raw_payload: result,
            status: 'routed',
          }).catch(() => null)
          if (evRow) broadcastProjectEvent(projectId, evRow as unknown as Record<string, unknown>)
          return { success: true, result }
        } catch (err) {
          const evRow = await logConnectorEvent({
            connector_id,
            event_type: action_id,
            direction: 'outbound',
            ref_keys: (params['target_ref_keys'] as Record<string, string>) ?? {},
            payload: params,
            raw_payload: { error: err instanceof Error ? err.message : String(err) },
            status: 'error',
          }).catch(() => null)
          if (evRow) broadcastProjectEvent(projectId, evRow as unknown as Record<string, unknown>)
          return { success: false, error: err instanceof Error ? err.message : String(err) }
        }
      },
    }),

    // ── Update binding config ─────────────────────────────────────────

    defineTool({
      meta: {
        id: 'connector_binding_update',
        name: 'Update Connector Binding',
        description: 'Update a connector binding configuration (trigger mode, rate limit, etc.)',
        group: 'connector',
      },
      permission: '*',
      modes: ['chat', 'task'],
      input: z.object({
        binding_id: z.string(),
        trigger_mode: z.enum(['always', 'mention', 'reply', 'command', 'keyword']).optional(),
        trigger_keywords: z.array(z.string()).optional(),
        rate_limit_rpm: z.number().int().optional(),
        context_window: z.number().int().optional(),
      }),
      execute: async (args) => {
        const { binding_id, ...updates } = args as { binding_id: string; [key: string]: unknown }
        const binding = await updateBinding(binding_id, updates as Parameters<typeof updateBinding>[1])
        return { binding }
      },
    }),

    // ── User identity: get ────────────────────────────────────────────

    defineTool({
      meta: {
        id: 'identity_get',
        name: 'Get User Identity',
        description: 'Get identity attributes for a user (telegram_user_id, discord_id, etc.)',
        group: 'connector',
      },
      permission: '*',
      modes: ['chat', 'task'],
      input: z.object({
        user_id: z.string().optional().describe('User ID (omit for current caller)'),
        keys: z.array(z.string()).optional().describe('Filter by keys'),
      }),
      execute: async (args, ctx) => {
        const { user_id, keys } = args as { user_id?: string; keys?: string[] }
        const targetUserId = user_id ?? ctx.runtime.caller.user_id
        const identities = await getUserIdentities(targetUserId, projectId, keys)
        return { identities }
      },
    }),

    // ── User identity: set ────────────────────────────────────────────

    defineTool({
      meta: {
        id: 'identity_set',
        side_effectful: true,
        name: 'Set User Identity',
        description: 'Set an identity attribute for a user (e.g. telegram_user_id = 123)',
        group: 'connector',
      },
      permission: '*',
      modes: ['chat', 'task'],
      input: z.object({
        user_id: z.string().optional(),
        key: z.string(),
        value: z.string(),
        label: z.string().optional(),
      }),
      execute: async (args, ctx) => {
        const { user_id, key, value, label } = args as { user_id?: string; key: string; value: string; label?: string }
        const targetUserId = user_id ?? ctx.runtime.caller.user_id
        const identity = await upsertUserIdentity({
          user_id: targetUserId,
          project_id: projectId,
          key,
          value,
          label,
          source: 'agent',
        })
        return { identity }
      },
    }),

    // ── User identity: find ───────────────────────────────────────────

    defineTool({
      meta: {
        id: 'identity_find',
        name: 'Find User by Identity',
        description: 'Find users by identity attribute — e.g. who has telegram_user_id = 123',
        group: 'connector',
      },
      permission: '*',
      modes: ['chat', 'task'],
      input: z.object({
        key: z.string(),
        value: z.string(),
      }),
      execute: async (args) => {
        const { key, value } = args as { key: string; value: string }
        const results = await findUserByIdentity(projectId, key, value)
        return { results }
      },
    }),

    // ── Plan 22 — Channel Targets ────────────────────────────────────

    defineTool({
      meta: {
        id: 'connector_list_targets',
        name: 'List Channel Targets',
        description:
          'List ADMIN-REGISTERED named ALIASES for outbound sends — a curated subset of destinations ' +
          '(groups, channels, DMs) that can be addressed by name via `connector_send_to_target`. ' +
          'This is NOT the authoritative list of chats the bot has seen — that comes from ' +
          '`connector_list_entities`. Use this only when the user asks you to send to a named ' +
          'alias ("kirim ke morning-briefing") or when you want a short, human-labeled list of ' +
          'preferred destinations. For discovery or observation use `connector_list_entities`. ' +
          '\n\nEach row includes the owning connector (id, plugin_id/adapter, display_name, status) ' +
          'so you can disambiguate when the same alias exists on multiple connectors.',
        group: 'connector',
      },
      permission: '*',
      modes: ['chat', 'task'],
      input: z.object({
        connector_id: z.string().optional().describe('Filter by connector ID (omit for all connectors in project)'),
      }),
      execute: async (args) => {
        const { connector_id } = args as { connector_id?: string }
        const rows = await getConnectorTargetsEnriched(projectId, connector_id)
        return {
          targets: rows.map(({ target, connector }) => ({
            id: target.id,
            name: target.name,
            display_name: target.display_name,
            description: target.description,
            ref_keys: target.ref_keys,
            scope_key: target.scope_key,
            connector: {
              id: connector.id,
              plugin_id: connector.plugin_id,
              display_name: connector.display_name,
              status: connector.status,
            },
          })),
        }
      },
    }),

    defineTool({
      meta: {
        id: 'connector_send_to_target',
        side_effectful: true,
        name: 'Send to Channel Target',
        description:
          'Send a message to a named channel target. If `connector_id` is omitted and the target ' +
          'name matches exactly one connector in the project, the call proceeds. If the name is ' +
          'ambiguous (same name on multiple connectors), the tool returns `AMBIGUOUS_TARGET` with a ' +
          'list of candidate connectors — retry with explicit `connector_id`. Use connector_list_targets ' +
          'first to see available targets + their connector metadata.',
        group: 'connector',
      },
      permission: '*',
      modes: ['chat', 'task'],
      input: z.object({
        target_name: z.string().describe('Target name from connector_list_targets, e.g. "morning-briefing"'),
        text: z.string().describe('Message text'),
        connector_id: z.string().optional().describe('Connector ID. Required only when target name is ambiguous across connectors.'),
        markdown: z.boolean().default(true),
        simulate_typing: z.boolean().default(false).describe('When true, the adapter shows a "typing" effect by editing a placeholder. Off for notifications/broadcasts.'),
        params: z.record(z.unknown()).optional().describe('Plan 27 — platform-specific extras. See connector_list > param_schema for valid keys per connector.'),
      }),
      execute: async (args) => {
        const { target_name, text, connector_id, markdown, simulate_typing, params } = args as {
          target_name: string; text: string; connector_id?: string; markdown: boolean; simulate_typing: boolean
          params?: Record<string, unknown>
        }

        const matches = await getConnectorTargetsByName(projectId, target_name, connector_id)

        if (matches.length === 0) {
          return {
            success: false,
            code: 'TARGET_NOT_FOUND',
            error: `Target "${target_name}" not found${connector_id ? ` on connector ${connector_id}` : ''}. Use connector_list_targets to see available targets.`,
          }
        }

        if (matches.length > 1) {
          return {
            success: false,
            code: 'AMBIGUOUS_TARGET',
            error:
              `AMBIGUOUS_TARGET: "${target_name}" exists on ${matches.length} connectors. ` +
              `Retry with an explicit connector_id from the candidates list.`,
            candidates: matches.map(({ connector, target }) => ({
              target_id: target.id,
              connector_id: connector.id,
              connector_display_name: connector.display_name,
              plugin_id: connector.plugin_id,
              status: connector.status,
            })),
          }
        }

        const { target, connector } = matches[0]!
        const adapter = connectorRegistry.getAdapterForConnector(target.connector_id)
        if (!adapter) {
          return {
            success: false,
            code: 'CONNECTOR_INACTIVE',
            error: `Connector "${connector.display_name}" (${connector.plugin_id}) is not active (status=${connector.status}).`,
          }
        }

        const sendTarget: ConnectorTarget = {
          ref_keys: target.ref_keys as Record<string, string>,
          scope_key: target.scope_key ?? undefined,
        }
        if (params && adapter.getParamSchema) {
          const schema = adapter.getParamSchema()
          const valid = new Set(schema.map(s => s.name))
          const unknown = Object.keys(params).filter(k => !valid.has(k))
          if (unknown.length > 0) {
            return {
              success: false,
              code: 'INVALID_PARAMS',
              error: `Unknown params for ${adapter.id}: ${unknown.join(', ')}. Check connector_list > param_schema for valid keys.`,
              valid_params: [...valid],
            }
          }
        }
        return adapter.sendMessage(sendTarget, { text, markdown, simulate_typing, params })
      },
    }),

    defineTool({
      meta: {
        id: 'connector_create_target',
        side_effectful: true,
        name: 'Create Channel Target',
        description:
          'Register a named outbound destination so you (or any agent) can send to it later by name. ' +
          'Use this when a user sets up a channel/group/topic for you to post to, or when you want to remember a private chat/group you are currently in. ' +
          'For Telegram: pass chat_id (e.g. "-1001234" for groups, "@channel" for channels, or a DM user_id) and optionally thread_id for forum topics. ' +
          'If you are currently reacting to a message inside a scope, copy the scope_key from the Connector Context for scope_key.',
        group: 'connector',
      },
      permission: '*',
      modes: ['chat', 'task'],
      input: z.object({
        connector_id: z.string().describe('Connector UUID (from connector_list)'),
        name: z.string().describe('Slug name, e.g. "morning-briefing", "team-sales-topic" — must be unique per connector'),
        chat_id: z.string().describe('Platform chat_id, e.g. Telegram group "-1001234..." or channel "@mystore"'),
        thread_id: z.string().optional().describe('Forum topic thread_id for group:*:topic:N scopes'),
        scope_key: z.string().optional().describe('Optional scope_key, e.g. "group:-1001234:topic:42". Auto-derived when thread_id + chat_id given for a group.'),
        display_name: z.string().optional(),
        description: z.string().optional().describe('Why this target exists — helpful for future agent runs'),
      }),
      execute: async (args) => {
        const {
          connector_id, name, chat_id, thread_id, scope_key, display_name, description,
        } = args as {
          connector_id: string; name: string; chat_id: string
          thread_id?: string; scope_key?: string; display_name?: string; description?: string
        }
        // Project scoping — refuse to create targets on connectors outside this project
        const connector = await getConnectorById(connector_id)
        if (!connector || connector.project_id !== projectId) {
          return { success: false, error: 'Connector not found in this project' }
        }
        // Prevent collision
        const existing = await getConnectorTargetByName(projectId, name, connector_id)
        if (existing) return { success: false, error: `Target "${name}" already exists on this connector. Use connector_update_target to change it.` }

        const ref_keys: Record<string, string> = { chat_id }
        if (thread_id) ref_keys['thread_id'] = thread_id
        // Auto-derive scope_key when caller passed thread_id/chat_id but not scope_key —
        // heuristic only for Telegram-style ids; if caller passes explicit scope_key it wins.
        let resolvedScope = scope_key
        if (!resolvedScope && thread_id && /^-\d+/.test(chat_id)) {
          resolvedScope = `group:${chat_id}:topic:${thread_id}`
        }

        const target = await createConnectorTarget({
          connector_id,
          name,
          display_name: display_name ?? null,
          description: description ?? null,
          ref_keys,
          scope_key: resolvedScope ?? null,
        })
        return { success: true, target }
      },
    }),

    defineTool({
      meta: {
        id: 'connector_update_target',
        side_effectful: true,
        name: 'Update Channel Target',
        description: 'Update an existing named target — rename, change chat_id/thread_id/scope_key, or update description.',
        group: 'connector',
      },
      permission: '*',
      modes: ['chat', 'task'],
      input: z.object({
        target_id: z.string().describe('Target UUID (from connector_list_targets)'),
        name: z.string().optional(),
        chat_id: z.string().optional(),
        thread_id: z.string().optional().describe('Omit to keep current; pass empty string to clear'),
        scope_key: z.string().optional(),
        display_name: z.string().optional(),
        description: z.string().optional(),
      }),
      execute: async (args) => {
        const a = args as {
          target_id: string; name?: string; chat_id?: string; thread_id?: string
          scope_key?: string; display_name?: string; description?: string
        }
        const target = await getConnectorTargetById(a.target_id)
        if (!target) return { success: false, error: 'Target not found' }
        const connector = await getConnectorById(target.connector_id)
        if (!connector || connector.project_id !== projectId) {
          return { success: false, error: 'Target not in this project' }
        }
        const patch: Record<string, unknown> = {}
        if (a.name !== undefined) patch['name'] = a.name
        if (a.display_name !== undefined) patch['display_name'] = a.display_name
        if (a.description !== undefined) patch['description'] = a.description
        if (a.scope_key !== undefined) patch['scope_key'] = a.scope_key || null
        if (a.chat_id !== undefined || a.thread_id !== undefined) {
          const existingRef = (target.ref_keys ?? {}) as Record<string, string>
          const next: Record<string, string> = { ...existingRef }
          if (a.chat_id !== undefined) next['chat_id'] = a.chat_id
          if (a.thread_id !== undefined) {
            if (a.thread_id === '') delete next['thread_id']
            else next['thread_id'] = a.thread_id
          }
          patch['ref_keys'] = next
        }
        const updated = await updateConnectorTarget(a.target_id, patch)
        return { success: true, target: updated }
      },
    }),

    defineTool({
      meta: {
        id: 'connector_delete_target',
        side_effectful: true,
        name: 'Delete Channel Target',
        description: 'Delete a named target by id. Irreversible.',
        group: 'connector',
      },
      permission: '*',
      modes: ['chat', 'task'],
      input: z.object({
        target_id: z.string(),
      }),
      execute: async (args) => {
        const { target_id } = args as { target_id: string }
        const target = await getConnectorTargetById(target_id)
        if (!target) return { success: false, error: 'Target not found' }
        const connector = await getConnectorById(target.connector_id)
        if (!connector || connector.project_id !== projectId) {
          return { success: false, error: 'Target not in this project' }
        }
        await deleteConnectorTarget(target_id)
        return { success: true }
      },
    }),

    defineTool({
      meta: {
        id: 'connector_save_current_scope',
        side_effectful: true,
        name: 'Save Current Scope as Target',
        description:
          'Shortcut: save the scope of the current inbound event as a named target. Use when a user says ' +
          '"remember this group as X" or "call this topic X". You must pass the scope_key you see in the ' +
          'Connector Context for the current message.',
        group: 'connector',
      },
      permission: '*',
      modes: ['chat', 'task'],
      input: z.object({
        connector_id: z.string(),
        scope_key: z.string().describe('scope_key from Connector Context, e.g. "group:-1001234:topic:42"'),
        name: z.string().describe('Slug name to register'),
        display_name: z.string().optional(),
        description: z.string().optional(),
      }),
      execute: async (args) => {
        const { connector_id, scope_key, name, display_name, description } = args as {
          connector_id: string; scope_key: string; name: string; display_name?: string; description?: string
        }
        const connector = await getConnectorById(connector_id)
        if (!connector || connector.project_id !== projectId) {
          return { success: false, error: 'Connector not found in this project' }
        }
        const adapter = connectorRegistry.getAdapterForConnector(connector_id)
        const resolved = adapter?.targetFromScopeKey?.(scope_key)
        if (!resolved) return { success: false, error: `Adapter cannot resolve scope_key: ${scope_key}` }

        const existing = await getConnectorTargetByName(projectId, name, connector_id)
        if (existing) return { success: false, error: `Target "${name}" already exists` }

        const target = await createConnectorTarget({
          connector_id,
          name,
          display_name: display_name ?? null,
          description: description ?? null,
          ref_keys: resolved.ref_keys,
          scope_key,
        })
        return { success: true, target }
      },
    }),

    defineTool({
      meta: {
        id: 'connector_list_scopes',
        name: 'List Active Scopes',
        description:
          'List group/topic/thread scopes that currently have an ACTIVE conversation tied to an agent ' +
          'via `connector_scope_conversations` (Plan 22). Narrower than `connector_list_entities` — ' +
          'only surfaces scopes with a live conversation binding, not every chat the bot has ever seen. ' +
          'Prefer `connector_list_entities` for general discovery; use this when you specifically need ' +
          '"where do I have an active conversation right now".',
        group: 'connector',
      },
      permission: '*',
      modes: ['chat', 'task'],
      input: z.object({
        connector_id: z.string().describe('Connector ID'),
        limit: z.number().int().min(1).max(50).default(20),
      }),
      execute: async (args) => {
        const { connector_id, limit } = args as { connector_id: string; limit: number }
        const scopes = await getConnectorScopes(connector_id, limit)
        return {
          scopes: scopes.map(s => ({
            scope_key: s.scope_key,
            conversation_id: s.conversation_id,
            last_activity_at: s.last_activity_at,
          })),
        }
      },
    }),

  ]
}
