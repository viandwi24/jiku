import type {
  ToolDefinition,
  PluginDefinition,
  AgentDefinition,
  ToolContext,
  RuntimeContext,
  PluginMeta,
  PluginDependency,
  ContributesValue,
  Contributes,
  MergeContributes,
  BasePluginContext,
  CallerContext,
} from '@jiku/types'

export type {
  ToolDefinition,
  PluginDefinition,
  AgentDefinition,
  ToolContext,
  RuntimeContext,
  PluginDependency,
  ContributesValue,
  BasePluginContext,
}

/**
 * Define a plugin with optional typed dependency injection.
 *
 * When `depends` includes plugin instances (not strings), their contributed context
 * is merged into `ctx` in `setup()` with full type safety.
 *
 * @example
 * const MyPlugin = definePlugin({
 *   meta: { id: 'my.plugin', name: 'My Plugin', version: '1.0.0' },
 *   depends: [DatabasePlugin],  // instance dep → ctx.database is typed
 *   setup(ctx) {
 *     ctx.database.query('posts')  // ✅ typed
 *   }
 * })
 */
export function definePlugin<
  Deps extends PluginDependency[],
  TContributes extends ContributesValue = Record<never, never>,
>(def: {
  meta: PluginMeta
  depends: Deps
  contributes?: Contributes<TContributes>
  setup: (ctx: BasePluginContext & MergeContributes<Deps>) => void
  onActivated?: (ctx: CallerContext) => void | Promise<void>
  onDeactivated?: () => void | Promise<void>
}): PluginDefinition<TContributes>

export function definePlugin<
  TContributes extends ContributesValue,
>(def: {
  meta: PluginMeta
  depends?: never
  contributes?: Contributes<TContributes>
  setup: (ctx: BasePluginContext) => void
  onActivated?: (ctx: CallerContext) => void | Promise<void>
  onDeactivated?: () => void | Promise<void>
}): PluginDefinition<TContributes>

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function definePlugin(def: any): any {
  // _contributes_type is phantom — not set at runtime, only used by TypeScript
  return def
}

export function defineTool(def: ToolDefinition): ToolDefinition {
  return def
}

export function defineAgent(def: AgentDefinition): AgentDefinition {
  return def
}

export function getJikuContext(toolCtx: ToolContext): RuntimeContext {
  return toolCtx.runtime
}
