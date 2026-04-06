import { and, eq, inArray } from 'drizzle-orm'
import { db } from '../client.ts'
import { projects, agents } from '../schema/index.ts'
import type { NewProject } from '../schema/index.ts'

// Import tables that need manual cascade (no onDelete: 'cascade' on their FK)
import { conversations, messages } from '../schema/conversations.ts'
import { agent_policies, agent_user_policies, policies, policy_rules } from '../schema/policies.ts'
import { agent_credentials } from '../schema/credentials.ts'
import { project_plugins, plugins } from '../schema/plugins.ts'
import { superadmin_transfers } from '../schema/acl.ts'
import { connector_identities, connector_messages } from '../schema/connectors.ts'

export async function getAllProjects() {
  return db.query.projects.findMany()
}

export async function getProjectsByCompanyId(companyId: string) {
  return db.query.projects.findMany({
    where: eq(projects.company_id, companyId),
  })
}

export async function getProjectById(id: string) {
  return db.query.projects.findFirst({
    where: eq(projects.id, id),
  })
}

export async function getProjectBySlug(companyId: string, slug: string) {
  return db.query.projects.findFirst({
    where: and(
      eq(projects.company_id, companyId),
      eq(projects.slug, slug),
    ),
  })
}

export async function createProject(data: Omit<NewProject, 'id' | 'created_at'>) {
  const [project] = await db.insert(projects).values(data).returning()
  return project!
}

export async function updateProject(id: string, data: Partial<Omit<NewProject, 'id' | 'created_at'>>) {
  const [project] = await db.update(projects).set(data).where(eq(projects.id, id)).returning()
  return project!
}

export async function deleteProject(id: string) {
  // Get all agents in this project to cascade their children
  const projectAgents = await db.query.agents.findMany({
    where: eq(agents.project_id, id),
    columns: { id: true },
  })
  const agentIds = projectAgents.map(a => a.id)

  if (agentIds.length > 0) {
    // Delete conversation messages first, then conversations
    const convs = await db.query.conversations.findMany({
      where: inArray(conversations.agent_id, agentIds),
      columns: { id: true },
    })
    const convIds = convs.map(c => c.id)
    if (convIds.length > 0) {
      // Null out nullable conversation_id references before deleting
      await db.update(connector_identities)
        .set({ conversation_id: null })
        .where(inArray(connector_identities.conversation_id, convIds))
      await db.update(connector_messages)
        .set({ conversation_id: null })
        .where(inArray(connector_messages.conversation_id, convIds))

      await db.delete(messages).where(inArray(messages.conversation_id, convIds))
      await db.delete(conversations).where(inArray(conversations.id, convIds))
    }

    // Delete agent policies
    const attachedPolicies = await db.query.agent_policies.findMany({
      where: inArray(agent_policies.agent_id, agentIds),
      columns: { policy_id: true },
    })
    await db.delete(agent_user_policies).where(inArray(agent_user_policies.agent_id, agentIds))
    await db.delete(agent_policies).where(inArray(agent_policies.agent_id, agentIds))

    // Delete detached policies (those only attached to these agents)
    const policyIds = attachedPolicies.map(p => p.policy_id)
    if (policyIds.length > 0) {
      await db.delete(policy_rules).where(inArray(policy_rules.policy_id, policyIds))
      await db.delete(policies).where(inArray(policies.id, policyIds))
    }

    // Delete agent credentials
    await db.delete(agent_credentials).where(inArray(agent_credentials.agent_id, agentIds))

    // Delete agents (memories, usage_logs, attachments have cascade)
    await db.delete(agents).where(inArray(agents.id, agentIds))
  }

  // Delete project plugins
  await db.delete(project_plugins).where(eq(project_plugins.project_id, id))

  // Delete superadmin_transfers (no cascade on project_id)
  await db.delete(superadmin_transfers).where(eq(superadmin_transfers.project_id, id))

  // Delete the project itself (cascade handles: memories, acl tables with cascade,
  // filesystem, attachments, plugin_kv, connectors)
  await db.delete(projects).where(eq(projects.id, id))
}
