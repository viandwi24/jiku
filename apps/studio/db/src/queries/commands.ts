import { eq, and } from 'drizzle-orm'
import { db } from '../client.ts'
import { project_commands, agent_commands } from '../schema/commands.ts'
import type { ProjectCommand, NewProjectCommand, AgentCommand } from '../schema/commands.ts'

// ── Project Commands ──────────────────────────────────────────────────────────

export async function getCommandsByProjectId(projectId: string): Promise<ProjectCommand[]> {
  return db.select().from(project_commands).where(eq(project_commands.project_id, projectId))
}

export async function getCommandById(id: string): Promise<ProjectCommand | null> {
  const rows = await db.select().from(project_commands).where(eq(project_commands.id, id))
  return rows[0] ?? null
}

export async function getCommandBySlug(projectId: string, slug: string, source = 'fs'): Promise<ProjectCommand | null> {
  const rows = await db.select().from(project_commands).where(
    and(
      eq(project_commands.project_id, projectId),
      eq(project_commands.slug, slug),
      eq(project_commands.source, source),
    )
  )
  return rows[0] ?? null
}

export async function findCommandBySlugAnySource(projectId: string, slug: string): Promise<ProjectCommand[]> {
  return db.select().from(project_commands).where(
    and(eq(project_commands.project_id, projectId), eq(project_commands.slug, slug))
  )
}

export async function upsertCommandCache(data: {
  project_id: string
  slug: string
  source: string
  plugin_id?: string | null
  name: string
  description: string | null
  tags: string[]
  entrypoint: string
  args_schema: unknown
  manifest: unknown
  manifest_hash: string
  active?: boolean
}): Promise<ProjectCommand> {
  const rows = await db.insert(project_commands)
    .values({
      project_id: data.project_id,
      slug: data.slug,
      source: data.source,
      plugin_id: data.plugin_id ?? null,
      name: data.name,
      description: data.description ?? null,
      tags: data.tags,
      entrypoint: data.entrypoint,
      args_schema: data.args_schema as NewProjectCommand['args_schema'],
      manifest: data.manifest as NewProjectCommand['manifest'],
      manifest_hash: data.manifest_hash,
      active: data.active ?? true,
      last_synced_at: new Date(),
    })
    .onConflictDoUpdate({
      target: [project_commands.project_id, project_commands.slug, project_commands.source],
      set: {
        plugin_id: data.plugin_id ?? null,
        name: data.name,
        description: data.description ?? null,
        tags: data.tags,
        entrypoint: data.entrypoint,
        args_schema: data.args_schema as NewProjectCommand['args_schema'],
        manifest: data.manifest as NewProjectCommand['manifest'],
        manifest_hash: data.manifest_hash,
        active: data.active ?? true,
        last_synced_at: new Date(),
        updated_at: new Date(),
      },
    })
    .returning()
  const row = rows[0]
  if (!row) throw new Error('upsertCommandCache: insert returned no rows')
  return row
}

export async function deactivateCommandsBySource(projectId: string, source: string): Promise<void> {
  await db.update(project_commands)
    .set({ active: false, updated_at: new Date() })
    .where(and(
      eq(project_commands.project_id, projectId),
      eq(project_commands.source, source),
    ))
}

export async function deactivateCommandBySlug(projectId: string, slug: string): Promise<void> {
  await db.update(project_commands)
    .set({ active: false, updated_at: new Date() })
    .where(and(
      eq(project_commands.project_id, projectId),
      eq(project_commands.slug, slug),
    ))
}

export async function getActiveCommands(projectId: string): Promise<ProjectCommand[]> {
  return db.select().from(project_commands).where(
    and(
      eq(project_commands.project_id, projectId),
      eq(project_commands.active, true),
      eq(project_commands.enabled, true),
    )
  )
}

export async function deleteCommand(id: string): Promise<void> {
  await db.delete(project_commands).where(eq(project_commands.id, id))
}

// ── Agent Commands (per-agent allow-list) ────────────────────────────────────

export async function getAgentCommands(agentId: string): Promise<(AgentCommand & { command: ProjectCommand })[]> {
  const rows = await db
    .select()
    .from(agent_commands)
    .innerJoin(project_commands, eq(agent_commands.command_id, project_commands.id))
    .where(eq(agent_commands.agent_id, agentId))
  return rows.map(r => ({ ...r.agent_commands, command: r.project_commands }))
}

export async function assignCommandToAgent(agentId: string, commandId: string, pinned = false): Promise<AgentCommand> {
  const rows = await db.insert(agent_commands)
    .values({ agent_id: agentId, command_id: commandId, pinned })
    .onConflictDoUpdate({
      target: [agent_commands.agent_id, agent_commands.command_id],
      set: { pinned },
    })
    .returning()
  const row = rows[0]
  if (!row) throw new Error('assignCommandToAgent: insert returned no rows')
  return row
}

export async function removeCommandFromAgent(agentId: string, commandId: string): Promise<void> {
  await db.delete(agent_commands).where(
    and(eq(agent_commands.agent_id, agentId), eq(agent_commands.command_id, commandId))
  )
}
