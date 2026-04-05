import type { AgentMemory, MemoryContext, ResolvedMemoryConfig } from '@jiku/types'
import { findRelevantMemories } from './relevance.ts'
import { estimateTokens } from '../utils/tokens.ts'

export async function buildMemoryContext(params: {
  memories: {
    runtime_global: AgentMemory[]
    agent_global: AgentMemory[]
    agent_caller: AgentMemory[]
    extended_pool: AgentMemory[]
  }
  current_input: string
  config: ResolvedMemoryConfig
}): Promise<MemoryContext> {
  const { memories, current_input, config } = params

  const runtimeCore = config.policy.read.runtime_global
    ? memories.runtime_global.filter(m => m.tier === 'core')
    : []

  const agentCore  = memories.agent_global.filter(m => m.tier === 'core')
  const callerCore = memories.agent_caller.filter(m => m.tier === 'core')
  const extPool    = memories.extended_pool.filter(m => m.tier === 'extended')

  const relevantExtended = findRelevantMemories(extPool, current_input, config.relevance)

  const totalTokens = estimateTokens(
    [...runtimeCore, ...agentCore, ...callerCore, ...relevantExtended]
      .map(m => m.content).join('\n')
  )

  return {
    runtime_global: runtimeCore,
    agent_global: agentCore,
    agent_caller: callerCore,
    extended: relevantExtended,
    total_tokens: Math.min(totalTokens, config.core.token_budget),
  }
}

export function formatMemorySection(
  ctx: MemoryContext,
  userName?: string,
): string {
  const sections: string[] = []

  if (ctx.runtime_global.length > 0) {
    sections.push([
      '### About This Project',
      ...ctx.runtime_global.map(m => `- ${m.content}`),
    ].join('\n'))
  }

  if (ctx.agent_global.length > 0) {
    sections.push([
      '### General',
      ...ctx.agent_global.map(m => `- ${m.content}`),
    ].join('\n'))
  }

  if (ctx.agent_caller.length > 0) {
    sections.push([
      `### About ${userName ?? 'User'}`,
      ...ctx.agent_caller.map(m => `- ${m.content}`),
    ].join('\n'))
  }

  if (ctx.extended.length > 0) {
    sections.push([
      '### Relevant Context',
      ...ctx.extended.map(m => `- ${m.content}`),
    ].join('\n'))
  }

  if (sections.length === 0) return ''
  return `## What I Remember\n\n${sections.join('\n\n')}`
}
