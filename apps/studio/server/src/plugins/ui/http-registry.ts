// Per-plugin HTTP handler registry.
// Plugins register handlers at setup time via `ctx.http.get/post/etc`, and the
// Studio server mounts them under `/api/plugins/:id/api/*`.

import type { Request, Response } from 'express'
import type { PluginHttpMethod } from '@jiku-plugin/studio'

export type { PluginHttpMethod }

export interface PluginHttpContext {
  projectId: string
  userId: string
  pluginId: string
  req: Request
  res: Response
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type PluginHttpHandler = (ctx: PluginHttpContext) => Promise<any> | any

interface Entry {
  method: PluginHttpMethod
  path: string
  handler: PluginHttpHandler
}

const registry = new Map<string, Entry[]>()

export function registerPluginRoute(pluginId: string, method: PluginHttpMethod, path: string, handler: PluginHttpHandler): void {
  const normalized = path.startsWith('/') ? path : `/${path}`
  const list = registry.get(pluginId) ?? []
  list.push({ method, path: normalized, handler })
  registry.set(pluginId, list)
}

export function resolvePluginRoute(pluginId: string, method: PluginHttpMethod, path: string): PluginHttpHandler | null {
  const normalized = path.startsWith('/') ? path : `/${path}`
  const list = registry.get(pluginId) ?? []
  for (const e of list) {
    if (e.method === method && e.path === normalized) return e.handler
  }
  return null
}

export function listPluginRoutes(pluginId: string): Array<{ method: PluginHttpMethod; path: string }> {
  return (registry.get(pluginId) ?? []).map(e => ({ method: e.method, path: e.path }))
}

export function clearPluginRoutes(pluginId: string): void {
  registry.delete(pluginId)
}
