import { definePlugin, defineTool } from '@jiku/kit'
import { z } from 'zod'

export default definePlugin({
  meta: {
    id: 'jiku.social',
    name: 'Social Media Manager',
    version: '2.0.0',
    description: 'Manage social media posts across platforms',
    project_scope: true,
    author: 'Jiku',
    icon: 'Share2',
    category: 'communication',
  },

  configSchema: z.object({
    api_key: z.string().optional().describe('Social Media API key'),
  }),

  contributes: () => ({
    social: {
      getPlatforms: (): string[] => ['twitter', 'instagram'],
    },
  }),

  setup(ctx) {
    ctx.project.tools.register(

      defineTool({
        meta: { id: 'list_posts', name: 'List Posts', description: 'List all posts' },
        permission: '*',
        modes: ['chat', 'task'],
        input: z.object({ limit: z.number().optional() }),
        execute: async (_args, _ctx) => {
          return {
            posts: [
              { id: 'post-1', content: 'Hello world!', platform: 'twitter' },
              { id: 'post-2', content: 'Check out our product!', platform: 'instagram' },
            ],
          }
        },
      }),

      defineTool({
        meta: { id: 'create_post', name: 'Create Post', description: 'Create a new post' },
        permission: 'post:write',
        modes: ['chat', 'task'],
        input: z.object({
          content: z.string(),
          platform: z.enum(['twitter', 'instagram']),
        }),
        execute: async (args, ctx) => {
          const typedArgs = args as { content: string; platform: string }
          const company_id = ctx.runtime.caller.user_data.company_id
          return {
            id: `post-${Date.now()}`,
            company_id,
            content: typedArgs.content,
            platform: typedArgs.platform,
            created_at: new Date().toISOString(),
          }
        },
      }),

      defineTool({
        meta: { id: 'delete_post', name: 'Delete Post', description: 'Delete a post by ID' },
        permission: 'post:delete',
        modes: ['chat'],
        input: z.object({ post_id: z.string() }),
        execute: async (args, _ctx) => {
          const typedArgs = args as { post_id: string }
          return { deleted: true, post_id: typedArgs.post_id }
        },
      }),

    )

  },
})
