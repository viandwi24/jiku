import type { AgentMode, ResolvedTool, CallerContext } from '@jiku/types'

/**
 * Build the mode-specific instruction segment.
 */
export function buildModeInstruction(mode: AgentMode): string {
  if (mode === 'chat') {
    return 'You are having a conversation with the user. Be helpful, concise, and responsive.'
  }
  return 'You are working autonomously on a goal. Complete the task thoroughly and produce a clear, structured output.'
}

/**
 * Build the user context segment.
 */
export function buildUserContext(caller: CallerContext): string {
  const name = (caller.user_data.name as string | undefined) ?? caller.user_id
  const roles = caller.roles.join(', ') || 'user'
  return `Current user: ${name} (${roles})`
}

/**
 * Build tool hint segments from active tools that have prompts.
 */
export function buildToolHints(tools: ResolvedTool[]): string {
  return tools
    .filter(t => t.prompt)
    .map(t => t.prompt as string)
    .join('\n')
}

/**
 * Build the full system prompt by assembling all segments.
 */
export function buildSystemPrompt(params: {
  base: string
  mode: AgentMode
  active_tools: ResolvedTool[]
  caller: CallerContext
  plugin_segments: string[]
}): string {
  const { base, mode, active_tools, caller, plugin_segments } = params

  const segments = [
    base,
    buildModeInstruction(mode),
    buildUserContext(caller),
    buildToolHints(active_tools),
    plugin_segments.join('\n'),
  ]

  return segments.filter(Boolean).join('\n\n')
}
