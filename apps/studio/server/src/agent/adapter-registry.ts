// Registry of agent execution adapters. Populated by:
//   - Built-in registration at server start (Default + Harness).
//   - Plugin setup via `ctx.agent.registerAdapter(adapter)` (future).
//
// Agent mode_configs reference adapters by stable `id` string, so a mode
// config stays valid across restarts as long as the adapter is registered.

import type { AgentAdapter } from '@jiku/core'

class AgentAdapterRegistry {
  private adapters = new Map<string, AgentAdapter>()

  register(adapter: AgentAdapter): void {
    if (this.adapters.has(adapter.id)) {
      console.warn(
        `[agent:adapters] Adapter '${adapter.id}' already registered — skipping duplicate`,
      )
      return
    }
    this.adapters.set(adapter.id, adapter)
    console.log(
      `[agent:adapters] Registered adapter: ${adapter.id} ("${adapter.displayName}")`,
    )
  }

  get(id: string): AgentAdapter | undefined {
    return this.adapters.get(id)
  }

  /** Falls back to the default adapter when `id` is unknown. */
  resolve(id: string): AgentAdapter {
    const hit = this.adapters.get(id)
    if (hit) return hit
    const fallback = this.adapters.get('jiku.agent.default')
    if (!fallback) {
      throw new Error(
        `[agent:adapters] Cannot resolve adapter '${id}' and default adapter is not registered`,
      )
    }
    return fallback
  }

  list(): Pick<AgentAdapter, 'id' | 'displayName' | 'description' | 'configSchema'>[] {
    return Array.from(this.adapters.values()).map(({ id, displayName, description, configSchema }) => ({
      id,
      displayName,
      description,
      configSchema,
    }))
  }

  has(id: string): boolean {
    return this.adapters.has(id)
  }
}

export const agentAdapterRegistry = new AgentAdapterRegistry()
