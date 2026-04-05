import { createTaskConversation, updateConversation, getConversationById } from '@jiku-studio/db'
import { runtimeManager } from '../runtime/manager.ts'
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

export interface RunTaskResult {
  status: 'completed' | 'failed'
  output?: string
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
): Promise<RunTaskResult> {
  await updateConversation(conversationId, {
    run_status: 'running',
    started_at: new Date(),
  })

  try {
    const caller = buildCaller(callerId)

    const result = await runtimeManager.run(projectId, {
      agent_id: agentId,
      caller,
      mode: 'task',
      input: goal,
      conversation_id: conversationId,
    })

    // Drain the stream fully
    const reader = result.stream.getReader()
    let outputText = ''

    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      if (value && 'type' in value && value.type === 'text-delta') {
        outputText += (value as { delta?: string }).delta ?? ''
      }
    }

    // Check metadata for output set by task_complete tool
    const conv = await getConversationById(conversationId)
    const meta = (conv?.metadata ?? {}) as Record<string, unknown>
    const finalOutput = (meta.output as string | undefined) ?? (outputText || undefined)

    await updateConversation(conversationId, {
      run_status: 'completed',
      finished_at: new Date(),
    })

    return { status: 'completed', output: finalOutput }
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
