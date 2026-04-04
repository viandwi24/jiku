import type {
  CallerContext,
  AgentDefinition,
  PolicyRule,
  ResolvedTool,
  ResolvedScope,
  AgentMode,
  SubjectMatcher,
} from '@jiku/types'
import { checkAccess } from './access.ts'

export function resolveScope(params: {
  caller: CallerContext
  agent: AgentDefinition
  rules: PolicyRule[]
  all_tools: ResolvedTool[]
  mode: AgentMode
  subject_matcher?: SubjectMatcher
}): ResolvedScope {
  const { caller, agent, rules, all_tools, mode, subject_matcher } = params

  const accessParams = { caller, rules, subject_matcher }

  // Check agent is accessible in the requested mode
  const agentAccessible = checkAccess({
    ...accessParams,
    resource_type: 'agent',
    resource_id: `${agent.meta.id}:${mode}`,
  })

  if (!agentAccessible) {
    return {
      accessible: false,
      denial_reason: `No access to agent '${agent.meta.id}' in mode '${mode}'`,
      allowed_modes: [],
      active_tools: [],
      system_prompt: '',
    }
  }

  const allowed_modes = agent.allowed_modes.filter(m =>
    checkAccess({
      ...accessParams,
      resource_type: 'agent',
      resource_id: `${agent.meta.id}:${m}`,
    })
  )

  const active_tools = all_tools
    .filter(tool => tool.modes.includes(mode))
    .filter(tool => {
      // Wildcard permission → always allow
      if (tool.resolved_permission === '*') return true

      // If there's an explicit rule for this tool, evaluate it
      const hasExplicitRule = rules.some(r =>
        r.resource_type === 'tool' && r.resource_id === tool.resolved_id
      )

      if (hasExplicitRule) {
        return checkAccess({
          ...accessParams,
          resource_type: 'tool',
          resource_id: tool.resolved_id,
        })
      }

      // No explicit rule → fall back to permission check
      return caller.permissions.includes(tool.resolved_permission)
    })

  return {
    accessible: true,
    allowed_modes,
    active_tools,
    system_prompt: '',
  }
}
