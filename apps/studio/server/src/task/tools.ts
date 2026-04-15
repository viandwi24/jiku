import { z } from 'zod'
import { zodSchema, tool } from 'ai'
import { getConversationById, updateConversation, getAgentsByProjectId, getAgentById, listProjectMembers, getMessages, listConversationsByAgent } from '@jiku-studio/db'
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
 * Build the list_project_members built-in tool — lets an agent see who is in the project.
 */
export function buildListProjectMembersTool(projectId: string): ToolDefinition {
  return {
    meta: {
      id: 'list_project_members',
      name: 'List Project Members',
      description: 'List all members of this project with their id, name, email, and role',
      group: 'task',
    },
    permission: '*',
    modes: ['chat', 'task'],
    input: z.object({}),
    execute: async () => {
      const members = await listProjectMembers(projectId)
      return {
        members: members.map(m => ({
          id: m.user.id,
          name: m.user.name,
          email: m.user.email,
          role: m.role?.name ?? null,
          is_superadmin: m.is_superadmin,
        })),
      }
    },
  }
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
    input: z.object({
      mode: z.enum(['chat', 'task']).optional().describe('Filter by supported mode'),
      search: z.string().optional().describe('Search in name/description'),
    }),
    execute: async (input: unknown) => {
      const { mode, search } = (input ?? {}) as { mode?: string; search?: string }
      let agents = await getAgentsByProjectId(projectId)

      if (mode) {
        agents = agents.filter(a => (a.allowed_modes as string[]).includes(mode))
      }
      if (search) {
        const q = search.toLowerCase()
        agents = agents.filter(a =>
          a.name.toLowerCase().includes(q) ||
          (a.description ?? '').toLowerCase().includes(q)
        )
      }

      return {
        agents: agents.map(a => ({
          id: a.id,
          name: a.name,
          slug: a.slug,
          description: a.description ?? null,
          modes: a.allowed_modes,
        })),
      }
    },
  }
}

/**
 * Plan 15.4: Build the agent_read_history tool — read conversation history of another agent.
 */
export function buildAgentReadHistoryTool(projectId: string): ToolDefinition {
  return {
    meta: {
      id: 'agent_read_history',
      name: 'Read Agent History',
      description: 'Read recent conversation history of another agent. Useful for reviewing what another agent has done.',
      group: 'task',
    },
    permission: '*',
    modes: ['chat', 'task'],
    input: z.object({
      agent_id: z.string().describe('Agent ID whose history to read'),
      conversation_id: z.string().optional().describe('Specific conversation. If omitted, reads latest.'),
      limit: z.number().int().min(1).max(20).default(5).describe('Number of recent messages to return'),
    }),
    execute: async (input: unknown) => {
      const { agent_id, conversation_id, limit } = input as { agent_id: string; conversation_id?: string; limit: number }

      let convId = conversation_id
      if (!convId) {
        // Get latest conversation for this agent
        const conversations = await listConversationsByAgent(agent_id)
        if (conversations.length === 0) {
          return { messages: [], note: 'No conversations found for this agent.' }
        }
        convId = conversations[0]!.id
      }

      const messages = await getMessages(convId)
      const recent = messages.slice(-limit)

      // Return text parts only (strip tool internals for security)
      return {
        conversation_id: convId,
        messages: recent.map(m => {
          const parts = (m.parts ?? []) as Array<Record<string, unknown>>
          const textParts = parts
            .filter(p => p.type === 'text')
            .map(p => p.text as string)
          return {
            role: m.role,
            text: textParts.join('\n') || null,
            created_at: m.created_at,
          }
        }),
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
      goal: z.string().describe(
        'The prompt/task for the child agent. Write it DETAILED and SELF-CONTAINED — the ' +
        'child agent starts fresh with NO access to your current conversation, system prompt, ' +
        'or active command context. Include every concrete detail the child needs: environment ' +
        '(test/production), target channel/connector name, required file paths, step-by-step flow, ' +
        'constraints ("do NOT forward", "must preserve entities"), and success criteria. ' +
        'If you are forwarding a slash-command invocation, paste the FULL SOP text (not a summary) ' +
        'into this goal — summarizing loses instructions and makes the child skip steps.',
      ),
      agent_id: z.string().min(1).describe('REQUIRED. UUID of the agent to run the task. Must be a valid agent id from `list_agents`. Pass your OWN agent id if you want to run the task as yourself — empty string and missing value are rejected (no silent fallback).'),
      detach: z.boolean().default(true).describe('true=background (returns task_id immediately), false=wait with timeout'),
      timeout_ms: z.number().default(30000).describe('Max wait ms when detach=false. Max 60s.'),
    }),
    execute: async (input: unknown, ctx) => {
      const parsed = input as { goal: string; agent_id: string; detach: boolean; timeout_ms: number }
      const timeoutMs = Math.min(parsed.timeout_ms ?? 30000, TASK_TIMEOUT_MAX_MS)

      // agent_id is REQUIRED. Explicit validation + explicit existence check —
      // no silent fallback to the current agent. Model must call `list_agents`
      // and pick a real id (or pass its own id to run as itself).
      const targetAgentId = (parsed.agent_id ?? '').trim()
      if (!targetAgentId) {
        return {
          status: 'error',
          code: 'AGENT_ID_REQUIRED',
          message: '`agent_id` is required and must be a non-empty UUID.',
          hint: 'Call `list_agents` to see available agent ids, then retry with `agent_id` set. If you want the current agent to run the task, pass your own agent id explicitly.',
        }
      }

      {
        const { getAgentById } = await import('@jiku-studio/db')
        const exists = await getAgentById(targetAgentId).catch(() => null)
        if (!exists) {
          return {
            status: 'error',
            code: 'AGENT_NOT_FOUND',
            message: `Agent with id "${targetAgentId}" not found in this project.`,
            hint: 'Call `list_agents` to see available agent ids in this project, then retry with a valid `agent_id`.',
          }
        }
      }

      // Check delegation permission when targeting a different agent
      if (targetAgentId !== agentId) {
        const permError = await checkTaskDelegationPermission(agentId, targetAgentId)
        if (permError) {
          return { status: 'error', code: 'DELEGATION_FORBIDDEN', message: permError, hint: 'Check the target agent\'s task_allowed_agents config — your current agent may not be on the allow-list.' }
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
        tool_results: result.tool_results,
        message_count: result.message_count,
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
