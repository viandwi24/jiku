import { desc, eq, and, gte, lte, sql, type SQL } from 'drizzle-orm'
import { db } from '../client.ts'
import { audit_logs, type NewAuditLog, type AuditLog } from '../schema/audit_logs.ts'
import { users } from '../schema/users.ts'

export async function insertAuditLog(entry: NewAuditLog): Promise<void> {
  await db.insert(audit_logs).values(entry)
}

export interface ListAuditLogParams {
  projectId?: string
  companyId?: string
  actorId?: string
  eventType?: string
  resourceType?: string
  from?: Date
  to?: Date
  limit?: number
  offset?: number
}

export interface AuditLogWithActor extends AuditLog {
  actor: { id: string; name: string; email: string } | null
}

function buildWhere(params: ListAuditLogParams): SQL | undefined {
  const conds: SQL[] = []
  if (params.projectId) conds.push(eq(audit_logs.project_id, params.projectId))
  if (params.companyId) conds.push(eq(audit_logs.company_id, params.companyId))
  if (params.actorId) conds.push(eq(audit_logs.actor_id, params.actorId))
  if (params.eventType) conds.push(eq(audit_logs.event_type, params.eventType))
  if (params.resourceType) conds.push(eq(audit_logs.resource_type, params.resourceType))
  if (params.from) conds.push(gte(audit_logs.created_at, params.from))
  if (params.to) conds.push(lte(audit_logs.created_at, params.to))
  return conds.length > 0 ? and(...conds) : undefined
}

export async function listAuditLogs(params: ListAuditLogParams): Promise<{ rows: AuditLogWithActor[]; total: number }> {
  const limit = Math.min(Math.max(params.limit ?? 50, 1), 500)
  const offset = Math.max(params.offset ?? 0, 0)
  const where = buildWhere(params)

  const rows = await db
    .select({
      log: audit_logs,
      actor: { id: users.id, name: users.name, email: users.email },
    })
    .from(audit_logs)
    .leftJoin(users, eq(audit_logs.actor_id, users.id))
    .where(where)
    .orderBy(desc(audit_logs.created_at))
    .limit(limit)
    .offset(offset)

  const countResult = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(audit_logs)
    .where(where)

  return {
    rows: rows.map(r => ({ ...r.log, actor: r.actor?.id ? r.actor as { id: string; name: string; email: string } : null })),
    total: countResult[0]?.count ?? 0,
  }
}

export async function getAuditLog(id: string): Promise<AuditLogWithActor | null> {
  const rows = await db
    .select({
      log: audit_logs,
      actor: { id: users.id, name: users.name, email: users.email },
    })
    .from(audit_logs)
    .leftJoin(users, eq(audit_logs.actor_id, users.id))
    .where(eq(audit_logs.id, id))
    .limit(1)
  const first = rows[0]
  if (!first) return null
  return { ...first.log, actor: first.actor?.id ? first.actor as { id: string; name: string; email: string } : null }
}

export async function exportAuditLogs(params: ListAuditLogParams): Promise<AuditLogWithActor[]> {
  const where = buildWhere(params)
  const rows = await db
    .select({
      log: audit_logs,
      actor: { id: users.id, name: users.name, email: users.email },
    })
    .from(audit_logs)
    .leftJoin(users, eq(audit_logs.actor_id, users.id))
    .where(where)
    .orderBy(desc(audit_logs.created_at))
    .limit(10000)
  return rows.map(r => ({ ...r.log, actor: r.actor?.id ? r.actor as { id: string; name: string; email: string } : null }))
}
