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

export function buildCronCreateTool(
  projectId: string,
  agentId: string,
  callerCtx: CallerSnapshotContext,
): ToolDefinition {
  return {
    meta: {
      id: 'cron_create',
      name: 'Create Cron Task',
      description: 'Create a new scheduled cron task for this agent',
      group: 'cron',
    },
    permission: '*',
    modes: ['chat', 'task'],
    input: z.object({
      name: z.string().max(255).describe('Human-readable name for the cron task'),
      description: z.string().optional().describe('Optional description'),
      cron_expression: z.string().max(100).describe('5-field cron expression, e.g. "0 * * * *" for every hour'),
      prompt: z.string().describe('The prompt to send to the agent when triggered'),
      enabled: z.boolean().default(true).describe('Whether the task is enabled immediately'),
    }),
    execute: async (input: unknown) => {
      const parsed = input as {
        name: string
        description?: string
        cron_expression: string
        prompt: string
        enabled: boolean
      }

      const task = await createCronTask({
        project_id: projectId,
        agent_id: agentId,
        name: parsed.name,
        description: parsed.description ?? null,
        cron_expression: parsed.cron_expression,
        prompt: parsed.prompt,
        enabled: parsed.enabled,
        caller_id: callerCtx.callerId,
        caller_role: callerCtx.callerRole,
        caller_is_superadmin: callerCtx.callerIsSuperadmin,
        metadata: {},
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
