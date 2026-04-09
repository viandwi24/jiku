import type { BrowserProjectConfig } from '@jiku-studio/db'

/**
 * Resolve CDP endpoint from project browser config.
 * @jiku/browser only needs a CDP endpoint — no managed mode, no control server.
 */
export function resolveCdpEndpoint(config: BrowserProjectConfig | undefined | null): string {
  if (!config?.cdp_url) {
    return 'ws://localhost:9222'
  }
  return config.cdp_url.trim().replace(/\/$/, '')
}
