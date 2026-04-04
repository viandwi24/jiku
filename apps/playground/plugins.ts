/**
 * Playground plugins — demonstrates Plugin System V2 features:
 *   - contributes (async init)
 *   - depends instance → typed ctx
 *   - depends string → sort only
 *   - override / bridge pattern
 */

import { definePlugin, defineTool } from '@jiku/kit'
import { z } from 'zod'

// ============================================================
// DatabasePlugin — async contributes
// ============================================================

/**
 * Contributes ctx.database to dependents.
 * Uses async contributes to simulate DB connection setup.
 */
export const DatabasePlugin = definePlugin({
  meta: { id: 'mock.database', name: 'Mock Database', version: '1.0.0' },

  contributes: async () => {
    await new Promise<void>(r => setTimeout(r, 10)) // simulate async init
    const store: Record<string, unknown[]> = {}
    return {
      database: {
        query: async (table: string): Promise<unknown[]> => store[table] ?? [],
        insert: async (table: string, data: unknown): Promise<void> => {
          store[table] = [...(store[table] ?? []), data]
        },
      },
    }
  },

  setup(_ctx) {},
})

// ============================================================
// SocialPlugin — depends instance (typed ctx)
// ============================================================

/**
 * Depends on DatabasePlugin → gets ctx.database typed.
 * Also contributes ctx.social to its own dependents.
 */
export const SocialPlugin = definePlugin({
  meta: { id: 'jiku.social', name: 'Social Media', version: '2.0.0' },
  depends: [DatabasePlugin],

  contributes: () => ({
    social: {
      getPlatforms: (): string[] => ['twitter', 'instagram'],
    },
  }),

  setup(ctx) {
    // ctx.database — fully typed from DatabasePlugin.contributes
    ctx.database.query('posts')

    ctx.tools.register(
      defineTool({
        meta: { id: 'list_posts', name: 'List Posts', description: 'List all available posts' },
        permission: '*',
        modes: ['chat', 'task'],
        input: z.object({ limit: z.number().optional() }),
        execute: async () => ({
          posts: [
            { id: 'post-1', content: 'Hello world!', platform: 'twitter' },
            { id: 'post-2', content: 'Check out our product!', platform: 'instagram' },
          ],
        }),
      }),

      defineTool({
        meta: { id: 'create_post', name: 'Create Post', description: 'Create a new post on a platform' },
        permission: 'post:write',
        modes: ['chat', 'task'],
        input: z.object({
          content: z.string(),
          platform: z.enum(['twitter', 'instagram']),
        }),
        execute: async (args, toolCtx) => {
          const typedArgs = args as { content: string; platform: 'twitter' | 'instagram' }
          const company_id = toolCtx.runtime.caller.user_data.company_id
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
        execute: async (args) => {
          const typedArgs = args as { post_id: string }
          return { deleted: true, post_id: typedArgs.post_id }
        },
      }),
    )

    ctx.provide('social', () => ({
      getPlatformConfig: () => ({ api_key: process.env.SOCIAL_API_KEY ?? 'demo-key' }),
    }))
  },
})

// ============================================================
// AnalyticsPlugin — depends string (sort only)
// ============================================================

/**
 * Depends on 'jiku.social' via string — guaranteed load order, no typed ctx.
 */
export const AnalyticsPlugin = definePlugin({
  meta: { id: 'jiku.analytics', name: 'Analytics', version: '1.0.0' },
  depends: ['jiku.social'],
  setup(_ctx) {},
})

// ============================================================
// MockServerPlugin — bridge pattern (noop placeholder)
// ============================================================

/**
 * Noop placeholder that contributes ctx.server.
 * In production, the app overrides this with an actual server (Hono, Express, etc).
 */
export const MockServerPlugin = definePlugin({
  meta: { id: '@jiku/plugin-server', name: 'Server Bridge', version: '1.0.0' },
  contributes: () => ({
    server: {
      get: (_path: string, _handler: unknown) => {},
    },
  }),
  setup(_ctx) {},
})

// ============================================================
// WebhookPlugin — depends instance (bridge consumer)
// ============================================================

/**
 * Depends on MockServerPlugin → ctx.server typed.
 * Registers routes + exposes a trigger_webhook tool.
 */
export const WebhookPlugin = definePlugin({
  meta: { id: 'jiku.webhook', name: 'Webhook', version: '1.0.0' },
  depends: [MockServerPlugin],

  setup(ctx) {
    ctx.server.get('/webhook', () => {})

    ctx.tools.register(
      defineTool({
        meta: { id: 'trigger_webhook', name: 'Trigger Webhook', description: 'Trigger a webhook endpoint' },
        permission: '*',
        modes: ['chat'],
        input: z.object({ event: z.string() }),
        execute: async (args) => {
          const typedArgs = args as { event: string }
          return { triggered: true, event: typedArgs.event }
        },
      }),
    )
  },
})
