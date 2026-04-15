/**
 * Plan 22 revision — compose [Cron Trigger] / [Cron Delivery] / [Cron Origin]
 * preludes from the structured `cron_tasks.context` column at fire time.
 *
 * Kept separate from the stored `prompt` so UI prompt edits cannot wipe delivery
 * context. `prompt` holds pure intent; the scheduler prepends the prelude before
 * invoking the task-mode runtime.
 */

export interface CronDeliverySpec {
  connector_id?: string
  target_name?: string
  chat_id?: string
  thread_id?: string
  scope_key?: string
  platform?: string
}

export interface CronOriginSpec {
  platform?: string
  originator_display_name?: string
  originator_user_id?: string
  connector_id?: string
  chat_id?: string
  scope_key?: string
}

export interface CronSubjectSpec {
  /** Jiku user_id of the person the task is ABOUT (may differ from originator). */
  user_id?: string
  display_name?: string
  /** Free-form identity hints, e.g. { telegram_user_id: '...' } */
  identity_hints?: Record<string, string>
}

export interface CronContext {
  origin?: CronOriginSpec
  delivery?: CronDeliverySpec
  subject?: CronSubjectSpec
  notes?: string
}

export function buildCronTriggerPreamble(): string {
  return [
    '[Cron Trigger]',
    'The scheduler is invoking you now — there is NO new user message in this run, and the user is NOT watching this task log.',
    '',
    'CRITICAL DELIVERY RULE:',
    'Any text you write as a normal response is logged in the internal task conversation ONLY — the user receives NOTHING from it. The user only sees output that you explicitly send via a delivery tool (see [Cron Delivery]).',
    'Producing the reminder text without calling a delivery tool = silent failure. The cron fired, the task ran, the user got nothing.',
    '',
    'REQUIRED OUTPUT FORMAT (every cron-triggered run with [Cron Delivery] present):',
    '  1. One short sentence stating what you will deliver and how, e.g. "Mengirim pengingat makan malam ke user via Telegram."',
    '  2. IMMEDIATELY in the same response, call the delivery tool from [Cron Delivery] with the actual content as the `text` param.',
    '  3. After the tool result, optionally one short sentence confirming success.',
    '  Do NOT split this across multiple responses — do step 1 and step 2 in the SAME response.',
    '',
    'OTHER RULES:',
    '- Do not ask the user clarifying questions — they are not in the loop right now.',
    '- If the Instruction describes conditional logic (e.g. "kalau X maka buat cron baru"): you MAY call cron_create / cron_update / cron_delete — dynamic scheduling is supported.',
    '- Never interpret the Instruction as a fresh request to set up a reminder unless it explicitly says so — the reminder already exists (it is this task).',
  ].join('\n')
}

function buildOriginBlock(origin?: CronOriginSpec): string {
  if (!origin) return ''
  const lines = ['', '[Cron Origin]']
  const parts: string[] = []
  if (origin.originator_display_name) parts.push(`requested by ${origin.originator_display_name}`)
  else if (origin.originator_user_id) parts.push(`originator user_id: ${origin.originator_user_id}`)
  if (origin.platform) parts.push(`via ${origin.platform}`)
  if (origin.scope_key) parts.push(`scope ${origin.scope_key}`)
  else if (origin.chat_id) parts.push(`chat_id ${origin.chat_id}`)
  if (parts.length === 0) return ''
  lines.push(`This task was created ${parts.join(', ')}.`)
  return lines.join('\n')
}

function buildSubjectBlock(subject?: CronSubjectSpec): string {
  if (!subject) return ''
  const lines = ['', '[Cron Subject]']
  if (subject.display_name) lines.push(`The task concerns: ${subject.display_name}${subject.user_id ? ` (user_id: ${subject.user_id})` : ''}.`)
  else if (subject.user_id) lines.push(`The task concerns user_id: ${subject.user_id}.`)
  if (subject.identity_hints && Object.keys(subject.identity_hints).length > 0) {
    lines.push(`Known identities: ${JSON.stringify(subject.identity_hints)}`)
    lines.push('Use identity_find / identity_get / connector_list_targets if you need a resolvable recipient beyond what is in [Cron Delivery].')
  }
  return lines.length > 1 ? lines.join('\n') : ''
}

function buildDeliveryBlock(delivery?: CronDeliverySpec): string {
  if (!delivery) return ''
  const platform = delivery.platform ?? 'the original channel'
  const lines: string[] = ['', '[Cron Delivery]']
  lines.push(`Originating channel: ${platform}. This task produces user-facing content — you MUST deliver it via one of the tools below.`)
  lines.push('Tool names below are LITERAL — they exist in your toolset with the exact names shown.')
  lines.push('Pick the FIRST option that has enough data:')
  if (delivery.target_name) {
    lines.push(`- connector_send_to_target({ target_name: "${delivery.target_name}"${delivery.connector_id ? `, connector_id: "${delivery.connector_id}"` : ''}, text: <message>, markdown: true })`)
  }
  if (delivery.scope_key && delivery.connector_id) {
    lines.push(`- connector_run_action({ connector_id: "${delivery.connector_id}", action_id: "send_to_scope", params: { scope_key: "${delivery.scope_key}", text: <message>, markdown: true } })`)
  }
  if (delivery.chat_id && delivery.connector_id) {
    const threadHint = delivery.thread_id ? `, thread_id: "${delivery.thread_id}"` : ''
    lines.push(`- connector_send({ connector_id: "${delivery.connector_id}", target_ref_keys: { chat_id: "${delivery.chat_id}"${threadHint} }, text: <message>, markdown: true })`)
  }
  lines.push('')
  lines.push('The tools above are in your toolset — use one of them to deliver the message. Do not reply that you cannot access the delivery system; prefer calling the tool over refusing.')
  lines.push('Skip this block ONLY if the Instruction explicitly says the task is silent / internal (file write, DB mutation, no notification expected).')
  return lines.join('\n')
}

/**
 * Compose the full runtime input the scheduler hands to `runTaskConversation`:
 * [Cron Trigger] preamble + [Cron Origin] + [Cron Subject] + stored prompt + [Cron Delivery].
 */
export function composeCronRunInput(storedPrompt: string, context: CronContext | null | undefined): string {
  const ctx = context ?? {}
  const parts = [
    buildCronTriggerPreamble(),
    buildOriginBlock(ctx.origin),
    buildSubjectBlock(ctx.subject),
    '',
    'Instruction:',
    storedPrompt,
    buildDeliveryBlock(ctx.delivery),
  ]
  return parts.filter(p => p !== '').join('\n')
}
