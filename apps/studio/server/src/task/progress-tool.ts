import { z } from 'zod'
import { getConversationById, updateConversation } from '@jiku-studio/db'
import type { ToolDefinition } from '@jiku/types'

/**
 * Plan 15.8: Built-in tool for reporting task progress.
 * Agent calls this after each significant step during task execution.
 * Progress is stored in conversation metadata and emitted to stream.
 */
export function buildProgressTool(conversationId: string): ToolDefinition {
  return {
    meta: {
      id: 'report_progress',
      name: 'Report Progress',
      description: 'Report current progress of this task. Call after each significant step to keep the user informed.',
      group: 'task',
    },
    permission: '*',
    modes: ['task'],
    input: z.object({
      step: z.string().describe('What was just completed'),
      percentage: z.number().min(0).max(100).optional().describe('Progress percentage 0-100'),
      details: z.string().optional().describe('Additional context about the step'),
    }),
    execute: async (input: unknown, ctx) => {
      const { step, percentage, details } = input as { step: string; percentage?: number; details?: string }

      const entry = {
        message: step,
        percent: percentage,
        details,
        at: new Date().toISOString(),
      }

      // Append to conversation metadata
      const conv = await getConversationById(conversationId)
      const meta = (conv?.metadata ?? {}) as Record<string, unknown>
      const log = (meta.progress_log as Array<unknown>) ?? []
      log.push(entry)

      await updateConversation(conversationId, {
        metadata: {
          ...meta,
          progress_log: log,
          current_progress: { step, percentage },
        },
      })

      // Emit to stream for live observers
      ctx.writer.write('jiku-tool-data', {
        tool_id: 'report_progress',
        data: entry,
      })

      return { recorded: true }
    },
  }
}
