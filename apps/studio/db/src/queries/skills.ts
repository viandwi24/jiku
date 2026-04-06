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

export async function getSkillBySlug(projectId: string, slug: string): Promise<ProjectSkill | null> {
  const rows = await db.select().from(project_skills).where(
    and(eq(project_skills.project_id, projectId), eq(project_skills.slug, slug))
  )
  return rows[0] ?? null
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
