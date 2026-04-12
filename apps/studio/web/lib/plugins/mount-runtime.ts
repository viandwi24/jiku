// Plan 17 — isolated plugin runtime loader.
//
// Dynamically imports a plugin's compiled ESM bundle (served by the Studio
// server) and mounts it into a host-provided div. The bundler is bypassed
// with `new Function('u', 'return import(u)')` so Turbopack / webpack never
// tries to resolve the URL at build time.

import { useSyncExternalStore } from 'react'
import type { PluginContext } from '@jiku/kit/ui'

type Unmount = () => void
interface Mountable {
  mount: (
    el: HTMLElement,
    ctx: PluginContext,
    meta: Record<string, unknown>,
    subPath?: string,
  ) => Unmount | Promise<Unmount>
}

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const runtimeImport = new Function('u', 'return import(u)') as (u: string) => Promise<any>

// Module cache: key = full URL (with ?v=...) → module promise.
const moduleCache = new Map<string, Promise<Mountable>>()

// Per-plugin bust counter. Incrementing it gives every SlotIsland a new URL
// on its next render, forcing the browser to fetch a fresh bundle.
const bustVersion = new Map<string, number>()
const listeners = new Set<() => void>()

function subscribe(l: () => void): () => void {
  listeners.add(l)
  return () => listeners.delete(l)
}

function getVersion(pluginId: string): number {
  return bustVersion.get(pluginId) ?? 0
}

/** React hook — returns the current bust version for a plugin.
 *  SlotIsland uses this to re-render whenever `invalidatePlugin` is called. */
export function usePluginBustVersion(pluginId: string): number {
  return useSyncExternalStore(
    subscribe,
    () => getVersion(pluginId),
    () => 0,
  )
}

export async function loadMountable(assetUrl: string, version: string): Promise<Mountable> {
  const abs = assetUrl.startsWith('http') ? assetUrl : `${API_URL}${assetUrl}`
  // Registry already appends `?sig=&exp=` for signed URLs; concatenate the
  // reload-bust parameter correctly.
  const sep = abs.includes('?') ? '&' : '?'
  const url = `${abs}${sep}v=${encodeURIComponent(version)}`
  let pending = moduleCache.get(url)
  if (!pending) {
    pending = runtimeImport(url).then(mod => {
      const candidate = (mod.default ?? mod) as Mountable
      if (typeof candidate?.mount !== 'function') {
        throw new Error(
          `Plugin bundle at ${url} did not default-export a Mountable. ` +
          `Wrap your component with defineMountable() from @jiku/kit/ui.`,
        )
      }
      return candidate
    })
    moduleCache.set(url, pending)
  }
  return pending
}

/** Drop all cached modules for a plugin and bump its bust counter. Every
 *  SlotIsland for this plugin re-renders and pulls a fresh bundle. */
export function invalidatePlugin(pluginId: string): void {
  for (const key of moduleCache.keys()) {
    if (key.includes(`/plugins/${pluginId}/ui/`)) moduleCache.delete(key)
  }
  bustVersion.set(pluginId, getVersion(pluginId) + 1)
  listeners.forEach(l => { try { l() } catch { /* ignore */ } })
}
