import type { ResolvedTool, PluginStorageAPI, JikuStorageAdapter, CallerContext } from '@jiku/types'

export class SharedRegistry {
  private tools: ResolvedTool[] = []
  private promptSegments: Array<string | (() => Promise<string>)> = []
  private providers = new Map<string, (ctx: CallerContext) => unknown>()

  registerTools(tools: ResolvedTool[]): void {
    this.tools.push(...tools)
  }

  injectPromptSegment(segment: string | (() => Promise<string>)): void {
    this.promptSegments.push(segment)
  }

  registerProvider(key: string, factory: (ctx: CallerContext) => unknown): void {
    this.providers.set(key, factory)
  }

  getResolvedTools(): ResolvedTool[] {
    return this.tools
  }

  async getPromptSegments(): Promise<string[]> {
    return Promise.all(
      this.promptSegments.map(s => (typeof s === 'string' ? s : s()))
    )
  }

  resolveProviders(caller: CallerContext): Record<string, unknown> {
    const result: Record<string, unknown> = {}
    for (const [key, factory] of this.providers) {
      result[key] = factory(caller)
    }
    return result
  }

  makePluginStorage(pluginId: string, storage: JikuStorageAdapter): PluginStorageAPI {
    const scope = pluginId
    return {
      get: (key) => storage.pluginGet(scope, key),
      set: (key, value) => storage.pluginSet(scope, key, value),
      delete: (key) => storage.pluginDelete(scope, key),
      keys: (prefix) => storage.pluginKeys(scope, prefix),
    }
  }
}
