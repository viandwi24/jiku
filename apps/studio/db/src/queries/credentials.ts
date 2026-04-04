import { and, eq, or } from 'drizzle-orm'
import { db } from '../client.ts'
import { credentials, agent_credentials } from '../schema/index.ts'
import type { NewCredential, NewAgentCredential } from '../schema/index.ts'

// ── Credential CRUD ──────────────────────────────────────────────────────────

export async function getCompanyCredentials(companyId: string) {
  return db.query.credentials.findMany({
    where: and(
      eq(credentials.scope, 'company'),
      eq(credentials.scope_id, companyId),
    ),
    orderBy: (c, { asc }) => [asc(c.created_at)],
  })
}

export async function getProjectCredentials(projectId: string) {
  return db.query.credentials.findMany({
    where: and(
      eq(credentials.scope, 'project'),
      eq(credentials.scope_id, projectId),
    ),
    orderBy: (c, { asc }) => [asc(c.created_at)],
  })
}

/** Union of company + project credentials available to a project */
export async function getAvailableCredentials(companyId: string, projectId: string) {
  return db.query.credentials.findMany({
    where: or(
      and(eq(credentials.scope, 'company'), eq(credentials.scope_id, companyId)),
      and(eq(credentials.scope, 'project'), eq(credentials.scope_id, projectId)),
    ),
    orderBy: (c, { asc }) => [asc(c.scope), asc(c.created_at)],
  })
}

export async function getCredentialById(id: string) {
  return db.query.credentials.findFirst({
    where: eq(credentials.id, id),
  })
}

export async function createCredential(data: Omit<NewCredential, 'id' | 'created_at' | 'updated_at'>) {
  const [cred] = await db.insert(credentials).values(data).returning()
  return cred!
}

export async function updateCredential(id: string, data: Partial<Omit<NewCredential, 'id' | 'created_at'>>) {
  const [cred] = await db
    .update(credentials)
    .set({ ...data, updated_at: new Date() })
    .where(eq(credentials.id, id))
    .returning()
  return cred!
}

export async function deleteCredential(id: string) {
  await db.delete(credentials).where(eq(credentials.id, id))
}

// ── Agent Credential Assignment ───────────────────────────────────────────────

export async function getAgentCredential(agentId: string) {
  return db.query.agent_credentials.findFirst({
    where: eq(agent_credentials.agent_id, agentId),
    with: { credential: true },
  })
}

export async function assignAgentCredential(data: Omit<NewAgentCredential, 'id'>) {
  const [ac] = await db.insert(agent_credentials).values(data).returning()
  return ac!
}

export async function updateAgentCredential(agentId: string, data: Partial<Omit<NewAgentCredential, 'id' | 'agent_id'>>) {
  const [ac] = await db
    .update(agent_credentials)
    .set(data)
    .where(eq(agent_credentials.agent_id, agentId))
    .returning()
  return ac!
}

export async function unassignAgentCredential(agentId: string) {
  await db.delete(agent_credentials).where(eq(agent_credentials.agent_id, agentId))
}
