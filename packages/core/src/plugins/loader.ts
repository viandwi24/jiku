import type {
  PluginDefinition,
  ToolDefinition,
  ResolvedTool,
  PluginLoaderInterface,
  CallerContext,
  JikuStorageAdapter,
  RuntimeContext,
} from '@jiku/types'
import { SharedRegistry } from './registry.ts'
import { sortPlugins } from './dependency.ts'
import { createHookAPI } from './hooks.ts'

export class PluginLoader implements PluginLoaderInterface {
  private plugins: PluginDefinition[] = []
  private registry = new SharedRegistry()
  private booted = false
  private storage: JikuStorageAdapter | null = null

  setStorage(storage: JikuStorageAdapter): void {
    this.storage = storage
  }

  register(...plugins: PluginDefinition[]): void {
    this.plugins.push(...plugins)
  }

  private prefixTool(plugin_id: string, tool: ToolDefinition): ResolvedTool {
    const resolved_id = `${plugin_id}:${tool.meta.id}`
    // Sanitize for LLM APIs that require ^[a-zA-Z0-9_-]+$
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

    // Phase 1+2: sort by dependency order
    const sorted = sortPlugins(this.plugins)

    // Phase 3: setup each plugin
    for (const plugin of sorted) {
      const pluginId = plugin.meta.id
      const pluginStorage = this.registry.makePluginStorage(pluginId, this.storage)
      const hookAPI = createHookAPI()
      const pendingTools: ToolDefinition[] = []

      const ctx = {
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

      plugin.setup(ctx)

      const resolved = pendingTools.map(t => this.prefixTool(pluginId, t))
      this.registry.registerTools(resolved)

      console.log(`[jiku] ${pluginId} loaded — ${resolved.length} tool(s) registered`)
    }

    this.booted = true
  }

  async stop(): Promise<void> {
    for (const plugin of [...this.plugins].reverse()) {
      await plugin.onDeactivated?.()
    }
    this.booted = false
  }

  getResolvedTools(): ResolvedTool[] {
    return this.registry.getResolvedTools()
  }

  getPromptSegments(): string[] {
    // Sync wrapper — segments are resolved lazily during prompt build
    // For async segments, callers should use getPromptSegmentsAsync()
    return []
  }

  async getPromptSegmentsAsync(): Promise<string[]> {
    return this.registry.getPromptSegments()
  }

  resolveProviders(caller: CallerContext): Record<string, unknown> {
    return this.registry.resolveProviders(caller)
  }
}
