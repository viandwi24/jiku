import type { AdapterModel, UsageLog } from './api'

/** Build a model pricing lookup map from adapters list */
export function buildPricingMap(
  adapters: { adapter_id: string; models: AdapterModel[] }[],
): Map<string, { cost_per_million_out: number; cost_per_million_in: number }> {
  const map = new Map<string, { cost_per_million_out: number; cost_per_million_in: number }>()
  for (const adapter of adapters) {
    for (const model of adapter.models) {
      if (model.cost_per_million_out !== undefined && model.cost_per_million_in !== undefined) {
        map.set(model.id, {
          cost_per_million_out: model.cost_per_million_out,
          cost_per_million_in: model.cost_per_million_in,
        })
      }
    }
  }
  return map
}

/**
 * Estimate cost using model-specific pricing when available,
 * falling back to generic gpt-4o-equivalent rates.
 *
 * Remember: input_tokens = tokens sent OUT to model (outbound)
 *           output_tokens = tokens received IN from model (inbound)
 */
export function estimateCost(
  input_tokens: number,
  output_tokens: number,
  modelId: string | null | undefined,
  pricingMap: Map<string, { cost_per_million_out: number; cost_per_million_in: number }>,
): string {
  const pricing = modelId ? pricingMap.get(modelId) : undefined
  const outRate = pricing?.cost_per_million_out ?? 2.5
  const inRate = pricing?.cost_per_million_in ?? 10

  const cost = (input_tokens / 1_000_000) * outRate + (output_tokens / 1_000_000) * inRate
  if (cost === 0) return '$0.000'
  if (cost < 0.0001) return '<$0.0001'
  return `$${cost.toFixed(4)}`
}

export function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`
  return String(n)
}

export interface DailyTokenUsage {
  date: string
  input_tokens: number
  output_tokens: number
}

/** Aggregate usage logs into a daily time-series breakdown */
export function aggregateByDay(logs: UsageLog[]): DailyTokenUsage[] {
  const map = new Map<string, DailyTokenUsage>()

  for (const log of logs) {
    const date = log.created_at.slice(0, 10) // "YYYY-MM-DD"
    const existing = map.get(date)
    if (existing) {
      map.set(date, {
        date,
        input_tokens: existing.input_tokens + log.input_tokens,
        output_tokens: existing.output_tokens + log.output_tokens,
      })
    } else {
      map.set(date, {
        date,
        input_tokens: log.input_tokens,
        output_tokens: log.output_tokens,
      })
    }
  }

  return Array.from(map.values()).sort((a, b) => a.date.localeCompare(b.date))
}

export interface AgentTokenUsage {
  agent_id: string
  agent_name: string
  input_tokens: number
  output_tokens: number
  total_tokens: number
}

/** Aggregate usage logs by agent — for project-level breakdown charts */
export function aggregateByAgent(
  logs: Array<UsageLog & { agent?: { id: string; name: string; slug: string } | null }>,
): AgentTokenUsage[] {
  const map = new Map<string, AgentTokenUsage>()

  for (const log of logs) {
    const agentId = log.agent_id
    const agentName = log.agent?.name ?? agentId.slice(0, 8)
    const existing = map.get(agentId)
    if (existing) {
      map.set(agentId, {
        agent_id: agentId,
        agent_name: agentName,
        input_tokens: existing.input_tokens + log.input_tokens,
        output_tokens: existing.output_tokens + log.output_tokens,
        total_tokens: existing.total_tokens + log.input_tokens + log.output_tokens,
      })
    } else {
      map.set(agentId, {
        agent_id: agentId,
        agent_name: agentName,
        input_tokens: log.input_tokens,
        output_tokens: log.output_tokens,
        total_tokens: log.input_tokens + log.output_tokens,
      })
    }
  }

  return Array.from(map.values()).sort((a, b) => b.total_tokens - a.total_tokens)
}

/**
 * Estimate the total cost across all logs using model-specific pricing when available.
 * Returns a formatted cost string.
 */
export function estimateTotalCost(
  logs: UsageLog[],
  pricingMap: Map<string, { cost_per_million_out: number; cost_per_million_in: number }>,
): string {
  let totalCost = 0
  for (const log of logs) {
    const pricing = log.model_id ? pricingMap.get(log.model_id) : undefined
    const outRate = pricing?.cost_per_million_out ?? 2.5
    const inRate = pricing?.cost_per_million_in ?? 10
    totalCost += (log.input_tokens / 1_000_000) * outRate + (log.output_tokens / 1_000_000) * inRate
  }
  if (totalCost === 0) return '$0.000'
  if (totalCost < 0.0001) return '<$0.0001'
  return `$${totalCost.toFixed(4)}`
}
