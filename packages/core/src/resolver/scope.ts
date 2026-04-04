import type {
  CallerContext,
  AgentDefinition,
  PolicyRule,
  ResolvedTool,
  ResolvedScope,
  AgentMode,
} from '@jiku/types'
import { checkAccess } from './access.ts'

export function resolveScope(params: {
  caller: CallerContext
  agent: AgentDefinition
  rules: PolicyRule[]
  all_tools: ResolvedTool[]
  mode: AgentMode
}): ResolvedScope {
  const { caller, agent, rules, all_tools } = params

  const agentAccessible = agent.allowed_modes.some(m =>
    checkAccess({
      resource_type: 'agent',
      resource_id: `${agent.meta.id}:${m}`,
      caller,
      rules,
    })
  )

  if (!agentAccessible) {
    return {
      accessible: false,
      denial_reason: `No access to agent '${agent.meta.id}'`,
      allowed_modes: [],
      active_tools: [],
      system_prompt: '',
    }
  }

  const allowed_modes = agent.allowed_modes.filter(m =>
    checkAccess({
      resource_type: 'agent',
      resource_id: `${agent.meta.id}:${m}`,
      caller,
      rules,
    })
  )

  const active_tools = all_tools.filter(tool => {
    if (tool.resolved_permission === '*') return true
    return checkAccess({
      resource_type: 'tool',
      resource_id: tool.resolved_id,
      caller,
      rules,
    })
  })

  return {
    accessible: true,
    allowed_modes,
    active_tools,
    system_prompt: '',
  }
}
