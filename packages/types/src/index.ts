// ============================================================
// MODE
// ============================================================

export type AgentMode = 'chat' | 'task'

// ============================================================
// TOOL
// ============================================================

export interface ToolMeta {
  id: string
  name: string
  description: string
}

export interface ToolDefinition {
  meta: ToolMeta
  permission: string
  modes: AgentMode[]
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  input: any
  execute: (args: unknown, ctx: ToolContext) => Promise<unknown>
  prompt?: string
}

export interface ResolvedTool extends ToolDefinition {
  resolved_id: string         // 'jiku.social:create_post' — untuk rules & internal refs
  tool_name: string           // 'jiku_social__create_post' — LLM-safe, pattern ^[a-zA-Z0-9_-]+$
  resolved_permission: string
  plugin_id: string
}

// ============================================================
// STREAM DATA TYPES
// ============================================================

/**
 * Typed data parts for the Jiku run stream.
 * Matches AI SDK's UIDataTypes shape — keys map to data payload types.
 *
 * Extend via declaration merging:
 *   declare module '@jiku/types' {
 *     interface JikuDataTypes { 'my-event': { value: string } }
 *   }
 */
export interface JikuDataTypes {
  'jiku-meta': {
    run_id: string
    conversation_id: string
    agent_id: string
    mode: AgentMode
  }
  'jiku-usage': {
    input_tokens: number
    output_tokens: number
  }
  'jiku-step-usage': {
    step: number
    input_tokens: number
    output_tokens: number
  }
  'jiku-tool-data': {
    tool_id: string
    data: unknown
  }
  'jiku-compact': {
    summary: string
    removed_count: number
    token_saved: number
  }
}

/**
 * JikuDataTypes with index signature for AI SDK UIDataTypes compatibility.
 * Used internally — do not use this for narrowing; use JikuDataTypes directly.
 */
export type JikuDataTypesCompat = JikuDataTypes & { [key: string]: unknown }

// ============================================================
// STREAM WRITER
// ============================================================

/**
 * Type-safe writer injected into ToolContext.
 * Based on AI SDK UIMessageStreamWriter, narrowed to JikuDataTypes.
 */
export interface JikuStreamWriter {
  write<K extends keyof JikuDataTypes & string>(
    type: K,
    data: JikuDataTypes[K],
  ): void
}

// ============================================================
// PLUGIN
// ============================================================

export interface PluginMeta {
  id: string
  name: string
  version: string
  description?: string
  author?: string
  icon?: string       // lucide icon name or URL
  category?: string   // 'productivity' | 'communication' | 'finance' | etc
  project_scope?: boolean  // default false = system plugin
}

// --- Contributes ---

export type ContributesValue = Record<string, unknown>

/**
 * Factory that produces the contributed context.
 * Can be sync or async. Always a function — enables lazy init and proper type inference.
 *
 * @example
 *   contributes: () => ({ server: { get, post } })
 *   contributes: async () => { const c = await connect(); return { db: c } }
 */
export type Contributes<TValue extends ContributesValue> =
  () => TValue | Promise<TValue>

// eslint-disable-next-line @typescript-eslint/no-explicit-any
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type PluginDependency = string | PluginDefinition<any>

// --- Type utilities for ctx inference ---

type UnionToIntersection<U> =
  (U extends unknown ? (x: U) => void : never) extends (x: infer I) => void
    ? I
    : never

/**
 * Extract TContributes from PluginDefinition via the phantom `_contributes_type` brand field.
 * Using the brand (covariant position) instead of `setup` (contravariant) allows TypeScript
 * to correctly narrow `infer C` to the specific TContributes, not the base ContributesValue.
 * `PluginDependency` uses `PluginDefinition<any>` so TypeScript doesn't widen the generic
 * param when adding instances to a `depends` array.
 * Exclude<..., undefined> is required because optional `?: T` infers as `T | undefined`.
 */
type ExtractContributes<T> = T extends { readonly _contributes_type?: infer C }
  ? Exclude<C, undefined>
  : never

export type MergeContributes<Deps extends PluginDependency[]> =
  UnionToIntersection<
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ExtractContributes<Extract<Deps[number], PluginDefinition<any>>>
  >

// --- Project plugin context (per-project activation) ---

export interface ProjectPluginContext<TConfig = Record<string, unknown>> {
  projectId: string
  config: TConfig
  storage: PluginStorageAPI
  hooks: HookAPI
}

// --- Base context always available in setup ---

export interface BasePluginContext {
  tools: {
    register: (...tools: ToolDefinition[]) => void
  }
  prompt: {
    inject: (segment: string | (() => Promise<string>)) => void
  }
  project: {
    tools: { register: (...tools: ToolDefinition[]) => void }
    prompt: { inject: (segment: string | (() => Promise<string>)) => void }
  }
  hooks: HookAPI
  storage: PluginStorageAPI
}

/**
 * @deprecated Use BasePluginContext. PluginSetupContext kept for backward compat.
 */
export type PluginSetupContext = BasePluginContext

export interface PluginDefinition<
  TContributes extends ContributesValue = ContributesValue
> {
  meta: PluginMeta
  /** @deprecated use depends */
  dependencies?: string[]
  depends?: PluginDependency[]
  /**
   * What this plugin exposes to dependents' ctx.
   * Kept in covariant position so TypeScript can infer TContributes via _contributes_type.
   */
  contributes?: Contributes<TContributes>
  /**
   * Phantom brand — never assigned at runtime.
   * Stores TContributes in covariant position so `Extract` + `infer` works correctly
   * in MergeContributes, bypassing the contravariance of the `setup` parameter.
   */
  readonly _contributes_type?: TContributes
  /**
   * Plugin setup. Ctx includes BasePluginContext merged with contributes from instance deps.
   * The exact ctx type is enforced in definePlugin's call signature, not here, to allow
   * PluginDefinition<Specific> to be assignable to PluginDefinition<ContributesValue>.
   */
  setup: (ctx: BasePluginContext) => void
  onActivated?: (ctx: CallerContext) => void | Promise<void>
  onDeactivated?: () => void | Promise<void>
  configSchema?: unknown  // z.ZodObject<any> but typed as unknown to avoid zod dependency in types
  onProjectPluginActivated?: (projectId: string, ctx: ProjectPluginContext<Record<string, unknown>>) => void | Promise<void>
  onProjectPluginDeactivated?: (projectId: string, ctx: ProjectPluginContext<Record<string, unknown>>) => void | Promise<void>
  onServerStop?: (ctx: BasePluginContext) => void | Promise<void>
}

// ============================================================
// AGENT
// ============================================================

export interface AgentMeta {
  id: string
  name: string
  description?: string
}

export interface AgentDefinition {
  meta: AgentMeta
  base_prompt: string
  allowed_modes: AgentMode[]
  provider_id?: string
  model_id?: string
  /** Context compaction threshold percentage (0–100). 0 = disabled. Default 80. */
  compaction_threshold?: number
}

// ============================================================
// POLICY & RULES
// ============================================================

export type PolicyEffect = 'allow' | 'deny'
/** @deprecated Open string — kept for backwards compat only */
export type ResourceType = string
/** @deprecated Open string — kept for backwards compat only */
export type SubjectType = string

/**
 * A condition evaluated against CallerContext.
 * All conditions in one rule are AND-logic — all must pass.
 */
export interface PolicyCondition {
  /**
   * Dot-notation path into CallerContext.
   * e.g. 'roles', 'permissions', 'attributes.plan', 'user_data.company_id'
   */
  attribute: string
  operator: 'eq' | 'not_eq' | 'in' | 'not_in' | 'contains' | 'not_contains'
  value: string | string[]
}

export interface PolicyRule {
  /** Open string — 'agent' | 'tool' | any developer-defined resource type */
  resource_type: string
  /** '*' matches all resources of this type */
  resource_id: string
  /** Open string — 'role' | 'permission' | 'user' | any attribute key */
  subject_type: string
  subject: string
  effect: PolicyEffect
  priority?: number
  /** Optional extra conditions — all must pass (AND logic) */
  conditions?: PolicyCondition[]
}

/**
 * Pluggable subject matching function for JikuRuntime.
 * If not set, defaultSubjectMatcher is used.
 */
export type SubjectMatcher = (rule: PolicyRule, caller: CallerContext) => boolean

// ============================================================
// CALLER
// ============================================================

export interface CallerContext {
  user_id: string
  roles: string[]
  permissions: string[]
  user_data: Record<string, unknown>
  /**
   * Arbitrary attributes for policy conditions.
   * Studio sets: channel, company_id, plan.
   * Custom integrations (telegram, webhook, cron) can add their own.
   */
  attributes?: Record<string, string | string[]>
}

// ============================================================
// RUNTIME CONTEXT
// ============================================================

export interface RuntimeContext {
  caller: CallerContext
  agent: {
    id: string
    name: string
    mode: AgentMode
  }
  conversation_id: string
  run_id: string
  [key: string]: unknown
}

export interface ToolContext {
  runtime: RuntimeContext
  storage: PluginStorageAPI
  /** Push typed data chunks into the current run stream. */
  writer: JikuStreamWriter
}

// ============================================================
// CONVERSATION
// ============================================================

export type ConversationMode = AgentMode

export interface Conversation {
  id: string
  agent_id: string
  mode: ConversationMode
  title?: string
  status: 'active' | 'completed' | 'failed'
  goal?: string
  output?: unknown
  created_at: Date
  updated_at: Date
}

export interface Message {
  id: string
  conversation_id: string
  role: 'user' | 'assistant' | 'tool'
  parts: MessagePart[]
  created_at: Date
}

export type MessagePart =
  | { type: 'text'; text: string }
  | { type: 'tool-invocation'; toolInvocationId: string; toolName: string; args: unknown; state: 'call' | 'partial-call' | 'result'; result?: unknown }
  | { type: string; [key: string]: unknown }

/** @deprecated Use MessagePart */
export type MessageContent = MessagePart

// ============================================================
// MODEL PROVIDER
// ============================================================

export interface ModelProviderDefinition {
  id: string
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  getModel(model_id: string): any
}

// ============================================================
// RUNTIME OPTIONS
// ============================================================

export interface JikuRuntimeOptions {
  plugins: PluginLoaderInterface
  storage: JikuStorageAdapter
  rules?: PolicyRule[]
  providers?: Record<string, ModelProviderDefinition>
  default_provider?: string
  default_model?: string
  /**
   * Custom subject matcher. When not set, defaultSubjectMatcher is used.
   * Handles: role, permission, user, wildcard '*', and attributes.{key}
   */
  subject_matcher?: SubjectMatcher
}

// ============================================================
// RUN PARAMS
// ============================================================

export interface JikuRunParams {
  agent_id: string
  caller: CallerContext
  mode: AgentMode
  input: string
  conversation_id?: string
  provider_id?: string
  model_id?: string
  abort_signal?: AbortSignal
}

// ============================================================
// RUN RESULT — fully typed via AI SDK
// ============================================================

import type { UIMessage, UIMessageChunk, UIMessageStreamWriter } from 'ai'

/** JikuUIMessage — uses JikuDataTypesCompat to satisfy AI SDK UIDataTypes constraint. */
export type JikuUIMessage = UIMessage<unknown, JikuDataTypesCompat>

/** Writer for Jiku's stream. */
export type JikuUIMessageStreamWriter = UIMessageStreamWriter<JikuUIMessage>

/**
 * Typed data chunks — one member per JikuDataTypes key.
 * This is a hand-rolled discriminated union so chunk.type narrows chunk.data correctly,
 * without the index-signature problem from UIMessageChunk<unknown, JikuDataTypes>.
 */
export type JikuDataChunk = {
  [K in keyof JikuDataTypes]: {
    type: `data-${K}`
    id?: string
    data: JikuDataTypes[K]
    transient?: boolean
  }
}[keyof JikuDataTypes]

/**
 * Full typed stream chunk — AI SDK base chunks + Jiku typed data chunks.
 * chunk.type === 'data-jiku-usage' narrows chunk.data to { input_tokens, output_tokens }.
 */
export type JikuStreamChunk =
  | Exclude<UIMessageChunk<unknown, JikuDataTypesCompat>, { type: `data-${string}` }>
  | JikuDataChunk

export interface JikuRunResult {
  run_id: string
  conversation_id: string
  stream: ReadableStream<JikuStreamChunk>
}

export type { UIMessage, UIMessageChunk, UIMessageStreamWriter }

// ============================================================
// RESOLVED SCOPE
// ============================================================

export interface ResolvedScope {
  accessible: boolean
  allowed_modes: AgentMode[]
  active_tools: ResolvedTool[]
  system_prompt: string
  denial_reason?: string
}

// ============================================================
// CONTEXT PREVIEW
// ============================================================

export interface ContextSegment {
  source: 'base_prompt' | 'mode' | 'user_context' | 'plugin' | 'tool_hint'
  label: string
  content: string
  token_estimate: number
}

export interface ConversationContext {
  segments: ContextSegment[]
  total_tokens: number
  history_tokens: number
  grand_total: number
  model_context_window: number
  usage_percent: number
}

export interface PreviewRunResult {
  context: ConversationContext
  active_tools: {
    id: string
    name: string
    permission: string
    has_prompt: boolean
    token_estimate: number
  }[]
  active_plugins: {
    id: string
    name: string
    segments: { label: string; token_estimate: number }[]
  }[]
  system_prompt: string
  warnings: string[]
  /** Number of compaction checkpoints that have occurred for this conversation. */
  compaction_count: number
  /** Active model/provider info — populated by the studio layer, optional in core. */
  model_info?: {
    provider_id: string
    provider_name: string
    model_id: string
  }
}

// ============================================================
// ADAPTERS
// ============================================================

export interface JikuStorageAdapter {
  getConversation(id: string): Promise<Conversation | null>
  createConversation(data: Omit<Conversation, 'id' | 'created_at' | 'updated_at'>): Promise<Conversation>
  updateConversation(id: string, updates: Partial<Conversation>): Promise<Conversation>
  listConversations(agent_id: string): Promise<Conversation[]>

  getMessages(conversation_id: string, opts?: { limit?: number; offset?: number }): Promise<Message[]>
  addMessage(conversation_id: string, message: Omit<Message, 'id' | 'created_at'>): Promise<Message>
  deleteMessages(conversation_id: string, ids: string[]): Promise<void>
  /** Replace all messages in a conversation — used for compaction checkpointing. */
  replaceMessages(conversation_id: string, messages: Omit<Message, 'id' | 'created_at'>[]): Promise<Message[]>

  pluginGet(scope: string, key: string): Promise<unknown>
  pluginSet(scope: string, key: string, value: unknown): Promise<void>
  pluginDelete(scope: string, key: string): Promise<void>
  pluginKeys(scope: string, prefix?: string): Promise<string[]>
}

export interface PluginStorageAPI {
  get(key: string): Promise<unknown>
  set(key: string, value: unknown): Promise<void>
  delete(key: string): Promise<void>
  keys(prefix?: string): Promise<string[]>
}

export interface HookAPI {
  hook(event: string, handler: (payload: unknown) => Promise<void>): void
  callHook(event: string, payload?: unknown): Promise<void>
}

export interface PluginLoaderInterface {
  boot(): Promise<void>
  stop(): Promise<void>
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  override(pluginId: string, newDef: Partial<PluginDefinition<any>>): void
  isLoaded(id: string): boolean
  getLoadOrder(): string[]
  /** Returns resolved tools. If projectId given, filters to system + enabled project-scoped plugins. */
  getResolvedTools(projectId?: string): ResolvedTool[]
  /** Returns prompt segments synchronously. If projectId given, filters appropriately. */
  getPromptSegments(projectId?: string): string[]
  resolveProviders(caller: CallerContext): Record<string, unknown>
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  getAllPlugins(): PluginDefinition<ContributesValue>[]
  setProjectEnabledPlugins(projectId: string, pluginIds: string[]): void
  activatePlugin(projectId: string, pluginId: string, config: unknown, options?: { updateSet?: boolean }): Promise<void>
  deactivatePlugin(projectId: string, pluginId: string, config?: Record<string, unknown>): Promise<void>
}

