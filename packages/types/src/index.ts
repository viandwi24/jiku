// ============================================================
// MODE
// ============================================================

export type AgentMode = 'chat' | 'task'

/** Plan 21 — Per-mode adapter configuration on an agent. */
export interface AgentModeConfig {
  /** Stable adapter id (e.g. 'jiku.agent.default'). */
  adapter: string
  /** Adapter-specific config; shape defined by adapter's `configSchema`. */
  config?: Record<string, unknown>
}

// ============================================================
// PLUGIN UI (Plan 17)
// ============================================================

export type { PluginUISlotId, PluginUIEntry, PluginUIDefinition } from './plugin-ui.ts'
import type { PluginUIDefinition as _PluginUIDefinition } from './plugin-ui.ts'

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
  /**
   * Plan 18 — if set, caller must have been granted this plugin permission
   * (either via per-member grant in `plugin_granted_permissions` or as a
   * superadmin) before the tool can be invoked.
   */
  required_plugin_permission?: string
  /**
   * Plan 22 revision — if true, the tool has external side effects (writes DB,
   * sends a message, creates a file, etc). The runner deduplicates these on
   * replay: if a prior assistant message in the same conversation already has a
   * tool-invocation with identical tool_name + args, the cached `result` is
   * returned instead of calling `execute()` again. Prevents duplicate cron task
   * creation / duplicate connector_send when a user edits an earlier message.
   */
  side_effectful?: boolean
}

/** Plan 15.1: Chunk yielded during tool streaming */
export interface ToolStreamChunk {
  type: 'progress' | 'partial'
  data: unknown
}

export interface ToolDefinition {
  meta: ToolMeta
  permission: string
  modes: AgentMode[]
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  input: any
  execute: (args: unknown, ctx: ToolContext) => Promise<unknown>
  /**
   * Plan 15.1: Optional streaming execute. When defined, takes precedence over execute.
   * Yields intermediate results; final return value is the tool result.
   */
  executeStream?: (args: unknown, ctx: ToolContext) => AsyncGenerator<ToolStreamChunk, unknown>
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
    /** Final assistant text aggregated across all steps of this run. */
    response?: string
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
  'jiku-harness-iteration': {
    iteration: number
    max_iterations: number
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

// Any object shape a plugin can contribute. Must be an object; fields are
// otherwise free-form. Kept intentionally permissive so specific interfaces
// (like `{ http, events }`) are assignable without needing an index signature.
export type ContributesValue = object

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
  /**
   * Plan 19 — Register plugin-contributed skills. Each registered spec is propagated
   * to every project that activates this plugin (via the SkillLoader), and cleaned
   * up when the plugin is deactivated for that project.
   */
  skills?: {
    register: (spec: PluginSkillSpec) => void
  }
  hooks: HookAPI
  storage: PluginStorageAPI
  // Host-specific extensions (e.g. Studio's `http` / `events`) are added via
  // module augmentation by their owning host package (see `@jiku-plugin/studio`).
  // Keeping @jiku/types host-agnostic.
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
  /** Plan 17 — optional UI contributions (slots, components, pages). */
  ui?: _PluginUIDefinition
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
  /** Plan 21 — per-mode adapter selection + config. */
  mode_configs?: Partial<Record<AgentMode, AgentModeConfig>>
  provider_id?: string
  model_id?: string
  /** Context compaction threshold percentage (0–100). 0 = disabled. Default 80. */
  compaction_threshold?: number
  /** Maximum number of LLM tool-call steps per run. Default 40. */
  max_tool_calls?: number
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
  /**
   * Plan 18 — per-member plugin permissions granted in the current project.
   * Populated by Studio's caller resolver. Used by the runner to enforce
   * `tool.meta.required_plugin_permission`.
   */
  granted_plugin_permissions?: string[]
  /** Plan 18 — bypasses plugin permission enforcement. */
  is_superadmin?: boolean
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
  /** Plan 23 — tip of the currently active branch path. */
  active_tip_message_id?: string | null
  created_at: Date
  updated_at: Date
}

export interface Message {
  id: string
  conversation_id: string
  role: 'user' | 'assistant' | 'tool'
  parts: MessagePart[]
  /** Plan 23 — parent pointer for message-level branching. */
  parent_message_id?: string | null
  /** Plan 23 — ordinal among siblings sharing `parent_message_id`. */
  branch_index?: number
  created_at: Date
}

/** Plan 23 — message + sibling metadata attached for the branch navigator. */
export interface MessageWithBranchMeta extends Message {
  sibling_count: number
  sibling_ids: string[]
  current_sibling_index: number
}

export type MessagePart =
  | { type: 'text'; text: string }
  | { type: 'tool-invocation'; toolInvocationId: string; toolName: string; args: unknown; state: 'call' | 'partial-call' | 'result'; result?: unknown }
  | { type: string; [key: string]: unknown }

/** @deprecated Use MessagePart */
export type MessageContent = MessagePart

// ============================================================
// CONTENT PERSISTENCE (Plan 33)
// ============================================================

/** Content part as stored in DB and streamed to clients. URL-free. */
export type ToolContentPart =
  | { type: 'text'; text: string }
  | { type: 'image'; attachment_id: string; storage_key: string; mime_type: string }
  | { type: 'document'; attachment_id: string; storage_key: string; mime_type: string; file_name: string }
  | { type: 'audio'; attachment_id: string; storage_key: string; mime_type: string }

/** Result of persisting binary content to S3 + DB. No URL -- URL is generated on-demand at render time. */
export interface ContentPersistResult {
  attachmentId: string
  storageKey: string       // e.g. 'jiku/attachments/{projectId}/{scope}/{uuid}.png'
  mimeType: string
  sizeBytes: number
}

export interface ContentPersistOptions {
  projectId: string
  data: Buffer
  mimeType: string
  filename: string
  sourceType: string       // 'browser' | 'tool' | 'user_upload' etc.
  conversationId?: string
  agentId?: string
  userId?: string
  scope?: 'per_user' | 'shared'
  metadata?: Record<string, unknown>
}

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
  /**
   * Plan 18 — optional hooks fired around every tool invocation in the
   * AI-SDK-wrapped runner. Use from Studio to write audit log entries.
   */
  tool_hooks?: ToolHooks
}

export interface ToolHooks {
  onInvoke?: (info: ToolHookInfo) => void | Promise<void>
  onBlocked?: (info: ToolHookInfo & { reason: string }) => void | Promise<void>
  onError?: (info: ToolHookInfo & { error: unknown }) => void | Promise<void>
}

export interface ToolHookInfo {
  tool_id: string
  tool_name: string
  plugin_id: string
  caller: CallerContext
  agent_id: string
  args?: unknown
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

export interface ToolStatesMap {
  /** Project-level tool overrides: tool_id → enabled */
  project: Record<string, boolean>
  /** Agent-level tool overrides: tool_id → enabled */
  agent: Record<string, boolean>
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
  /** Tool on/off states for filtering. Agent override > project override > default (enabled). */
  tool_states?: ToolStatesMap
  /** Plan 15.8: Extra built-in tools injected per-run (e.g., progress tool for task mode). */
  extra_built_in_tools?: ToolDefinition[]
  /**
   * Per-run tool id suppression. Builtin tool meta.ids to strip before the run.
   * Used by cron-triggered runs to remove `cron_create`/`cron_update`/`cron_delete` —
   * prevents a cron task from recursively creating more cron tasks (infinite loop).
   */
  suppress_tool_ids?: string[]
  /**
   * Plan 22 revision — extra system-prompt segments appended to the base system prompt
   * for this single run only. Used by Studio to inject per-project, per-caller context
   * (e.g. Company & Team structure, Project Context) without registering a global plugin.
   * Each segment carries an explicit label so it appears with a meaningful name in the
   * Context Preview Sheet (instead of "Runtime Segment 1").
   */
  extra_system_segments?: Array<{ label: string; content: string }>
  /**
   * Plan 22 revision — system-prompt segments injected BEFORE base_prompt.
   * Use for hard rules that must override agent persona (e.g. "you CAN schedule via cron_create" —
   * weak agents otherwise default to "I can't" because base_prompt persona dominates).
   */
  extra_system_prepend?: Array<{ label: string; content: string }>
  /** Plan 15.2: Semantic similarity scores from Qdrant (memoryId → score 0-1). Injected by studio layer. */
  semantic_scores?: Map<string, number>
  /**
   * Plan 23 — branching: parent message id for the new user message. When absent,
   * runner falls back to `conversation.active_tip_message_id` (linear extend).
   * When present but different from active tip, the new message becomes a branch
   * sibling (edit-message flow).
   */
  parent_message_id?: string | null
  /**
   * Plan 23 — regenerate mode: if true, runner skips persisting a new user message
   * and re-runs the model from the existing path ending at `parent_message_id`
   * (which must itself point at a user message). Assistant response is saved as
   * a sibling of the previous assistant reply.
   */
  regenerate?: boolean
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
  source: 'base_prompt' | 'mode' | 'user_context' | 'plugin' | 'memory' | 'tool_hint' | 'persona' | 'skill' | 'runtime'
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
  /** Plan 21 — the mode this preview was built for, plus resolved adapter info. */
  mode?: AgentMode
  adapter_info?: {
    id: string
    display_name: string
    description?: string
    config?: Record<string, unknown>
  }
}

// ============================================================
// MEMORY
// ============================================================

export type MemoryScope = 'agent_caller' | 'agent_global' | 'runtime_global' | 'agent_self'

// ============================================================
// AUTO-REPLY & QUEUE (Plan 15)
// ============================================================

export type AgentQueueMode = 'off' | 'queue' | 'ack_queue'

export interface AutoReplyRule {
  trigger: 'exact' | 'contains' | 'regex' | 'command'
  pattern: string
  response: string
  enabled: boolean
}

export interface ScheduleHours {
  days: number[]   // 0=Sunday, 1=Monday, ..., 6=Saturday
  from: string     // 'HH:MM' (24h format)
  to: string       // 'HH:MM' (24h format)
}

export interface AvailabilitySchedule {
  enabled: boolean
  timezone: string
  hours: ScheduleHours[]
  offline_message: string
}

// ============================================================
// PERSONA
// ============================================================

export interface PersonaTraits {
  formality: 'casual' | 'balanced' | 'formal'
  verbosity: 'concise' | 'moderate' | 'detailed'
  humor: 'none' | 'light' | 'frequent'
  empathy: 'low' | 'moderate' | 'high'
  expertise_display: 'simplified' | 'balanced' | 'technical'
}

export const DEFAULT_PERSONA_TRAITS: PersonaTraits = {
  formality: 'balanced',
  verbosity: 'moderate',
  humor: 'light',
  empathy: 'moderate',
  expertise_display: 'balanced',
}

export interface PersonaSeed {
  name?: string
  role?: string
  personality?: string
  communication_style?: string
  background?: string
  initial_memories?: string[]
  /** Structured communication traits. */
  traits?: PersonaTraits
  /** Hard boundaries — things the agent refuses to do. */
  boundaries?: string[]
}
export type MemoryTier = 'core' | 'extended'
export type MemoryImportance = 'low' | 'medium' | 'high'
export type MemoryVisibility = 'private' | 'agent_shared' | 'project_shared'

/** Plan 19: Semantic classification of memory content. */
export type MemoryType = 'episodic' | 'semantic' | 'procedural' | 'reflective'

/** Plan 19: Where this memory record originated. */
export type MemorySourceType = 'tool' | 'reflection' | 'dream' | 'flush'

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
  /** Plan 19 */
  memory_type: MemoryType
  /** Plan 19: 0..1, decayed by dreaming, boosted by retrieval. */
  score_health: number
  /** Plan 19: How this record was produced. */
  source_type: MemorySourceType
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
      /** Plan 15.2: Semantic similarity weight. Default 0 (disabled until Qdrant available). */
      semantic?: number
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
  /** Plan 15.2: Embedding config for semantic memory search via Qdrant. */
  embedding: {
    enabled: boolean
    /** Credential adapter ID: 'openai' | 'openrouter' | etc. */
    provider: string
    /** Embedding model ID, e.g. 'text-embedding-3-small'. */
    model: string
    /** Credential ID to use for authentication. null = use env fallback. */
    credential_id: string | null
    /** Vector dimensions (auto-detected from model, but stored for collection creation). */
    dimensions: number
  }
  /** Plan 19: Dreaming engine config (project-level only). */
  dreaming?: DreamingConfig
  /** Plan 19: Post-run reflection (per-agent override allowed). */
  reflection?: ReflectionConfig
}

/** Plan 19: Dreaming engine per-project config. */
export interface DreamingPhaseConfig {
  enabled: boolean
  cron: string
  /** Credential row id used to build the provider for this phase. null = inherit from `dreaming.credential_id`. */
  credential_id: string | null
  /** Explicit model id. Empty string = inherit from `dreaming.model_id`. */
  model_id: string
}

export interface DreamingConfig {
  enabled: boolean
  /** Default credential used when a phase doesn't override. */
  credential_id: string | null
  /** Default model id used when a phase doesn't override. */
  model_id: string
  light: DreamingPhaseConfig
  deep: DreamingPhaseConfig
  rem: DreamingPhaseConfig & { min_pattern_strength: number }
}

/** @deprecated Kept for backward compat with rows saved before 2026-04-12 */
export type DreamingModelTier = 'cheap' | 'balanced' | 'expensive'

export interface ReflectionConfig {
  enabled: boolean
  /** Model id used for insight LLM. */
  model: string
  /** Where to attach the reflective memory. */
  scope: 'agent_caller' | 'agent_global'
  /** Conversations below this turn count do not trigger. */
  min_conversation_turns: number
}

/** Plan 19: Durable background job queue. */
export type JobStatus = 'pending' | 'running' | 'completed' | 'failed' | 'cancelled'

export type JobType =
  | 'memory.reflection'
  | 'memory.dream'
  | 'memory.flush'

export interface BackgroundJob {
  id: string
  type: JobType | string
  project_id: string | null
  idempotency_key: string | null
  payload: unknown
  status: JobStatus
  attempts: number
  max_attempts: number
  scheduled_at: Date
  started_at: Date | null
  completed_at: Date | null
  error: string | null
  created_at: Date
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
  embedding?: Partial<ResolvedMemoryConfig['embedding']>
  reflection?: Partial<ReflectionConfig>
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

  // ── Plan 23 — message-level branching ────────────────────────────────────
  /** Load messages along the active branch path (root → tip). */
  getActivePathMessages?(conversation_id: string): Promise<Message[]>
  /** Load messages from a specific tip walking parent links backwards. */
  getMessagesByPath?(tip_message_id: string): Promise<Message[]>
  /** Insert a message with correct branch_index and atomically bump active tip. */
  addBranchedMessage?(input: {
    conversation_id: string
    parent_message_id: string | null
    role: Message['role']
    parts: MessagePart[]
  }): Promise<Message>
  /** Persist a new active tip for a conversation. */
  setActiveTip?(conversation_id: string, tip_message_id: string | null): Promise<void>

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
  > & Partial<Pick<AgentMemory, 'memory_type' | 'score_health' | 'source_type'>>): Promise<AgentMemory>

  updateMemory?(id: string, data: Partial<Pick<AgentMemory,
    'content' | 'importance' | 'visibility' | 'expires_at' | 'score_health' | 'memory_type'
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

/**
 * Media metadata only — NO url/data, NO file_id (Plan 22).
 * file_id disimpan di connector_events.metadata (internal, tidak diekspos ke AI).
 * AI fetch media via connector_run_action('fetch_media', { event_id, save_path }).
 */
export interface ConnectorEventMedia {
  type: 'photo' | 'document' | 'voice' | 'video' | 'sticker'
  file_name?: string
  mime_type?: string
  file_size?: number
}

export interface ConnectorEvent {
  type: ConnectorEventType
  connector_id: string
  /** Flexible platform-specific message/event keys, e.g. { message_id, chat_id } */
  ref_keys: Record<string, string>
  /** Plan 22 — Computed conversation scope. Null/undefined = DM/default. Non-null = group/topic/thread. */
  scope_key?: string
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
    media?: ConnectorEventMedia
    raw?: unknown
  }
  metadata?: Record<string, unknown>
  /** Original platform-side payload (e.g. Telegram update JSON) — preserved for inspection in the channels UI. */
  raw_payload?: unknown
  timestamp: Date
}

export interface ConnectorTarget {
  ref_keys: Record<string, string>
  reply_to_ref_keys?: Record<string, string>
  /** Plan 22 — Override target scope (e.g. kirim ke topic tertentu dalam group) */
  scope_key?: string
  /**
   * Multi-tenant isolation — connector UUID this target belongs to. Adapter
   * with multiple active credentials (e.g. two Telegram bots in different
   * projects) uses this to look up the RIGHT bot/session instance to send
   * with. When omitted, adapter falls back to last-activated instance — that
   * fallback is the legacy behaviour and SHOULD be considered deprecated.
   * All studio-side callers MUST set this.
   */
  connector_id?: string
}

/**
 * Single outbound media item (Plan 22) — used in ConnectorContent.media and media_group[].
 * Telegram caption limit: 1024 chars (vs 4096 for text messages).
 */
export interface ConnectorMediaItem {
  type: 'image' | 'video' | 'document' | 'voice'
  /** Public URL — adapter downloads directly */
  url?: string
  /** Raw bytes — for generated or pre-downloaded files */
  data?: Uint8Array
  /** Filename (required for document, optional for image/video) */
  name?: string
  /** Caption shown under media. For media_group only the first item caption is prominent. */
  caption?: string
  /** Parse caption as MarkdownV2 (Telegram) */
  caption_markdown?: boolean
}

export interface ConnectorContent {
  text?: string
  markdown?: boolean
  /** Single media — one photo, document, or voice note */
  media?: ConnectorMediaItem
  /**
   * Media group (album) — max 10. Photo + video may mix; documents cannot mix with photo/video.
   * Adapter fallback: if sendMediaGroup unsupported, send items sequentially.
   */
  media_group?: ConnectorMediaItem[]
  buttons?: Array<{ text: string; data: string }>
  /** Plan 22 — Override target scope (e.g. thread/topic within a group) */
  target_scope_key?: string
  /**
   * Plan 22 revision — when true, adapter simulates a "typing" effect by sending
   * a placeholder and progressively editing it (text-only sends). Default false —
   * proactive notifications/broadcasts skip the effect.
   */
  simulate_typing?: boolean

  /**
   * Plan 27 — Platform-specific send parameters. Adapter declares the accepted
   * keys via `getParamSchema()` (surfaced to agents via `connector_list`).
   * Adapter is responsible for passing these through to the platform API.
   *
   * Examples — Telegram: `reply_to_message_id`, `parse_mode`, `disable_web_page_preview`,
   * `message_thread_id`, `protect_content`, `allow_sending_without_reply`.
   */
  params?: Record<string, unknown>
}

export interface ConnectorSendResult {
  success: boolean
  ref_keys?: Record<string, string>
  error?: string
  /** Raw response from the platform API (e.g. Telegram sendMessage response) for inspection. */
  raw_payload?: unknown
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

// ============================================================
// CONNECTOR INTERACTIVE SETUP (Plan 24 Phase 1)
// ============================================================

/**
 * One input field rendered by the generic setup wizard. Secret=true → masked.
 */
export interface ConnectorSetupInput {
  name: string
  type: 'string' | 'number' | 'boolean'
  required: boolean
  secret?: boolean
  label: string
  placeholder?: string
  description?: string
}

/**
 * One step in the interactive setup wizard. Rendered in order; adapter drives
 * transitions via `runSetupStep`'s `next_step` return.
 */
export interface ConnectorSetupStep {
  id: string
  title: string
  description: string
  inputs: ConnectorSetupInput[]
  /** When true, wizard may skip this step based on adapter branching logic. */
  conditional?: boolean
}

/**
 * Declared by `ConnectorAdapter.getSetupSpec()`. Studio auto-mounts the setup
 * endpoints and renders the generic wizard from this spec.
 */
export interface ConnectorSetupSpec {
  /** Ordered list of steps the wizard walks through. */
  steps: ConnectorSetupStep[]
  /** Optional title shown in the wizard header. */
  title?: string
  /** Optional intro paragraph shown at step 1. */
  intro?: string
}

/**
 * Server-side state carried across steps. Adapter mutates `scratch` to persist
 * transient data between steps (e.g. an mtcute client, phone_code_hash).
 * Stored in-memory with a TTL; lost on server restart (user re-runs the wizard).
 */
export interface ConnectorSetupSessionState {
  session_id: string
  project_id: string
  credential_id: string
  /**
   * Decrypted credential fields, refreshed by the route handler on every step
   * call. Adapter reads (e.g. `state.credential_fields.api_id`) but should NOT
   * mutate; permanent updates land via `runSetupStep` returning
   * `{ok:true, complete:true, fields}`.
   */
  credential_fields: Record<string, string>
  /** Adapter-owned scratch — never exposed to UI. */
  scratch: Record<string, unknown>
  /** Monotonic counter of failed attempts on the current step — wizard enforces a retry cap. */
  retry_count: number
  /** Which step we're currently expecting input for. */
  current_step_id: string | null
  created_at: number
  updated_at: number
}

/**
 * Result of a single `runSetupStep` call.
 *  - `ok:true, next_step` → wizard advances to `next_step`.
 *  - `ok:true, complete:true, fields` → wizard persists `fields` into the credential and closes.
 *  - `ok:false, retry_step` → wizard stays on (or returns to) `retry_step` and shows the error.
 *  - `ok:false` (no retry_step) → wizard terminates with the error.
 */
export type ConnectorSetupStepResult =
  | { ok: true; next_step?: string; ui_message?: string }
  | { ok: true; complete: true; fields: Record<string, unknown>; ui_message?: string }
  | { ok: false; error: string; hint?: string; retry_step?: string }

/**
 * Plan 28 — Resolved binding context passed to `ConnectorAdapter.handleResolvedEvent()`.
 *
 * The event-router does first-contact work (log, resolve binding + identity + scope,
 * create conversation, build connector_context block) then hands off to the adapter.
 * The adapter owns queueing + streaming + outbound send + usage logging from this
 * point on, because rate-limits and typing UX differ per platform.
 *
 * All platform- and studio-internal services the adapter needs are injected as
 * callables so the plugin stays decoupled from `@jiku-studio/server`.
 */
export interface ResolvedEventContext {
  event: ConnectorEvent
  binding: { id: string; agent_id: string; source_type: string; [k: string]: unknown }
  identity: { id: string; external_id: string; [k: string]: unknown } | null
  conversationId: string
  agentId: string
  projectId: string
  connectorId: string
  connectorDisplayName: string | null
  /** Internal DB id for the inbound `connector_events` row. */
  eventId: string | null
  /** Internal DB id for the inbound `connector_messages` row. */
  inboundMessageId: string | null
  /** The `<connector_context>…</connector_context>` block already built by the router. */
  contextString: string
  /**
   * The full prompt that should be fed to the runner — context block + wrapped
   * user_message + optional @file reference hint block. Adapter passes this as
   * `input` when calling `startRun`.
   */
  inputText: string

  /** Start an agent run for this conversation. Returns the full run stream. */
  startRun(): Promise<{ stream: ReadableStream<unknown> }>

  /**
   * Hand a tee'd branch of the stream to the host so SSE observers (chat web UI)
   * keep receiving real-time updates. Host drains + broadcasts + buffers. Adapter
   * must keep draining its own branch independently.
   */
  registerObserverStream(stream: ReadableStream<unknown>): { done(): void }

  /** Log an outbound `connector_messages` row. */
  logOutboundMessage(row: {
    ref_keys: Record<string, string>
    content_snapshot?: string
    raw_payload?: unknown
    status: string
  }): Promise<{ id: string } | null>

  /** Log an outbound `connector_events` row. */
  logOutboundEvent(row: {
    event_type: string
    ref_keys: Record<string, string>
    payload?: unknown
    raw_payload?: unknown
    status: string
  }): Promise<{ id: string } | null>

  /** Record LLM usage for billing + observability. */
  recordUsage(row: {
    input_tokens: number
    output_tokens: number
    provider: string | null
    model: string | null
    raw_system_prompt?: string | null
    raw_messages?: unknown
    raw_response?: string | null
    active_tools?: string[] | null
    agent_adapter?: string | null
  }): void
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
  /** When true, each trigger_keywords entry is compiled as a case-insensitive regex. */
  trigger_keywords_regex?: boolean
  /** Custom tokens for trigger_mode='mention' — any text match counts. */
  trigger_mention_tokens?: string[] | null
  /** Whitelist of command names (without leading '/') for trigger_mode='command'. */
  trigger_commands?: string[] | null
  trigger_event_type?: string | null
  trigger_event_filter?: Record<string, unknown> | null
  output_adapter: string
  output_config: Record<string, unknown>
  /** Routing priority — higher wins. Default 0. */
  priority: number
  /** Regex pattern matched against message text. */
  trigger_regex?: string | null
  /** Schedule filter (AvailabilitySchedule shape). */
  schedule_filter?: Record<string, unknown> | null
  rate_limit_rpm?: number | null
  include_sender_info: boolean
  /** Plan 22 — Scope filter: null = all, "group:*" = groups only, "dm:*" = DMs, exact = specific scope */
  scope_key_pattern?: string | null
  /**
   * Group/channel member admission gate. Applies only when the binding spans
   * multiple users (source_type=group|channel or scope_key present).
   *   'require_approval' = new members become pending identities; admin must approve.
   *   'allow_all'        = new members trigger the agent immediately.
   * For DM bindings (source_type='private') this is ignored.
   */
  member_mode: 'require_approval' | 'allow_all'
  enabled: boolean
  created_at: Date
}

/** Named channel target record (Plan 22) */
export interface ConnectorTargetRecord {
  id: string
  connector_id: string
  name: string
  display_name?: string | null
  description?: string | null
  ref_keys: Record<string, string>
  scope_key?: string | null
  metadata: Record<string, unknown>
  created_at: Date
  updated_at: Date
}

/** Scope-scoped conversation record (Plan 22) */
export interface ConnectorScopeConversationRecord {
  id: string
  connector_id: string
  scope_key: string
  agent_id?: string | null
  conversation_id?: string | null
  last_activity_at: Date
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
  /** Match mode: 'all' = execute all matching bindings, 'first' = first match wins. */
  match_mode: 'all' | 'first'
  /** Fallback agent when no binding matches. */
  default_agent_id?: string | null
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
  RUNS_CANCEL:   'runs:cancel',

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

  // Cron Tasks
  CRON_TASKS_READ:  'cron_tasks:read',
  CRON_TASKS_WRITE: 'cron_tasks:write',

  // Skills
  SKILLS_READ:  'skills:read',
  SKILLS_WRITE: 'skills:write',

  // Commands (slash commands)
  COMMANDS_READ:  'commands:read',
  COMMANDS_WRITE: 'commands:write',

  // Browser profiles
  BROWSER_READ:  'browser:read',
  BROWSER_WRITE: 'browser:write',

  // Disk / project virtual filesystem
  DISK_READ:  'disk:read',
  DISK_WRITE: 'disk:write',

  // Usage metrics
  USAGE_READ: 'usage:read',

  // Console (per-plugin live log streams)
  CONSOLE_READ: 'console:read',
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
      'runs:read', 'runs:cancel',
      'agents:read',
      'channels:read',
      'plugins:read',
      'settings:read',
      'members:read',
      'cron_tasks:read', 'cron_tasks:write',
      'skills:read', 'skills:write',
      'commands:read', 'commands:write',
      'browser:read', 'browser:write',
      'disk:read', 'disk:write',
      'usage:read',
      'console:read',
    ] as Permission[],
  },
  member: {
    name: 'Member',
    permissions: [
      'chats:read', 'chats:create',
      'memory:read',
      'runs:read',
      'agents:read',
      'skills:read',
      'commands:read',
      'disk:read',
      'console:read',
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

// ============================================================
// SKILLS (Plan 19 Workstream B)
// ============================================================

/** SKILL.md frontmatter schema — compatible with skills.sh/vercel-labs shape. */
export interface SkillManifest {
  /** Human-readable name (required). */
  name: string
  /** Short description used for progressive disclosure (required). */
  description: string
  /** Optional classification tags. */
  tags?: string[]
  /** Jiku-specific extension — safe to omit for third-party skills. */
  metadata?: {
    jiku?: {
      emoji?: string
      os?: NodeJS.Platform[]
      requires?: {
        bins?: string[]
        env?: string[]
        permissions?: string[]
        config?: string[]
      }
      /** Entry file, relative to skill folder. Default "SKILL.md" with "index.md" legacy fallback. */
      entrypoint?: string
    }
    [k: string]: unknown
  }
}

/** Origin of a skill: FS scan or a plugin-contributed registration. */
export type SkillSource = 'fs' | `plugin:${string}`

/** How an agent consumes skills. */
export type SkillAccessMode = 'manual' | 'all_on_demand'

/** Runtime-computed file tree for an activated skill. */
export type SkillFileCategory = 'markdown' | 'code' | 'asset' | 'binary'

export interface SkillFileTree {
  entrypoint: { path: string; content: string }
  files: Array<{
    path: string
    category: SkillFileCategory
    size_bytes: number
  }>
}

/** Shape that a plugin can contribute via ctx.registerSkill(). */
export type PluginSkillSpec =
  | {
      slug: string
      source: 'folder'
      /** Path relative to the plugin root. */
      path: string
    }
  | {
      slug: string
      source: 'inline'
      manifest: SkillManifest
      files: Record<string, string>
    }

/** Runtime context consulted by the eligibility checker. */
export interface SkillEligibilityContext {
  os: NodeJS.Platform
  availableBins: Set<string>
  env: Record<string, string | undefined>
  grantedPermissions: Set<string>
  projectConfig: unknown
}

export interface SkillEligibility {
  eligible: boolean
  reason?: string
}

/** An entry in the union SkillRegistry (FS + plugin sources). */
export interface SkillEntry {
  slug: string
  source: SkillSource
  plugin_id: string | null
  manifest: SkillManifest
  manifest_hash: string
  active: boolean
  last_synced_at: Date | null
}

// ============================================================
// COMMANDS (Plan 24)
// ============================================================

/**
 * Argument spec declared in command frontmatter.
 * Simple positional schema; runtime parses the raw string after `/slug ` into
 * these fields. Unknown / unscheduled arg text lands in `raw`.
 */
export interface CommandArgSpec {
  name: string
  description?: string
  type?: 'string' | 'number' | 'boolean'
  required?: boolean
}

/** COMMAND.md frontmatter schema. Mirrors SkillManifest shape, adds `args`. */
export interface CommandManifest {
  name: string
  description: string
  tags?: string[]
  args?: CommandArgSpec[]
  metadata?: {
    jiku?: {
      emoji?: string
      os?: NodeJS.Platform[]
      requires?: {
        bins?: string[]
        env?: string[]
        permissions?: string[]
        config?: string[]
      }
      entrypoint?: string
    }
    [k: string]: unknown
  }
}

export type CommandSource = 'fs' | `plugin:${string}`

/** How an agent consumes commands. 'manual' = allow-list, 'all' = any active command. */
export type CommandAccessMode = 'manual' | 'all'

export interface CommandEntry {
  slug: string
  source: CommandSource
  plugin_id: string | null
  manifest: CommandManifest
  manifest_hash: string
  active: boolean
  last_synced_at: Date | null
}

export interface CommandFileTree {
  entrypoint: { path: string; content: string }
  files: Array<{
    path: string
    category: SkillFileCategory
    size_bytes: number
  }>
}

export type PluginCommandSpec =
  | {
      slug: string
      source: 'folder'
      path: string
    }
  | {
      slug: string
      source: 'inline'
      manifest: CommandManifest
      files: Record<string, string>
    }

/** Result returned by the dispatcher when a `/slug` prefix is detected. */
export interface CommandDispatchResult {
  matched: boolean
  slug?: string
  source?: CommandSource
  /** Full resolved input text (body + appended args as reference). */
  resolvedInput?: string
  /** Parsed args keyed by arg spec name; `raw` holds remaining string. */
  args?: Record<string, string | number | boolean>
  error?: string
}

