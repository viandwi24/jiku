import { definePlugin, defineTool } from '@jiku/kit'
import { z } from 'zod'

const configSchema = z.object({
  timezone: z.string().default('UTC').describe('Timezone for all cron jobs (e.g. Asia/Jakarta)'),
  max_jobs: z.number().int().min(1).max(100).default(20).describe('Maximum concurrent cron jobs per project'),
})

export default definePlugin({
  meta: {
    id: 'jiku.cron',
    name: 'Cron Scheduler',
    version: '1.0.0',
    description: 'Schedule and automate tasks using cron expressions. Supports standard cron syntax and human-readable shortcuts.',
    author: 'Jiku',
    icon: 'Clock',
    category: 'productivity',
    project_scope: true,
  },

  configSchema,

  setup(ctx) {
    ctx.project.tools.register(
      defineTool({
        meta: { id: 'cron_create', name: 'Create Cron Job', description: 'Create a new scheduled cron job' },
        permission: 'cron:write',
        modes: ['chat', 'task'],
        input: z.object({
          name: z.string().describe('Unique name for the cron job'),
          expression: z.string().describe('Cron expression (e.g. "0 9 * * 1-5" or "every 5m")'),
          task: z.string().describe('Task description to execute'),
        }),
        execute: async (args) => {
          const { name, expression, task } = args as { name: string; expression: string; task: string }
          return {
            id: `cron-${Date.now()}`,
            name,
            expression,
            task,
            created_at: new Date().toISOString(),
            status: 'scheduled',
          }
        },
      }),

      defineTool({
        meta: { id: 'cron_list', name: 'List Cron Jobs', description: 'List all scheduled cron jobs for this project' },
        permission: 'cron:read',
        modes: ['chat', 'task'],
        input: z.object({}),
        execute: async () => {
          return { jobs: [] }
        },
      }),

      defineTool({
        meta: { id: 'cron_delete', name: 'Delete Cron Job', description: 'Delete a scheduled cron job by ID' },
        permission: 'cron:write',
        modes: ['chat', 'task'],
        input: z.object({
          job_id: z.string().describe('ID of the cron job to delete'),
        }),
        execute: async (args) => {
          const { job_id } = args as { job_id: string }
          return { deleted: true, job_id }
        },
      }),
    )

    ctx.project.prompt.inject(
      'You have access to a cron scheduler. You can create, list, and delete scheduled jobs using cron expressions.'
    )
  },

  onProjectPluginActivated: async (projectId, ctx) => {
    const { timezone, max_jobs } = ctx.config
    console.log(`[jiku.cron] Activated for project ${projectId} — timezone: ${timezone}, max_jobs: ${max_jobs}`)
    // Restore persisted jobs from storage
    const jobs = await ctx.storage.get('jobs') as unknown[] ?? []
    console.log(`[jiku.cron] Restored ${jobs.length} job(s) for project ${projectId}`)
  },

  onProjectPluginDeactivated: async (projectId) => {
    console.log(`[jiku.cron] Deactivated for project ${projectId}`)
  },

  onServerStop: async () => {
    console.log('[jiku.cron] Server stopping — cron scheduler shutdown')
  },
})
