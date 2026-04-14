import { createTaskConversation, updateConversation, getConversationById, getMessages, getAgentById } from '@jiku-studio/db'
import { runtimeManager } from '../runtime/manager.ts'
import { buildProgressTool } from './progress-tool.ts'
import { recordLLMUsage } from '../usage/tracker.ts'
import { dispatchSlashCommand } from '../commands/dispatcher.ts'
import { scanReferences } from '../references/hint.ts'
import type { CallerContext } from '@jiku/types'

/** Build a system CallerContext (no real user) for task/heartbeat runs */
export function buildSystemCaller(): CallerContext {
  return {
    user_id: 'system',
    roles: ['system'],
    permissions: ['*'],
    user_data: {},
    attributes: { channel: 'task' },
  }
}

/** Build a CallerContext from a nullable user ID */
export function buildCaller(callerId: string | null): CallerContext {
  if (!callerId) return buildSystemCaller()
  return {
    user_id: callerId,
    roles: [],
    permissions: [],
    user_data: {},
    attributes: { channel: 'task' },
  }
}

export interface RunTaskToolResult {
  tool_name: string
  args: unknown
  result: unknown
}

export interface RunTaskResult {
  status: 'completed' | 'failed'
  output?: string
  /** Plan 15.4: Structured tool results from the run */
  tool_results?: RunTaskToolResult[]
  /** Plan 15.4: Number of messages generated */
  message_count?: number
}

/**
 * Runs a task conversation end-to-end.
 * Updates run_status in DB and streams the agent run.
 */
export async function runTaskConversation(
  projectId: string,
  conversationId: string,
  agentId: string,
  goal: string,
  callerId: string | null,
  opts: { triggeredByCron?: boolean; allowCreateCron?: boolean } = {},
): Promise<RunTaskResult> {
  await updateConversation(conversationId, {
    run_status: 'running',
    started_at: new Date(),
  })

  try {
    const caller = buildCaller(callerId)

    // Plan 15.8: Inject progress tool for task mode
    const progressTool = buildProgressTool(conversationId)

    // Plan 24 — dispatcher: allow cron/heartbeat/task prompts to invoke `/slug`.
    const surface: 'cron' | 'heartbeat' | 'task' = opts.triggeredByCron ? 'cron' : 'task'
    const cmd = await dispatchSlashCommand({
      projectId, agentId, input: goal, surface, userId: callerId,
    }).catch(() => ({ matched: false, resolvedInput: undefined } as const))
    // Command + @file injection: same model as chat route. User goal stays
    // literal; resolved command body + file-mention hint go into per-turn
    // system segments. See chat.ts for rationale.
    const resolvedForScan = (cmd.matched && cmd.resolvedInput) ? cmd.resolvedInput : goal
    const commandSegment = (cmd.matched && cmd.resolvedInput)
      ? [{ label: `Command Invoked: /${cmd.slug ?? ''} (this turn only)`, content: cmd.resolvedInput }]
      : undefined
    const refScan = await scanReferences({
      projectId, text: resolvedForScan, userId: callerId, surface,
    }).catch(() => ({ hintBlock: null } as const))
    const refSegments = refScan.hintBlock
      ? [{ label: 'File mentions (this turn only)', content: refScan.hintBlock }]
      : undefined
    const extraSegments = [...(commandSegment ?? []), ...(refSegments ?? [])]

    const result = await runtimeManager.run(projectId, {
      agent_id: agentId,
      caller,
      mode: 'task',
      input: goal,
      conversation_id: conversationId,
      extra_built_in_tools: [progressTool],
      extra_system_segments: extraSegments.length > 0 ? extraSegments : undefined,
      // suppress_tool_ids is kept as an opt-in escape hatch but NOT applied for cron triggers:
      // a cron-fired agent is allowed to create/update/delete cron tasks (dynamic / conditional scheduling).
      // The infinite-loop risk is handled by the [Cron Trigger] preamble in the stored prompt instead.
      suppress_tool_ids: undefined,
    })

    // Drain the stream fully
    const reader = result.stream.getReader()
    let outputText = ''
    let usageInput = 0
    let usageOutput = 0
    let providerId: string | null = null
    let modelId: string | null = null
    let runSnapshot: { system_prompt: string; messages: unknown[]; response?: string; tools?: string[]; adapter?: string } | null = null

    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      if (value && 'type' in value) {
        const v = value as { type: string; delta?: string; data?: unknown }
        if (v.type === 'text-delta') {
          outputText += v.delta ?? ''
        } else if (v.type === 'data-jiku-run-snapshot') {
          runSnapshot = v.data as { system_prompt: string; messages: unknown[]; response?: string; tools?: string[]; adapter?: string }
        } else if (v.type === 'data-jiku-usage') {
          const d = v.data as { input_tokens?: number; output_tokens?: number } | undefined
          if (d) {
            usageInput = d.input_tokens ?? 0
            usageOutput = d.output_tokens ?? 0
          }
        } else if (v.type === 'data-jiku-meta') {
          const d = v.data as { provider_id?: string; model_id?: string } | undefined
          providerId = d?.provider_id ?? providerId
          modelId = d?.model_id ?? modelId
        }
      }
    }

    if (usageInput > 0 || usageOutput > 0) {
      const agent = await getAgentById(agentId).catch(() => null)
      recordLLMUsage({
        source: 'task',
        mode: 'task',
        project_id: agent?.project_id ?? projectId,
        agent_id: agentId,
        conversation_id: conversationId,
        provider: providerId,
        model: modelId,
        input_tokens: usageInput,
        output_tokens: usageOutput,
        raw_system_prompt: runSnapshot?.system_prompt ?? null,
        raw_messages: runSnapshot?.messages ?? null,
        raw_response: runSnapshot?.response ?? (outputText || null),
        active_tools: runSnapshot?.tools ?? null,
        agent_adapter: runSnapshot?.adapter ?? null,
      })
    }

    // Check metadata for output set by task_complete tool
    const conv = await getConversationById(conversationId)
    const meta = (conv?.metadata ?? {}) as Record<string, unknown>
    const finalOutput = (meta.output as string | undefined) ?? (outputText || undefined)

    // Plan 15.4: Extract tool results from messages
    const messages = await getMessages(conversationId)
    const toolResults: RunTaskToolResult[] = []
    for (const msg of messages) {
      if (msg.role !== 'assistant') continue
      const parts = (msg.parts ?? []) as Array<Record<string, unknown>>
      for (const part of parts) {
        if (part.type === 'tool-invocation' && part.state === 'result') {
          toolResults.push({
            tool_name: part.toolName as string,
            args: part.args,
            result: part.result,
          })
        }
      }
    }

    await updateConversation(conversationId, {
      run_status: 'completed',
      finished_at: new Date(),
    })

    return {
      status: 'completed',
      output: finalOutput,
      tool_results: toolResults.length > 0 ? toolResults : undefined,
      message_count: messages.length,
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err)
    await updateConversation(conversationId, {
      run_status: 'failed',
      finished_at: new Date(),
      error_message: msg,
    })
    throw err
  }
}

export interface SpawnTaskOptions {
  projectId: string
  agentId: string
  goal: string
  callerId: string | null
  parentConversationId: string | null
  toolCallId?: string
}

/** Create a task conversation record and start the runner (async, non-blocking) */
export async function spawnTask(opts: SpawnTaskOptions): Promise<{
  conversationId: string
  promise: Promise<RunTaskResult>
}> {
  const conv = await createTaskConversation({
    agent_id: opts.agentId,
    project_id: opts.projectId,
    type: 'task',
    caller_id: opts.callerId,
    parent_conversation_id: opts.parentConversationId,
    metadata: {
      goal: opts.goal,
      spawned_by_tool_call_id: opts.toolCallId,
    },
  })

  const promise = runTaskConversation(
    opts.projectId,
    conv.id,
    opts.agentId,
    opts.goal,
    opts.callerId,
  )

  return { conversationId: conv.id, promise }
}
