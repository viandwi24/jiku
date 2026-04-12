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

/**
 * Plan 19 — includes rows scoped directly to the project (background LLM calls:
 * reflection, dreaming, flush, plugin-invoked) plus legacy rows linked via agent.
 */
function projectUsageWhere(projectId: string, agentIds: string[], since?: Date) {
  const baseCondition = agentIds.length === 0
    ? eq(usage_logs.project_id, projectId)
    : or(eq(usage_logs.project_id, projectId), inArray(usage_logs.agent_id, agentIds))!
  if (!since) return baseCondition
  return and(baseCondition, gte(usage_logs.created_at, since))!
}

async function getProjectAgentIds(projectId: string) {
  const projectAgents = await db.query.agents.findMany({
    where: eq(agents.project_id, projectId),
    columns: { id: true },
  })
  return projectAgents.map(a => a.id)
}

export async function getUsageLogsByProject(projectId: string, limit = 50, offset = 0, since?: Date) {
  const agentIds = await getProjectAgentIds(projectId)
  return db.query.usage_logs.findMany({
    where: projectUsageWhere(projectId, agentIds, since),
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

export async function getUsageSummaryByProject(projectId: string, since?: Date) {
  const agentIds = await getProjectAgentIds(projectId)
  const result = await db
    .select({
      total_input: sql<number>`coalesce(sum(${usage_logs.input_tokens}), 0)`.mapWith(Number),
      total_output: sql<number>`coalesce(sum(${usage_logs.output_tokens}), 0)`.mapWith(Number),
      total_runs: sql<number>`count(*)`.mapWith(Number),
    })
    .from(usage_logs)
    .where(projectUsageWhere(projectId, agentIds, since))

  return result[0] ?? { total_input: 0, total_output: 0, total_runs: 0 }
}

export async function getUsageCountByProject(projectId: string, since?: Date) {
  const agentIds = await getProjectAgentIds(projectId)
  const result = await db
    .select({ count: sql<number>`count(*)`.mapWith(Number) })
    .from(usage_logs)
    .where(projectUsageWhere(projectId, agentIds, since))
  return result[0]?.count ?? 0
}
