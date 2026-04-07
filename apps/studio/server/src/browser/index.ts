import type { BrowserProjectConfig } from '@jiku-studio/db'
import { startBrowserControlServer, stopBrowserControlServer } from './browser/server.js'
import { resolveProjectBrowserConfig, resolveBaseServerConfig } from './config.js'
import { env } from '../env.ts'

export type BrowserServerHandle = {
  port: number
  baseUrl: string
}

// The browser control server is a global singleton — one Node child process per app process.
// All projects share the same server; each project gets an isolated profile via ?profile=<projectId>.

let sharedHandle: BrowserServerHandle | null = null
const registeredProfiles = new Set<string>()

async function ensureSharedServer(): Promise<BrowserServerHandle> {
  if (sharedHandle) return sharedHandle

  if (!env.BROWSER_CONTROL_SERVER_ENABLED) {
    throw new Error('[browser] Browser control server is disabled (BROWSER_CONTROL_SERVER_ENABLED=false)')
  }

  const resolved = resolveBaseServerConfig()
  const state = await startBrowserControlServer(resolved)

  if (!state) {
    throw new Error('[browser] Failed to start browser control server')
  }

  sharedHandle = {
    port: state.port,
    baseUrl: `http://127.0.0.1:${state.port}`,
  }

  return sharedHandle
}

/**
 * Start browser tools for a project.
 *
 * - remote mode: registers project as a named profile on the shared server via HTTP
 * - managed mode: passes the full config (with profile) when starting the server,
 *   or registers the profile via HTTP if server is already running
 */
export async function startBrowserServer(
  projectId: string,
  config: BrowserProjectConfig,
): Promise<BrowserServerHandle> {
  const handle = await ensureSharedServer()

  if (!registeredProfiles.has(projectId)) {
    const projectConfig = resolveProjectBrowserConfig(config, projectId)
    const profile = projectConfig.profiles[projectId] as Record<string, unknown>

    const res = await fetch(`${handle.baseUrl}/profiles/create`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: projectId,
        cdpUrl: (profile['cdpUrl'] as string | undefined) ?? undefined,
      }),
    })

    if (!res.ok && res.status !== 409) {
      const body = await res.text().catch(() => '')
      throw new Error(`[browser] Failed to register profile for project ${projectId}: ${body}`)
    }

    registeredProfiles.add(projectId)
  }

  return handle
}

export async function stopBrowserServer(_projectId: string): Promise<void> {
  // Individual projects cannot stop the shared server.
}

export async function stopAllBrowserServers(): Promise<void> {
  if (!sharedHandle) return
  await stopBrowserControlServer()
  sharedHandle = null
  registeredProfiles.clear()
}

export function getBrowserServerHandle(_projectId: string): BrowserServerHandle | undefined {
  return sharedHandle ?? undefined
}
