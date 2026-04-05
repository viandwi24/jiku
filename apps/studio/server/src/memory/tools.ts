import { defineTool } from '@jiku/kit'
import { z } from 'zod'
import type { ResolvedMemoryConfig } from '@jiku/types'
import { findRelevantMemories } from '@jiku/core'
import type { StudioStorageAdapter } from '../runtime/storage.ts'

/**
 * Build memory tools as built-in ToolDefinitions scoped to a specific StudioStorageAdapter.
 * These tools are NOT plugins — they are registered directly on the agent at wakeUp time.
 *
 * Because ToolContext.storage is plugin-scoped KV, we need to close over the adapter.
 */
export function buildMemoryTools(
  config: ResolvedMemoryConfig,
  storage: StudioStorageAdapter,
  runtimeId: string,
) {
  const tools: ReturnType<typeof defineTool>[] = [

    // ── Always-available tools ─────────────────────────────────────

    defineTool({
      meta: {
        id: 'memory_core_append',
        name: 'Remember',
        description: 'Save an important fact to core memory. Always available in future conversations.',
      },
      permission: '*',
      modes: ['chat', 'task'],
      input: z.object({
        content: z.string().max(100).describe('Fact to remember, max 100 chars'),
        scope: z.enum(['agent_caller', 'agent_global'])
          .describe('agent_caller = about current user, agent_global = applies to all users'),
        importance: z.enum(['low', 'medium', 'high']).default('medium'),
      }),
      execute: async (args, ctx) => {
        const { content, scope, importance } = args as { content: string; scope: 'agent_caller' | 'agent_global'; importance: 'low' | 'medium' | 'high' }
        await storage.saveMemory({
          runtime_id: runtimeId,
          agent_id: ctx.runtime.agent.id,
          caller_id: scope === 'agent_caller' ? ctx.runtime.caller.user_id : null,
          scope,
          tier: 'core',
          content,
          importance,
          visibility: 'private',
          source: 'agent',
          expires_at: null,
        })
        return `Remembered: "${content}"`
      },
    }),

    defineTool({
      meta: {
        id: 'memory_core_replace',
        name: 'Update Memory',
        description: 'Update or correct an existing memory.',
      },
      permission: '*',
      modes: ['chat', 'task'],
      input: z.object({
        memory_id: z.string(),
        new_content: z.string().max(100),
      }),
      execute: async (args) => {
        const { memory_id, new_content } = args as { memory_id: string; new_content: string }
        await storage.updateMemory(memory_id, { content: new_content })
        return 'Memory updated.'
      },
    }),

    defineTool({
      meta: {
        id: 'memory_core_remove',
        name: 'Forget',
        description: 'Remove a memory that is no longer relevant.',
      },
      permission: '*',
      modes: ['chat', 'task'],
      input: z.object({
        memory_id: z.string(),
      }),
      execute: async (args) => {
        const { memory_id } = args as { memory_id: string }
        await storage.deleteMemory(memory_id)
        return 'Memory removed.'
      },
    }),

    defineTool({
      meta: {
        id: 'memory_extended_insert',
        name: 'Remember (Extended)',
        description: 'Save a fact to extended memory. Retrieved based on relevance, not always present.',
      },
      permission: '*',
      modes: ['chat', 'task'],
      input: z.object({
        content: z.string(),
        scope: z.enum(['agent_caller', 'agent_global']),
        importance: z.enum(['low', 'medium', 'high']).default('low'),
        visibility: z.enum(['private', 'agent_shared']).default('private'),
      }),
      execute: async (args, ctx) => {
        const { content, scope, importance, visibility } = args as {
          content: string
          scope: 'agent_caller' | 'agent_global'
          importance: 'low' | 'medium' | 'high'
          visibility: 'private' | 'agent_shared'
        }
        await storage.saveMemory({
          runtime_id: runtimeId,
          agent_id: ctx.runtime.agent.id,
          caller_id: scope === 'agent_caller' ? ctx.runtime.caller.user_id : null,
          scope,
          tier: 'extended',
          content,
          importance,
          visibility,
          source: 'agent',
          expires_at: null,
        })
        return `Stored in extended memory: "${content}"`
      },
    }),

    defineTool({
      meta: {
        id: 'memory_search',
        name: 'Search Memory',
        description: 'Search through memories to find relevant information.',
      },
      permission: '*',
      modes: ['chat', 'task'],
      input: z.object({
        query: z.string(),
        scope: z.enum(['agent_caller', 'agent_global', 'all']).default('all'),
      }),
      execute: async (args, ctx) => {
        const { query, scope } = args as { query: string; scope: 'agent_caller' | 'agent_global' | 'all' }
        const scopes: ('agent_caller' | 'agent_global')[] =
          scope === 'all' ? ['agent_caller', 'agent_global'] : [scope]

        const memories = await storage.getMemories({
          runtime_id: runtimeId,
          agent_id: ctx.runtime.agent.id,
          caller_id: ctx.runtime.caller.user_id,
          scope: scopes,
        })
        const relevant = findRelevantMemories(memories, query, config.relevance)
        if (relevant.length === 0) return 'No relevant memories found.'
        return relevant.map(m => `[${m.id}] (${m.scope}, ${m.importance}) ${m.content}`).join('\n')
      },
    }),
  ]

  // ── Policy-gated tools ─────────────────────────────────────

  if (config.policy.read.runtime_global) {
    tools.push(defineTool({
      meta: {
        id: 'memory_runtime_read',
        name: 'Read Project Memory',
        description: 'Search the shared project memory visible to all agents.',
      },
      permission: '*',
      modes: ['chat', 'task'],
      input: z.object({ query: z.string() }),
      execute: async (args, ctx) => {
        const { query } = args as { query: string }
        const memories = await storage.getMemories({
          runtime_id: runtimeId,
          agent_id: ctx.runtime.agent.id,
          scope: 'runtime_global',
        })
        const relevant = findRelevantMemories(memories, query, config.relevance)
        if (relevant.length === 0) return 'No relevant project memories found.'
        return relevant.map(m => `[${m.id}] ${m.content}`).join('\n')
      },
    }))
  }

  if (config.policy.write.runtime_global) {
    tools.push(defineTool({
      meta: {
        id: 'memory_runtime_write',
        name: 'Write Project Memory',
        description: 'Write to shared project memory. Visible to all agents in this project.',
      },
      permission: '*',
      modes: ['chat', 'task'],
      input: z.object({
        content: z.string(),
        importance: z.enum(['low', 'medium', 'high']).default('medium'),
      }),
      execute: async (args, ctx) => {
        const { content, importance } = args as { content: string; importance: 'low' | 'medium' | 'high' }
        await storage.saveMemory({
          runtime_id: runtimeId,
          agent_id: ctx.runtime.agent.id,
          caller_id: null,
          scope: 'runtime_global',
          tier: 'extended',
          content,
          importance,
          visibility: 'project_shared',
          source: 'agent',
          expires_at: null,
        })
        return `Written to project memory: "${content}"`
      },
    }))
  }

  if (config.policy.write.cross_user) {
    tools.push(defineTool({
      meta: {
        id: 'memory_user_write',
        name: 'Write User Memory',
        description: 'Write a memory about another user (agent_shared visibility). Only usable when cross-user write is enabled.',
      },
      permission: '*',
      modes: ['chat', 'task'],
      input: z.object({
        caller_id: z.string().describe('User ID to write memory for'),
        content: z.string(),
        importance: z.enum(['low', 'medium', 'high']).default('medium'),
      }),
      execute: async (args, ctx) => {
        const { caller_id, content, importance } = args as { caller_id: string; content: string; importance: 'low' | 'medium' | 'high' }
        await storage.saveMemory({
          runtime_id: runtimeId,
          agent_id: ctx.runtime.agent.id,
          caller_id,
          scope: 'agent_caller',
          tier: 'extended',
          content,
          importance,
          visibility: 'agent_shared',
          source: 'agent',
          expires_at: null,
        })
        return `Written to user memory for ${caller_id}: "${content}"`
      },
    }))
  }

  if (config.policy.read.cross_user) {
    tools.push(defineTool({
      meta: {
        id: 'memory_user_lookup',
        name: 'Lookup User Memory',
        description: 'Access memories about another user (only agent_shared visibility).',
      },
      permission: '*',
      modes: ['chat', 'task'],
      input: z.object({
        caller_id: z.string().describe('User ID to look up'),
        query: z.string(),
      }),
      execute: async (args, ctx) => {
        const { caller_id, query } = args as { caller_id: string; query: string }
        const memories = await storage.getMemories({
          runtime_id: runtimeId,
          agent_id: ctx.runtime.agent.id,
          caller_id,
          scope: 'agent_caller',
          visibility: ['agent_shared'],
        })
        const relevant = findRelevantMemories(memories, query, config.relevance)
        if (relevant.length === 0) return 'No shared memories found for this user.'
        return relevant.map(m => `[${m.id}] ${m.content}`).join('\n')
      },
    }))
  }

  return tools
}
