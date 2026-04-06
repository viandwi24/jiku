// ============================================================
// MODE
// ============================================================

export type AgentMode = 'chat' | 'task'

// ============================================================
// CONVERSATION TYPES (Plan 11)
// ============================================================

export type ConversationType = 'chat' | 'task' | 'heartbeat' | string
export type ConversationRunStatus = 'idle' | 'running' | 'completed' | 'failed' | 'cancelled'

export interface ChatMetadata {
  // reserved for future use
}

export interface TaskMetadata {
  goal: string
  spawned_by_tool_call_id?: string
  timeout_ms?: number
  output?: string
  progress_log?: Array<{ message: string; percent?: number; at: string }>
}

export interface HeartbeatMetadata {
  scheduled_at: string
  trigger: 'cron' | 'manual'
}

export interface ConversationRow {
  id: string
  type: string
  run_status: string
  agent_id: string
  agent_name: string
  caller_id: string | null
  parent_conversation_id: string | null
  metadata: Record<string, unknown>
  message_count: number
  started_at: Date | null
  finished_at: Date | null
  duration_ms: number | null
  error_message: string | null
  created_at: Date
}

export interface ListConversationsResult {
  data: ConversationRow[]
  total: number
  page: number
  per_page: number
  total_pages: number
}

// ============================================================
// TOOL
// ============================================================

export interface ToolMeta {
  id: string
  name: string
  description: string
  group?: string
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
  'jiku-run-snapshot': {
    system_prompt: string
    messages: unknown[]
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
  /**
   * Built-in tools injected directly into this agent (not via plugins).
   * Used for memory tools and other per-agent built-ins.
   * These bypass the plugin tool resolution pipeline.
   */
  built_in_tools?: ToolDefinition[]
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
  /**
   * Set when a run is triggered from a connector (Telegram, Discord, etc.)
   * Provides platform context for connector-aware tools.
   */
  connector_context?: ConnectorCallerContext
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

export interface ChatAttachment {
  /** MIME type, e.g. "image/png", "text/csv" */
  mime_type: string
  /** Original filename */
  name: string
  /**
   * For images: base64-encoded data URI ("data:image/png;base64,...")
   * For text files: plain text content
   */
  data: string
}

export interface ChatFilePart {
  /** MIME type, e.g. "image/png" */
  mediaType: string
  /** Original filename */
  filename?: string
  /** URL — typically "attachment://{id}" */
  url: string
}

export interface JikuRunParams {
  agent_id: string
  caller: CallerContext
  mode: AgentMode
  input: string
  attachments?: ChatAttachment[]
  /** Original file parts from the UI message — stored verbatim in DB (attachment:// URLs) */
  input_file_parts?: ChatFilePart[]
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
  source: 'base_prompt' | 'mode' | 'user_context' | 'plugin' | 'memory' | 'tool_hint' | 'persona'
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
    description: string
    permission: string
    has_prompt: boolean
    token_estimate: number
    input_schema?: unknown
    group?: string
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
// MEMORY
// ============================================================

export type MemoryScope = 'agent_caller' | 'agent_global' | 'runtime_global' | 'agent_self'

export interface PersonaSeed {
  name?: string
  role?: string
  personality?: string
  communication_style?: string
  background?: string
  initial_memories?: string[]
}
export type MemoryTier = 'core' | 'extended'
export type MemoryImportance = 'low' | 'medium' | 'high'
export type MemoryVisibility = 'private' | 'agent_shared' | 'project_shared'

export interface AgentMemory {
  id: string
  runtime_id: string
  agent_id: string
  caller_id: string | null
  scope: MemoryScope
  tier: MemoryTier
  section?: string
  content: string
  importance: MemoryImportance
  visibility: MemoryVisibility
  source: 'agent' | 'extraction'
  access_count: number
  last_accessed: Date | null
  expires_at: Date | null
  created_at: Date
  updated_at: Date
}

export interface MemoryContext {
  runtime_global: AgentMemory[]
  agent_global: AgentMemory[]
  agent_caller: AgentMemory[]
  extended: AgentMemory[]
  total_tokens: number
}

export interface ResolvedMemoryConfig {
  policy: {
    read: {
      runtime_global: boolean
      cross_user: boolean
    }
    write: {
      agent_global: boolean
      runtime_global: boolean
      cross_user: boolean
    }
  }
  relevance: {
    min_score: number
    max_extended: number
    weights: {
      keyword: number
      recency: number
      access: number
    }
    recency_half_life_days: number
  }
  core: {
    max_chars: number
    token_budget: number
  }
  extraction: {
    enabled: boolean
    model: string
    target_scope: 'agent_caller' | 'agent_global' | 'both'
  }
}

export type ProjectMemoryConfig = ResolvedMemoryConfig

export type AgentMemoryConfig = {
  policy?: {
    read?: Partial<ResolvedMemoryConfig['policy']['read']>
    write?: Partial<ResolvedMemoryConfig['policy']['write']>
  }
  relevance?: Partial<Omit<ResolvedMemoryConfig['relevance'], 'weights'>> & {
    weights?: Partial<ResolvedMemoryConfig['relevance']['weights']>
  }
  core?: Partial<ResolvedMemoryConfig['core']>
  extraction?: Partial<ResolvedMemoryConfig['extraction']>
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

  // Memory methods (optional — implementations that don't support memory can omit these)
  getMemories?(params: {
    runtime_id: string
    agent_id?: string
    caller_id?: string
    scope?: MemoryScope | MemoryScope[]
    tier?: MemoryTier
    visibility?: MemoryVisibility[]
  }): Promise<AgentMemory[]>

  saveMemory?(memory: Omit<AgentMemory,
    'id' | 'created_at' | 'updated_at' | 'access_count' | 'last_accessed'
  >): Promise<AgentMemory>

  updateMemory?(id: string, data: Partial<Pick<AgentMemory,
    'content' | 'importance' | 'visibility' | 'expires_at'
  >>): Promise<void>

  deleteMemory?(id: string): Promise<void>
  touchMemories?(ids: string[]): Promise<void>
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

// ============================================================
// CONNECTOR SYSTEM (Plan 10)
// ============================================================

export type ConnectorEventType =
  | 'message'
  | 'reaction'
  | 'unreaction'
  | 'edit'
  | 'delete'
  | 'pin'
  | 'join'
  | 'leave'
  | 'custom'

export interface ConnectorEvent {
  type: ConnectorEventType
  connector_id: string
  /** Flexible platform-specific message/event keys, e.g. { message_id, chat_id } */
  ref_keys: Record<string, string>
  sender: {
    external_id: string
    display_name?: string
    username?: string
    is_bot?: boolean
  }
  /** For reaction/edit/delete events — ref to the original message */
  target_ref_keys?: Record<string, string>
  content?: {
    text?: string
    media?: { type: string; url?: string; data?: Uint8Array }
    raw?: unknown
  }
  metadata?: Record<string, unknown>
  timestamp: Date
}

export interface ConnectorTarget {
  ref_keys: Record<string, string>
  reply_to_ref_keys?: Record<string, string>
}

export interface ConnectorContent {
  text?: string
  markdown?: boolean
  media?: { type: 'image' | 'video' | 'document'; url?: string; data?: Uint8Array }
  buttons?: Array<{ text: string; data: string }>
}

export interface ConnectorSendResult {
  success: boolean
  ref_keys?: Record<string, string>
  error?: string
}

export interface ConnectorContext {
  projectId: string
  connectorId: string
  /** Decrypted credential fields (e.g. bot_token) */
  fields: Record<string, string>
  /** Plain metadata from the credential */
  metadata: Record<string, string>
  /** Emit a parsed ConnectorEvent into the routing pipeline */
  onEvent(event: ConnectorEvent): Promise<void>
}

/**
 * A platform-specific action that a connector adapter can perform.
 * Exposed via connector_list_actions / connector_run_action tools so
 * agents can discover and invoke adapter-specific capabilities (e.g.
 * send_file, pin_message) without hardcoded tool-per-capability proliferation.
 */
export interface ConnectorAction {
  /** Unique action id within this adapter, e.g. 'send_file' */
  id: string
  /** Human-readable name shown to the agent */
  name: string
  /** Description of what the action does */
  description: string
  /**
   * JSON-serializable param schema describing the action's inputs.
   * Used to inform the agent what params to pass.
   * Shape: Record<paramName, { type, description, required? }>
   */
  params: Record<string, { type: string; description: string; required?: boolean }>
}

/** Output adapter config shapes */
export interface ConversationOutputConfig {
  agent_id: string
  conversation_mode?: 'persistent' | 'new'
}

export interface TaskOutputConfig {
  agent_id: string
}

/** Binding record from DB */
export interface ConnectorBinding {
  id: string
  connector_id: string
  display_name?: string | null
  source_type: 'private' | 'group' | 'channel' | 'any'
  source_ref_keys?: Record<string, string> | null
  trigger_source: 'message' | 'event'
  trigger_mode: 'always' | 'mention' | 'reply' | 'command' | 'keyword'
  trigger_keywords?: string[] | null
  trigger_event_type?: string | null
  trigger_event_filter?: Record<string, unknown> | null
  output_adapter: string
  output_config: Record<string, unknown>
  rate_limit_rpm?: number | null
  include_sender_info: boolean
  enabled: boolean
  created_at: Date
}

/** Identity record from DB */
export interface ConnectorIdentity {
  id: string
  binding_id: string
  external_ref_keys: Record<string, string>
  display_name?: string | null
  avatar_url?: string | null
  status: 'pending' | 'approved' | 'blocked'
  approved_by?: string | null
  approved_at?: Date | null
  mapped_user_id?: string | null
  conversation_id?: string | null
  last_seen_at?: Date | null
  created_at: Date
}

/** User identity key-value store */
export interface UserIdentity {
  id: string
  user_id: string
  project_id: string
  key: string
  value: string
  label?: string | null
  source: 'user' | 'agent' | 'system'
  visibility: 'private' | 'project'
  created_at: Date
  updated_at: Date
}

/** Connector definition (DB row) */
export interface ConnectorRecord {
  id: string
  project_id: string
  plugin_id: string
  display_name: string
  config: Record<string, unknown>
  status: 'active' | 'inactive' | 'error'
  error_message?: string | null
  created_at: Date
  updated_at: Date
}

/** Connector context added to CallerContext when a run is triggered from a connector */
export interface ConnectorCallerContext {
  connector_id: string
  binding_id: string
  identity_id: string
  external_ref_keys: Record<string, string>
  event_ref_keys: Record<string, string>
  event_type: ConnectorEventType
  platform: string
}

// ============================================================
// FILESYSTEM (Plan 14)
// ============================================================

export type FilesystemEntryType = 'file' | 'folder'

export interface FilesystemFolderEntry {
  type: 'folder'
  path: string
  name: string
}

export interface FilesystemFileEntry {
  type: 'file'
  id: string
  project_id: string
  path: string
  name: string
  folder_path: string
  extension: string
  storage_key: string
  size_bytes: number
  mime_type: string
  content_cache: string | null
  created_by: string | null
  updated_by: string | null
  created_at: Date
  updated_at: Date
}

export type FilesystemEntry = FilesystemFolderEntry | FilesystemFileEntry

export interface ProjectFilesystemConfig {
  id: string
  project_id: string
  adapter_id: string
  credential_id: string | null
  enabled: boolean
  total_files: number
  total_size_bytes: number
  created_at: Date
  updated_at: Date
}

export const FILESYSTEM_ALLOWED_EXTENSIONS = [
  '.txt', '.md', '.mdx', '.rst',
  '.html', '.css', '.js', '.jsx', '.ts', '.tsx',
  '.py', '.rs', '.go', '.java', '.c', '.cpp', '.h',
  '.rb', '.php', '.swift', '.kt', '.cs', '.sh',
  '.json', '.yaml', '.yml', '.toml', '.env', '.ini',
  '.xml', '.csv', '.sql',
] as const

export const FILESYSTEM_MAX_FILE_SIZE_BYTES = 5 * 1024 * 1024

// ============================================================
// ACL — Auth & Permissions (Plan 12)
// ============================================================

export const PERMISSIONS = {
  // Chat
  CHATS_READ:    'chats:read',
  CHATS_CREATE:  'chats:create',

  // Memory
  MEMORY_READ:   'memory:read',
  MEMORY_WRITE:  'memory:write',
  MEMORY_DELETE: 'memory:delete',

  // Runs
  RUNS_READ:     'runs:read',

  // Agents
  AGENTS_READ:   'agents:read',
  AGENTS_WRITE:  'agents:write',
  AGENTS_CREATE: 'agents:create',
  AGENTS_DELETE: 'agents:delete',

  // Channels
  CHANNELS_READ:  'channels:read',
  CHANNELS_WRITE: 'channels:write',

  // Plugins
  PLUGINS_READ:  'plugins:read',
  PLUGINS_WRITE: 'plugins:write',

  // Project Settings
  SETTINGS_READ:  'settings:read',
  SETTINGS_WRITE: 'settings:write',

  // Members & Roles
  MEMBERS_READ:  'members:read',
  MEMBERS_WRITE: 'members:write',
  ROLES_WRITE:   'roles:write',
} as const

export type Permission = typeof PERMISSIONS[keyof typeof PERMISSIONS]

export const ROLE_PRESETS = {
  admin: {
    name: 'Admin',
    permissions: Object.values(PERMISSIONS) as Permission[],
  },
  manager: {
    name: 'Manager',
    permissions: [
      'chats:read', 'chats:create',
      'memory:read', 'memory:write',
      'runs:read',
      'agents:read',
      'channels:read',
      'plugins:read',
      'settings:read',
      'members:read',
    ] as Permission[],
  },
  member: {
    name: 'Member',
    permissions: [
      'chats:read', 'chats:create',
      'memory:read',
      'runs:read',
      'agents:read',
    ] as Permission[],
  },
  viewer: {
    name: 'Viewer',
    permissions: [
      'chats:read',
      'runs:read',
      'agents:read',
    ] as Permission[],
  },
} satisfies Record<string, { name: string; permissions: Permission[] }>

export interface ResolvedPermissions {
  granted: boolean
  isSuperadmin: boolean
  permissions: Permission[]
  agentRestrictions: Record<string, boolean>
  toolRestrictions: Record<string, Record<string, boolean>>
}

export interface ProjectGrant {
  project_id: string
  role_id: string
}

