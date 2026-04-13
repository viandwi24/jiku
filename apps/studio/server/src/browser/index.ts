// Plan 20 — Browser module entrypoint.
//
// Responsibilities:
//   - Register the built-in `jiku.browser.vercel` adapter in the global
//     BrowserAdapterRegistry.
//   - Re-export the legacy `registerBrowserCdp` / `unregisterBrowserCdp`
//     helpers so existing callers keep compiling. They are thin pass-throughs
//     and will be removed once every caller migrates to the profile model.

import { browserAdapterRegistry } from './adapter-registry.ts'
import { jikuBrowserVercelAdapter } from './adapters/jiku-browser-vercel.ts'

// Register the built-in adapter at module load time — before the plugin
// loader runs and before any project wakes up. We explicitly want this
// adapter always available, regardless of which plugins are installed.
browserAdapterRegistry.register(jikuBrowserVercelAdapter)

export { browserAdapterRegistry } from './adapter-registry.ts'
export { jikuBrowserVercelAdapter } from './adapters/jiku-browser-vercel.ts'

// ── Legacy helpers (kept as no-ops for backward compat) ────────────────────
// The CDP endpoint is now resolved per-profile from the DB at call time.

export function registerBrowserCdp(_projectId: string, _config: unknown): void {
  // No-op — profile rows are the source of truth now.
}

export function unregisterBrowserCdp(_projectId: string): void {
  // No-op — see above.
}

export function getCdpEndpoint(_projectId: string): string | null {
  // Callers should look up via the profile row instead.
  return null
}
