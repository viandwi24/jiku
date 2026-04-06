import { getAgentAlwaysSkills, getAgentOnDemandSkills } from '@jiku-studio/db'
import { getFilesystemService } from '../filesystem/service.ts'

/** Filesystem path prefix for all skills in a project. */
export function skillFsPath(slug: string, filePath = ''): string {
  const base = `/skills/${slug}`
  return filePath ? `${base}/${filePath.replace(/^\//, '')}` : base
}

export class SkillService {
  /**
   * Load the entrypoint file content of a skill via the project filesystem.
   */
  static async loadEntrypoint(projectId: string, slug: string, entrypoint: string): Promise<string | null> {
    const fs = await getFilesystemService(projectId)
    if (!fs) return null
    try {
      return await fs.read(skillFsPath(slug, entrypoint))
    } catch {
      return null
    }
  }

  /**
   * Load a specific nested file within a skill via the project filesystem.
   */
  static async loadFile(projectId: string, slug: string, path: string): Promise<string | null> {
    const fs = await getFilesystemService(projectId)
    if (!fs) return null
    try {
      return await fs.read(skillFsPath(slug, path))
    } catch {
      return null
    }
  }

  /**
   * List all files available in a skill folder.
   */
  static async listFiles(projectId: string, slug: string): Promise<{ path: string; size_bytes: number }[]> {
    const fs = await getFilesystemService(projectId)
    if (!fs) return []
    try {
      const entries = await fs.list(skillFsPath(slug))
      const rootPrefix = skillFsPath(slug) + '/'
      return entries
        .filter(e => e.type === 'file')
        .map(e => ({
          path: e.path.startsWith(rootPrefix) ? e.path.slice(rootPrefix.length) : e.path,
          size_bytes: e.type === 'file' ? e.size_bytes : 0,
        }))
    } catch {
      return []
    }
  }

  /**
   * Build the "always" skill section for the system prompt.
   * Loads entrypoints of all always-mode skills assigned to the agent.
   */
  static async buildAlwaysSkillSection(agentId: string): Promise<string | undefined> {
    const assignments = await getAgentAlwaysSkills(agentId)
    if (assignments.length === 0) return undefined

    const parts: string[] = []
    for (const { skill } of assignments) {
      const content = await SkillService.loadEntrypoint(skill.project_id, skill.slug, skill.entrypoint)
      if (content) {
        parts.push(`## Skill: ${skill.name}\n${skill.description ? `_${skill.description}_\n\n` : ''}${content}`)
      }
    }

    if (parts.length === 0) return undefined
    return `# Skills\n\n${parts.join('\n\n---\n\n')}`
  }

  /**
   * Build a strong system-prompt instruction listing on-demand skills.
   * Instructs the model to call skill_activate BEFORE answering.
   */
  static async buildOnDemandSkillHint(agentId: string): Promise<string | undefined> {
    const assignments = await getAgentOnDemandSkills(agentId)
    if (assignments.length === 0) return undefined

    const lines = assignments.map(({ skill }) => {
      const desc = skill.description ? `\n  Description: ${skill.description}` : ''
      return `- slug: \`${skill.slug}\`  name: ${skill.name}${desc}`
    })

    return [
      `## On-Demand Skills`,
      `You have ${assignments.length} specialized skill(s) available. **Before answering any request that matches a skill's description, you MUST call \`skill_activate\` with the matching slug first.** Do not answer from general knowledge when a relevant skill exists — always load it first, then use its content in your response.`,
      `If the skill references additional files, use \`skill_read_file\` to load them as needed.`,
      `\nAvailable skills:\n${lines.join('\n')}`,
    ].join('\n')
  }
}
