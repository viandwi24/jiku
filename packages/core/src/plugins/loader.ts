import type {
  PluginDefinition,
  ToolDefinition,
  ResolvedTool,
  PluginLoaderInterface,
  CallerContext,
  JikuStorageAdapter,
  BasePluginContext,
  ContributesValue,
  ProjectPluginContext,
  PluginSkillSpec,
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

interface RegisteredTool {
  tool: ResolvedTool
  plugin_id: string
}

interface RegisteredPrompt {
  segment: string | (() => Promise<string>)
  plugin_id: string
}

export class PluginLoader implements PluginLoaderInterface {
  private plugins = new Map<string, AnyPluginDef>()
  private overrides = new Map<string, Partial<AnyPluginDef>>()
  private registry = new SharedRegistry()
  private booted = false
  private loadOrder: string[] = []
  private storage: JikuStorageAdapter | null = null

  // New: per-tool and per-prompt tracking with plugin_id
  private registeredTools: RegisteredTool[] = []
  private registeredPrompts: RegisteredPrompt[] = []

  // Plan 19 — per-plugin skill specs collected during setup
  private registeredSkills = new Map<string, PluginSkillSpec[]>()
  // Plugin root directory (absolute path on disk) for plugins discovered from FS.
  // Required to resolve `source: 'folder'` skill spec paths.
  private pluginRoots = new Map<string, string>()

  // New: per-project enabled plugin sets
  private projectEnabledPlugins = new Map<string, Set<string>>()

  // Global hook listeners: event → handlers[]
  private globalHookListeners = new Map<string, Array<(payload: unknown) => Promise<void>>>()

  /** Plan 17 — host-provided extender that adds fields (e.g. http, events) to each plugin's setup ctx. */
  private contextExtender: ((pluginId: string, baseCtx: BasePluginContext) => BasePluginContext) | null = null

  setContextExtender(fn: (pluginId: string, baseCtx: BasePluginContext) => BasePluginContext): void {
    this.contextExtender = fn
  }

  setStorage(storage: JikuStorageAdapter): void {
    this.storage = storage
  }

  /**
   * Register a global hook listener that fires whenever ANY plugin calls
   * `ctx.hooks.callHook(event, payload)` during setup/boot.
   * Must be registered before `boot()` is called.
   */
  onHook(event: string, handler: (payload: unknown) => Promise<void>): void {
    const listeners = this.globalHookListeners.get(event) ?? []
    listeners.push(handler)
    this.globalHookListeners.set(event, listeners)
  }

  register(...plugins: AnyPluginDef[]): void {
    for (const p of plugins) this.plugins.set(p.meta.id, p)
  }

  /** Plan 19 — record a plugin's root directory (used for resolving skill folder specs). */
  setPluginRoot(pluginId: string, root: string): void {
    this.pluginRoots.set(pluginId, root)
  }

  getPluginRoot(pluginId: string): string | undefined {
    return this.pluginRoots.get(pluginId)
  }

  /** Plan 19 — return all skills contributed by a plugin during setup. */
  getPluginSkills(pluginId: string): PluginSkillSpec[] {
    return this.registeredSkills.get(pluginId) ?? []
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

  getAllPlugins(): PluginDefinition<ContributesValue>[] {
    return [...this.plugins.values()]
  }

  setProjectEnabledPlugins(projectId: string, pluginIds: string[]): void {
    this.projectEnabledPlugins.set(projectId, new Set(pluginIds))
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
      // Forward global hook listeners into this plugin's hookAPI
      for (const [event, handlers] of this.globalHookListeners) {
        for (const handler of handlers) {
          hookAPI.hook(event, handler)
        }
      }
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
      const registerTool = (...tools: ToolDefinition[]) => pendingTools.push(...tools)
      const injectPrompt = (segment: string | (() => Promise<string>)) => {
        this.registeredPrompts.push({ segment, plugin_id: pluginId })
      }
      const registerSkill = (spec: PluginSkillSpec) => {
        const arr = this.registeredSkills.get(pluginId) ?? []
        arr.push(spec)
        this.registeredSkills.set(pluginId, arr)
      }

      const baseCtx: BasePluginContext = {
        tools: {
          register: registerTool,
        },
        prompt: {
          inject: injectPrompt,
        },
        project: {
          tools: { register: registerTool },
          prompt: { inject: injectPrompt },
        },
        skills: {
          register: registerSkill,
        },
        hooks: hookAPI,
        storage: pluginStorage,
      }

      const extended = this.contextExtender ? this.contextExtender(pluginId, baseCtx) : baseCtx
      const ctx = { ...extended, ...mergedFromDeps } as BasePluginContext & Record<string, unknown>
      node.def.setup(ctx)

      // Register tools with plugin_id tracking
      const resolved = pendingTools.map(t => this.prefixTool(pluginId, t))
      for (const tool of resolved) {
        this.registeredTools.push({ tool, plugin_id: pluginId })
      }
      // Keep registry in sync for backward compat
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

  /**
   * Trigger onServerStop lifecycle for all registered plugins.
   * Called when the server is shutting down.
   */
  async stopPlugins(): Promise<void> {
    const storage = this.storage
    for (const id of [...this.loadOrder].reverse()) {
      const plugin = this.plugins.get(id)
      if (!plugin?.onServerStop) continue
      const pluginStorage = storage
        ? this.registry.makePluginStorage(id, storage)
        : { get: async () => null, set: async () => {}, delete: async () => {}, keys: async () => [] } as unknown as import('@jiku/types').PluginStorageAPI
      const hookAPI = createHookAPI()
      const ctx: BasePluginContext = {
        tools: { register: () => {} },
        prompt: { inject: () => {} },
        project: {
          tools: { register: () => {} },
          prompt: { inject: () => {} },
        },
        skills: { register: () => {} },
        hooks: hookAPI,
        storage: pluginStorage,
      }
      try {
        await plugin.onServerStop(ctx)
      } catch (err) {
        console.warn(`[jiku] onServerStop error in plugin "${id}":`, err)
      }
    }
  }

  /**
   * Returns resolved tools, optionally filtered by project context.
   * - No projectId: returns all tools (backward compat).
   * - With projectId: system plugins (project_scope falsy) always included;
   *   project-scoped plugins included only if enabled for that project.
   */
  getResolvedTools(projectId?: string): ResolvedTool[] {
    if (!projectId) {
      return this.registeredTools.map(r => r.tool)
    }
    const enabled = this.projectEnabledPlugins.get(projectId) ?? new Set<string>()
    return this.registeredTools
      .filter(r => {
        const plugin = this.plugins.get(r.plugin_id)
        if (!plugin) return false
        if (!plugin.meta.project_scope) return true  // system plugin — always included
        return enabled.has(r.plugin_id)              // project-scoped — only if enabled
      })
      .map(r => r.tool)
  }

  /**
   * Returns prompt segments synchronously (empty — use getPromptSegmentsAsync for resolved values).
   * Kept for PluginLoaderInterface backward compat.
   */
  getPromptSegments(projectId?: string): string[] {
    // Synchronous version returns only string segments (not async factories)
    if (!projectId) {
      return this.registeredPrompts
        .filter(r => typeof r.segment === 'string')
        .map(r => r.segment as string)
    }
    const enabled = this.projectEnabledPlugins.get(projectId) ?? new Set<string>()
    return this.registeredPrompts
      .filter(r => {
        if (typeof r.segment !== 'string') return false
        const plugin = this.plugins.get(r.plugin_id)
        if (!plugin) return false
        if (!plugin.meta.project_scope) return true
        return enabled.has(r.plugin_id)
      })
      .map(r => r.segment as string)
  }

  /**
   * Returns all prompt segments (including async factories), optionally filtered by project.
   */
  /**
   * Like getPromptSegmentsAsync but returns the owning plugin's id + name
   * alongside each segment — used by the preview UI to label segments per
   * plugin instead of a generic "Plugin Segment N".
   */
  async getPromptSegmentsWithMetaAsync(projectId?: string): Promise<Array<{ plugin_id: string; plugin_name: string; segment: string }>> {
    const filtered = !projectId
      ? this.registeredPrompts
      : (() => {
          const enabled = this.projectEnabledPlugins.get(projectId) ?? new Set<string>()
          return this.registeredPrompts.filter(r => {
            const plugin = this.plugins.get(r.plugin_id)
            if (!plugin) return false
            if (!plugin.meta.project_scope) return true
            return enabled.has(r.plugin_id)
          })
        })()

    return Promise.all(
      filtered.map(async r => {
        const plugin = this.plugins.get(r.plugin_id)
        const seg = typeof r.segment === 'string' ? r.segment : await r.segment()
        return {
          plugin_id: r.plugin_id,
          plugin_name: plugin?.meta.name ?? r.plugin_id,
          segment: seg,
        }
      })
    )
  }

  async getPromptSegmentsAsync(projectId?: string): Promise<string[]> {
    if (!projectId) {
      return Promise.all(
        this.registeredPrompts.map(r =>
          typeof r.segment === 'string' ? r.segment : r.segment()
        )
      )
    }
    const enabled = this.projectEnabledPlugins.get(projectId) ?? new Set<string>()
    const filtered = this.registeredPrompts.filter(r => {
      const plugin = this.plugins.get(r.plugin_id)
      if (!plugin) return false
      if (!plugin.meta.project_scope) return true
      return enabled.has(r.plugin_id)
    })
    return Promise.all(
      filtered.map(r => typeof r.segment === 'string' ? r.segment : r.segment())
    )
  }

  async activatePlugin(projectId: string, pluginId: string, config: unknown, { updateSet = true } = {}): Promise<void> {
    const plugin = this.plugins.get(pluginId)

    if (updateSet) {
      const enabled = this.projectEnabledPlugins.get(projectId) ?? new Set<string>()
      enabled.add(pluginId)
      this.projectEnabledPlugins.set(projectId, enabled)
    }

    if (!plugin?.onProjectPluginActivated) return

    const storage = this.storage!
    const pluginStorage = this.registry.makePluginStorage(`${projectId}:${pluginId}`, storage)
    const hookAPI = createHookAPI()
    const ctx: ProjectPluginContext = {
      projectId,
      config: config as Record<string, unknown>,
      storage: pluginStorage,
      hooks: hookAPI,
    }
    await plugin.onProjectPluginActivated(projectId, ctx)
  }

  async deactivatePlugin(projectId: string, pluginId: string, config: Record<string, unknown> = {}): Promise<void> {
    const plugin = this.plugins.get(pluginId)

    // Remove from enabled set
    const enabled = this.projectEnabledPlugins.get(projectId)
    enabled?.delete(pluginId)

    if (!plugin?.onProjectPluginDeactivated) return

    const storage = this.storage!
    const pluginStorage = this.registry.makePluginStorage(`${projectId}:${pluginId}`, storage)
    const hookAPI = createHookAPI()
    const ctx: ProjectPluginContext = {
      projectId,
      config,
      storage: pluginStorage,
      hooks: hookAPI,
    }
    await plugin.onProjectPluginDeactivated(projectId, ctx)
  }

  resolveProviders(caller: CallerContext): Record<string, unknown> {
    return this.registry.resolveProviders(caller)
  }
}
