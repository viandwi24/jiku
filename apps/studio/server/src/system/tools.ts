import { z } from 'zod'
import type { ToolDefinition } from '@jiku/types'

/**
 * Built-in system tools always injected on every agent, regardless of mode.
 */
export const systemTools: ToolDefinition[] = [
  {
    meta: {
      id: 'get_datetime',
      name: 'Get Date & Time',
      description: 'Returns the current date, time, and server timezone. Use this whenever you need to know the current time or to convert between timezones.',
      group: 'system',
    },
    permission: '*',
    modes: ['chat', 'task'],
    input: z.object({}),
    execute: async () => {
      const now = new Date()
      const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone
      return {
        iso: now.toISOString(),
        timezone,
        local: now.toLocaleString('en-US', { timeZone: timezone, dateStyle: 'full', timeStyle: 'long' }),
        unix: Math.floor(now.getTime() / 1000),
      }
    },
  },
]
