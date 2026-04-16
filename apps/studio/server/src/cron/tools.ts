import { z } from 'zod'
import {
  getCronTaskById,
  getCronTasksByAgent,
  createCronTask,
  updateCronTask,
  deleteCronTask,
  archiveCronTask,
  restoreCronTask,
  type CronTaskStatus,
} from '@jiku-studio/db'
import type { ToolContext, ToolDefinition } from '@jiku/types'
import { cronTaskScheduler } from './scheduler.ts'
import type { CronContext } from './context.ts'

/**
 * Loose heuristic — does the prompt imply the cron should produce user-facing
 * output when it fires? Used to decide whether to auto-populate `delivery`
 * from the active Connector Context. False positives are OK (user can still
 * omit a channel explicitly by leaving the connector context out of their
 * chat run); false negatives waste the auto-population.
 */
function promptImpliesUserFacingOutput(prompt: string): boolean {
  return /\b(kirim|kirimkan|ingatkan|ingatin|ingetin|beritahu|bilang|tanyakan|sampaikan|notify|notif|send|remind|tell|ping|alert|message|reply)\b/i.test(prompt)
}

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
      mode: z.enum(['recurring', 'once']).describe(
        'Execution mode. REQUIRED — no default; pick deliberately based on what the user asked for.\n' +
        '\n' +
        'USE "once" (fires exactly once at `run_at`, then auto-archives) when:\n' +
        '- User says a SPECIFIC single time: "jam 23.44", "besok jam 9", "nanti malam", "30 menit lagi", "15 Mei jam 10".\n' +
        '- User asks for a one-off reminder without frequency words ("harian", "tiap", "setiap", "daily").\n' +
        '- Indonesian hint: "ingetin saya jam X untuk Y" (tanpa "tiap hari" / "setiap") → ALMOST ALWAYS once.\n' +
        '\n' +
        'USE "recurring" (fires repeatedly on `cron_expression` until disabled) ONLY when:\n' +
        '- User EXPLICITLY says frequency: "tiap hari", "setiap senin", "daily", "every morning", "mingguan", "jam 9 pagi setiap hari".\n' +
        '- Periodic digests, reports, heartbeats, automations that repeat by design.\n' +
        '\n' +
        'WHEN AMBIGUOUS: default to "once". Do NOT silently upgrade a one-off request into a recurring schedule — that creates unwanted daily spam. If unsure, ask the user first.\n' +
        '\n' +
        'HARD RULE: your confirmation sentence to the user MUST match the mode you picked. Saying "sudah ku-set pengingat satu kali" but passing mode: "recurring" = lying to the user. Saying "sudah ku-set tiap hari" but passing mode: "once" = misleading.',
      ),
      cron_expression: z.string().max(100).optional().describe(
        'Required when `mode` is "recurring". 5-field cron expression evaluated in UTC. Convert from the user\'s local time BEFORE passing. ' +
        'Default timezone is in [Project Context] above — use it as fallback when the user doesn\'t specify a zone. ' +
        'Examples: "0 10 * * *" = 10:00 UTC daily; "0 10 * * 1-5" = weekdays 10:00 UTC. ' +
        'If project default is Asia/Jakarta (UTC+7) and user says "jam 17", that\'s 17 WIB → cron_expression "0 10 * * *". ' +
        'Omit for `mode: "once"`.',
      ),
      run_at: z.string().datetime().optional().describe(
        'Required when `mode` is "once". ISO 8601 UTC datetime when the task should fire (e.g. "2026-04-14T02:00:00.000Z"). ' +
        'Convert user\'s local time to UTC before passing. If user says "besok jam 9" and project timezone is Asia/Jakarta, ' +
        'that\'s 09:00 WIB tomorrow → "<tomorrow>T02:00:00.000Z". Past timestamps will fire immediately on startup.',
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
    execute: async (input: unknown, toolCtx: ToolContext) => {
      const parsed = input as {
        name: string
        description?: string
        mode: 'recurring' | 'once'
        cron_expression?: string
        run_at?: string
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

      // Mode-specific validation.
      let runAt: Date | null = null
      if (parsed.mode === 'recurring') {
        if (!parsed.cron_expression?.trim()) {
          return { success: false, error: 'cron_expression is required when mode is "recurring".' }
        }
      } else {
        if (!parsed.run_at) {
          return { success: false, error: 'run_at is required when mode is "once".' }
        }
        const d = new Date(parsed.run_at)
        if (Number.isNaN(d.getTime())) {
          return { success: false, error: 'run_at is not a valid ISO datetime.' }
        }
        runAt = d
      }

      const context: CronContext = {}
      if (parsed.origin) context.origin = parsed.origin
      if (parsed.delivery) context.delivery = parsed.delivery
      if (parsed.subject) context.subject = parsed.subject

      // Auto-populate delivery from the active Connector Context when the
      // agent didn't supply one. Event-router surfaces `connector_hint` on
      // `RuntimeContext` for every connector-initiated run (see
      // `event-router.ts::buildConnectorHint`). The heuristic: if the prompt
      // is user-facing (implies the cron should deliver something back) AND
      // delivery is missing/incomplete AND we have a connector hint → copy
      // connector_id + chat_id + thread_id + scope_key + platform into
      // `context.delivery`. This is the "reminder on this chat" path — user
      // chats in Telegram → agent creates cron → fire-time delivery lands
      // back in the same chat without the agent needing to remember to wire
      // the fields. Not applied if the prompt is clearly internal (file
      // write, cron_create chain, etc.) or if the agent already set a
      // delivery target.
      const runtime = (toolCtx as { runtime?: Record<string, unknown> } | undefined)?.runtime
      const connectorHint = runtime?.['connector_hint'] as Record<string, string> | undefined
      const hasUsableDeliveryField = !!(
        context.delivery?.target_name
        || context.delivery?.chat_id
        || context.delivery?.scope_key
      )
      if (!hasUsableDeliveryField && connectorHint && promptImpliesUserFacingOutput(parsed.prompt)) {
        const auto: NonNullable<CronContext['delivery']> = { ...(context.delivery ?? {}) }
        if (!auto.connector_id && connectorHint['connector_id']) auto.connector_id = connectorHint['connector_id']
        if (!auto.chat_id && connectorHint['chat_id']) auto.chat_id = connectorHint['chat_id']
        if (!auto.thread_id && connectorHint['thread_id']) auto.thread_id = connectorHint['thread_id']
        if (!auto.scope_key && connectorHint['scope_key']) auto.scope_key = connectorHint['scope_key']
        if (!auto.platform && connectorHint['platform']) auto.platform = connectorHint['platform']
        context.delivery = auto
      }

      const task = await createCronTask({
        project_id: projectId,
        agent_id: agentId,
        name: parsed.name,
        description: parsed.description ?? null,
        mode: parsed.mode,
        cron_expression: parsed.mode === 'recurring' ? (parsed.cron_expression ?? null) : null,
        run_at: runAt,
        prompt: parsed.prompt,
        context: context as unknown as Record<string, unknown>,
        enabled: parsed.enabled,
        status: 'active',
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
      description: 'List scheduled cron tasks for this agent. By default only active (non-archived) tasks are returned. Archived tasks (including one-shot tasks that already fired) are hidden unless `include_archived` is true.',
      group: 'cron',
    },
    permission: '*',
    modes: ['chat', 'task'],
    input: z.object({
      include_archived: z.boolean().default(false).describe('Set true to include archived tasks in the result (useful for reviewing history of one-shot reminders).'),
    }),
    execute: async (input: unknown) => {
      const parsed = (input ?? {}) as { include_archived?: boolean }
      const statuses: CronTaskStatus[] = parsed.include_archived ? ['active', 'archived'] : ['active']
      const tasks = await getCronTasksByAgent(agentId, { statuses })
      return {
        tasks: tasks.map(t => ({
          id: t.id,
          name: t.name,
          description: t.description,
          mode: t.mode,
          status: t.status,
          cron_expression: t.cron_expression,
          run_at: t.run_at?.toISOString() ?? null,
          enabled: t.enabled,
          run_count: t.run_count,
          last_run_at: t.last_run_at?.toISOString() ?? null,
          next_run_at: t.next_run_at?.toISOString() ?? null,
        })),
      }
    },
  }
}

export function buildCronArchiveTool(
  projectId: string,
  agentId: string,
  callerCtx: CallerSnapshotContext,
): ToolDefinition {
  return {
    meta: {
      id: 'cron_archive',
      name: 'Archive Cron Task',
      side_effectful: true,
      description: 'Archive a cron task. Archived tasks are hidden from the default list, stop firing, but remain in the DB so history and audit are preserved. Use this instead of delete when the task is done but the record should stay.',
      group: 'cron',
    },
    permission: '*',
    modes: ['chat', 'task'],
    input: z.object({
      task_id: z.string().describe('ID of the cron task to archive'),
    }),
    execute: async (input: unknown) => {
      const parsed = input as { task_id: string }
      const existing = await getCronTaskById(parsed.task_id)
      if (!existing) return { success: false, error: 'Cron task not found' }
      if (existing.agent_id !== agentId) return { success: false, error: 'Not authorized' }
      if (existing.caller_is_superadmin && !callerCtx.callerIsSuperadmin) {
        return { success: false, error: 'Only a superadmin can modify a superadmin-created cron task' }
      }
      cronTaskScheduler.stopTask(parsed.task_id)
      await archiveCronTask(parsed.task_id)
      return { success: true }
    },
  }
}

export function buildCronRestoreTool(
  projectId: string,
  agentId: string,
  callerCtx: CallerSnapshotContext,
): ToolDefinition {
  return {
    meta: {
      id: 'cron_restore',
      name: 'Restore Cron Task',
      side_effectful: true,
      description: 'Restore a previously archived cron task back to active. If the task is enabled and (for recurring) has a valid cron_expression, it will be rescheduled.',
      group: 'cron',
    },
    permission: '*',
    modes: ['chat', 'task'],
    input: z.object({
      task_id: z.string().describe('ID of the cron task to restore'),
    }),
    execute: async (input: unknown) => {
      const parsed = input as { task_id: string }
      const existing = await getCronTaskById(parsed.task_id)
      if (!existing) return { success: false, error: 'Cron task not found' }
      if (existing.agent_id !== agentId) return { success: false, error: 'Not authorized' }
      if (existing.caller_is_superadmin && !callerCtx.callerIsSuperadmin) {
        return { success: false, error: 'Only a superadmin can modify a superadmin-created cron task' }
      }
      const task = await restoreCronTask(parsed.task_id)
      if (task.enabled) {
        cronTaskScheduler.scheduleTask(task.id, projectId).catch(err =>
          console.warn('[cron:tools] Failed to schedule restored task:', err)
        )
      }
      return { success: true, task_id: task.id }
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
