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
  ConnectorEvent,
  ConnectorEventType,
  ConnectorTarget,
  ConnectorContent,
  ConnectorSendResult,
  ConnectorContext,
  ConnectorAction,
  PluginUIDefinition,
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
  ConnectorEvent,
  ConnectorEventType,
  ConnectorTarget,
  ConnectorContent,
  ConnectorSendResult,
  ConnectorContext,
  ConnectorAction,
  PluginUIDefinition,
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
  ui?: PluginUIDefinition
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
  ui?: PluginUIDefinition
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

// ─────────────────────────────────────────────────────────────────────────────
// CONNECTOR SYSTEM
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Abstract base class for connector adapters.
 *
 * Connector plugins are plain `definePlugin()` plugins. Inside `setup()`,
 * register the adapter instance via the `connector:register` hook so the
 * server ConnectorRegistry picks it up.
 *
 * @example
 * class TelegramAdapter extends ConnectorAdapter {
 *   readonly id = 'jiku.telegram'
 *   // ...
 * }
 *
 * const telegramAdapter = new TelegramAdapter()
 *
 * export default definePlugin({
 *   meta: { id: 'jiku.telegram', name: 'Telegram', version: '1.0.0' },
 *   setup(ctx) {
 *     ctx.hooks.callHook('connector:register', telegramAdapter).catch(() => {})
 *   },
 * })
 */
// Minimal Zod-compatible shape for credential schemas — avoids importing zod as a dep in kit
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type CredentialSchemaLike = any

export abstract class ConnectorAdapter {
  abstract readonly id: string
  abstract readonly displayName: string
  /** Credential adapter_id this connector expects (e.g. 'telegram') */
  abstract readonly credentialAdapterId: string
  /** Optional display name for the credential type (defaults to displayName) */
  readonly credentialDisplayName?: string
  /** Platform-specific ref key names, e.g. ['message_id', 'chat_id'] */
  abstract readonly refKeys: string[]
  abstract readonly supportedEvents: readonly ConnectorEventType[]
  /**
   * Zod schema describing the credential fields this connector needs.
   * Used to auto-generate the credential form UI.
   * Fields with `z.string()` become plain text inputs.
   * Fields described with `.describe('secret')` become password inputs.
   *
   * @example
   * credentialSchema = z.object({
   *   bot_token: z.string().describe('secret').min(1),
   * })
   */
  readonly credentialSchema?: CredentialSchemaLike

  abstract onActivate(ctx: ConnectorContext): Promise<void>
  abstract onDeactivate(): Promise<void>
  abstract parseEvent(raw: unknown): ConnectorEvent | null
  abstract sendMessage(target: ConnectorTarget, content: ConnectorContent): Promise<ConnectorSendResult>

  sendReaction?(target: ConnectorTarget, emoji: string): Promise<void>
  deleteMessage?(target: ConnectorTarget): Promise<void>
  editMessage?(target: ConnectorTarget, content: ConnectorContent): Promise<void>
  getHistory?(refKeys: Record<string, string>, limit: number): Promise<ConnectorEvent[]>
  /** Send a typing/processing indicator to the target chat */
  sendTyping?(target: ConnectorTarget): Promise<void>

  /**
   * List of platform-specific actions this adapter supports beyond the standard interface.
   * Exposed to agents via connector_list_actions tool.
   */
  readonly actions?: ConnectorAction[]

  /**
   * Execute a platform-specific action by id.
   * Called by the connector_run_action tool.
   */
  runAction?(actionId: string, params: Record<string, unknown>): Promise<unknown>
}
