import { eq, and } from 'drizzle-orm'
import { db } from '../client.ts'
import { project_skills, agent_skills } from '../schema/skills.ts'
import type { ProjectSkill, NewProjectSkill, AgentSkill } from '../schema/skills.ts'

// ── Project Skills ────────────────────────────────────────────────────────────

export async function getSkillsByProjectId(projectId: string): Promise<ProjectSkill[]> {
  return db.select().from(project_skills).where(eq(project_skills.project_id, projectId))
}

export async function getSkillById(id: string): Promise<ProjectSkill | null> {
  const rows = await db.select().from(project_skills).where(eq(project_skills.id, id))
  return rows[0] ?? null
}

export async function getSkillBySlug(projectId: string, slug: string, source = 'fs'): Promise<ProjectSkill | null> {
  const rows = await db.select().from(project_skills).where(
    and(
      eq(project_skills.project_id, projectId),
      eq(project_skills.slug, slug),
      eq(project_skills.source, source),
    )
  )
  return rows[0] ?? null
}

/** Plan 19 — look up by slug regardless of source (FS or any plugin). */
export async function findSkillBySlugAnySource(projectId: string, slug: string): Promise<ProjectSkill[]> {
  return db.select().from(project_skills).where(
    and(eq(project_skills.project_id, projectId), eq(project_skills.slug, slug))
  )
}

/** Plan 19 — upsert cache row keyed by (project_id, slug, source). */
export async function upsertSkillCache(data: {
  project_id: string
  slug: string
  source: string
  plugin_id?: string | null
  name: string
  description: string | null
  tags: string[]
  entrypoint: string
  manifest: unknown
  manifest_hash: string
  active?: boolean
}): Promise<ProjectSkill> {
  const rows = await db.insert(project_skills)
    .values({
      project_id: data.project_id,
      slug: data.slug,
      source: data.source,
      plugin_id: data.plugin_id ?? null,
      name: data.name,
      description: data.description ?? null,
      tags: data.tags,
      entrypoint: data.entrypoint,
      manifest: data.manifest as NewProjectSkill['manifest'],
      manifest_hash: data.manifest_hash,
      active: data.active ?? true,
      last_synced_at: new Date(),
    })
    .onConflictDoUpdate({
      target: [project_skills.project_id, project_skills.slug, project_skills.source],
      set: {
        plugin_id: data.plugin_id ?? null,
        name: data.name,
        description: data.description ?? null,
        tags: data.tags,
        entrypoint: data.entrypoint,
        manifest: data.manifest as NewProjectSkill['manifest'],
        manifest_hash: data.manifest_hash,
        active: data.active ?? true,
        last_synced_at: new Date(),
        updated_at: new Date(),
      },
    })
    .returning()
  const row = rows[0]
  if (!row) throw new Error('upsertSkillCache: insert returned no rows')
  return row
}

/** Plan 19 — mark all skills from a given source inactive (used on plugin deactivate). */
export async function deactivateSkillsBySource(projectId: string, source: string): Promise<void> {
  await db.update(project_skills)
    .set({ active: false, updated_at: new Date() })
    .where(and(
      eq(project_skills.project_id, projectId),
      eq(project_skills.source, source),
    ))
}

/** Plan 19 — union of active FS + plugin skills in a project. */
export async function getActiveSkills(projectId: string): Promise<ProjectSkill[]> {
  return db.select().from(project_skills).where(
    and(
      eq(project_skills.project_id, projectId),
      eq(project_skills.active, true),
      eq(project_skills.enabled, true),
    )
  )
}

export async function createSkill(data: NewProjectSkill): Promise<ProjectSkill> {
  const rows = await db.insert(project_skills).values(data).returning()
  const row = rows[0]
  if (!row) throw new Error('createSkill: insert returned no rows')
  return row
}

export async function updateSkill(id: string, data: Partial<Pick<ProjectSkill, 'name' | 'description' | 'tags' | 'entrypoint' | 'enabled' | 'updated_at'>>): Promise<ProjectSkill | null> {
  const rows = await db.update(project_skills)
    .set({ ...data, updated_at: new Date() })
    .where(eq(project_skills.id, id))
    .returning()
  return rows[0] ?? null
}

export async function deleteSkill(id: string): Promise<void> {
  await db.delete(project_skills).where(eq(project_skills.id, id))
}

// ── Agent Skills ──────────────────────────────────────────────────────────────

export async function getAgentSkills(agentId: string): Promise<(AgentSkill & { skill: ProjectSkill })[]> {
  const rows = await db
    .select()
    .from(agent_skills)
    .innerJoin(project_skills, eq(agent_skills.skill_id, project_skills.id))
    .where(eq(agent_skills.agent_id, agentId))
  return rows.map(r => ({ ...r.agent_skills, skill: r.project_skills }))
}

export async function getAgentAlwaysSkills(agentId: string): Promise<(AgentSkill & { skill: ProjectSkill })[]> {
  const rows = await db
    .select()
    .from(agent_skills)
    .innerJoin(project_skills, eq(agent_skills.skill_id, project_skills.id))
    .where(
      and(
        eq(agent_skills.agent_id, agentId),
        eq(agent_skills.mode, 'always'),
        eq(project_skills.enabled, true),
      )
    )
  return rows.map(r => ({ ...r.agent_skills, skill: r.project_skills }))
}

export async function getAgentOnDemandSkills(agentId: string): Promise<(AgentSkill & { skill: ProjectSkill })[]> {
  const rows = await db
    .select()
    .from(agent_skills)
    .innerJoin(project_skills, eq(agent_skills.skill_id, project_skills.id))
    .where(
      and(
        eq(agent_skills.agent_id, agentId),
        eq(agent_skills.mode, 'on_demand'),
        eq(project_skills.enabled, true),
      )
    )
  return rows.map(r => ({ ...r.agent_skills, skill: r.project_skills }))
}

export async function assignSkillToAgent(agentId: string, skillId: string, mode: 'always' | 'on_demand'): Promise<AgentSkill> {
  const rows = await db.insert(agent_skills)
    .values({ agent_id: agentId, skill_id: skillId, mode })
    .onConflictDoUpdate({
      target: [agent_skills.agent_id, agent_skills.skill_id],
      set: { mode },
    })
    .returning()
  const row = rows[0]
  if (!row) throw new Error('assignSkillToAgent: insert returned no rows')
  return row
}

export async function removeSkillFromAgent(agentId: string, skillId: string): Promise<void> {
  await db.delete(agent_skills).where(
    and(eq(agent_skills.agent_id, agentId), eq(agent_skills.skill_id, skillId))
  )
}
