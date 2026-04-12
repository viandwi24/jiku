'use client'

// Plan 17 — <Slot> renders all plugin entries against `name`.
// Each entry becomes an isolated "island": a div into which the plugin's
// compiled bundle mounts its OWN React root. Host/plugin React instances
// are fully separate — a plugin crash can never corrupt Studio's tree.

import { useEffect, useRef, useState, type ReactNode } from 'react'
import { usePluginUIRegistry, type RegistryPluginEntry } from './provider'
import { PluginErrorBoundary } from './boundary'
import { usePluginContextFactory, type PluginContextInput } from './build-ctx'
import { loadMountable, usePluginBustVersion } from './mount-runtime'

interface SlotProps {
  name: string
  contextBase: Omit<PluginContextInput, 'pluginId' | 'pluginVersion'>
  subPath?: string
  renderEntry?: (entry: RegistryPluginEntry, node: ReactNode) => ReactNode
  empty?: ReactNode
}

export function Slot({ name, contextBase, subPath, renderEntry, empty = null }: SlotProps) {
  const { entriesBySlot, isLoading } = usePluginUIRegistry()
  const entries = entriesBySlot[name] ?? []

  if (isLoading && entries.length === 0) return null
  if (entries.length === 0) return <>{empty}</>

  return (
    <>
      {entries.map(entry => {
        const node = (
          <SlotIsland
            key={`${entry.pluginId}:${entry.id}`}
            entry={entry}
            contextBase={contextBase}
            subPath={subPath}
          />
        )
        return renderEntry ? renderEntry(entry, node) : node
      })}
    </>
  )
}

interface IslandProps {
  entry: RegistryPluginEntry
  contextBase: Omit<PluginContextInput, 'pluginId' | 'pluginVersion'>
  subPath?: string
}

export function SlotIsland({ entry, contextBase, subPath }: IslandProps) {
  return (
    <PluginErrorBoundary pluginId={entry.pluginId} entryId={entry.id}>
      <SlotIslandInner entry={entry} contextBase={contextBase} subPath={subPath} />
    </PluginErrorBoundary>
  )
}

function SlotIslandInner({ entry, contextBase, subPath }: IslandProps) {
  const ctx = usePluginContextFactory({
    ...contextBase,
    pluginId: entry.pluginId,
    pluginVersion: entry.pluginVersion,
  })
  const hostRef = useRef<HTMLDivElement>(null)
  const [error, setError] = useState<Error | null>(null)
  const [ready, setReady] = useState(false)
  const [localReloadKey, setLocalReloadKey] = useState(0)
  const globalBust = usePluginBustVersion(entry.pluginId)

  useEffect(() => {
    if (!hostRef.current) return
    let cancelled = false
    let unmountFn: (() => void) | null = null
    setError(null)
    setReady(false)

    ;(async () => {
      try {
        const mod = await loadMountable(
          entry.assetUrl,
          `${entry.pluginVersion}.${globalBust}.${localReloadKey}`,
        )
        if (cancelled || !hostRef.current) return
        const maybeUnmount = await mod.mount(hostRef.current, ctx, entry.meta as Record<string, unknown>, subPath)
        if (cancelled) { maybeUnmount?.(); return }
        unmountFn = maybeUnmount ?? null
        setReady(true)
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e : new Error(String(e)))
      }
    })()

    return () => {
      cancelled = true
      try { unmountFn?.() } catch { /* plugin misbehaved — ignore */ }
    }
  }, [entry.assetUrl, entry.pluginVersion, globalBust, localReloadKey, subPath, ctx, entry.meta])

  if (error) {
    return (
      <div className="rounded-md border border-destructive/40 bg-destructive/5 p-4 text-sm">
        <div className="font-medium text-destructive">
          Plugin "{entry.pluginId}" failed to load
        </div>
        <div className="mt-1 text-xs text-muted-foreground">{error.message}</div>
        <button
          type="button"
          onClick={() => setLocalReloadKey(k => k + 1)}
          className="mt-2 rounded border px-2 py-1 text-xs hover:bg-accent"
        >
          Reload
        </button>
      </div>
    )
  }

  return <div ref={hostRef} data-plugin-id={entry.pluginId} data-plugin-entry={entry.id} style={{ display: ready ? undefined : 'none' }} />
}
