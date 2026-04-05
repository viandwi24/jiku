import type { ConnectorAdapter } from '@jiku/kit'

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
    return this.adapters.get(adapterId)
  }

  getRequired(adapterId: string): ConnectorAdapter {
    const adapter = this.adapters.get(adapterId)
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
    return this.adapters.get(ctx.adapterId) ?? null
  }
}

export const connectorRegistry = new ConnectorRegistry()
