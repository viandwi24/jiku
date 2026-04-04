import { and, eq } from 'drizzle-orm'
import { db } from '../client.ts'
import { agents, agent_user_policies } from '../schema/index.ts'
import type { NewAgent } from '../schema/index.ts'

export async function getAgentsByProjectId(projectId: string) {
  return db.query.agents.findMany({
    where: eq(agents.project_id, projectId),
  })
}

export async function getAgentById(id: string) {
  return db.query.agents.findFirst({
    where: eq(agents.id, id),
  })
}

export async function getAgentBySlug(projectId: string, slug: string) {
  return db.query.agents.findFirst({
    where: and(
      eq(agents.project_id, projectId),
      eq(agents.slug, slug),
    ),
  })
}

export async function getAgentWithPolicy(agentId: string, userId: string) {
  const agent = await db.query.agents.findFirst({
    where: eq(agents.id, agentId),
    with: {
      agent_user_policies: {
        where: eq(agent_user_policies.user_id, userId),
        limit: 1,
      },
    },
  })
  return agent
}

export async function createAgent(data: Omit<NewAgent, 'id' | 'created_at'>) {
  const [agent] = await db.insert(agents).values(data).returning()
  return agent!
}

export async function updateAgent(id: string, data: Partial<Omit<NewAgent, 'id' | 'created_at'>>) {
  const [agent] = await db.update(agents).set(data).where(eq(agents.id, id)).returning()
  return agent!
}

export async function deleteAgent(id: string) {
  await db.delete(agents).where(eq(agents.id, id))
}
