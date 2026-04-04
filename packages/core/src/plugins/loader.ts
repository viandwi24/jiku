import type {
  PluginDefinition,
  ToolDefinition,
  ResolvedTool,
  PluginLoaderInterface,
  CallerContext,
  JikuStorageAdapter,
  RuntimeContext,
  BasePluginContext,
} from '@jiku/types'
import { SharedRegistry } from './registry.ts'
import {
  buildGraph,
  detectCircular,
  detectMissing,
  topoSort,
  resolveContributes,
} from './dependency.ts'
import { createHookAPI } from './hooks.ts'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyPluginDef = PluginDefinition<any>

export class PluginLoader implements PluginLoaderInterface {
  private plugins = new Map<string, AnyPluginDef>()
  private overrides = new Map<string, Partial<AnyPluginDef>>()
  private registry = new SharedRegistry()
  private booted = false
  private loadOrder: string[] = []
  private storage: JikuStorageAdapter | null = null

  setStorage(storage: JikuStorageAdapter): void {
    this.storage = storage
  }

  register(...plugins: AnyPluginDef[]): void {
    for (const p of plugins) this.plugins.set(p.meta.id, p)
  }

  override(pluginId: string, newDef: Partial<AnyPluginDef>): void {
    this.overrides.set(pluginId, newDef)
  }

  isLoaded(id: string): boolean {
    return this.loadOrder.includes(id)
  }

  getLoadOrder(): string[] {
    return [...this.loadOrder]
  }

  private prefixTool(plugin_id: string, tool: ToolDefinition): ResolvedTool {
    const resolved_id = `${plugin_id}:${tool.meta.id}`
    const tool_name = resolved_id.replace(/[^a-zA-Z0-9_-]/g, '_').replace(/__+/g, '_')
    return {
      ...tool,
      plugin_id,
      resolved_id,
      tool_name,
      resolved_permission: tool.permission === '*' ? '*' : `${plugin_id}:${tool.permission}`,
    }
  }

  async boot(): Promise<void> {
    if (this.booted) return
    if (!this.storage) throw new Error('PluginLoader: call setStorage() before boot()')

    // Apply overrides
    const allDefs = [...this.plugins.values()].map(def => {
      const ov = this.overrides.get(def.meta.id)
      return ov ? { ...def, ...ov } : def
    })

    // Phase 1 — Build graph
    const graph = buildGraph(allDefs)

    // Phase 2a — Circular detection (throws if cycle found)
    detectCircular(graph)

    // Phase 2b — Missing detection (warn + disable, continue boot)
    const missing = detectMissing(graph)
    for (const [id, missingDeps] of missing) {
      console.warn(
        `[jiku] ⚠ Plugin "${id}" disabled\n` +
        `  Reason: missing dependencies: ${missingDeps.join(', ')}`
      )
      graph.delete(id)
    }

    // Phase 2c — Topological sort
    const sorted = topoSort(graph)
    this.loadOrder = sorted

    // Phase 3 — Load (in sorted order)
    const contributesCache = new Map<string, Record<string, unknown>>()

    for (const id of sorted) {
      const node = graph.get(id)!
      const pluginId = node.def.meta.id
      const pluginStorage = this.registry.makePluginStorage(pluginId, this.storage)
      const hookAPI = createHookAPI()
      const pendingTools: ToolDefinition[] = []

      // 3a: Resolve this plugin's contributes
      const contributed = await resolveContributes(node.def.contributes)
      contributesCache.set(id, contributed)

      // 3b: Merge contributes from all instance deps
      const mergedFromDeps: Record<string, unknown> = {}
      for (const instanceDep of node.instanceDeps) {
        const depContributes = contributesCache.get(instanceDep.meta.id) ?? {}
        Object.assign(mergedFromDeps, depContributes)
      }

      // 3c: Build ctx and run setup
      const baseCtx: BasePluginContext = {
        tools: {
          register: (...tools: ToolDefinition[]) => pendingTools.push(...tools),
        },
        prompt: {
          inject: (segment: string | (() => Promise<string>)) =>
            this.registry.injectPromptSegment(segment),
        },
        hooks: hookAPI,
        storage: pluginStorage,
        provide: <K extends keyof RuntimeContext>(
          key: K,
          factory: (ctx: CallerContext) => RuntimeContext[K]
        ) => {
          this.registry.registerProvider(key as string, factory as (ctx: CallerContext) => unknown)
        },
      }

      const ctx = { ...baseCtx, ...mergedFromDeps } as BasePluginContext & Record<string, unknown>
      node.def.setup(ctx)

      const resolved = pendingTools.map(t => this.prefixTool(pluginId, t))
      this.registry.registerTools(resolved)

      console.log(`[jiku] ✓ ${pluginId} loaded — ${resolved.length} tool(s) registered`)
    }

    this.booted = true
  }

  async stop(): Promise<void> {
    const reversed = [...this.loadOrder].reverse()
    for (const id of reversed) {
      const plugin = this.plugins.get(id)
      await plugin?.onDeactivated?.()
    }
    this.booted = false
  }

  getResolvedTools(): ResolvedTool[] {
    return this.registry.getResolvedTools()
  }

  getPromptSegments(): string[] {
    return []
  }

  async getPromptSegmentsAsync(): Promise<string[]> {
    return this.registry.getPromptSegments()
  }

  resolveProviders(caller: CallerContext): Record<string, unknown> {
    return this.registry.resolveProviders(caller)
  }
}
