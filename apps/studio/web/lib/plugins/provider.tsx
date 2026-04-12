'use client'

// Plan 17 — PluginUIProvider.
//
// Fetches `/api/plugins/ui-registry` and exposes a slot-indexed view that
// <Slot> consumes. No plugin source is imported here — the host only knows
// the manifest (slot + assetUrl + meta). Plugin modules are fetched and
// mounted at render time by mount-runtime.

import { createContext, useContext, useMemo, type ReactNode } from 'react'
import { useQuery } from '@tanstack/react-query'
import { pluginUiApi, type RegistryPlugin } from './api-client'
import type { PluginUIEntry } from '@jiku/types'

export interface RegistryPluginEntry extends PluginUIEntry {
  pluginId: string
  pluginVersion: string
  /** Browser-reachable URL for the compiled ESM bundle. */
  assetUrl: string
}

export interface PluginUIRegistryState {
  plugins: RegistryPlugin[]
  isLoading: boolean
  error: Error | null
  entriesBySlot: Record<string, RegistryPluginEntry[]>
  getPlugin(pluginId: string): RegistryPlugin | undefined
}

const Ctx = createContext<PluginUIRegistryState | null>(null)

export function usePluginUIRegistry(): PluginUIRegistryState {
  const v = useContext(Ctx)
  if (!v) throw new Error('usePluginUIRegistry() must be used within <PluginUIProvider>')
  return v
}

/** Non-throwing variant — returns null when rendered outside a provider. */
export function useOptionalPluginUIRegistry(): PluginUIRegistryState | null {
  return useContext(Ctx)
}

export function PluginUIProvider({ projectId, children }: { projectId: string; children: ReactNode }) {
  const q = useQuery({
    queryKey: ['plugin-ui-registry', projectId],
    queryFn: () => pluginUiApi.registry(projectId),
    enabled: !!projectId,
    staleTime: 30_000,
  })

  const state = useMemo<PluginUIRegistryState>(() => {
    const plugins = (q.data?.plugins ?? []).filter(p => p.enabled)
    const entriesBySlot: Record<string, RegistryPluginEntry[]> = {}
    for (const p of plugins) {
      for (const e of p.uiEntries) {
        if (!entriesBySlot[e.slot]) entriesBySlot[e.slot] = []
        entriesBySlot[e.slot]!.push({
          ...e,
          pluginId: p.id,
          pluginVersion: p.version,
          assetUrl: (e as { assetUrl?: string }).assetUrl ?? '',
        })
      }
    }
    for (const slot of Object.keys(entriesBySlot)) {
      entriesBySlot[slot]!.sort((a, b) => {
        const ao = (a.meta as { order?: number }).order ?? 9999
        const bo = (b.meta as { order?: number }).order ?? 9999
        if (ao !== bo) return ao - bo
        return `${a.pluginId}:${a.id}`.localeCompare(`${b.pluginId}:${b.id}`)
      })
    }
    return {
      plugins,
      isLoading: q.isLoading,
      error: (q.error as Error | null) ?? null,
      entriesBySlot,
      getPlugin: (pluginId: string) => plugins.find(p => p.id === pluginId),
    }
  }, [q.data, q.isLoading, q.error])

  return <Ctx.Provider value={state}>{children}</Ctx.Provider>
}
