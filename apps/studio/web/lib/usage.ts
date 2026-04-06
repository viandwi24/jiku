import type { AdapterModel } from './api'

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
