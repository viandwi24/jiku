import { eq, and } from 'drizzle-orm'
import { db } from '../client.ts'
import { mcp_servers, project_tool_states, agent_tool_states } from '../schema/mcp_servers.ts'

// ─── MCP Servers ──────────────────────────────────────────────────────────────

export async function getMcpServersByProject(projectId: string) {
  return db.select().from(mcp_servers).where(eq(mcp_servers.project_id, projectId))
}

export async function getMcpServerById(id: string) {
  const rows = await db.select().from(mcp_servers).where(eq(mcp_servers.id, id)).limit(1)
  return rows[0] ?? null
}

export async function createMcpServer(data: {
  project_id: string
  agent_id?: string | null
  name: string
  transport: string
  config: Record<string, unknown>
  enabled?: boolean
}) {
  const [row] = await db.insert(mcp_servers).values({
    ...data,
    enabled: data.enabled ?? true,
  }).returning()
  return row!
}

export async function updateMcpServer(id: string, data: Partial<{
  name: string
  transport: string
  config: Record<string, unknown>
  enabled: boolean
  agent_id: string | null
}>) {
  const [row] = await db.update(mcp_servers)
    .set({ ...data, updated_at: new Date() })
    .where(eq(mcp_servers.id, id))
    .returning()
  return row ?? null
}

export async function deleteMcpServer(id: string) {
  await db.delete(mcp_servers).where(eq(mcp_servers.id, id))
}

// ─── Tool States ──────────────────────────────────────────────────────────────

export interface ToolStates {
  project: Record<string, boolean>
  agent: Record<string, boolean>
}

export async function getToolStates(projectId: string, agentId: string): Promise<ToolStates> {
  const [projectRows, agentRows] = await Promise.all([
    db.select().from(project_tool_states).where(eq(project_tool_states.project_id, projectId)),
    db.select().from(agent_tool_states).where(eq(agent_tool_states.agent_id, agentId)),
  ])

  const project: Record<string, boolean> = {}
  for (const row of projectRows) {
    project[row.tool_id] = row.enabled
  }

  const agent: Record<string, boolean> = {}
  for (const row of agentRows) {
    agent[row.tool_id] = row.enabled
  }

  return { project, agent }
}

export async function setProjectToolState(projectId: string, toolId: string, enabled: boolean) {
  await db.insert(project_tool_states)
    .values({ project_id: projectId, tool_id: toolId, enabled })
    .onConflictDoUpdate({
      target: [project_tool_states.project_id, project_tool_states.tool_id],
      set: { enabled },
    })
}

export async function setAgentToolState(agentId: string, toolId: string, enabled: boolean) {
  await db.insert(agent_tool_states)
    .values({ agent_id: agentId, tool_id: toolId, enabled })
    .onConflictDoUpdate({
      target: [agent_tool_states.agent_id, agent_tool_states.tool_id],
      set: { enabled },
    })
}

export async function deleteProjectToolState(projectId: string, toolId: string) {
  await db.delete(project_tool_states).where(
    and(eq(project_tool_states.project_id, projectId), eq(project_tool_states.tool_id, toolId))
  )
}

export async function deleteAgentToolState(agentId: string, toolId: string) {
  await db.delete(agent_tool_states).where(
    and(eq(agent_tool_states.agent_id, agentId), eq(agent_tool_states.tool_id, toolId))
  )
}
