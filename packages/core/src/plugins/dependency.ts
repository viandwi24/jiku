import type { PluginDefinition, PluginDependency, Contributes, ContributesValue } from '@jiku/types'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyPluginDef = PluginDefinition<any>

// ============================================================
// PLUGIN NODE — internal graph node
// ============================================================

export interface PluginNode {
  id: string
  def: AnyPluginDef
  /** All dep IDs (normalized to string) — used for sort */
  deps: string[]
  /** Only instance deps — used to merge contributes into ctx */
  instanceDeps: AnyPluginDef[]
}

// ============================================================
// CIRCULAR DEPENDENCY ERROR
// ============================================================

export class PluginCircularDepError extends Error {
  constructor(public cycle: string[]) {
    const path = [...cycle, cycle[0]].join(' → ')
    super(
      `Circular dependency detected: ${path}\n\n` +
      `Involved plugins:\n` +
      cycle.map(id => `  - ${id}`).join('\n') +
      `\n\nFix: Remove one of the dependencies to break the cycle.`
    )
    this.name = 'PluginCircularDepError'
  }
}

// ============================================================
// NORMALIZE HELPERS
// ============================================================

function normalizeDeps(depends: PluginDependency[]): string[] {
  return depends.map(d => (typeof d === 'string' ? d : d.meta.id))
}

function getInstanceDeps(depends: PluginDependency[]): AnyPluginDef[] {
  return depends.filter((d): d is AnyPluginDef => typeof d !== 'string')
}

// ============================================================
// BUILD GRAPH
// ============================================================

export function buildGraph(plugins: AnyPluginDef[]): Map<string, PluginNode> {
  const graph = new Map<string, PluginNode>()
  for (const def of plugins) {
    const depends = def.depends ?? (def.dependencies?.map(d => d as PluginDependency) ?? [])
    graph.set(def.meta.id, {
      id: def.meta.id,
      def,
      deps: normalizeDeps(depends),
      instanceDeps: getInstanceDeps(depends),
    })
  }
  return graph
}

// ============================================================
// CIRCULAR DETECTION — DFS 3-color marking
// ============================================================

type NodeColor = 'white' | 'gray' | 'black'

export function detectCircular(graph: Map<string, PluginNode>): void {
  const color = new Map<string, NodeColor>()
  for (const id of graph.keys()) color.set(id, 'white')

  const stack: string[] = []

  function dfs(id: string): void {
    color.set(id, 'gray')
    stack.push(id)

    const node = graph.get(id)
    if (!node) {
      stack.pop()
      color.set(id, 'black')
      return
    }

    for (const dep of node.deps) {
      if (color.get(dep) === 'gray') {
        const cycle = stack.slice(stack.indexOf(dep))
        throw new PluginCircularDepError(cycle)
      }
      if (color.get(dep) === 'white' && graph.has(dep)) {
        dfs(dep)
      }
    }

    stack.pop()
    color.set(id, 'black')
  }

  for (const id of graph.keys()) {
    if (color.get(id) === 'white') dfs(id)
  }
}

// ============================================================
// MISSING DEPENDENCY DETECTION
// ============================================================

export function detectMissing(
  graph: Map<string, PluginNode>
): Map<string, string[]> {
  const missing = new Map<string, string[]>()
  for (const [id, node] of graph) {
    const missingDeps = node.deps.filter(dep => !graph.has(dep))
    if (missingDeps.length > 0) missing.set(id, missingDeps)
  }
  return missing
}

// ============================================================
// TOPOLOGICAL SORT — Kahn's algorithm
// ============================================================

export function topoSort(graph: Map<string, PluginNode>): string[] {
  const inDegree = new Map<string, number>()
  const adjList = new Map<string, string[]>()

  for (const id of graph.keys()) {
    inDegree.set(id, 0)
    adjList.set(id, [])
  }

  for (const [id, node] of graph) {
    for (const dep of node.deps) {
      if (!graph.has(dep)) continue
      adjList.get(dep)!.push(id)
      inDegree.set(id, (inDegree.get(id) ?? 0) + 1)
    }
  }

  const queue = [...inDegree.entries()]
    .filter(([, deg]) => deg === 0)
    .map(([id]) => id)

  const sorted: string[] = []

  while (queue.length > 0) {
    const id = queue.shift()!
    sorted.push(id)
    for (const next of adjList.get(id) ?? []) {
      const deg = (inDegree.get(next) ?? 1) - 1
      inDegree.set(next, deg)
      if (deg === 0) queue.push(next)
    }
  }

  return sorted
}

// ============================================================
// RESOLVE CONTRIBUTES — always a function, sync or async
// ============================================================

export async function resolveContributes(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  contributes: Contributes<any> | undefined
): Promise<Record<string, unknown>> {
  if (!contributes) return {}
  return await contributes()
}
