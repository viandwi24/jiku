import { eq, and, desc, lt, sql, inArray } from 'drizzle-orm'
import { db } from '../client.ts'
import {
  action_requests,
  action_request_events,
  type ActionRequestRow,
  type NewActionRequestRow,
  type ActionRequestEventRow,
  type NewActionRequestEventRow,
} from '../schema/action_requests.ts'

export type ActionRequestStatusValue =
  | 'pending' | 'approved' | 'rejected' | 'answered' | 'dropped' | 'expired' | 'failed'

export interface ListActionRequestsParams {
  project_id: string
  status?: ActionRequestStatusValue | ActionRequestStatusValue[]
  agent_id?: string
  type?: string
  limit?: number
  offset?: number
}

export async function createActionRequest(data: NewActionRequestRow): Promise<ActionRequestRow> {
  const rows = await db.insert(action_requests).values(data).returning()
  const row = rows[0]
  if (!row) throw new Error('createActionRequest: insert returned no rows')
  return row
}

export async function getActionRequestById(id: string): Promise<ActionRequestRow | null> {
  const rows = await db.select().from(action_requests).where(eq(action_requests.id, id))
  return rows[0] ?? null
}

export async function listActionRequests(params: ListActionRequestsParams): Promise<ActionRequestRow[]> {
  const conds = [eq(action_requests.project_id, params.project_id)]
  if (params.status) {
    if (Array.isArray(params.status)) conds.push(inArray(action_requests.status, params.status))
    else conds.push(eq(action_requests.status, params.status))
  }
  if (params.agent_id) conds.push(eq(action_requests.agent_id, params.agent_id))
  if (params.type) conds.push(eq(action_requests.type, params.type))
  const rows = await db
    .select()
    .from(action_requests)
    .where(and(...conds))
    .orderBy(desc(action_requests.created_at))
    .limit(params.limit ?? 50)
    .offset(params.offset ?? 0)
  return rows
}

export async function countActionRequestsPending(projectId: string, agentId?: string): Promise<number> {
  const conds = [eq(action_requests.project_id, projectId), eq(action_requests.status, 'pending')]
  if (agentId) conds.push(eq(action_requests.agent_id, agentId))
  const rows = await db
    .select({ c: sql<number>`count(*)::int` })
    .from(action_requests)
    .where(and(...conds))
  return rows[0]?.c ?? 0
}

export interface UpdateActionRequestStatus {
  id: string
  fromStatus: ActionRequestStatusValue
  toStatus: ActionRequestStatusValue
  response?: unknown
  response_by?: string | null
  execution_error?: string | null
}

/**
 * Atomic state transition. Uses a WHERE on current status to prevent races
 * (e.g. responded + expired at the same moment). Returns the updated row, or
 * null if no row matched (someone else already transitioned it).
 */
export async function transitionActionRequest(p: UpdateActionRequestStatus): Promise<ActionRequestRow | null> {
  const setClause: Partial<NewActionRequestRow> = {
    status: p.toStatus,
    updated_at: new Date(),
  }
  if (p.response !== undefined) setClause.response = p.response as NewActionRequestRow['response']
  if (p.toStatus !== 'pending' && p.toStatus !== 'failed') {
    setClause.response_at = new Date()
    if (p.response_by !== undefined) setClause.response_by = p.response_by
  }
  if (p.execution_error !== undefined) setClause.execution_error = p.execution_error
  const rows = await db
    .update(action_requests)
    .set(setClause)
    .where(and(eq(action_requests.id, p.id), eq(action_requests.status, p.fromStatus)))
    .returning()
  return rows[0] ?? null
}

/** Mark all pending AR whose expires_at < now as expired. Returns the rows transitioned. */
export async function expirePendingActionRequests(now: Date = new Date()): Promise<ActionRequestRow[]> {
  const rows = await db
    .update(action_requests)
    .set({ status: 'expired', updated_at: now })
    .where(and(
      eq(action_requests.status, 'pending'),
      lt(action_requests.expires_at, now),
    ))
    .returning()
  return rows
}

export async function appendActionRequestEvent(data: NewActionRequestEventRow): Promise<ActionRequestEventRow> {
  const rows = await db.insert(action_request_events).values(data).returning()
  const row = rows[0]
  if (!row) throw new Error('appendActionRequestEvent: insert returned no rows')
  return row
}

export async function listActionRequestEvents(arId: string): Promise<ActionRequestEventRow[]> {
  return db
    .select()
    .from(action_request_events)
    .where(eq(action_request_events.action_request_id, arId))
    .orderBy(action_request_events.created_at)
}
