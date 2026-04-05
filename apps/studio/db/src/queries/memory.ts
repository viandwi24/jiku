import { eq, and, inArray, or, ne, desc, sql, lt, isNotNull } from 'drizzle-orm'
import { db } from '../client.ts'
import { agent_memories } from '../schema/memories.ts'
import { projects } from '../schema/projects.ts'
import { agents } from '../schema/agents.ts'
import type { AgentMemoryRow, NewAgentMemoryRow } from '../schema/memories.ts'

export type MemoryScope = 'agent_caller' | 'agent_global' | 'runtime_global' | 'agent_self'
export type MemoryTier = 'core' | 'extended'
export type MemoryVisibility = 'private' | 'agent_shared' | 'project_shared'

export interface GetMemoriesParams {
  project_id: string
  agent_id?: string
  caller_id?: string
  scope?: MemoryScope | MemoryScope[]
  tier?: MemoryTier
  visibility?: MemoryVisibility[]
}

export async function getMemories(params: GetMemoriesParams): Promise<AgentMemoryRow[]> {
  const conditions = [
    eq(agent_memories.project_id, params.project_id),
  ]

  if (params.agent_id) {
    conditions.push(eq(agent_memories.agent_id, params.agent_id))
  }

  if (params.scope) {
    if (Array.isArray(params.scope)) {
      conditions.push(inArray(agent_memories.scope, params.scope))
    } else {
      conditions.push(eq(agent_memories.scope, params.scope))
    }
  }

  if (params.caller_id) {
    conditions.push(
      or(
        and(
          eq(agent_memories.scope, 'agent_caller'),
          eq(agent_memories.caller_id, params.caller_id),
        ),
        ne(agent_memories.scope, 'agent_caller'),
      )!
    )
  }

  if (params.tier) {
    conditions.push(eq(agent_memories.tier, params.tier))
  }

  if (params.visibility && params.visibility.length > 0) {
    conditions.push(inArray(agent_memories.visibility, params.visibility))
  }

  return db
    .select()
    .from(agent_memories)
    .where(and(...conditions))
    .orderBy(desc(agent_memories.importance), desc(agent_memories.last_accessed))
}

export type SaveMemoryData = Omit<NewAgentMemoryRow,
  'id' | 'created_at' | 'updated_at' | 'access_count' | 'last_accessed'
>

export async function saveMemory(data: SaveMemoryData): Promise<AgentMemoryRow> {
  const [row] = await db
    .insert(agent_memories)
    .values({
      project_id: data.project_id,
      agent_id: data.agent_id,
      caller_id: data.caller_id,
      scope: data.scope,
      tier: data.tier ?? 'extended',
      section: data.section,
      content: data.content,
      importance: data.importance ?? 'medium',
      visibility: data.visibility ?? 'private',
      source: data.source ?? 'agent',
      expires_at: data.expires_at,
    })
    .returning()
  return row!
}

export async function updateMemory(
  id: string,
  data: Partial<Pick<AgentMemoryRow, 'content' | 'importance' | 'visibility' | 'expires_at'>>,
): Promise<void> {
  await db
    .update(agent_memories)
    .set({ ...data, updated_at: new Date() })
    .where(eq(agent_memories.id, id))
}

export async function deleteMemory(id: string): Promise<void> {
  await db.delete(agent_memories).where(eq(agent_memories.id, id))
}

export async function touchMemories(ids: string[]): Promise<void> {
  if (ids.length === 0) return
  await db
    .update(agent_memories)
    .set({
      access_count: sql`${agent_memories.access_count} + 1`,
      last_accessed: new Date(),
    })
    .where(inArray(agent_memories.id, ids))
}

export async function listProjectMemories(params: {
  project_id: string
  agent_id?: string
  caller_id?: string
  scope?: string
  tier?: string
  search?: string
  limit?: number
  offset?: number
}): Promise<AgentMemoryRow[]> {
  const conditions = [eq(agent_memories.project_id, params.project_id)]

  if (params.agent_id) conditions.push(eq(agent_memories.agent_id, params.agent_id))
  if (params.caller_id) conditions.push(eq(agent_memories.caller_id, params.caller_id))
  if (params.scope) conditions.push(eq(agent_memories.scope, params.scope))
  if (params.tier) conditions.push(eq(agent_memories.tier, params.tier))

  const query = db
    .select()
    .from(agent_memories)
    .where(and(...conditions))
    .orderBy(desc(agent_memories.created_at))

  if (params.limit) {
    return query.limit(params.limit).offset(params.offset ?? 0)
  }

  return query
}

export async function getMemoryById(id: string): Promise<AgentMemoryRow | null> {
  const [row] = await db.select().from(agent_memories).where(eq(agent_memories.id, id))
  return row ?? null
}

export async function deleteExpiredMemories(): Promise<number> {
  const result = await db
    .delete(agent_memories)
    .where(and(isNotNull(agent_memories.expires_at), lt(agent_memories.expires_at, new Date())))
    .returning({ id: agent_memories.id })
  return result.length
}

export async function updateProjectMemoryConfig(projectId: string, config: Record<string, unknown> | null): Promise<void> {
  await db.update(projects).set({ memory_config: config }).where(eq(projects.id, projectId))
}

export async function updateAgentMemoryConfig(agentId: string, config: Record<string, unknown> | null): Promise<void> {
  await db.update(agents).set({ memory_config: config }).where(eq(agents.id, agentId))
}

export async function updateAgentPersonaSeed(agentId: string, seed: Record<string, unknown> | null): Promise<void> {
  await db.update(agents).set({ persona_seed: seed }).where(eq(agents.id, agentId))
}

export async function updateAgentPersonaPrompt(agentId: string, prompt: string | null): Promise<void> {
  await db.update(agents).set({ persona_prompt: prompt }).where(eq(agents.id, agentId))
}

export async function markAgentPersonaSeeded(agentId: string): Promise<void> {
  await db.update(agents).set({ persona_seeded_at: new Date() }).where(eq(agents.id, agentId))
}

export async function resetAgentPersona(agentId: string): Promise<void> {
  // Delete all agent_self memories and clear seeded_at so next run re-seeds
  await db.delete(agent_memories).where(
    and(
      eq(agent_memories.agent_id, agentId),
      eq(agent_memories.scope, 'agent_self'),
    )
  )
  await db.update(agents).set({ persona_seeded_at: null }).where(eq(agents.id, agentId))
}

export async function getAgentSelfMemories(agentId: string): Promise<AgentMemoryRow[]> {
  return db
    .select()
    .from(agent_memories)
    .where(
      and(
        eq(agent_memories.agent_id, agentId),
        eq(agent_memories.scope, 'agent_self'),
      )
    )
    .orderBy(desc(agent_memories.created_at))
}
