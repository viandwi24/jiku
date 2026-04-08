import type { AgentMemory, MemoryContext, ResolvedMemoryConfig, PersonaSeed } from '@jiku/types'
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
  /** Plan 15.2: Semantic similarity scores from vector search (memoryId → score 0-1) */
  semanticScores?: Map<string, number>
}): Promise<MemoryContext> {
  const { memories, current_input, config, semanticScores } = params

  const runtimeCore = config.policy.read.runtime_global
    ? memories.runtime_global.filter(m => m.tier === 'core')
    : []

  const agentCore  = memories.agent_global.filter(m => m.tier === 'core')
  const callerCore = memories.agent_caller.filter(m => m.tier === 'core')
  const extPool    = memories.extended_pool.filter(m => m.tier === 'extended')

  const relevantExtended = findRelevantMemories(extPool, current_input, config.relevance, semanticScores)

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
  return [
    '## What I Remember',
    '',
    'IMPORTANT: Actively apply these memories when generating responses. If a memory mentions an allergy, dietary restriction, preference, or dislike — do NOT include the restricted item in suggestions, recommendations, or examples. Filter your output based on what you know about the user, not just mention it as an afterthought.',
    '',
    ...sections,
  ].join('\n')
}

/**
 * Format the [Persona] system prompt section from agent_self memories.
 * All agent_self memories are always injected (no relevance filtering).
 */
export function formatPersonaSection(
  agentName: string,
  selfMemories: AgentMemory[],
  seed?: PersonaSeed | null,
): string | null {
  if (selfMemories.length === 0 && !seed) return null

  const lines: string[] = ['## Who I Am']
  lines.push(`**Name:** ${seed?.name ?? agentName}`)
  if (seed?.role) lines.push(`**Role:** ${seed.role}`)
  lines.push('')

  if (selfMemories.length > 0) {
    lines.push(...selfMemories.map(m => `- ${m.content}`))
  } else {
    lines.push(`I am ${seed?.name ?? agentName}, an AI assistant. I'm still learning about myself.`)
  }

  // Plan 15.9: Structured traits
  if (seed?.traits) {
    lines.push('')
    lines.push('### Communication Style')
    lines.push(`- Formality: ${seed.traits.formality}`)
    lines.push(`- Verbosity: ${seed.traits.verbosity}`)
    lines.push(`- Humor: ${seed.traits.humor}`)
    lines.push(`- Empathy: ${seed.traits.empathy}`)
    lines.push(`- Expertise display: ${seed.traits.expertise_display}`)
  }

  // Plan 15.9: Boundaries
  if (seed?.boundaries && seed.boundaries.length > 0) {
    lines.push('')
    lines.push('### Boundaries')
    lines.push('You must NEVER do the following:')
    seed.boundaries.forEach(b => lines.push(`- ${b}`))
  }

  return lines.join('\n')
}
