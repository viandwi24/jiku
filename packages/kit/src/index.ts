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
  ResolvedEventContext,
  ConnectorSetupSpec,
  ConnectorSetupSessionState,
  ConnectorSetupStepResult,
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
  ResolvedEventContext,
  ConnectorSetupSpec,
  ConnectorSetupSessionState,
  ConnectorSetupStepResult,
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

// ─── Browser adapter system (Plan 20) ──────────────────────────────────────

export {
  BrowserAdapter,
  defineBrowserAdapter,
} from './browser-adapter.ts'
export type {
  BrowserAdapterContext,
  BrowserAdapterResult,
  BrowserAdapterContentPart,
  BrowserAdapterTextPart,
  BrowserAdapterImagePart,
  BrowserAdapterConfigSchema,
  BrowserPingResult,
  BrowserPreviewResult,
  BrowserCustomAction,
} from './browser-adapter.ts'

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

  /**
   * Plan 24 — When true, Studio shows a "Setup" button on the credential
   * form (alongside or instead of standard "Save") and forbids activating
   * the credential until the interactive setup wizard runs to completion.
   * The wizard is driven by `getSetupSpec()` + `runSetupStep()`.
   */
  readonly requiresInteractiveSetup?: boolean

  abstract onActivate(ctx: ConnectorContext): Promise<void>
  /**
   * Tear down a previously-activated connector instance. The optional
   * `connectorId` argument lets adapters with per-credential state (Telegram
   * bot adapter holding one Bot per credential) deactivate the RIGHT instance.
   * Adapters that ignore the argument fall back to the legacy "deactivate
   * the only known instance" behaviour — fine for single-credential adapters.
   * Server (`activation.ts`) always passes the connectorId being deactivated.
   */
  abstract onDeactivate(connectorId?: string): Promise<void>
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
  runAction?(actionId: string, params: Record<string, unknown>, connectorId?: string): Promise<unknown>

  /**
   * Plan 22 — Compute scope_key for a parsed event.
   * Default returns undefined (DM/single-chat adapters do not need to override).
   * Multi-chat adapters (Telegram, Discord) MUST override.
   *
   * Examples:
   *   DM:                   undefined
   *   Telegram group:       "group:-1001234"
   *   Telegram forum topic: "group:-1001234:topic:42"
   */
  computeScopeKey?(event: { ref_keys: Record<string, string>; metadata?: Record<string, unknown> }): string | undefined

  /**
   * Plan 22 — Build a ConnectorTarget from a scope_key.
   * Used by event-router / tools to route outbound messages to the correct scope.
   */
  targetFromScopeKey?(scopeKey: string): ConnectorTarget | null

  /**
   * Plan 27 — Declare the platform-specific parameters this adapter accepts via
   * `ConnectorContent.params`. Exposed to agents through `connector_list` so the
   * model knows, per-connector, what extras are available (e.g. Telegram's
   * `reply_to_message_id`, `parse_mode`, `message_thread_id`).
   *
   * Return [] if no extras are supported. Default returns [].
   */
  getParamSchema?(): ConnectorParamSpec[]

  /**
   * Identity of the active connector instance (e.g. for Telegram bot adapter:
   * `{ name: 'mybot', username: '@mybot', user_id: '123456' }`; for userbot:
   * `{ name: 'alice', username: '@alice', user_id: '789' }`).
   *
   * Surfaced by every connector_* agent tool in the `identity` field so the
   * agent (and the operator inspecting tool output) can verify EXACTLY which
   * platform identity is acting. Critical for diagnostics like "chat not found"
   * — usually means the configured bot identity is not a member of the chat.
   *
   * Adapter MAY return null pre-activation. Default returns null.
   */
  getIdentity?(connectorId?: string): ConnectorIdentity | null

  /**
   * Plan 24 — Interactive setup: declare the wizard steps the credential
   * requires. When this returns a spec, Studio auto-mounts setup endpoints and
   * renders a generic multi-step wizard driven by `runSetupStep`. Return
   * `undefined` (or omit) for adapters that take a simple static credential
   * (e.g. a bot token).
   */
  getSetupSpec?(): ConnectorSetupSpec | undefined

  /**
   * Plan 24 — Advance the interactive setup one step. Receives the step id
   * being executed, the user's input for that step, and the session state
   * (where the adapter persists cross-step scratch like an mtcute client or a
   * phone_code_hash). On success, return `{ok:true, next_step}` to advance, or
   * `{ok:true, complete:true, fields}` to persist fields into the credential.
   * On failure, return `{ok:false, error, retry_step?}` — `retry_step` lets the
   * wizard show the error and stay on (or rewind to) a specific step.
   */
  runSetupStep?(
    stepId: string,
    input: Record<string, unknown>,
    sessionState: ConnectorSetupSessionState,
  ): Promise<ConnectorSetupStepResult>

  /**
   * Streaming adapter: handle a resolved inbound event end-to-end. When defined, the
   * event-router hands off after resolving binding + identity + conversation +
   * inbound context string, and the adapter takes ownership of queueing,
   * runtimeManager.run invocation, stream consumption, outbound send, and usage
   * logging. This is the path that lets adapters render streaming typing,
   * per-tool status chips, and platform-specific queue UX without the router
   * blocking on full-stream accumulation.
   *
   * If this method is not overridden, the router falls back to the legacy
   * "accumulate then sendMessage" path.
   */
  handleResolvedEvent?(ctx: ResolvedEventContext): Promise<void>
}

/**
 * Identity of the active connector instance — bot username, user_id, anything
 * the platform uses to identify "who is acting". Returned by `getIdentity()`
 * and surfaced as `identity` in every connector_* agent tool result.
 */
export interface ConnectorIdentity {
  /** Display label — usually the username or login handle. */
  name: string
  /** Platform username if applicable (e.g. `@mybot` for Telegram). */
  username?: string | null
  /** Platform-side numeric/string id (e.g. Telegram bot.id). */
  user_id?: string | null
  /** Free-form extras the adapter wants to expose (premium status, etc). */
  metadata?: Record<string, unknown>
}

/**
 * Plan 27 — Schema entry for a platform-specific send param.
 */
export interface ConnectorParamSpec {
  name: string
  type: 'string' | 'number' | 'boolean' | 'enum' | 'array' | 'object'
  enum_values?: string[]
  description: string
  example?: string | number | boolean | unknown[] | Record<string, unknown>
}
