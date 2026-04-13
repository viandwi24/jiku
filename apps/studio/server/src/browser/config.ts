import type { JikuBrowserVercelConfig } from './adapters/jiku-browser-vercel-types.ts'

/**
 * Resolve a CDP endpoint from a Jiku Browser profile config.
 * @jiku/browser only needs a CDP endpoint — no managed mode, no control server.
 */
export function resolveCdpEndpoint(config: JikuBrowserVercelConfig | undefined | null): string {
  if (!config?.cdp_url) {
    return 'ws://localhost:9222'
  }
  return config.cdp_url.trim().replace(/\/$/, '')
}
