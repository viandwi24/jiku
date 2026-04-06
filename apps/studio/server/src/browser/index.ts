import type { BrowserProjectConfig } from '@jiku-studio/db'
import { startBrowserControlServer, stopBrowserControlServer } from './browser/server.js'
import { resolveProjectBrowserConfig } from './config.js'

export type BrowserServerHandle = {
  port: number
  baseUrl: string
}

// projectId → handle
const projectBrowserServers = new Map<string, BrowserServerHandle>()

export async function startBrowserServer(
  projectId: string,
  config: BrowserProjectConfig,
): Promise<BrowserServerHandle> {
  const existing = projectBrowserServers.get(projectId)
  if (existing) return existing

  const portOffset = projectBrowserServers.size
  const resolved = resolveProjectBrowserConfig(config, projectId, portOffset)
  const state = await startBrowserControlServer(resolved)

  if (!state) {
    throw new Error(`[browser] Failed to start browser server for project ${projectId}`)
  }

  const handle: BrowserServerHandle = {
    port: state.port,
    baseUrl: `http://127.0.0.1:${state.port}`,
  }

  projectBrowserServers.set(projectId, handle)
  return handle
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
