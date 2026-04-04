import type { CallerContext, PolicyRule, PolicyCondition, SubjectMatcher } from '@jiku/types'

// ============================================================
// Default Subject Matcher
// ============================================================

/**
 * Built-in subject matcher — covers the common cases:
 * - '*'           → match all callers
 * - 'role'        → caller.roles.includes(subject)
 * - 'permission'  → caller.permissions.includes(subject)
 * - 'user'        → caller.user_id === subject
 * - anything else → check caller.attributes?.[subject_type]
 */
export const defaultSubjectMatcher: SubjectMatcher = (
  rule: PolicyRule,
  caller: CallerContext,
): boolean => {
  if (rule.subject === '*') return true

  switch (rule.subject_type) {
    case 'role':
      return caller.roles.includes(rule.subject)

    case 'permission':
      return caller.permissions.includes(rule.subject)

    case 'user':
      return caller.user_id === rule.subject

    default: {
      // subject_type is an attribute key — e.g. 'plan', 'channel'
      const attr = caller.attributes?.[rule.subject_type]
      if (attr === undefined) return false
      return Array.isArray(attr)
        ? attr.includes(rule.subject)
        : attr === rule.subject
    }
  }
}

// ============================================================
// Condition evaluation
// ============================================================

/**
 * Resolve a dot-notation path against CallerContext.
 * 'roles'                → caller.roles
 * 'permissions'          → caller.permissions
 * 'user_id'              → caller.user_id
 * 'attributes.plan'      → caller.attributes?.plan
 * 'user_data.company_id' → caller.user_data?.company_id
 */
function resolveAttribute(
  path: string,
  caller: CallerContext,
): string | string[] | undefined {
  const parts = path.split('.')
  let current: unknown = caller
  for (const part of parts) {
    if (current === null || current === undefined) return undefined
    current = (current as Record<string, unknown>)[part]
  }
  if (typeof current === 'string') return current
  if (Array.isArray(current)) return current as string[]
  return undefined
}

/**
 * Evaluate all conditions — AND logic, all must pass.
 */
export function evaluateConditions(
  conditions: PolicyCondition[],
  caller: CallerContext,
): boolean {
  return conditions.every(condition => {
    const attrValue = resolveAttribute(condition.attribute, caller)
    if (attrValue === undefined) return false

    switch (condition.operator) {
      case 'eq':
        return attrValue === condition.value
      case 'not_eq':
        return attrValue !== condition.value
      case 'in':
        return Array.isArray(condition.value)
          ? condition.value.includes(attrValue as string)
          : false
      case 'not_in':
        return Array.isArray(condition.value)
          ? !condition.value.includes(attrValue as string)
          : true
      case 'contains':
        return Array.isArray(attrValue)
          ? attrValue.includes(condition.value as string)
          : false
      case 'not_contains':
        return Array.isArray(attrValue)
          ? !attrValue.includes(condition.value as string)
          : true
    }
  })
}

// ============================================================
// checkAccess
// ============================================================

export function checkAccess(params: {
  resource_type: string
  resource_id: string
  caller: CallerContext
  rules: PolicyRule[]
  subject_matcher?: SubjectMatcher
}): boolean {
  const {
    resource_type,
    resource_id,
    caller,
    rules,
    subject_matcher = defaultSubjectMatcher,
  } = params

  // Match rules for this resource; rule.resource_id '*' applies to all
  const relevant = rules
    .filter(r =>
      r.resource_type === resource_type &&
      (r.resource_id === resource_id || r.resource_id === '*')
    )
    .sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0))

  // No rules → default ALLOW
  if (relevant.length === 0) return true

  for (const rule of relevant) {
    const subjectMatch = subject_matcher(rule, caller)
    if (!subjectMatch) continue

    // All conditions must pass (AND)
    if (rule.conditions && rule.conditions.length > 0) {
      if (!evaluateConditions(rule.conditions, caller)) continue
    }

    if (rule.effect === 'deny') return false
    if (rule.effect === 'allow') return true
  }

  // Rules exist but none matched caller → DENY
  return false
}
