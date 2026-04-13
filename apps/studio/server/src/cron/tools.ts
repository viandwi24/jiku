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
import type { CronContext } from './context.ts'

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
      side_effectful: true,
      description:
        'Create a scheduled cron task for this agent. SAFETY CRITICAL — a bad prompt here will run on a schedule forever, potentially causing infinite loops, spam, or silent failures. ' +
        'Before calling this tool you MUST confirm all of the following:\n' +
        '1. The `prompt` is a self-contained command to future-you (the cron-triggered run). It must NOT be a copy of the user\'s chat message — reword it into a direct instruction.\n' +
        '2. The `prompt` includes every piece of context future-you will need (who the user is, what their timezone/locale is if relevant, what exact content to produce, any thresholds or ids). Future-you will NOT see the current chat history.\n' +
        '3. If the user expects a reply on a channel (Telegram/Discord/etc.), `delivery` is filled with the current Connector Context (connector_id + chat_id/scope_key). Without it the user never receives the output.\n' +
        '4. The schedule, name, and description match what the user actually asked for. When in doubt, ASK the user before calling — do not guess.\n' +
        'If you cannot satisfy all four, ask the user for clarification instead of calling this tool.',
      group: 'cron',
    },
    permission: '*',
    modes: ['chat', 'task'],
    input: z.object({
      name: z.string().max(255).describe('Human-readable name for the cron task. Short, unique, descriptive — e.g. "Reminder jam pulang (Budi)", "Daily sales digest — #sales topic".'),
      description: z.string().optional().describe('Optional description — summarize who asked for it, why, and the expected output. Useful for audit.'),
      cron_expression: z.string().max(100).describe(
        '5-field cron expression evaluated in UTC. Convert from the user\'s local time BEFORE passing. ' +
        'Default timezone is in [Project Context] above — use it as fallback when the user doesn\'t specify a zone. ' +
        'Examples: "0 10 * * *" = 10:00 UTC daily; "0 10 * * 1-5" = weekdays 10:00 UTC. ' +
        'If project default is Asia/Jakarta (UTC+7) and user says "jam 17", that\'s 17 WIB → cron_expression "0 10 * * *".',
      ),
      prompt: z.string().describe(
        'THE INSTRUCTION FUTURE-YOU WILL RECEIVE when the cron fires. Treated as a command, not a conversation.\n' +
        'Hard rules:\n' +
        '- Must be SELF-CONTAINED. Future-you has no access to the current chat history, no user in the loop to ask, no memory of today\'s context unless you wrote it here.\n' +
        '- Must be ACTIONABLE and UNAMBIGUOUS. Start with a verb: "Kirim...", "Buat...", "Hitung...", "Cek apakah...".\n' +
        '- Must include everyone/everything referenced by name or id (user_id, chat_id already go in `delivery`; but e.g. agent identity, product names, thresholds — write them here).\n' +
        '- MUST NOT be a copy of the user\'s request verbatim. Rewrite from their perspective ("ingatkan saya") to future-you\'s perspective ("kirim pengingat ke user bahwa ...").\n' +
        '- MUST NOT include delivery channel instructions — those go in the `delivery` field.\n' +
        'Examples:\n' +
        '- User: "Ingatkan saya jam pulang tiap hari kerja jam 17 WIB"\n' +
        '  BAD prompt: "Ingatkan saya jam pulang"\n' +
        '  GOOD prompt: "Kirim pesan pengingat singkat dan ramah bahwa sekarang sudah jam 17:00 WIB — waktunya pulang. Ajak user untuk melakukan tes jam pulang jika itu yang biasanya dia lakukan. Gunakan bahasa santai sesuai gaya chat user sebelumnya."\n' +
        '- User: "Kalau stok di bawah 10 besok jam 9, buat reminder restock"\n' +
        '  GOOD prompt: "Cek stok produk A di filesystem /stock/current.json. Jika kurang dari 10, panggil cron_create untuk membuat reminder restock esok hari jam 09:00 WIB (cron_expression \\"0 2 * * *\\"). Jika cukup, tidak perlu tindakan."',
      ),
      delivery: z.object({
        connector_id: z.string().optional().describe('Connector UUID from Connector Context'),
        target_name: z.string().optional().describe('Name of an existing Channel Target to send to (preferred if one exists)'),
        chat_id: z.string().optional().describe('Raw chat_id (from current Chat ref) — fallback when no named target'),
        thread_id: z.string().optional().describe('Forum topic thread_id if applicable'),
        scope_key: z.string().optional().describe('scope_key from Connector Context — enables send_to_scope'),
        platform: z.string().optional().describe('Human label, e.g. "Telegram", "Discord"'),
      }).optional().describe(
        'OPTIONAL delivery hint. Fill when the task produces user-facing output (notifications, reminders, digests). ' +
        'Omit for purely internal tasks (file writes, internal triggers, conditional cron creators). ' +
        'Default rule: if you created this task in response to a user asking for a reminder/notification on a channel, copy the channel\'s connector_id + chat_id/scope_key here.',
      ),
      origin: z.object({
        platform: z.string().optional().describe('Where the request came from, e.g. "Telegram"'),
        originator_display_name: z.string().optional(),
        originator_user_id: z.string().optional().describe('Jiku user_id of the person who asked'),
        connector_id: z.string().optional(),
        chat_id: z.string().optional(),
        scope_key: z.string().optional(),
      }).optional().describe('Optional — who/where this task was requested from. Helps future-you orient.'),
      subject: z.object({
        user_id: z.string().optional().describe('Jiku user_id of the person the task is ABOUT (may differ from originator, e.g. "ingatkan user B")'),
        display_name: z.string().optional(),
        identity_hints: z.record(z.string(), z.string()).optional().describe('Known identity keys/values, e.g. { telegram_user_id: "..." }'),
      }).optional().describe('Optional — who the task is ABOUT. Distinct from originator: originator = who asked; subject = who is affected.'),
      enabled: z.boolean().default(true).describe('Whether the task is enabled immediately'),
    }),
    execute: async (input: unknown) => {
      const parsed = input as {
        name: string
        description?: string
        cron_expression: string
        prompt: string
        enabled: boolean
        delivery?: CronContext['delivery']
        origin?: CronContext['origin']
        subject?: CronContext['subject']
      }

      // Safety rails — cheap heuristics that catch the most common "bad prompt" failure modes.
      const trimmed = parsed.prompt.trim()
      if (trimmed.length < 30) {
        return {
          success: false,
          error: 'prompt too short to be self-contained. Expand into a full actionable instruction for future-you — include who, what, and any required context. See the `prompt` field description for examples.',
        }
      }
      const firstPerson = /^(ingatkan saya|reminder me|remind me|tolong ingatkan|catat untuk saya)\b/i
      if (firstPerson.test(trimmed)) {
        return {
          success: false,
          error: 'prompt is written from the user\'s perspective ("ingatkan saya..."). Rewrite from future-you\'s perspective as a command — e.g. "Kirim pengingat ke user bahwa ...". See the `prompt` field description.',
        }
      }

      const context: CronContext = {}
      if (parsed.origin) context.origin = parsed.origin
      if (parsed.delivery) context.delivery = parsed.delivery
      if (parsed.subject) context.subject = parsed.subject

      const task = await createCronTask({
        project_id: projectId,
        agent_id: agentId,
        name: parsed.name,
        description: parsed.description ?? null,
        cron_expression: parsed.cron_expression,
        // Stored prompt is now pure intent — [Cron Trigger] / [Cron Delivery] / [Cron Origin]
        // are composed by the scheduler from `context` at fire time. This means editing
        // `prompt` via UI never wipes delivery info.
        prompt: parsed.prompt,
        context: context as unknown as Record<string, unknown>,
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
      side_effectful: true,
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
      prompt: z.string().optional().describe('Pure intent string — do NOT include [Cron Trigger] / [Cron Delivery] blocks; those are composed from `context` at fire time.'),
      context: z.object({
        origin: z.record(z.string(), z.unknown()).optional(),
        delivery: z.record(z.string(), z.unknown()).optional(),
        subject: z.record(z.string(), z.unknown()).optional(),
        notes: z.string().optional(),
      }).optional().describe('Partial context patch. Only the keys you pass are replaced; unspecified keys are preserved.'),
      enabled: z.boolean().optional(),
    }),
    execute: async (input: unknown) => {
      const parsed = input as {
        task_id: string
        name?: string
        description?: string
        cron_expression?: string
        prompt?: string
        context?: Partial<CronContext>
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
      if (parsed.context !== undefined) {
        // Shallow merge: unspecified top-level keys preserved.
        const current = (existing.context ?? {}) as Record<string, unknown>
        updates.context = { ...current, ...parsed.context } as typeof existing.context
      }
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
      side_effectful: true,
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
