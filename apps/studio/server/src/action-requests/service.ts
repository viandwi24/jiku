/**
 * Plan 25 — Action Request service.
 *
 * Owns:
 *   - createActionRequest()      with destination-type validation
 *   - respondToActionRequest()   atomic state transition + execution dispatch + audit + pubsub
 *   - dropActionRequest()        atomic transition; no source notification
 *   - sweepExpiredActionRequests() called by the periodic expiry sweep
 *
 * Every transition publishes to the in-process pubsub bus and writes an audit log.
 */
import {
  createActionRequest as dbCreate,
  getActionRequestById as dbGet,
  transitionActionRequest,
  expirePendingActionRequests,
  appendActionRequestEvent,
  countActionRequestsPending,
  type ActionRequestRow,
  type NewActionRequestRow,
} from '@jiku-studio/db'
import type {
  ActionRequest,
  ActionRequestType,
  ActionRequestSpec,
  ActionRequestSourceType,
  ActionRequestSourceRef,
  ActionRequestDestinationType,
  ActionRequestDestinationRef,
  ActionRequestStatus,
  ActionRequestResponse,
} from '@jiku/types'
import { audit } from '../audit/logger.ts'
import { publishActionRequestUpdate } from './pubsub.ts'
import { getDestinationHandler, validateDestinationCompatibility } from './destinations.ts'

/** Hard cap to keep one runaway agent from spamming operators. */
export const MAX_PENDING_PER_AGENT = 10

export interface CreateActionRequestInput {
  project_id: string
  agent_id?: string | null
  conversation_id?: string | null
  task_id?: string | null
  type: ActionRequestType
  title: string
  description?: string | null
  context?: Record<string, unknown>
  spec: ActionRequestSpec
  source_type: ActionRequestSourceType
  source_ref: ActionRequestSourceRef
  destination_type?: ActionRequestDestinationType | null
  destination_ref?: ActionRequestDestinationRef | null
  expires_in_seconds?: number | null
  created_by?: string | null
  actor_id?: string | null
  actor_type?: 'user' | 'agent' | 'system'
}

export class ActionRequestError extends Error {
  constructor(public code: string, message: string) {
    super(message)
    this.name = 'ActionRequestError'
  }
}

function rowToActionRequest(row: ActionRequestRow): ActionRequest {
  return {
    id: row.id,
    project_id: row.project_id,
    agent_id: row.agent_id,
    conversation_id: row.conversation_id,
    task_id: row.task_id,
    type: row.type as ActionRequestType,
    title: row.title,
    description: row.description,
    context: (row.context ?? {}) as Record<string, unknown>,
    spec: (row.spec ?? {}) as ActionRequestSpec,
    source_type: row.source_type as ActionRequestSourceType,
    source_ref: (row.source_ref ?? {}) as ActionRequestSourceRef,
    destination_type: row.destination_type as ActionRequestDestinationType | null,
    destination_ref: row.destination_ref as ActionRequestDestinationRef | null,
    status: row.status as ActionRequestStatus,
    response: row.response as ActionRequestResponse | null,
    response_by: row.response_by,
    response_at: row.response_at?.toISOString() ?? null,
    expires_at: row.expires_at?.toISOString() ?? null,
    execution_error: row.execution_error,
    created_at: row.created_at?.toISOString() ?? new Date().toISOString(),
    created_by: row.created_by,
    updated_at: row.updated_at?.toISOString() ?? new Date().toISOString(),
  }
}

export async function createActionRequest(input: CreateActionRequestInput): Promise<ActionRequest> {
  // Type-constraint validation (e.g. outbound_approval = boolean only).
  const destType = input.destination_type ?? null
  const compat = validateDestinationCompatibility(destType, input.type)
  if (!compat.ok) throw new ActionRequestError('invalid_destination', compat.error)

  // Per-agent rate limit.
  if (input.agent_id) {
    const pending = await countActionRequestsPending(input.project_id, input.agent_id)
    if (pending >= MAX_PENDING_PER_AGENT) {
      throw new ActionRequestError(
        'too_many_pending',
        `Agent already has ${pending} pending action requests (max ${MAX_PENDING_PER_AGENT}). Resolve or drop older requests first.`,
      )
    }
  }

  const expiresAt = input.expires_in_seconds && input.expires_in_seconds > 0
    ? new Date(Date.now() + input.expires_in_seconds * 1000)
    : null

  const row = await dbCreate({
    project_id: input.project_id,
    agent_id: input.agent_id ?? null,
    conversation_id: input.conversation_id ?? null,
    task_id: input.task_id ?? null,
    type: input.type,
    title: input.title,
    description: input.description ?? null,
    context: (input.context ?? {}) as NewActionRequestRow['context'],
    spec: input.spec as NewActionRequestRow['spec'],
    source_type: input.source_type,
    source_ref: input.source_ref as NewActionRequestRow['source_ref'],
    destination_type: destType,
    destination_ref: (input.destination_ref ?? null) as NewActionRequestRow['destination_ref'],
    status: 'pending',
    expires_at: expiresAt,
    created_by: input.created_by ?? null,
  })

  await appendActionRequestEvent({
    action_request_id: row.id,
    event_type: 'created',
    actor_id: input.actor_type === 'user' ? (input.actor_id ?? null) : null,
    actor_type: input.actor_type ?? (input.actor_id ? 'user' : 'system'),
    metadata: {},
  })

  audit.write({
    actor_id: input.actor_id ?? null,
    actor_type: input.actor_type ?? 'system',
    project_id: input.project_id,
    event_type: 'action_request.created',
    resource_type: 'action_request',
    resource_id: row.id,
    resource_name: row.title,
    metadata: {
      type: row.type,
      source_type: row.source_type,
      destination_type: row.destination_type,
      agent_id: row.agent_id,
    },
  })

  const ar = rowToActionRequest(row)
  publishActionRequestUpdate({ action_request: ar, event: 'created' })
  return ar
}

export async function getActionRequest(id: string): Promise<ActionRequest | null> {
  const row = await dbGet(id)
  return row ? rowToActionRequest(row) : null
}

interface RespondInput {
  id: string
  response: ActionRequestResponse
  responder_id: string | null
  actor_type?: 'user' | 'agent' | 'system'
  ip_address?: string | null
  user_agent?: string | null
}

/**
 * Submit a decision. Determines `approved` / `rejected` / `answered` from the
 * response shape + AR type, transitions atomically, runs destination handler.
 */
export async function respondToActionRequest(input: RespondInput): Promise<ActionRequest> {
  const current = await dbGet(input.id)
  if (!current) throw new ActionRequestError('not_found', 'Action request not found')
  if (current.status !== 'pending') {
    throw new ActionRequestError('not_pending', `Action request is ${current.status}, no longer accepting responses`)
  }

  const newStatus = decideStatus(current.type, input.response)

  const updated = await transitionActionRequest({
    id: input.id,
    fromStatus: 'pending',
    toStatus: newStatus,
    response: input.response,
    response_by: input.responder_id,
  })
  if (!updated) {
    // Lost the race. Re-fetch and surface the actual state.
    const re = await dbGet(input.id)
    throw new ActionRequestError(
      're_raced',
      `Action request transitioned to ${re?.status ?? 'unknown'} concurrently`,
    )
  }

  await appendActionRequestEvent({
    action_request_id: updated.id,
    event_type: 'responded',
    actor_id: input.responder_id,
    actor_type: input.actor_type ?? 'user',
    metadata: { status: newStatus, response: input.response },
  })

  audit.write({
    actor_id: input.responder_id,
    actor_type: input.actor_type ?? 'user',
    project_id: updated.project_id,
    ip_address: input.ip_address ?? null,
    user_agent: input.user_agent ?? null,
    event_type: 'action_request.responded',
    resource_type: 'action_request',
    resource_id: updated.id,
    resource_name: updated.title,
    metadata: { status: newStatus, type: updated.type },
  })

  let ar = rowToActionRequest(updated)
  publishActionRequestUpdate({ action_request: ar, event: `status:${newStatus}` })

  // Execution dispatch (best-effort; failures mark AR as failed but don't roll back the response).
  await runDestination(ar).catch(() => { /* runDestination already records its own state */ })
  // Re-fetch in case execution flipped status to 'failed'
  const reread = await dbGet(updated.id)
  if (reread) ar = rowToActionRequest(reread)
  return ar
}

interface DropInput {
  id: string
  responder_id: string | null
  actor_type?: 'user' | 'agent' | 'system'
  reason?: string
  ip_address?: string | null
  user_agent?: string | null
}

export async function dropActionRequest(input: DropInput): Promise<ActionRequest> {
  const current = await dbGet(input.id)
  if (!current) throw new ActionRequestError('not_found', 'Action request not found')
  if (current.status !== 'pending') {
    throw new ActionRequestError('not_pending', `Action request is ${current.status}, cannot drop`)
  }
  const updated = await transitionActionRequest({
    id: input.id,
    fromStatus: 'pending',
    toStatus: 'dropped',
    response_by: input.responder_id,
  })
  if (!updated) throw new ActionRequestError('re_raced', 'Action request transitioned concurrently')

  await appendActionRequestEvent({
    action_request_id: updated.id,
    event_type: 'dropped',
    actor_id: input.responder_id,
    actor_type: input.actor_type ?? 'user',
    metadata: { reason: input.reason ?? null },
  })

  audit.write({
    actor_id: input.responder_id,
    actor_type: input.actor_type ?? 'user',
    project_id: updated.project_id,
    ip_address: input.ip_address ?? null,
    user_agent: input.user_agent ?? null,
    event_type: 'action_request.dropped',
    resource_type: 'action_request',
    resource_id: updated.id,
    resource_name: updated.title,
    metadata: { reason: input.reason ?? null },
  })

  const ar = rowToActionRequest(updated)
  publishActionRequestUpdate({ action_request: ar, event: 'dropped' })
  return ar
}

/**
 * Periodic sweep — called from the bootstrap setInterval. Returns count
 * transitioned to expired so callers can log it.
 */
export async function sweepExpiredActionRequests(): Promise<number> {
  const expired = await expirePendingActionRequests()
  for (const row of expired) {
    await appendActionRequestEvent({
      action_request_id: row.id,
      event_type: 'expired',
      actor_id: null,
      actor_type: 'system',
      metadata: {},
    })
    audit.write({
      actor_id: null,
      actor_type: 'system',
      project_id: row.project_id,
      event_type: 'action_request.expired',
      resource_type: 'action_request',
      resource_id: row.id,
      resource_name: row.title,
      metadata: { agent_id: row.agent_id },
    })
    publishActionRequestUpdate({ action_request: rowToActionRequest(row), event: 'expired' })
  }
  return expired.length
}

/**
 * Translate (type, response) → final status.
 *  - boolean: value === true → approved, else rejected
 *  - choice : if option style is destructive AND value implies reject, still 'answered' (operator
 *             intent is captured by `value`; agents read response.value, not status semantics).
 *             Treat all choice picks as 'answered'.
 *  - input  : 'answered'
 *  - form   : 'answered'
 */
function decideStatus(type: string, response: ActionRequestResponse): ActionRequestStatus {
  if (type === 'boolean') {
    const value = (response as { value: boolean }).value
    return value === true ? 'approved' : 'rejected'
  }
  return 'answered'
}

async function runDestination(ar: ActionRequest): Promise<void> {
  if (!ar.destination_type) return
  const handler = getDestinationHandler(ar.destination_type)
  if (!handler) {
    console.warn(`[action-requests] No handler registered for destination_type=${ar.destination_type} (ar=${ar.id})`)
    return
  }
  try {
    await handler({ action_request: ar })
    await appendActionRequestEvent({
      action_request_id: ar.id,
      event_type: 'executed',
      actor_id: null,
      actor_type: 'system',
      metadata: { destination_type: ar.destination_type },
    })
    audit.write({
      actor_id: null,
      actor_type: 'system',
      project_id: ar.project_id,
      event_type: 'action_request.executed',
      resource_type: 'action_request',
      resource_id: ar.id,
      resource_name: ar.title,
      metadata: { destination_type: ar.destination_type, success: true },
    })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    // Best-effort: try to flip status to 'failed' (only meaningful if not still pending).
    await transitionActionRequest({
      id: ar.id,
      fromStatus: ar.status,
      toStatus: 'failed',
      execution_error: msg,
    }).catch(() => null)
    await appendActionRequestEvent({
      action_request_id: ar.id,
      event_type: 'execution_failed',
      actor_id: null,
      actor_type: 'system',
      metadata: { error: msg },
    })
    audit.write({
      actor_id: null,
      actor_type: 'system',
      project_id: ar.project_id,
      event_type: 'action_request.execution_failed',
      resource_type: 'action_request',
      resource_id: ar.id,
      resource_name: ar.title,
      metadata: { destination_type: ar.destination_type, error: msg },
    })
    publishActionRequestUpdate({ action_request: { ...ar, status: 'failed', execution_error: msg }, event: 'execution_failed' })
    throw err
  }
}

