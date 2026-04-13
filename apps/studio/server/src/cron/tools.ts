import { z } from 'zod'
import {
  getCronTaskById,
  getCronTasksByAgent,
  createCronTask,
  updateCronTask,
  deleteCronTask,
} from '@jiku-studio/db'
import type { ToolDefinition } from '@jiku/types'
import { cronTaskScheduler } from './scheduler.ts'

interface CallerSnapshotContext {
  callerId: string | null
  callerRole: string | null
  callerIsSuperadmin: boolean
}

function buildCronDeliveryBlock(delivery?: {
  connector_id?: string
  target_name?: string
  chat_id?: string
  thread_id?: string
  scope_key?: string
}): string {
  if (!delivery) return ''
  const lines: string[] = ['', '[Cron Delivery]']
  lines.push('When this task fires there is NO incoming message — you are triggered by the scheduler.')
  lines.push('After producing the reminder/content, you MUST deliver it via one of the tools below:')
  if (delivery.target_name) {
    lines.push(`- Preferred: connector_send_to_target({ target_name: "${delivery.target_name}"${delivery.connector_id ? `, connector_id: "${delivery.connector_id}"` : ''}, text: <your message>, markdown: true })`)
  }
  if (delivery.scope_key && delivery.connector_id) {
    lines.push(`- Or: connector_run_action({ connector_id: "${delivery.connector_id}", action_id: "send_to_scope", params: { scope_key: "${delivery.scope_key}", text: <your message>, markdown: true } })`)
  }
  if (delivery.chat_id && delivery.connector_id) {
    const threadHint = delivery.thread_id ? `, thread_id: "${delivery.thread_id}"` : ''
    lines.push(`- Or raw: connector_send({ connector_id: "${delivery.connector_id}", target_ref_keys: { chat_id: "${delivery.chat_id}"${threadHint} }, text: <your message>, markdown: true })`)
  }
  lines.push('Do not just return text — without one of these calls the user will receive nothing.')
  return lines.join('\n')
}

export function buildCronCreateTool(
  projectId: string,
  agentId: string,
  callerCtx: CallerSnapshotContext,
): ToolDefinition {
  return {
    meta: {
      id: 'cron_create',
      name: 'Create Cron Task',
      description:
        'Create a new scheduled cron task for this agent. When the task fires there is NO incoming message — ' +
        'so if the user needs to be notified (e.g. reminder to a Telegram chat), you MUST pass a `delivery` object ' +
        'so the cron-run version of this agent knows where to send the output. Read the current Connector Context ' +
        '(connector_id, chat scope, chat ref) and copy those values into delivery.',
      group: 'cron',
    },
    permission: '*',
    modes: ['chat', 'task'],
    input: z.object({
      name: z.string().max(255).describe('Human-readable name for the cron task'),
      description: z.string().optional().describe('Optional description'),
      cron_expression: z.string().max(100).describe('5-field cron expression, e.g. "0 * * * *" for every hour'),
      prompt: z.string().describe('The prompt to send to the agent when triggered. DO NOT include delivery instructions here — use the `delivery` field instead.'),
      delivery: z.object({
        connector_id: z.string().optional().describe('Connector UUID from Connector Context'),
        target_name: z.string().optional().describe('Name of an existing Channel Target to send to (preferred if one exists)'),
        chat_id: z.string().optional().describe('Raw chat_id (from current Chat ref) — fallback when no named target'),
        thread_id: z.string().optional().describe('Forum topic thread_id if applicable'),
        scope_key: z.string().optional().describe('scope_key from Connector Context — enables send_to_scope'),
      }).optional().describe('Where to send the output when the task fires. Omit only if the task has no user-facing output.'),
      enabled: z.boolean().default(true).describe('Whether the task is enabled immediately'),
    }),
    execute: async (input: unknown) => {
      const parsed = input as {
        name: string
        description?: string
        cron_expression: string
        prompt: string
        enabled: boolean
        delivery?: {
          connector_id?: string
          target_name?: string
          chat_id?: string
          thread_id?: string
          scope_key?: string
        }
      }

      const fullPrompt = parsed.prompt + buildCronDeliveryBlock(parsed.delivery)

      const task = await createCronTask({
        project_id: projectId,
        agent_id: agentId,
        name: parsed.name,
        description: parsed.description ?? null,
        cron_expression: parsed.cron_expression,
        prompt: fullPrompt,
        enabled: parsed.enabled,
        caller_id: callerCtx.callerId,
        caller_role: callerCtx.callerRole,
        caller_is_superadmin: callerCtx.callerIsSuperadmin,
        metadata: parsed.delivery ? { delivery: parsed.delivery } : {},
      })

      if (task.enabled) {
        cronTaskScheduler.scheduleTask(task.id, projectId).catch(err =>
          console.warn('[cron:tools] Failed to schedule new task:', err)
        )
      }

      return { success: true, task_id: task.id, name: task.name }
    },
  }
}

export function buildCronListTool(projectId: string, agentId: string): ToolDefinition {
  return {
    meta: {
      id: 'cron_list',
      name: 'List Cron Tasks',
      description: 'List all scheduled cron tasks for this agent',
      group: 'cron',
    },
    permission: '*',
    modes: ['chat', 'task'],
    input: z.object({}),
    execute: async () => {
      const tasks = await getCronTasksByAgent(agentId)
      return {
        tasks: tasks.map(t => ({
          id: t.id,
          name: t.name,
          description: t.description,
          cron_expression: t.cron_expression,
          enabled: t.enabled,
          run_count: t.run_count,
          last_run_at: t.last_run_at?.toISOString() ?? null,
          next_run_at: t.next_run_at?.toISOString() ?? null,
        })),
      }
    },
  }
}

export function buildCronUpdateTool(
  projectId: string,
  agentId: string,
  callerCtx: CallerSnapshotContext,
): ToolDefinition {
  return {
    meta: {
      id: 'cron_update',
      name: 'Update Cron Task',
      description: 'Update an existing cron task (name, schedule, prompt, or enabled state)',
      group: 'cron',
    },
    permission: '*',
    modes: ['chat', 'task'],
    input: z.object({
      task_id: z.string().describe('ID of the cron task to update'),
      name: z.string().max(255).optional(),
      description: z.string().optional(),
      cron_expression: z.string().max(100).optional(),
      prompt: z.string().optional(),
      enabled: z.boolean().optional(),
    }),
    execute: async (input: unknown) => {
      const parsed = input as {
        task_id: string
        name?: string
        description?: string
        cron_expression?: string
        prompt?: string
        enabled?: boolean
      }

      const existing = await getCronTaskById(parsed.task_id)
      if (!existing) return { success: false, error: 'Cron task not found' }
      if (existing.agent_id !== agentId) return { success: false, error: 'Not authorized' }

      // Security: if created by superadmin and caller is not superadmin, reject
      if (existing.caller_is_superadmin && !callerCtx.callerIsSuperadmin) {
        return { success: false, error: 'Only a superadmin can modify a superadmin-created cron task' }
      }

      const updates: Partial<typeof existing> = {}
      if (parsed.name !== undefined) updates.name = parsed.name
      if (parsed.description !== undefined) updates.description = parsed.description
      if (parsed.cron_expression !== undefined) updates.cron_expression = parsed.cron_expression
      if (parsed.prompt !== undefined) updates.prompt = parsed.prompt
      if (parsed.enabled !== undefined) updates.enabled = parsed.enabled

      const task = await updateCronTask(parsed.task_id, updates)

      if (task.enabled) {
        cronTaskScheduler.rescheduleTask(task.id, projectId).catch(err =>
          console.warn('[cron:tools] Failed to reschedule task:', err)
        )
      } else {
        cronTaskScheduler.stopTask(task.id)
      }

      return { success: true, task_id: task.id }
    },
  }
}

export function buildCronDeleteTool(
  projectId: string,
  agentId: string,
  callerCtx: CallerSnapshotContext,
): ToolDefinition {
  return {
    meta: {
      id: 'cron_delete',
      name: 'Delete Cron Task',
      description: 'Delete an existing cron task',
      group: 'cron',
    },
    permission: '*',
    modes: ['chat', 'task'],
    input: z.object({
      task_id: z.string().describe('ID of the cron task to delete'),
    }),
    execute: async (input: unknown) => {
      const parsed = input as { task_id: string }

      const existing = await getCronTaskById(parsed.task_id)
      if (!existing) return { success: false, error: 'Cron task not found' }
      if (existing.agent_id !== agentId) return { success: false, error: 'Not authorized' }

      // Security: if created by superadmin and caller is not superadmin, reject
      if (existing.caller_is_superadmin && !callerCtx.callerIsSuperadmin) {
        return { success: false, error: 'Only a superadmin can delete a superadmin-created cron task' }
      }

      cronTaskScheduler.stopTask(parsed.task_id)
      await deleteCronTask(parsed.task_id)

      return { success: true }
    },
  }
}
