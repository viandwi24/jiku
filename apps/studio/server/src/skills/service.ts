import { getAgentAlwaysSkills } from '@jiku-studio/db'
import { getFilesystemService } from '../filesystem/service.ts'
import { getSkillLoader } from './loader.ts'
import type { SkillSource } from '@jiku/types'

/** Filesystem path prefix for FS-sourced skills in a project. */
export function skillFsPath(slug: string, filePath = ''): string {
  const base = `/skills/${slug}`
  return filePath ? `${base}/${filePath.replace(/^\//, '')}` : base
}

/**
 * Plan 19 — `SkillService` now delegates to the project-scoped SkillLoader for
 * source-aware file access. The legacy (projectId, slug, ...) signatures still
 * work for FS-sourced skills via `source='fs'` default.
 */
export class SkillService {
  static async loadEntrypoint(projectId: string, slug: string, entrypoint: string, source: SkillSource = 'fs'): Promise<string | null> {
    const loader = getSkillLoader(projectId)
    return loader.loadFile(slug, source, entrypoint)
  }

  static async loadFile(projectId: string, slug: string, path: string, source: SkillSource = 'fs'): Promise<string | null> {
    const loader = getSkillLoader(projectId)
    return loader.loadFile(slug, source, path)
  }

  static async listFiles(projectId: string, slug: string, source: SkillSource = 'fs'): Promise<{ path: string; size_bytes: number }[]> {
    const loader = getSkillLoader(projectId)
    const tree = await loader.buildFileTree(slug, source)
    if (!tree) {
      // Fallback to raw FS listing for FS source (when no manifest is present yet)
      if (source === 'fs') {
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
        } catch { return [] }
      }
      return []
    }
    return tree.files.map(f => ({ path: f.path, size_bytes: f.size_bytes }))
  }

  /**
   * Build the "always" skill section for the system prompt.
   * Loads entrypoints of all always-mode skills assigned to the agent,
   * across both FS and plugin sources.
   */
  static async buildAlwaysSkillSection(agentId: string): Promise<string | undefined> {
    const assignments = await getAgentAlwaysSkills(agentId)
    if (assignments.length === 0) return undefined

    const parts: string[] = []
    for (const { skill } of assignments) {
      const source = (skill.source ?? 'fs') as SkillSource
      const content = await SkillService.loadEntrypoint(skill.project_id, skill.slug, skill.entrypoint, source)
      if (content) {
        parts.push(`## Skill: ${skill.name}\n${skill.description ? `_${skill.description}_\n\n` : ''}${content}`)
      }
    }

    if (parts.length === 0) return undefined
    return `# Skills\n\n${parts.join('\n\n---\n\n')}`
  }

  /**
   * Plan 19 — Progressive-disclosure XML hint for on-demand skills.
   * See `buildOnDemandSkillHint` in prompt-hint.ts (moved out to keep this class focused).
   */
  static async buildOnDemandSkillHint(agentId: string): Promise<string | undefined> {
    const { buildOnDemandSkillHint } = await import('./prompt-hint.ts')
    return buildOnDemandSkillHint(agentId)
  }
}
