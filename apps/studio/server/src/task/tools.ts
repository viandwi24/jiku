import { z } from 'zod'
import { zodSchema, tool } from 'ai'
import { getConversationById, updateConversation, getAgentsByProjectId, getAgentById } from '@jiku-studio/db'
import { spawnTask } from './runner.ts'
import type { ToolDefinition, CallerContext } from '@jiku/types'

const TASK_TIMEOUT_MAX_MS = 60_000

/**
 * Check if the source agent is allowed to delegate tasks to the target agent.
 * Returns an error string if not allowed, or null if allowed.
 */
async function checkTaskDelegationPermission(
  sourceAgentId: string,
  targetAgentId: string,
): Promise<string | null> {
  const sourceAgent = await getAgentById(sourceAgentId)
  if (!sourceAgent) return `Source agent ${sourceAgentId} not found`

  const allowed = sourceAgent.task_allowed_agents
  // null = no restriction (allow all)
  if (allowed === null || allowed === undefined) return null
  // empty array = delegation fully disabled
  if (allowed.length === 0) return `Agent is not permitted to delegate tasks to any other agent`
  // specific list — check membership
  if (!allowed.includes(targetAgentId)) {
    return `Agent is not permitted to delegate tasks to agent ${targetAgentId}`
  }
  return null
}

/**
 * Build the list_agents built-in tool — lets an agent discover other agents in the project.
 */
export function buildListAgentsTool(projectId: string): ToolDefinition {
  return {
    meta: {
      id: 'list_agents',
      name: 'List Agents',
      description: 'List all agents available in this project for task delegation',
      group: 'task',
    },
    permission: '*',
    modes: ['chat', 'task'],
    input: z.object({}),
    execute: async () => {
      const agents = await getAgentsByProjectId(projectId)
      return {
        agents: agents.map(a => ({
          id: a.id,
          name: a.name,
          slug: a.slug,
          description: a.description ?? null,
        })),
      }
    },
  }
}

/**
 * Build the run_task built-in tool for a given agent+project context.
 * This tool is always active in chat, task, and heartbeat modes.
 */
export function buildRunTaskTool(
  projectId: string,
  agentId: string,
  getCallerContext: () => CallerContext,
  getConversationId: () => string | undefined,
): ToolDefinition {
  return {
    meta: {
      id: 'run_task',
      name: 'Run Task',
      description: 'Spawn a new autonomous task conversation, optionally delegating to a different agent',
      group: 'task',
    },
    permission: '*',
    modes: ['chat', 'task'],
    input: z.object({
      goal: z.string().describe('The prompt/goal for the task agent to accomplish'),
      agent_id: z.string().optional().describe('ID of the agent to run the task. Defaults to current agent. Use list_agents to discover available agents.'),
      detach: z.boolean().default(true).describe('true=background (returns task_id immediately), false=wait with timeout'),
      timeout_ms: z.number().default(30000).describe('Max wait ms when detach=false. Max 60s.'),
    }),
    execute: async (input: unknown, ctx) => {
      const parsed = input as { goal: string; agent_id?: string; detach: boolean; timeout_ms: number }
      const timeoutMs = Math.min(parsed.timeout_ms ?? 30000, TASK_TIMEOUT_MAX_MS)
      const targetAgentId = parsed.agent_id ?? agentId

      // Check delegation permission when targeting a different agent
      if (targetAgentId !== agentId) {
        const permError = await checkTaskDelegationPermission(agentId, targetAgentId)
        if (permError) {
          return { status: 'error', message: permError }
        }
      }

      const caller = getCallerContext()
      const callerId = caller.user_id === 'system' ? null : caller.user_id
      const parentConvId = getConversationId() ?? null

      const { conversationId, promise } = await spawnTask({
        projectId,
        agentId: targetAgentId,
        goal: parsed.goal,
        callerId,
        parentConversationId: parentConvId,
        toolCallId: (ctx as unknown as Record<string, unknown>)['toolCallId'] as string | undefined,
      })

      if (parsed.detach) {
        promise.catch((err: unknown) => {
          console.error(`[run_task] Task ${conversationId} failed:`, err)
        })
        return { status: 'spawned', task_id: conversationId, message: 'Task spawned in background.' }
      }

      // Attach mode — wait with timeout
      const timeoutPromise = new Promise<{ timed_out: true }>(resolve =>
        setTimeout(() => resolve({ timed_out: true }), timeoutMs)
      )

      const result = await Promise.race([promise, timeoutPromise])

      if ('timed_out' in result) {
        return {
          status: 'running',
          task_id: conversationId,
          message: `Task still running after ${timeoutMs / 1000}s. Check via task_id.`,
        }
      }

      return {
        status: result.status,
        task_id: conversationId,
        output: result.output,
      }
    },
  }
}

/**
 * Build task_complete + task_fail tools for task/heartbeat conversations.
 * These are injected only when the conversation type is 'task' or 'heartbeat'.
 */
export function buildTaskLifecycleTools(conversationId: string): ToolDefinition[] {
  const taskComplete: ToolDefinition = {
    meta: {
      id: 'task_complete',
      name: 'Task Complete',
      description: 'Mark this task as completed with output',
      group: 'task',
    },
    permission: '*',
    modes: ['task'],
    input: z.object({
      output: z.string().describe('Final output or result of the task'),
    }),
    execute: async (input: unknown) => {
      const parsed = input as { output: string }
      const conv = await getConversationById(conversationId)
      const existingMeta = (conv?.metadata ?? {}) as Record<string, unknown>
      await updateConversation(conversationId, {
        run_status: 'completed',
        finished_at: new Date(),
        metadata: { ...existingMeta, output: parsed.output },
      })
      return { success: true }
    },
  }

  const taskFail: ToolDefinition = {
    meta: {
      id: 'task_fail',
      name: 'Task Fail',
      description: 'Mark this task as failed with reason',
      group: 'task',
    },
    permission: '*',
    modes: ['task'],
    input: z.object({
      reason: z.string().describe('Reason why the task failed'),
    }),
    execute: async (input: unknown) => {
      const parsed = input as { reason: string }
      await updateConversation(conversationId, {
        run_status: 'failed',
        finished_at: new Date(),
        error_message: parsed.reason,
      })
      return { success: true }
    },
  }

  return [taskComplete, taskFail]
}
