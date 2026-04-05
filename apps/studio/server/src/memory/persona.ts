import { getAgentById, saveMemory, markAgentPersonaSeeded } from '@jiku-studio/db'
import type { PersonaSeed } from '@jiku/types'

/**
 * Ensure the persona seed has been applied for an agent.
 * If agent_self memories are empty and persona_seed is set, inserts seed memories.
 * Returns the project_id so the caller can fetch agent_self memories from storage.
 */
export async function ensurePersonaSeeded(
  agentId: string,
  projectId: string,
  hasSelfMemories: boolean,
): Promise<void> {
  if (hasSelfMemories) return

  const agent = await getAgentById(agentId)
  if (!agent) return
  if (agent.persona_seeded_at) return  // already seeded
  if (!agent.persona_seed) return       // no seed configured

  const seed = agent.persona_seed as PersonaSeed
  const memoriesToInsert: { content: string; section: string }[] = []

  if (seed.name) memoriesToInsert.push({ content: `My name is ${seed.name}`, section: 'name' })
  if (seed.role) memoriesToInsert.push({ content: `My role is ${seed.role}`, section: 'role' })
  if (seed.personality) memoriesToInsert.push({ content: `My personality: ${seed.personality}`, section: 'personality' })
  if (seed.communication_style) memoriesToInsert.push({ content: `My communication style: ${seed.communication_style}`, section: 'communication_style' })
  if (seed.background) memoriesToInsert.push({ content: `My background and expertise: ${seed.background}`, section: 'background' })
  seed.initial_memories?.forEach((m, i) => memoriesToInsert.push({ content: m, section: `seed_${i}` }))

  if (memoriesToInsert.length === 0) {
    // Nothing to seed but mark as seeded so we don't re-check every run
    await markAgentPersonaSeeded(agentId)
    return
  }

  await Promise.all(memoriesToInsert.map(m =>
    saveMemory({
      project_id: projectId,
      agent_id: agentId,
      caller_id: null,
      scope: 'agent_self',
      tier: 'core',
      section: m.section,
      content: m.content,
      importance: 'high',
      visibility: 'private',
      source: 'agent',
      expires_at: null,
    })
  ))

  await markAgentPersonaSeeded(agentId)
}
