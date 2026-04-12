import {
  getAgentById,
  getAgentAlwaysSkills,
  getAgentOnDemandSkills,
  getActiveSkills,
  type ProjectSkill,
} from '@jiku-studio/db'
import { checkSkillEligibility } from '@jiku/core'
import type { SkillAccessMode, SkillManifest } from '@jiku/types'
import { buildEligibilityContext } from './eligibility-context.ts'

const MAX_SKILLS_IN_PROMPT = 50
const MAX_SKILLS_PROMPT_CHARS = 20_000

/**
 * Plan 19 — Resolve the concrete list of on-demand skills for an agent, honoring
 * the agent's `skill_access_mode`. Applies eligibility filtering.
 */
export async function resolveOnDemandSkillsForAgent(agentId: string): Promise<ProjectSkill[]> {
  const agent = await getAgentById(agentId)
  if (!agent) return []

  const mode = (agent.skill_access_mode ?? 'manual') as SkillAccessMode
  const projectId = agent.project_id

  let candidates: ProjectSkill[]
  if (mode === 'all_on_demand') {
    candidates = await getActiveSkills(projectId)
  } else {
    candidates = (await getAgentOnDemandSkills(agentId)).map(a => a.skill)
  }

  const elCtx = await buildEligibilityContext(projectId)
  return candidates.filter(s => {
    const manifest = (s.manifest as SkillManifest | null | undefined) ?? { name: s.name, description: s.description ?? '' }
    return checkSkillEligibility(manifest, elCtx).eligible
  })
}

/**
 * Plan 19 — Structured XML progressive-disclosure hint injected into the system prompt.
 * Replaces the legacy markdown list. Enforces budget limits.
 */
export async function buildOnDemandSkillHint(agentId: string): Promise<string | undefined> {
  // In `all_on_demand` mode we also pin any `always`-mode rows to the hint list
  // so the agent can re-activate them on demand (always-mode skills are already
  // injected via buildAlwaysSkillSection, but their slugs also need to be
  // discoverable for skill_read_file).
  const skills = await resolveOnDemandSkillsForAgent(agentId)
  if (skills.length === 0) return undefined

  const truncated = skills.slice(0, MAX_SKILLS_IN_PROMPT)
  const entries = truncated
    .map(s => ({
      slug: s.slug,
      name: s.name,
      description: s.description ?? '',
      tags: s.tags ?? [],
      source: s.source,
    }))

  // Render XML, then enforce char budget by dropping tail entries if needed.
  let xml = renderXml(entries)
  while (xml.length > MAX_SKILLS_PROMPT_CHARS && entries.length > 1) {
    entries.pop()
    xml = renderXml(entries)
  }

  return [
    xml,
    '',
    'Before answering any request that matches a skill description above,',
    'you MUST call `skill_activate` with the matching slug first. Do not answer',
    'from general knowledge when a relevant skill exists. Use `skill_read_file`',
    'to load any nested files the skill references.',
  ].join('\n')
}

function renderXml(entries: Array<{ slug: string; name: string; description: string; tags: string[]; source: string }>): string {
  const items = entries.map(e => {
    const tagsLine = e.tags.length > 0 ? `    <tags>${escapeXml(e.tags.join(', '))}</tags>\n` : ''
    return [
      '  <skill>',
      `    <slug>${escapeXml(e.slug)}</slug>`,
      `    <name>${escapeXml(e.name)}</name>`,
      `    <description>${escapeXml(e.description)}</description>`,
      tagsLine.trimEnd(),
      `    <source>${escapeXml(e.source)}</source>`,
      '  </skill>',
    ].filter(Boolean).join('\n')
  }).join('\n')
  return `<available_skills>\n${items}\n</available_skills>`
}

function escapeXml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

/**
 * Plan 19 — Always-injected skill section (mode='always' rows). Kept separate so we
 * avoid a circular import with SkillService.
 */
export async function listAlwaysSkillsForAgent(agentId: string): Promise<ProjectSkill[]> {
  const rows = await getAgentAlwaysSkills(agentId)
  return rows.map(r => r.skill)
}
