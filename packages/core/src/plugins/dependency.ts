import type { PluginDefinition } from '@jiku/types'

/**
 * Topological sort using Kahn's algorithm.
 * Returns plugins in load order, skipping any with missing dependencies.
 */
export function sortPlugins(plugins: PluginDefinition[]): PluginDefinition[] {
  const pluginMap = new Map(plugins.map(p => [p.meta.id, p]))
  const inDegree = new Map<string, number>()
  const adjList = new Map<string, string[]>()

  for (const plugin of plugins) {
    inDegree.set(plugin.meta.id, 0)
    adjList.set(plugin.meta.id, [])
  }

  const skipped = new Set<string>()

  for (const plugin of plugins) {
    for (const dep of plugin.dependencies ?? []) {
      if (!pluginMap.has(dep)) {
        console.warn(`[jiku] Plugin '${plugin.meta.id}' requires missing dep '${dep}' — skipping`)
        skipped.add(plugin.meta.id)
        break
      }
      // dep must load before plugin → dep → plugin edge
      adjList.get(dep)!.push(plugin.meta.id)
      inDegree.set(plugin.meta.id, (inDegree.get(plugin.meta.id) ?? 0) + 1)
    }
  }

  const queue = [...inDegree.entries()]
    .filter(([id, deg]) => deg === 0 && !skipped.has(id))
    .map(([id]) => id)

  const sorted: PluginDefinition[] = []

  while (queue.length > 0) {
    const id = queue.shift()!
    if (skipped.has(id)) continue
    sorted.push(pluginMap.get(id)!)
    for (const next of adjList.get(id) ?? []) {
      const deg = (inDegree.get(next) ?? 1) - 1
      inDegree.set(next, deg)
      if (deg === 0 && !skipped.has(next)) queue.push(next)
    }
  }

  return sorted
}
