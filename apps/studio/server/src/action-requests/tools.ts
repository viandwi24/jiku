/**
 * Plan 25 — Agent tools for the Action Request Center.
 *
 *   action_request_create  — create an AR (non-blocking, fire-and-forget)
 *   action_request_list    — read-only list (self-monitoring)
 *
 * Agent flow is always DETACHED: create an AR and move on. The operator decision
 * flows independently to its destination handler (outbound_approval, task_resume,
 * etc.) — the agent is not expected to block on the result.
 */
import { z } from 'zod'
import type { ToolDefinition } from '@jiku/types'
import {
  createActionRequest,
  ActionRequestError,
} from './service.ts'
import { listActionRequests } from '@jiku-studio/db'

const TYPE_ENUM = z.enum(['boolean', 'choice', 'input', 'form'])
const DESTINATION_ENUM = z.enum(['outbound_approval', 'task', 'task_resume'])

export function buildActionRequestTools(projectId: string): ToolDefinition[] {
  return [
    {
      meta: {
        id: 'action_request_create',
        name: 'Create Action Request',
        description: [
          'Create a human-in-the-loop request that appears in the Action Center for an operator to act on.',
          '',
          'Returns IMMEDIATELY with { action_request_id, status: "pending" }. Fire-and-forget — the operator decision flows to its destination handler independently (e.g. outbound_approval sends the message, task_resume re-invokes the task). The agent does NOT need to wait.',
          '',
          'Types:',
          '  boolean — two buttons (default Approve/Reject). spec: { approve_label, reject_label, approve_style?, reject_style? }',
          '  choice  — n buttons. spec: { options: [{ value, label, style?, description? }] }',
          '  input   — free-form text. spec: { input_kind?: text|textarea|password|number|url|email, placeholder?, default_value?, min_length?, max_length?, pattern?, validation_hint? }',
          '  form    — multi-field form. spec: { fields: [{ name, label, type, required, options?, default_value?, placeholder? }], submit_label? }',
          '',
          'The `context` object is shown to the operator verbatim — include enough info for them to make a good decision.',
        ].join('\n'),
        group: 'action_request',
      },
      permission: '*',
      modes: ['chat', 'task'],
      input: z.object({
        type: TYPE_ENUM.describe('UI type — see description for spec shape per type.'),
        title: z.string().min(1).max(200).describe('Short title shown to the operator.'),
        description: z.string().optional().describe('Longer explanation, shown under the title.'),
        context: z.record(z.unknown()).optional().describe('Free-form context dict for operator decision support.'),
        spec: z.record(z.unknown()).describe('Type-specific UI spec. See description for shape.'),
        expires_in_seconds: z.number().int().positive().max(86400 * 7).optional().describe('Auto-expire after N seconds. Omit for no expiry.'),
        destination: z.object({
          type: DESTINATION_ENUM,
          ref: z.record(z.unknown()),
        }).optional().describe('Where the decision flows when the operator responds. Omit if no side-effect is needed (pure record of decision).'),
      }),
      execute: async (args, ctx) => {
        const a = args as {
          type: 'boolean' | 'choice' | 'input' | 'form'
          title: string
          description?: string
          context?: Record<string, unknown>
          spec: Record<string, unknown>
          expires_in_seconds?: number
          destination?: { type: 'outbound_approval' | 'task' | 'task_resume'; ref: Record<string, unknown> }
        }
        const runtime = ctx?.runtime as { agent?: { id: string; name?: string }; conversation_id?: string } | undefined
        const agentId = runtime?.agent?.id ?? null
        const conversationId = runtime?.conversation_id ?? null
        try {
          const ar = await createActionRequest({
            project_id: projectId,
            agent_id: agentId,
            conversation_id: conversationId,
            type: a.type,
            title: a.title,
            description: a.description ?? null,
            context: a.context ?? {},
            spec: a.spec as never,
            source_type: 'agent_tool',
            source_ref: {
              kind: 'agent_tool',
              conversation_id: conversationId ?? '',
              agent_id: agentId ?? '',
            },
            destination_type: a.destination?.type ?? null,
            destination_ref: a.destination ? ({ kind: a.destination.type, ...a.destination.ref } as never) : null,
            expires_in_seconds: a.expires_in_seconds ?? null,
            actor_id: agentId,
            actor_type: 'agent',
          })
          return {
            action_request_id: ar.id,
            status: ar.status,
            expires_at: ar.expires_at,
          }
        } catch (err) {
          if (err instanceof ActionRequestError) {
            return { error: err.message, code: err.code }
          }
          return { error: err instanceof Error ? err.message : 'Failed to create action request' }
        }
      },
    },

    {
      meta: {
        id: 'action_request_list',
        name: 'List Action Requests',
        description: 'List action requests scoped to the current project. Useful for self-monitoring (e.g. avoid creating a duplicate request) or to recover an AR id you forgot.',
        group: 'action_request',
      },
      permission: '*',
      modes: ['chat', 'task'],
      input: z.object({
        status: z.enum(['pending', 'approved', 'rejected', 'answered', 'dropped', 'expired', 'failed']).optional(),
        agent_only: z.boolean().default(false).describe('When true, only ARs created by the current agent.'),
        limit: z.number().int().min(1).max(100).default(20),
      }),
      execute: async (args, ctx) => {
        const a = args as { status?: string; agent_only: boolean; limit: number }
        const runtime = ctx?.runtime as { agent?: { id: string } } | undefined
        const agentId = a.agent_only ? runtime?.agent?.id : undefined
        const rows = await listActionRequests({
          project_id: projectId,
          status: a.status as never,
          agent_id: agentId,
          limit: a.limit,
        })
        return {
          items: rows.map(r => ({
            id: r.id,
            type: r.type,
            title: r.title,
            status: r.status,
            agent_id: r.agent_id,
            created_at: r.created_at?.toISOString(),
            expires_at: r.expires_at?.toISOString() ?? null,
          })),
        }
      },
    },
  ]
}
