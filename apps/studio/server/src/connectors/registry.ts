import type { ConnectorAdapter } from '@jiku/kit'

/**
 * Plan 24 Phase 2 — Backward-compat aliases for renamed adapter ids.
 * When an existing connector row references an old id, we silently resolve to
 * the new one. Aliases SHOULD be removed after one release cycle once all
 * persisted rows have been migrated by `0032_plan24_telegram_adapter_rename.sql`.
 */
const ADAPTER_ID_ALIASES: Record<string, string> = {
  'jiku.telegram': 'jiku.telegram.bot',
}

/**
 * Global registry of connector adapters keyed by adapter ID.
 * Adapters are registered when their plugin is loaded (system-wide).
 * Active contexts (with connectorId, projectId) are stored separately.
 */
class ConnectorRegistry {
  private adapters = new Map<string, ConnectorAdapter>()
  private activeContexts = new Map<string, { adapterId: string; projectId: string; connectorId: string }>()

  register(adapter: ConnectorAdapter): void {
    this.adapters.set(adapter.id, adapter)
  }

  get(adapterId: string): ConnectorAdapter | undefined {
    const direct = this.adapters.get(adapterId)
    if (direct) return direct
    const aliased = ADAPTER_ID_ALIASES[adapterId]
    if (aliased) return this.adapters.get(aliased)
    return undefined
  }

  getRequired(adapterId: string): ConnectorAdapter {
    const adapter = this.get(adapterId)
    if (!adapter) throw new Error(`Connector adapter not found: ${adapterId}`)
    return adapter
  }

  list(): ConnectorAdapter[] {
    return Array.from(this.adapters.values())
  }

  /** Track an active connector instance (per project) */
  setActive(connectorId: string, adapterId: string, projectId: string): void {
    this.activeContexts.set(connectorId, { adapterId, projectId, connectorId })
  }

  removeActive(connectorId: string): void {
    this.activeContexts.delete(connectorId)
  }

  getActiveContext(connectorId: string) {
    return this.activeContexts.get(connectorId) ?? null
  }

  getAdapterForConnector(connectorId: string): ConnectorAdapter | null {
    const ctx = this.activeContexts.get(connectorId)
    if (!ctx) return null
    return this.get(ctx.adapterId) ?? null
  }

  /** Lookup active context by plugin_id (adapter id) + projectId */
  getActiveContextForPlugin(pluginId: string, projectId: string) {
    // Resolve aliases on the lookup key too so old ids still match active rows.
    const canonical = ADAPTER_ID_ALIASES[pluginId] ?? pluginId
    for (const ctx of this.activeContexts.values()) {
      const ctxCanonical = ADAPTER_ID_ALIASES[ctx.adapterId] ?? ctx.adapterId
      if (ctxCanonical === canonical && ctx.projectId === projectId) return ctx
    }
    return null
  }
}

export const connectorRegistry = new ConnectorRegistry()
