import type { BrowserProjectConfig } from '@jiku-studio/db'
import { resolveCdpEndpoint } from './config.ts'

/**
 * CDP endpoint tracker for projects.
 * @jiku/browser requires a CDP endpoint; no long-running server is needed.
 */
const cdpEndpoints = new Map<string, { endpoint: string }>()

/**
 * Register a project's CDP endpoint for browser tools.
 */
export function registerBrowserCdp(projectId: string, config: BrowserProjectConfig | undefined | null): void {
  const endpoint = resolveCdpEndpoint(config)
  cdpEndpoints.set(projectId, { endpoint })
}

/**
 * Unregister a project's CDP endpoint.
 */
export function unregisterBrowserCdp(projectId: string): void {
  cdpEndpoints.delete(projectId)
}

/**
 * Get the CDP endpoint for a project.
 */
export function getCdpEndpoint(projectId: string): string | null {
  const entry = cdpEndpoints.get(projectId)
  return entry?.endpoint ?? null
}
