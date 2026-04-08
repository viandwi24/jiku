import type { AutoReplyRule, AvailabilitySchedule } from '@jiku/types'
import { isWithinSchedule } from '../utils/schedule.ts'

export interface AutoReplyResult {
  matched: boolean
  response?: string
  reason?: 'rule_match' | 'offline' | 'none'
}

/**
 * Evaluate whether a message should be auto-replied without invoking the LLM.
 * Checks availability schedule first, then rules.
 */
export function evaluateAutoReply(
  input: string,
  rules: AutoReplyRule[],
  schedule: AvailabilitySchedule | null,
): AutoReplyResult {
  // 1. Check availability schedule — if outside hours, return offline message
  if (schedule?.enabled && !isWithinSchedule(schedule)) {
    return {
      matched: true,
      response: schedule.offline_message || 'The agent is currently offline. Please try again later.',
      reason: 'offline',
    }
  }

  // 2. Check rules (in order)
  for (const rule of rules) {
    if (!rule.enabled) continue

    const trimmedInput = input.trim()

    switch (rule.trigger) {
      case 'exact':
        if (trimmedInput.toLowerCase() === rule.pattern.toLowerCase()) {
          return { matched: true, response: rule.response, reason: 'rule_match' }
        }
        break

      case 'contains':
        if (trimmedInput.toLowerCase().includes(rule.pattern.toLowerCase())) {
          return { matched: true, response: rule.response, reason: 'rule_match' }
        }
        break

      case 'regex':
        try {
          if (new RegExp(rule.pattern, 'i').test(trimmedInput)) {
            return { matched: true, response: rule.response, reason: 'rule_match' }
          }
        } catch {
          // Invalid regex — skip this rule
        }
        break

      case 'command':
        if (trimmedInput.startsWith(`/${rule.pattern}`)) {
          return { matched: true, response: rule.response, reason: 'rule_match' }
        }
        break
    }
  }

  return { matched: false, reason: 'none' }
}
