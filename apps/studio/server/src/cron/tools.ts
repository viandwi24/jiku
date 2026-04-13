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
  platform?: string
}): string {
  if (!delivery) return ''
  const platform = delivery.platform ?? 'the original channel'
  const lines: string[] = ['', '[Cron Delivery]']
  lines.push(`This reminder was requested from ${platform}, so the user expects the response on ${platform} — not as plain text in this task run.`)
  lines.push('After producing the content, you MUST deliver it using ONE of the tools below (pick the first one that has enough data):')
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
  lines.push('Only skip delivery if the instruction explicitly says "no notification" — otherwise text in the task log never reaches the user.')
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
        'Examples: "0 10 * * *" = 10:00 UTC daily; "0 10 * * 1-5" = weekdays 10:00 UTC. ' +
        'If the user said a local time (e.g. "jam 17 WIB"), convert: WIB=UTC+7 so 17:00 WIB → "0 10 * * *".',
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
        platform: z.string().optional().describe('Human label, e.g. "Telegram", "Discord" — used in the delivery instructions for your future self'),
      }).optional().describe(
        'Where to send the output when the task fires. ' +
        'DEFAULT RULE: if the user made this request from a channel (Telegram, Discord, etc.) and did not say "don\'t notify me" or specify another channel, ' +
        'ALWAYS fill this with the current channel\'s connector_id + chat_id/scope_key. ' +
        'Only omit when user explicitly says the task is silent / runs in background without reply.',
      ),
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

      // Safety rails — cheap heuristics that catch the most common "bad prompt" failure modes.
      // These are intentionally lenient (agent can retry) not exhaustive.
      const trimmed = parsed.prompt.trim()
      if (trimmed.length < 30) {
        return {
          success: false,
          error: 'prompt too short to be self-contained. Expand into a full actionable instruction for future-you — include who, what, and any required context. See the `prompt` field description for examples.',
        }
      }
      // Catch the classic "echoing the user" failure.
      const firstPerson = /^(ingatkan saya|reminder me|remind me|tolong ingatkan|catat untuk saya)\b/i
      if (firstPerson.test(trimmed)) {
        return {
          success: false,
          error: 'prompt is written from the user\'s perspective ("ingatkan saya..."). Rewrite from future-you\'s perspective as a command — e.g. "Kirim pengingat ke user bahwa ...". See the `prompt` field description.',
        }
      }

      const preamble =
        '[Cron Trigger]\n' +
        'The scheduler is invoking you now — there is NO new user message in this run. ' +
        'Treat the Instruction block below as a command FROM YOURSELF (the past-you that created this task) TO YOURSELF (present-you that must act).\n' +
        '- If the Instruction describes content to deliver (e.g. a reminder, summary, digest): produce that content and send it via [Cron Delivery] — do NOT ask the user clarifying questions, the user is not in the loop right now.\n' +
        '- If the Instruction describes a conditional (e.g. "kalau X maka buat cron baru"): you MAY call cron_create/update/delete as needed — this is supported.\n' +
        '- Never interpret the Instruction as a fresh request to set up a reminder unless it explicitly says so — the reminder already exists (it is this task).\n\n' +
        'Instruction:\n'
      const fullPrompt = preamble + parsed.prompt + buildCronDeliveryBlock(parsed.delivery)

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
