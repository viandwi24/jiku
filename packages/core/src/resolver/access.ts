import type { CallerContext, PolicyRule, ResourceType } from '@jiku/types'

export function checkAccess(params: {
  resource_type: ResourceType
  resource_id: string
  caller: CallerContext
  rules: PolicyRule[]
}): boolean {
  const { resource_type, resource_id, caller, rules } = params

  const relevant = rules
    .filter(r => r.resource_type === resource_type && r.resource_id === resource_id)
    .sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0))

  // No rules → default ALLOW
  if (relevant.length === 0) return true

  for (const rule of relevant) {
    const match =
      rule.subject_type === 'role'
        ? caller.roles.includes(rule.subject)
        : caller.permissions.includes(rule.subject)

    if (match && rule.effect === 'deny') return false
    if (match && rule.effect === 'allow') return true
  }

  // Rules exist but none matched the caller → DENY
  return false
}
