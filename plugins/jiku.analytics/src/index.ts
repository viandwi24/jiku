// jiku.analytics — demo plugin showcasing the isolated Plugin UI runtime.
//
// Server-side: exposes `/summary` + `/events` HTTP handlers and a couple of
// harmless tools. The plugin's UI is NOT imported here — it lives in
// `src/ui/*.tsx`, built independently by tsup, and loaded by the browser
// via dynamic URL import.

import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { definePlugin, defineTool } from '@jiku/kit'
import { defineUI } from '@jiku/kit/ui'
import { StudioPlugin } from '@jiku-plugin/studio'
import { z } from 'zod'

const __dirname = dirname(fileURLToPath(import.meta.url))
/** Absolute path to the built UI assets. Server uses this to serve `/api/plugins/jiku.analytics/ui/*`. */
const UI_DIST_DIR = join(__dirname, '..', 'dist', 'ui')

const configSchema = z.object({
  track_page_views: z.boolean().default(true).describe('Record page-view events'),
})

interface Event {
  id: string
  name: string
  at: string
  meta?: Record<string, unknown>
}

export default definePlugin({
  meta: {
    id: 'jiku.analytics',
    name: 'Analytics',
    version: '1.0.0',
    description: 'Project-level analytics dashboard — demo plugin for the isolated UI runtime.',
    author: 'Jiku',
    icon: 'BarChart2',
    category: 'analytics',
    project_scope: true,
  },

  // Depend on the Studio host anchor — signals "this plugin needs ctx.http /
  // ctx.events / ctx.studio" and pulls in their TypeScript types.
  depends: [StudioPlugin],

  configSchema,

  ui: defineUI({
    assetsDir: UI_DIST_DIR,
    entries: [
      {
        slot: 'project.page',
        id: 'dashboard',
        module: './Dashboard.js',
        meta: { path: '', title: 'Analytics', icon: 'BarChart2' },
      },
      {
        slot: 'project.settings.section',
        id: 'settings',
        module: './Settings.js',
        meta: { label: 'Analytics', icon: 'BarChart2', order: 50 },
      },
    ],
  }),

  setup(ctx) {
    // ─── HTTP handlers (namespaced under /api/plugins/jiku.analytics/api/*) ────
    // ctx.

    ctx.http.get('/summary', async ({ projectId }) => {
      const events = ((await ctx.storage.get(`events:${projectId}`)) as Event[] | null) ?? []
      return {
        project_id: projectId,
        total_events: events.length,
        last_event_at: events[events.length - 1]?.at ?? null,
      }
    })

    ctx.http.get('/events', async ({ projectId }) => {
      const events = ((await ctx.storage.get(`events:${projectId}`)) as Event[] | null) ?? []
      return { events }
    })

    ctx.http.post('/events', async ({ projectId, req }) => {
      const body = (req.body ?? {}) as { name?: string; meta?: Record<string, unknown> }
      const name = body.name ?? 'unknown'
      const events = ((await ctx.storage.get(`events:${projectId}`)) as Event[] | null) ?? []
      const ev: Event = {
        id: `evt-${Date.now().toString(36)}`,
        name,
        at: new Date().toISOString(),
        meta: body.meta,
      }
      const next = [...events, ev].slice(-200)
      await ctx.storage.set(`events:${projectId}`, next)
      ctx.events?.emit('event.recorded', ev, { projectId })
      return { ok: true, event: ev }
    })

    ctx.http.delete('/events', async ({ projectId }) => {
      await ctx.storage.delete(`events:${projectId}`)
      return { ok: true }
    })

    // ─── Tools ────────────────────────────────────────────────────────────────

    ctx.project.tools.register(
      defineTool({
        meta: { id: 'analytics_record', name: 'Record Analytics Event', description: 'Record a named event with optional metadata' },
        permission: 'analytics:write',
        modes: ['chat', 'task'],
        input: z.object({
          name: z.string().min(1).describe('Event name, e.g. "signup" or "page_view"'),
          meta: z.record(z.unknown()).optional().describe('Arbitrary metadata payload'),
        }),
        execute: async (args, toolCtx) => {
          const input = args as { name: string; meta?: Record<string, unknown> }
          // Tool-side storage is already scoped per plugin; the shared UI
          // handlers above use the same key schema so both paths converge.
          const key = 'events:__tool__'
          const events = ((await toolCtx.storage.get(key)) as Event[] | null) ?? []
          const ev: Event = { id: `evt-${Date.now().toString(36)}`, name: input.name, at: new Date().toISOString(), meta: input.meta }
          await toolCtx.storage.set(key, [...events, ev].slice(-200))
          return ev
        },
      }),
    )

    ctx.project.prompt.inject(
      'You have access to a lightweight analytics plugin. Call `analytics_record` to log named events.',
    )
  },

  onProjectPluginActivated: async (projectId) => {
    console.log(`[jiku.analytics] activated for project ${projectId}`)
  },

  onProjectPluginDeactivated: async (projectId) => {
    console.log(`[jiku.analytics] deactivated for project ${projectId}`)
  },
})
