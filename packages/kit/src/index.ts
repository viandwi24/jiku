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
  ProjectPluginContext,
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
  ProjectPluginContext,
}

// Minimal ZodObject shape — avoids importing zod as a dep in kit
interface ZodObjectLike<TOutput> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  parse(data: unknown): TOutput
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  safeParse(data: unknown): { success: boolean; data?: TOutput; error?: unknown }
  _output: TOutput
}

/**
 * Define a plugin with optional typed dependency injection and typed config schema.
 *
 * When `depends` includes plugin instances (not strings), their contributed context
 * is merged into `ctx` in `setup()` with full type safety.
 *
 * When `configSchema` is a Zod object, `onProjectPluginActivated` / `onProjectPluginDeactivated`
 * receive `ctx.config` typed as the schema's output.
 *
 * @example
 * const MyPlugin = definePlugin({
 *   meta: { id: 'my.plugin', name: 'My Plugin', version: '1.0.0', project_scope: true },
 *   configSchema: z.object({ api_key: z.string() }),
 *   onProjectPluginActivated: async (projectId, ctx) => {
 *     ctx.config.api_key  // ✅ typed as string
 *   },
 * })
 */
export function definePlugin<
  Deps extends PluginDependency[],
  TContributes extends ContributesValue = Record<never, never>,
  TConfigOutput = Record<string, unknown>,
>(def: {
  meta: PluginMeta
  depends: Deps
  contributes?: Contributes<TContributes>
  configSchema?: ZodObjectLike<TConfigOutput>
  setup: (ctx: BasePluginContext & MergeContributes<Deps>) => void
  onActivated?: (ctx: CallerContext) => void | Promise<void>
  onDeactivated?: () => void | Promise<void>
  onProjectPluginActivated?: (projectId: string, ctx: ProjectPluginContext<TConfigOutput>) => void | Promise<void>
  onProjectPluginDeactivated?: (projectId: string, ctx: ProjectPluginContext<TConfigOutput>) => void | Promise<void>
  onServerStop?: (ctx: BasePluginContext & MergeContributes<Deps>) => void | Promise<void>
}): PluginDefinition<TContributes>

export function definePlugin<
  TContributes extends ContributesValue = Record<never, never>,
  TConfigOutput = Record<string, unknown>,
>(def: {
  meta: PluginMeta
  depends?: never
  contributes?: Contributes<TContributes>
  configSchema?: ZodObjectLike<TConfigOutput>
  setup: (ctx: BasePluginContext) => void
  onActivated?: (ctx: CallerContext) => void | Promise<void>
  onDeactivated?: () => void | Promise<void>
  onProjectPluginActivated?: (projectId: string, ctx: ProjectPluginContext<TConfigOutput>) => void | Promise<void>
  onProjectPluginDeactivated?: (projectId: string, ctx: ProjectPluginContext<TConfigOutput>) => void | Promise<void>
  onServerStop?: (ctx: BasePluginContext) => void | Promise<void>
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
