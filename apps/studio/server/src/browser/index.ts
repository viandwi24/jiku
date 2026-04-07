import type { BrowserProjectConfig } from '@jiku-studio/db'
import { startBrowserControlServer, stopBrowserControlServer } from './browser/server.js'
import { resolveProjectBrowserConfig } from './config.js'

export type BrowserServerHandle = {
  port: number
  baseUrl: string
}

// The underlying browser control server is a global singleton (one Node child process
// per app process). All projects share the same server; each project gets its own
// browser profile/context inside that server.
// projectId → handle (stores per-project metadata, but all point to the same port)
const projectBrowserServers = new Map<string, BrowserServerHandle>()

// Singleton handle — set once when the first project starts the server
let sharedHandle: BrowserServerHandle | null = null

export async function startBrowserServer(
  projectId: string,
  config: BrowserProjectConfig,
): Promise<BrowserServerHandle> {
  const existing = projectBrowserServers.get(projectId)
  if (existing) return existing

  // Only start the underlying server once; subsequent projects reuse it
  if (!sharedHandle) {
    const resolved = resolveProjectBrowserConfig(config, projectId, 0)
    const state = await startBrowserControlServer(resolved)

    if (!state) {
      throw new Error(`[browser] Failed to start browser server for project ${projectId}`)
    }

    sharedHandle = {
      port: state.port,
      baseUrl: `http://127.0.0.1:${state.port}`,
    }
  }

  projectBrowserServers.set(projectId, sharedHandle)
  return sharedHandle
}

export async function stopBrowserServer(projectId: string): Promise<void> {
  if (!projectBrowserServers.has(projectId)) return
  await stopBrowserControlServer()
  projectBrowserServers.delete(projectId)
}

export async function stopAllBrowserServers(): Promise<void> {
  await Promise.all(Array.from(projectBrowserServers.keys()).map(stopBrowserServer))
}

export function getBrowserServerHandle(projectId: string): BrowserServerHandle | undefined {
  return projectBrowserServers.get(projectId)
}
