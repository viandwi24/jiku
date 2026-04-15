/**
 * Plan 25 Phase 5 — `task` and `task_resume` destination handlers.
 *
 *   task        → spawn a NEW task with the operator's response injected via
 *                 prompt_template substitution.
 *   task_resume → resume an existing task by injecting a synthetic user message
 *                 with the decision and re-invoking the task runner against the
 *                 same conversation_id. The agent picks up where it left off
 *                 with the operator's decision in its message history.
 *
 * Resume token: stored in `conversations.metadata.action_request_resume_tokens`
 * as an object map { [token]: ar_id }. Validated on resume to prevent replay.
 */
import { addMessage, getConversationById, getAgentById } from '@jiku-studio/db'
import { spawnTask, runTaskConversation } from '../task/runner.ts'
import { registerDestinationHandler } from './destinations.ts'
import type { ActionRequestResponse } from '@jiku/types'

function renderTemplate(template: string, response: ActionRequestResponse | null): string {
  const stringified = response == null ? '' : JSON.stringify(response)
  return template
    .replace(/\{\{\s*response\s*\}\}/g, stringified)
    .replace(/\{\{\s*response\.value\s*\}\}/g, () => {
      if (response && 'value' in response) return String((response as { value: unknown }).value ?? '')
      return ''
    })
    .replace(/\{\{\s*response\.label\s*\}\}/g, () => {
      if (response && 'label' in response) return String((response as { label: unknown }).label ?? '')
      return ''
    })
}

function formatDecision(status: string, response: ActionRequestResponse | null): string {
  return [
    `[Operator decision]`,
    `Status: ${status}`,
    response ? `Response: ${JSON.stringify(response, null, 2)}` : 'Response: (none)',
  ].join('\n')
}

export function registerTaskDestinationHandlers(): void {
  registerDestinationHandler('task', async ({ action_request: ar }) => {
    const ref = ar.destination_ref as
      | { kind: 'task'; agent_id: string; prompt_template: string; context?: Record<string, unknown>; parent_task_id?: string }
      | null
    if (!ref) throw new Error('task AR missing destination_ref')

    const targetAgent = await getAgentById(ref.agent_id)
    if (!targetAgent) throw new Error(`Target agent ${ref.agent_id} not found`)
    if (targetAgent.project_id !== ar.project_id) {
      throw new Error('Cross-project task spawn not allowed')
    }

    const goal = renderTemplate(ref.prompt_template, ar.response)
    const { promise } = await spawnTask({
      projectId: ar.project_id,
      agentId: ref.agent_id,
      goal,
      callerId: ar.response_by,
      parentConversationId: ref.parent_task_id ?? ar.task_id ?? null,
    })
    // Don't await — task runs in background.
    promise.catch((err) => {
      console.warn(`[action-requests] spawned task from AR ${ar.id} failed:`, err)
    })
  })

  registerDestinationHandler('task_resume', async ({ action_request: ar }) => {
    const ref = ar.destination_ref as
      | { kind: 'task_resume'; task_id: string; resume_token: string }
      | null
    if (!ref) throw new Error('task_resume AR missing destination_ref')

    const conv = await getConversationById(ref.task_id)
    if (!conv) throw new Error(`Task conversation ${ref.task_id} not found`)
    const meta = (conv.metadata ?? {}) as Record<string, unknown>
    const tokens = (meta['action_request_resume_tokens'] ?? {}) as Record<string, string>
    if (tokens[ref.resume_token] && tokens[ref.resume_token] !== ar.id) {
      throw new Error('Resume token mismatch — refusing to resume task')
    }
    if (!conv.agent_id) throw new Error(`Task ${ref.task_id} has no agent_id`)
    const convAgent = await getAgentById(conv.agent_id)
    if (!convAgent || convAgent.project_id !== ar.project_id) {
      throw new Error('Cross-project task resume not allowed')
    }

    // Inject the decision as a synthetic user message so the agent sees it on
    // its next read of message history.
    await addMessage({
      conversation_id: ref.task_id,
      role: 'user',
      parts: [{ type: 'text', text: formatDecision(ar.status, ar.response) }] as never,
    })

    // Continue the task. runTaskConversation accepts an existing conversation
    // id and re-runs the agent with the new message in history. Fire-and-forget.
    runTaskConversation(
      convAgent.project_id,
      ref.task_id,
      conv.agent_id,
      `Operator decision received for action request "${ar.title}". Continue from where you paused.`,
      ar.response_by,
    ).catch((err) => {
      console.warn(`[action-requests] resumed task ${ref.task_id} failed:`, err)
    })
  })
}
