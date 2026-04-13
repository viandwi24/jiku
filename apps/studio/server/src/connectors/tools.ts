import { defineTool } from '@jiku/kit'
import { z } from 'zod'
import {
  getConnectors,
  getConnectorEvents,
  getConnectorMessages,
  updateBinding,
  getUserIdentities,
  upsertUserIdentity,
  findUserByIdentity,
  getConnectorTargets,
  getConnectorTargetByName,
  getConnectorTargetById,
  getConnectorScopes,
  getConnectorById,
  createConnectorTarget,
  updateConnectorTarget,
  deleteConnectorTarget,
} from '@jiku-studio/db'
import type { ConnectorTarget } from '@jiku/types'
import { connectorRegistry } from './registry.ts'

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
        description: 'List all connectors in the project. Use this to find connector IDs before calling other connector tools.',
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
          connectors: filtered.map(c => ({
            id: c.id,
            plugin_id: c.plugin_id,
            display_name: c.display_name,
            status: c.status,
          })),
        }
      },
    }),

    // ── Query events on a message ────────────────────────────────────

    defineTool({
      meta: {
        id: 'connector_get_events',
        name: 'Get Message Events',
        description: 'Query events (reactions, edits, etc.) on a specific message or chat',
        group: 'connector',
      },
      permission: '*',
      modes: ['chat', 'task'],
      input: z.object({
        connector_id: z.string().describe('Connector ID'),
        event_types: z.array(z.string()).optional().describe('Filter by event types'),
        limit: z.number().int().min(1).max(100).default(20),
      }),
      execute: async (args) => {
        const { connector_id, limit } = args as { connector_id: string; event_types?: string[]; limit: number }
        const events = await getConnectorEvents(connector_id, limit)
        return { events }
      },
    }),

    // ── Get recent messages from a chat ──────────────────────────────

    defineTool({
      meta: {
        id: 'connector_get_thread',
        name: 'Get Thread Messages',
        description: 'Get recent messages from a connector conversation',
        group: 'connector',
      },
      permission: '*',
      modes: ['chat', 'task'],
      input: z.object({
        connector_id: z.string().describe('Connector ID'),
        limit: z.number().int().min(1).max(50).default(10),
      }),
      execute: async (args) => {
        const { connector_id, limit } = args as { connector_id: string; limit: number }
        const messages = await getConnectorMessages(connector_id, limit)
        return { messages }
      },
    }),

    // ── Send a message to a platform ─────────────────────────────────

    defineTool({
      meta: {
        id: 'connector_send',
        name: 'Send Connector Message',
        description: 'Send a message to a platform chat via connector',
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
      }),
      execute: async (args) => {
        const { connector_id, target_ref_keys, text, reply_to_ref_keys, markdown } = args as {
          connector_id: string
          target_ref_keys: Record<string, string>
          text: string
          reply_to_ref_keys?: Record<string, string>
          markdown: boolean
        }
        const adapter = connectorRegistry.getAdapterForConnector(connector_id)
        if (!adapter) return { success: false, error: 'Connector not active' }
        return adapter.sendMessage(
          { ref_keys: target_ref_keys, reply_to_ref_keys },
          { text, markdown }
        )
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

    // ── Run an adapter-specific action ───────────────────────────────

    defineTool({
      meta: {
        id: 'connector_run_action',
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
          return { success: true, result }
        } catch (err) {
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
        description: 'List named channel targets — predefined destinations (groups, channels, DMs) you can send to by name without knowing chat IDs. Call this before connector_send_to_target.',
        group: 'connector',
      },
      permission: '*',
      modes: ['chat', 'task'],
      input: z.object({
        connector_id: z.string().optional().describe('Filter by connector ID (omit for all connectors in project)'),
      }),
      execute: async (args) => {
        const { connector_id } = args as { connector_id?: string }
        const targets = await getConnectorTargets(projectId, connector_id)
        return {
          targets: targets.map(t => ({
            id: t.id,
            connector_id: t.connector_id,
            name: t.name,
            display_name: t.display_name,
            description: t.description,
            ref_keys: t.ref_keys,
            scope_key: t.scope_key,
          })),
        }
      },
    }),

    defineTool({
      meta: {
        id: 'connector_send_to_target',
        name: 'Send to Channel Target',
        description: 'Send a message to a named channel target. Use connector_list_targets first to see available targets.',
        group: 'connector',
      },
      permission: '*',
      modes: ['chat', 'task'],
      input: z.object({
        target_name: z.string().describe('Target name from connector_list_targets, e.g. "morning-briefing"'),
        text: z.string().describe('Message text'),
        connector_id: z.string().optional().describe('Connector ID (omit if target name is unique in the project)'),
        markdown: z.boolean().default(true),
      }),
      execute: async (args) => {
        const { target_name, text, connector_id, markdown } = args as {
          target_name: string; text: string; connector_id?: string; markdown: boolean
        }
        const target = await getConnectorTargetByName(projectId, target_name, connector_id)
        if (!target) {
          return { success: false, error: `Target "${target_name}" not found. Use connector_list_targets to see available targets.` }
        }
        const adapter = connectorRegistry.getAdapterForConnector(target.connector_id)
        if (!adapter) return { success: false, error: 'Connector not active' }

        const sendTarget: ConnectorTarget = {
          ref_keys: target.ref_keys as Record<string, string>,
          scope_key: target.scope_key ?? undefined,
        }
        return adapter.sendMessage(sendTarget, { text, markdown })
      },
    }),

    defineTool({
      meta: {
        id: 'connector_create_target',
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
        description: 'List active conversation scopes (groups, topics, threads) that the connector has seen. Useful for discovering where the bot is active.',
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
