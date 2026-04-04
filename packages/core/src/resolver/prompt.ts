import type { AgentMode, ResolvedTool, CallerContext } from '@jiku/types'

export function buildSystemPrompt(params: {
  base: string
  mode: AgentMode
  active_tools: ResolvedTool[]
  caller: CallerContext
  plugin_segments: string[]
}): string {
  const { base, mode, active_tools, caller, plugin_segments } = params

  const modeInstruction =
    mode === 'chat'
      ? 'You are having a conversation with the user. Be helpful and responsive.'
      : 'You are working autonomously on a goal. Complete the task thoroughly and produce a clear output.'

  const userName = (caller.user_data.name as string | undefined) ?? caller.user_id
  const userCtx = `Current user: ${userName} (${caller.roles.join(', ')})`

  const toolHints = active_tools
    .filter(t => t.prompt)
    .map(t => t.prompt as string)
    .join('\n')

  const pluginCtx = plugin_segments.join('\n')

  return [base, modeInstruction, userCtx, toolHints, pluginCtx]
    .filter(Boolean)
    .join('\n\n')
}
