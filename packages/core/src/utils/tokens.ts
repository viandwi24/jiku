/**
 * Rough token estimation — 1 token ≈ 4 chars (English).
 * Sufficient for preview/compaction threshold checks.
 * For production billing accuracy, actual usage from model.usage is always preferred.
 */
export function estimateTokens(text: string | object): number {
  const str = typeof text === 'string' ? text : JSON.stringify(text)
  return Math.ceil(str.length / 4)
}

/**
 * Known model context windows.
 * Default: 128k when model is unknown.
 */
export function getModelContextWindow(modelId: string): number {
  const windows: Record<string, number> = {
    'claude-opus-4-6':    200000,
    'claude-sonnet-4-6':  200000,
    'claude-haiku-4-5':   200000,
    'claude-opus-4-5':    200000,
    'claude-sonnet-4-5':  200000,
    'gpt-4o':             128000,
    'gpt-4o-mini':        128000,
    'gpt-4.1':            128000,
    'gpt-4.1-mini':       128000,
    'gpt-4.1-nano':        32000,
  }
  return windows[modelId] ?? 128000
}
