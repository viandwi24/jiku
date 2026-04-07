import type { BrowserProjectConfig } from '@jiku-studio/db'
import { startBrowserControlServer, stopBrowserControlServer } from './browser/server.js'
import { resolveRemoteBrowserConfig } from './config.js'
import { env } from '../env.ts'

export type BrowserServerHandle = {
  port: number
  baseUrl: string
}

// The browser control server is a global singleton — one Node child process per app process.
// All projects share the same server; each project gets an isolated profile via ?profile=<projectId>.
// Only remote mode is supported (local/managed mode would conflict across projects).

let sharedHandle: BrowserServerHandle | null = null
const registeredProfiles = new Set<string>()

async function ensureSharedServer(): Promise<BrowserServerHandle> {
  if (sharedHandle) return sharedHandle

  if (!env.BROWSER_CONTROL_SERVER_ENABLED) {
    throw new Error('[browser] Browser control server is disabled (BROWSER_CONTROL_SERVER_ENABLED=false)')
  }

  const resolved = resolveRemoteBrowserConfig()
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
 * Register a project as a remote profile on the shared browser control server.
 * Only supports remote mode — if the config is not remote, returns null.
 */
export async function startBrowserServer(
  projectId: string,
  config: BrowserProjectConfig,
): Promise<BrowserServerHandle> {
  if (config.mode !== 'remote' || !config.cdp_url) {
    throw new Error(
      `[browser] Project ${projectId} browser config is not remote — only remote mode is supported`,
    )
  }

  const handle = await ensureSharedServer()

  // Register this project as a named profile if not already done
  if (!registeredProfiles.has(projectId)) {
    const res = await fetch(`${handle.baseUrl}/profiles/create`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: projectId, cdpUrl: config.cdp_url }),
    })

    if (!res.ok && res.status !== 409) {
      // 409 = already exists, which is fine
      const body = await res.text().catch(() => '')
      throw new Error(`[browser] Failed to register profile for project ${projectId}: ${body}`)
    }

    registeredProfiles.add(projectId)
  }

  return handle
}

export async function stopBrowserServer(_projectId: string): Promise<void> {
  // Individual projects cannot stop the shared server.
  // The server is stopped only when all projects are shut down.
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
