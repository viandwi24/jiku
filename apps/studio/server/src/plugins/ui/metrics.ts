// Lightweight in-memory metrics for the Plugin Inspector (Plan 17 M6).
// Not persisted; rolling aggregates only.

interface PluginStats {
  apiCalls: number
  apiErrors: number
  apiTotalMs: number
  lastApiAt?: number
  toolInvokes: number
  toolErrors: number
  lastError?: { message: string; at: number; where: string }
}

const stats = new Map<string, PluginStats>()

function bucket(pluginId: string): PluginStats {
  let s = stats.get(pluginId)
  if (!s) {
    s = { apiCalls: 0, apiErrors: 0, apiTotalMs: 0, toolInvokes: 0, toolErrors: 0 }
    stats.set(pluginId, s)
  }
  return s
}

export function recordApiCall(pluginId: string, durationMs: number, ok: boolean): void {
  const s = bucket(pluginId)
  s.apiCalls += 1
  s.apiTotalMs += durationMs
  s.lastApiAt = Date.now()
  if (!ok) s.apiErrors += 1
}

export function recordToolInvoke(pluginId: string, ok: boolean): void {
  const s = bucket(pluginId)
  s.toolInvokes += 1
  if (!ok) s.toolErrors += 1
}

export function recordError(pluginId: string, where: string, message: string): void {
  const s = bucket(pluginId)
  s.lastError = { message, at: Date.now(), where }
}

export function getPluginMetrics(pluginId: string): PluginStats {
  const s = bucket(pluginId)
  return { ...s }
}

export function getAllMetrics(): Record<string, PluginStats> {
  const out: Record<string, PluginStats> = {}
  for (const [k, v] of stats.entries()) out[k] = { ...v }
  return out
}
