import { defineTool } from '@jiku/kit'
import { z } from 'zod'
import { resolveOnDemandSkillsForAgent } from './prompt-hint.ts'
import { SkillService } from './service.ts'
import { getSkillLoader } from './loader.ts'
import type { SkillSource } from '@jiku/types'

/**
 * Plan 19 — Runtime skill tools.
 * All tools now operate against the project's SkillLoader (FS + plugin sources).
 * Eligibility filter is applied via `resolveOnDemandSkillsForAgent`.
 */
export function buildSkillTools(agentId: string, projectId: string) {
  const pickAssignment = async (slug: string) => {
    const skills = await resolveOnDemandSkillsForAgent(agentId)
    return skills.find(s => s.slug === slug) ?? null
  }

  return [
    defineTool({
      meta: {
        id: 'skill_list',
        name: 'List Skills',
        description: 'List all available on-demand skills (from filesystem and plugin sources). Call this first to discover what knowledge/capabilities are available.',
        group: 'skills',
      },
      permission: '*',
      modes: ['chat', 'task'],
      input: z.object({}),
      execute: async (_args, _ctx) => {
        const skills = await resolveOnDemandSkillsForAgent(agentId)
        if (skills.length === 0) {
          return { skills: [], message: 'No on-demand skills available for this agent.' }
        }
        return {
          skills: skills.map(s => ({
            slug: s.slug,
            name: s.name,
            description: s.description ?? '',
            tags: s.tags,
            source: s.source,
          })),
        }
      },
    }),

    defineTool({
      meta: {
        id: 'skill_activate',
        name: 'Activate Skill',
        description: 'Load the knowledge/instructions from a skill by its slug. Returns the full entrypoint content and a categorized file tree. Use this when you need specialized knowledge or instructions for a task.',
        group: 'skills',
      },
      permission: '*',
      modes: ['chat', 'task'],
      input: z.object({
        slug: z.string().describe('Skill slug to activate'),
      }),
      execute: async (args) => {
        const { slug } = args as { slug: string }
        const skill = await pickAssignment(slug)
        if (!skill) {
          return { error: `Skill "${slug}" is not available for this agent. Use skill_list to see available skills.` }
        }
        const source = (skill.source ?? 'fs') as SkillSource
        const loader = getSkillLoader(projectId)
        const tree = await loader.buildFileTree(slug, source)
        if (!tree) {
          return {
            error: `Skill "${slug}" entrypoint could not be loaded. The skill folder may be empty or missing SKILL.md.`,
            hint: 'Edit SKILL.md at `/skills/<slug>/` (for FS) or re-activate the contributing plugin.',
          }
        }
        const nested = tree.files.filter(f => f.path !== tree.entrypoint.path)
        return {
          skill: { slug: skill.slug, name: skill.name, description: skill.description, source: skill.source },
          content: tree.entrypoint.content,
          entrypoint: tree.entrypoint.path,
          files: nested,
          ...(nested.length > 0
            ? { hint: `Use skill_read_file to load nested files, e.g. ${nested.slice(0, 3).map(f => f.path).join(', ')}` }
            : {}),
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
      execute: async (args) => {
        const { slug, path } = args as { slug: string; path: string }
        const skill = await pickAssignment(slug)
        if (!skill) return { error: `Skill "${slug}" is not available for this agent.` }
        const source = (skill.source ?? 'fs') as SkillSource
        const content = await SkillService.loadFile(projectId, slug, path, source)
        if (!content) {
          const files = await SkillService.listFiles(projectId, slug, source)
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
        description: 'List all files available in a skill folder, categorized by type (markdown/code/asset/binary).',
        group: 'skills',
      },
      permission: '*',
      modes: ['chat', 'task'],
      input: z.object({
        slug: z.string().describe('Skill slug'),
      }),
      execute: async (args) => {
        const { slug } = args as { slug: string }
        const skill = await pickAssignment(slug)
        if (!skill) return { error: `Skill "${slug}" is not available for this agent.` }
        const source = (skill.source ?? 'fs') as SkillSource
        const tree = await getSkillLoader(projectId).buildFileTree(slug, source)
        if (!tree) return { files: [] }
        return {
          entrypoint: tree.entrypoint.path,
          files: tree.files,
        }
      },
    }),
  ]
}
