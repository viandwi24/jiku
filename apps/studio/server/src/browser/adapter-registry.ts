// Registry of browser adapters available to all projects. Populated by:
//   - Built-in registration at server start (e.g. JikuBrowserVercelAdapter).
//   - Plugin setup via `ctx.browser.register(adapter)` (e.g. jiku.camofox).
//
// Browser profiles reference adapters by their stable `id` string, so a
// profile stays valid across restarts as long as the adapter is registered.

import type { BrowserAdapter } from '@jiku/kit'

class BrowserAdapterRegistry {
  private adapters = new Map<string, BrowserAdapter>()

  register(adapter: BrowserAdapter): void {
    if (this.adapters.has(adapter.id)) {
      console.warn(
        `[browser:adapters] Adapter '${adapter.id}' already registered — skipping duplicate`,
      )
      return
    }
    this.adapters.set(adapter.id, adapter)
    console.log(
      `[browser:adapters] Registered adapter: ${adapter.id} ("${adapter.displayName}")`,
    )
  }

  get(id: string): BrowserAdapter | undefined {
    return this.adapters.get(id)
  }

  list(): BrowserAdapter[] {
    return Array.from(this.adapters.values())
  }

  has(id: string): boolean {
    return this.adapters.has(id)
  }
}

export const browserAdapterRegistry = new BrowserAdapterRegistry()
