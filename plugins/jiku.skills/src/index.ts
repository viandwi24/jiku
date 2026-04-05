import { definePlugin, defineTool } from '@jiku/kit'
import { z } from 'zod'

const configSchema = z.object({
  skills_dir: z.string().default('./skills').describe('Directory containing skill markdown files'),
  max_inject: z.number().int().min(1).max(10).default(3).describe('Maximum number of skills to inject per conversation'),
})

export default definePlugin({
  meta: {
    id: 'jiku.skills',
    name: 'Skills & SOPs',
    version: '1.0.0',
    description: 'Inject standard operating procedures and skill definitions into agent context. Define SOPs as markdown files.',
    author: 'Jiku',
    icon: 'BookOpen',
    category: 'productivity',
    project_scope: true,
  },

  configSchema,

  setup(ctx) {
    ctx.project.tools.register(
      defineTool({
        meta: { id: 'skills_list', name: 'List Skills', description: 'List all available skills and SOPs for this project' },
        permission: 'skills:read',
        modes: ['chat', 'task'],
        input: z.object({}),
        execute: async () => {
          return { skills: [] }
        },
      }),

      defineTool({
        meta: { id: 'skills_get', name: 'Get Skill', description: 'Get the content of a specific skill or SOP by name' },
        permission: 'skills:read',
        modes: ['chat', 'task'],
        input: z.object({
          name: z.string().describe('Name of the skill or SOP to retrieve'),
        }),
        execute: async (args) => {
          const { name } = args as { name: string }
          return { name, content: null, found: false }
        },
      }),

      defineTool({
        meta: { id: 'skills_create', name: 'Create Skill', description: 'Create a new skill or SOP definition' },
        permission: 'skills:write',
        modes: ['chat', 'task'],
        input: z.object({
          name: z.string().describe('Unique name for the skill'),
          content: z.string().describe('Markdown content of the skill or SOP'),
          tags: z.array(z.string()).optional().describe('Optional tags for categorization'),
        }),
        execute: async (args) => {
          const { name, content, tags } = args as { name: string; content: string; tags?: string[] }
          return {
            id: `skill-${Date.now()}`,
            name,
            content,
            tags: tags ?? [],
            created_at: new Date().toISOString(),
          }
        },
      }),
    )

    ctx.project.prompt.inject(
      'You have access to project skills and SOPs. Use the skills tools to look up standard operating procedures relevant to your tasks.'
    )
  },

  onProjectPluginActivated: async (projectId, ctx) => {
    const { skills_dir, max_inject } = ctx.config
    console.log(`[jiku.skills] Activated for project ${projectId} — skills_dir: ${skills_dir}, max_inject: ${max_inject}`)
  },

  onProjectPluginDeactivated: async (projectId) => {
    console.log(`[jiku.skills] Deactivated for project ${projectId}`)
  },
})
