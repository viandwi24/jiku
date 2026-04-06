import { defineTool } from '@jiku/kit'
import { z } from 'zod'
import { getAgentOnDemandSkills } from '@jiku-studio/db'
import { SkillService, skillFsPath } from './service.ts'
import { getFilesystemService } from '../filesystem/service.ts'

/**
 * Build skill tools for on-demand skill loading.
 * Returns 3 tools: skill_list, skill_activate, skill_read_file.
 */
export function buildSkillTools(agentId: string, projectId: string) {
  return [
    defineTool({
      meta: {
        id: 'skill_list',
        name: 'List Skills',
        description: 'List all available on-demand skills. Call this first to discover what knowledge/capabilities are available.',
        group: 'skills',
      },
      permission: '*',
      modes: ['chat', 'task'],
      input: z.object({}),
      execute: async (_args, ctx) => {
        const assignments = await getAgentOnDemandSkills(ctx.runtime.agent.id)
        if (assignments.length === 0) {
          return { skills: [], message: 'No on-demand skills assigned to this agent.' }
        }
        return {
          skills: assignments.map(({ skill }) => ({
            slug: skill.slug,
            name: skill.name,
            description: skill.description ?? '',
            tags: skill.tags,
          })),
        }
      },
    }),

    defineTool({
      meta: {
        id: 'skill_activate',
        name: 'Activate Skill',
        description: 'Load the knowledge/instructions from a skill by its slug. Returns the full entrypoint content. Use this when you need specialized knowledge or instructions for a task.',
        group: 'skills',
      },
      permission: '*',
      modes: ['chat', 'task'],
      input: z.object({
        slug: z.string().describe('Skill slug to activate'),
      }),
      execute: async (args, ctx) => {
        const { slug } = args as { slug: string }

        const assignments = await getAgentOnDemandSkills(ctx.runtime.agent.id)
        const assignment = assignments.find(a => a.skill.slug === slug)
        if (!assignment) {
          return { error: `Skill "${slug}" is not available for this agent. Use skill_list to see available skills.` }
        }

        const { skill } = assignment
        let content = await SkillService.loadEntrypoint(projectId, skill.slug, skill.entrypoint)
        let usedEntrypoint = skill.entrypoint

        // Auto-discover: if configured entrypoint doesn't exist, try any .md file in the folder
        if (!content) {
          const allFiles = await SkillService.listFiles(projectId, skill.slug)
          const mdFile = allFiles.find(f => f.path.endsWith('.md'))
          if (mdFile) {
            content = await SkillService.loadFile(projectId, skill.slug, mdFile.path)
            usedEntrypoint = mdFile.path
          }
          if (!content) {
            const available = allFiles.map(f => f.path)
            return {
              error: `Skill "${slug}" entrypoint "${skill.entrypoint}" not found.`,
              ...(available.length > 0
                ? { available_files: available, hint: `Use skill_read_file to load one of these files directly.` }
                : { hint: `No files found in skill folder. Add files via the Skills page.` }),
            }
          }
        }

        const files = await SkillService.listFiles(projectId, skill.slug)
        const nestedFiles = files.filter(f => f.path !== usedEntrypoint)

        return {
          skill: { slug: skill.slug, name: skill.name, description: skill.description },
          content,
          ...(nestedFiles.length > 0 ? {
            available_files: nestedFiles.map(f => f.path),
            hint: `Use skill_read_file to load nested files: ${nestedFiles.map(f => f.path).join(', ')}`,
          } : {}),
        }
      },
    }),

    defineTool({
      meta: {
        id: 'skill_read_file',
        name: 'Read Skill File',
        description: 'Read a specific nested file within a skill. Use after skill_activate when you need deeper content referenced in the entrypoint.',
        group: 'skills',
      },
      permission: '*',
      modes: ['chat', 'task'],
      input: z.object({
        slug: z.string().describe('Skill slug'),
        path: z.string().describe('File path within the skill (e.g. "examples/basic.md")'),
      }),
      execute: async (args, ctx) => {
        const { slug, path } = args as { slug: string; path: string }

        const assignments = await getAgentOnDemandSkills(ctx.runtime.agent.id)
        const assignment = assignments.find(a => a.skill.slug === slug)
        if (!assignment) {
          return { error: `Skill "${slug}" is not available for this agent.` }
        }

        const content = await SkillService.loadFile(projectId, slug, path)
        if (!content) {
          const files = await SkillService.listFiles(projectId, slug)
          return {
            error: `File "${path}" not found in skill "${slug}".`,
            available_files: files.map(f => f.path),
          }
        }

        return { skill: slug, path, content }
      },
    }),

    defineTool({
      meta: {
        id: 'skill_list_files',
        name: 'List Skill Files',
        description: 'List all files available in a skill folder.',
        group: 'skills',
      },
      permission: '*',
      modes: ['chat', 'task'],
      input: z.object({
        slug: z.string().describe('Skill slug'),
      }),
      execute: async (args, ctx) => {
        const { slug } = args as { slug: string }

        const assignments = await getAgentOnDemandSkills(ctx.runtime.agent.id)
        const assignment = assignments.find(a => a.skill.slug === slug)
        if (!assignment) {
          return { error: `Skill "${slug}" is not available for this agent.` }
        }

        const fs = await getFilesystemService(projectId)
        if (!fs) return { error: 'Filesystem not configured for this project.' }

        try {
          const entries = await fs.list(skillFsPath(slug))
          return { files: entries.filter(e => e.type === 'file').map(e => e.path) }
        } catch {
          return { files: [] }
        }
      },
    }),
  ]
}
