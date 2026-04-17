import { eq, desc, or, inArray, sql, and, gte } from 'drizzle-orm'
import { db } from '../client.ts'
import { usage_logs, agents } from '../schema/index.ts'
import type { NewUsageLog } from '../schema/index.ts'

export async function createUsageLog(data: Omit<NewUsageLog, 'id' | 'created_at'>) {
  const [log] = await db.insert(usage_logs).values(data).returning()
  return log!
}

export async function getUsageLogsByAgent(agentId: string, limit = 100, offset = 0) {
  return db.query.usage_logs.findMany({
    where: eq(usage_logs.agent_id, agentId),
    orderBy: [desc(usage_logs.created_at)],
    limit,
    offset,
    with: {
      user: { columns: { id: true, name: true, email: true } },
      conversation: { columns: { id: true, mode: true, type: true } },
    },
  })
}

export async function getUsageLogsByConversation(conversationId: string) {
  return db.query.usage_logs.findMany({
    where: eq(usage_logs.conversation_id, conversationId),
    orderBy: [desc(usage_logs.created_at)],
  })
}

export async function getUsageSummaryByAgent(agentId: string) {
  const result = await db
    .select({
      total_input: sql<number>`coalesce(sum(${usage_logs.input_tokens}), 0)`.mapWith(Number),
      total_output: sql<number>`coalesce(sum(${usage_logs.output_tokens}), 0)`.mapWith(Number),
      total_runs: sql<number>`count(*)`.mapWith(Number),
    })
    .from(usage_logs)
    .where(eq(usage_logs.agent_id, agentId))

  return result[0] ?? { total_input: 0, total_output: 0, total_runs: 0 }
}

export async function getUsageCountByAgent(agentId: string) {
  const result = await db
    .select({ count: sql<number>`count(*)`.mapWith(Number) })
    .from(usage_logs)
    .where(eq(usage_logs.agent_id, agentId))
  return result[0]?.count ?? 0
}

export interface UsageFilters {
  since?: Date
  agent_id?: string
  user_id?: string
  mode?: string
  source?: string
}

/**
 * Plan 19 — includes rows scoped directly to the project (background LLM calls:
 * reflection, dreaming, flush, plugin-invoked) plus legacy rows linked via agent.
 */
function projectUsageWhere(projectId: string, agentIds: string[], filters: UsageFilters = {}) {
  const conditions = []
  const baseCondition = agentIds.length === 0
    ? eq(usage_logs.project_id, projectId)
    : or(eq(usage_logs.project_id, projectId), inArray(usage_logs.agent_id, agentIds))!
  conditions.push(baseCondition)
  if (filters.since) conditions.push(gte(usage_logs.created_at, filters.since))
  if (filters.agent_id) conditions.push(eq(usage_logs.agent_id, filters.agent_id))
  if (filters.user_id) conditions.push(eq(usage_logs.user_id, filters.user_id))
  if (filters.mode) conditions.push(eq(usage_logs.mode, filters.mode))
  if (filters.source) conditions.push(eq(usage_logs.source, filters.source))
  return conditions.length === 1 ? conditions[0]! : and(...conditions)!
}

async function getProjectAgentIds(projectId: string) {
  const projectAgents = await db.query.agents.findMany({
    where: eq(agents.project_id, projectId),
    columns: { id: true },
  })
  return projectAgents.map(a => a.id)
}

export async function getUsageLogsByProject(projectId: string, limit = 50, offset = 0, filters: UsageFilters = {}) {
  const agentIds = await getProjectAgentIds(projectId)
  return db.query.usage_logs.findMany({
    where: projectUsageWhere(projectId, agentIds, filters),
    orderBy: [desc(usage_logs.created_at)],
    limit,
    offset,
    with: {
      agent: { columns: { id: true, name: true, slug: true } },
      user: { columns: { id: true, name: true, email: true } },
      conversation: { columns: { id: true, mode: true, type: true } },
    },
  })
}

export async function getUsageSummaryByProject(projectId: string, filters: UsageFilters = {}) {
  const agentIds = await getProjectAgentIds(projectId)
  const result = await db
    .select({
      total_input: sql<number>`coalesce(sum(${usage_logs.input_tokens}), 0)`.mapWith(Number),
      total_output: sql<number>`coalesce(sum(${usage_logs.output_tokens}), 0)`.mapWith(Number),
      total_runs: sql<number>`count(*)`.mapWith(Number),
    })
    .from(usage_logs)
    .where(projectUsageWhere(projectId, agentIds, filters))

  return result[0] ?? { total_input: 0, total_output: 0, total_runs: 0 }
}

export async function getUsageCountByProject(projectId: string, filters: UsageFilters = {}) {
  const agentIds = await getProjectAgentIds(projectId)
  const result = await db
    .select({ count: sql<number>`count(*)`.mapWith(Number) })
    .from(usage_logs)
    .where(projectUsageWhere(projectId, agentIds, filters))
  return result[0]?.count ?? 0
}

/** Distinct filter options across ALL matching rows (ignoring pagination). */
export async function getUsageFilterOptions(projectId: string, since?: Date) {
  const agentIds = await getProjectAgentIds(projectId)
  const where = projectUsageWhere(projectId, agentIds, { since })
  const [agentOpts, userOpts, modeOpts, sourceOpts] = await Promise.all([
    db.selectDistinctOn([usage_logs.agent_id], {
      id: usage_logs.agent_id,
      name: agents.name,
    }).from(usage_logs).leftJoin(agents, eq(usage_logs.agent_id, agents.id)).where(where),
    db.selectDistinct({ id: usage_logs.user_id }).from(usage_logs).where(where),
    db.selectDistinct({ mode: usage_logs.mode }).from(usage_logs).where(where),
    db.selectDistinct({ source: usage_logs.source }).from(usage_logs).where(where),
  ])
  return {
    agents: agentOpts.filter(a => a.id).map(a => ({ id: a.id!, name: a.name ?? a.id! })),
    user_ids: userOpts.filter(u => u.id).map(u => u.id!),
    modes: modeOpts.map(m => m.mode).filter(Boolean) as string[],
    sources: sourceOpts.map(s => s.source).filter(Boolean) as string[],
  }
}
