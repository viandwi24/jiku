import {
  createUIMessageStream,
  generateText,
  tool,
  zodSchema,
  jsonSchema,
  type ToolSet,
  type ModelMessage,
  type ToolContent,
  type StepResult,
} from 'ai'
import { DefaultAgentAdapter } from './adapters/default.ts'
import type { AgentAdapter, AgentAdapterRegistryLike, AgentRunContext } from './adapter.ts'
import { zodToJsonSchema } from 'zod-to-json-schema'
import type {
  AgentDefinition,
  JikuRunParams,
  JikuRunResult,
  JikuStreamChunk,
  JikuDataTypes,
  JikuStreamWriter,
  PolicyRule,
  SubjectMatcher,
  JikuStorageAdapter,
  RuntimeContext,
  LLMBridge,
  ToolContext,
  PreviewRunResult,
  ContextSegment,
  ResolvedMemoryConfig,
  AgentMemory,
  PersonaSeed,
  ToolHooks,
} from '@jiku/types'
import type { JikuUIMessage, JikuUIMessageStreamWriter } from './types.ts'
import { resolveScope } from './resolver/scope.ts'
import {
  buildSystemPrompt,
  buildModeInstruction,
  buildUserContext,
  buildToolHints,
} from './resolver/prompt.ts'
import type { ModelProviders } from './providers.ts'
import type { PluginLoader } from './plugins/loader.ts'
import { estimateTokens, getModelContextWindow } from './utils/tokens.ts'
import { compactMessages, applyCompactBoundary } from './compaction.ts'
import { buildMemoryContext, formatMemorySection, formatPersonaSection } from './memory/builder.ts'

/**
 * Serialize a tool input schema (Zod or plain JSON Schema) to a plain JSON Schema object
 * suitable for sending over the wire (e.g. preview API response).
 */
function serializeToolSchema(input: unknown): Record<string, unknown> {
  if (!input || typeof input !== 'object') return { type: 'object', properties: {} }
  if ('_def' in (input as Record<string, unknown>)) {
    try {
      return zodToJsonSchema(input as Parameters<typeof zodToJsonSchema>[0]) as Record<string, unknown>
    } catch {
      return { type: 'object', properties: {} }
    }
  }
  return input as Record<string, unknown>
}

/**
 * Convert a tool input schema (Zod v3) to an AI SDK-compatible schema.
 * Delegates to AI SDK's zodSchema() which handles v3 correctly via zod-to-json-schema internally.
 */
function toInputSchema(input: unknown) {
  if (!input || typeof input !== 'object') {
    return jsonSchema({ type: 'object' as const, properties: {} })
  }
  if ('_def' in (input as Record<string, unknown>)) {
    return zodSchema(input as Parameters<typeof zodSchema>[0])
  }
  return jsonSchema(input as Parameters<typeof jsonSchema>[0])
}

export class JikuAccessError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'JikuAccessError'
  }
}

function generateRunId(): string {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36)
}

/** Build a JikuStreamWriter that delegates to an AI SDK UIMessageStreamWriter. */
function makeWriter(sdkWriter: JikuUIMessageStreamWriter): JikuStreamWriter {
  return {
    write<K extends keyof JikuDataTypes & string>(type: K, data: JikuDataTypes[K]) {
      sdkWriter.write({
        type: `data-${type}` as `data-${K}`,
        data,
      })
    },
  }
}

/**
 * Plan 19 — Hook fired when compaction produces a summary.
 * Called fire-and-forget AFTER the summary is persisted but BEFORE the stream opens.
 * Studio wires this to enqueue a `memory.flush` background job.
 */
export interface CompactionHook {
  (info: {
    conversation_id: string
    agent_id: string
    summary: string
    removed_count: number
    /** Usage metadata for the summarizer LLM call — for usage logging. */
    raw_system_prompt?: string
    raw_user_message?: string
    input_tokens?: number
    output_tokens?: number
    duration_ms?: number
  }): void
}

/**
 * Plan 19 — Hook fired when `run()` finalizes (stream closed, response sent).
 * Studio wires this to enqueue a `memory.reflection` job when reflection is enabled.
 * MUST be fire-and-forget — do not await inside the handler.
 */
export interface FinalizeHook {
  (info: {
    conversation_id: string
    agent_id: string
    mode: string
    turn_count: number
  }): void
}

/** Local fallback registry — used when AgentRunner is constructed without one. */
class DefaultOnlyRegistry implements AgentAdapterRegistryLike {
  private readonly fallback = new DefaultAgentAdapter()
  resolve(_id: string): AgentAdapter {
    return this.fallback
  }
}

export class AgentRunner {
  private toolHooks?: ToolHooks
  private compactionHook?: CompactionHook
  private finalizeHook?: FinalizeHook
  private adapterRegistry: AgentAdapterRegistryLike

  constructor(
    private agent: AgentDefinition,
    private plugins: PluginLoader,
    private storage: JikuStorageAdapter,
    private providers: ModelProviders,
    private memoryConfig?: ResolvedMemoryConfig,
    private runtimeId?: string,
    private personaSeed?: PersonaSeed | null,
    private personaPrompt?: string | null,
    private skillSection?: string | null,
    private skillHint?: string | null,
    adapterRegistry?: AgentAdapterRegistryLike,
  ) {
    this.adapterRegistry = adapterRegistry ?? new DefaultOnlyRegistry()
  }

  setToolHooks(hooks: ToolHooks | undefined): void {
    this.toolHooks = hooks
  }

  /** Plan 19 */
  setCompactionHook(hook: CompactionHook | undefined): void {
    this.compactionHook = hook
  }

  /** Plan 19 */
  setFinalizeHook(hook: FinalizeHook | undefined): void {
    this.finalizeHook = hook
  }

  /**
   * Check whether conversation history has exceeded the compaction threshold.
   * Returns false if threshold is 0 (disabled).
   */
  private async checkCompactionThreshold(
    conversation_id: string,
    threshold: number,
    model_id: string,
  ): Promise<boolean> {
    if (threshold === 0) return false

    // Plan 23 — measure tokens of the ACTIVE BRANCH PATH only. Other branches'
    // messages are irrelevant to the model's current context window.
    const messages = this.storage.getActivePathMessages
      ? await this.storage.getActivePathMessages(conversation_id)
      : await this.storage.getMessages(conversation_id)
    if (messages.length === 0) return false

    const effective = applyCompactBoundary(messages)
    const historyTokens = estimateTokens(JSON.stringify(effective))
    const contextWindow = getModelContextWindow(model_id)
    const usagePercent = (historyTokens / contextWindow) * 100

    return usagePercent >= threshold
  }

  async run(params: JikuRunParams & { rules: PolicyRule[]; subject_matcher?: SubjectMatcher }): Promise<JikuRunResult> {
    const { caller, mode, input, attachments, rules, subject_matcher } = params

    // 1. Resolve scope
    const scope = resolveScope({
      caller,
      agent: this.agent,
      rules,
      all_tools: this.plugins.getResolvedTools(this.runtimeId),
      mode,
      subject_matcher,
    })

    if (!scope.accessible) throw new JikuAccessError(scope.denial_reason ?? 'Access denied')
    if (!scope.allowed_modes.includes(mode)) throw new JikuAccessError(`Mode '${mode}' not allowed`)

    // Merge built-in agent tools (e.g. memory tools) with plugin-resolved tools
    const allBuiltIn = [
      ...(this.agent.built_in_tools ?? []),
      ...(params.extra_built_in_tools ?? []),
    ]
    // Built-in tools use their bare meta.id as tool_name (no `builtin_` prefix).
    // resolved_id keeps the `__builtin__:` namespace internally for tool_states / audit.
    const builtInResolved = allBuiltIn.map(t => ({
      ...t,
      plugin_id: '__builtin__',
      resolved_id: `__builtin__:${t.meta.id}`,
      tool_name: t.meta.id,
      resolved_permission: '*',
    }))
    let modeTools = [
      ...scope.active_tools.filter(t => t.modes.includes(mode)),
      ...builtInResolved.filter(t => t.modes.includes(mode)),
    ]

    // Per-run tool-id suppression (e.g. strip cron_create in cron-triggered runs)
    if (params.suppress_tool_ids && params.suppress_tool_ids.length > 0) {
      const suppressed = new Set(params.suppress_tool_ids)
      modeTools = modeTools.filter(t => !suppressed.has(t.meta.id))
    }

    // Plan 15.6: Filter tools by on/off state (agent override > project override > default enabled)
    if (params.tool_states) {
      const { project, agent: agentStates } = params.tool_states
      modeTools = modeTools.filter(t => {
        const agentState = agentStates[t.resolved_id]
        if (agentState !== undefined) return agentState
        const projectState = project[t.resolved_id]
        if (projectState !== undefined) return projectState
        return true // default: enabled
      })
    }

    // 2. Resolve model — run-level > agent-level > runtime defaults
    const activeProviderId = params.provider_id ?? this.agent.provider_id
    const activeModelId = params.model_id ?? this.agent.model_id
    const model = this.providers.resolve(activeProviderId, activeModelId)
    const model_id = params.model_id ?? this.agent.model_id ?? 'unknown'

    // Plan 26 — LLM bridge exposed to tool handlers via RuntimeContext.llm.
    // Default: reuse the agent's resolved model. Plugins may override provider/model per-call.
    const providers = this.providers
    const llmBridge: LLMBridge = {
      generate: async (prompt, opts) => {
        const target = (opts?.provider || opts?.model)
          ? providers.resolve(opts?.provider ?? activeProviderId, opts?.model ?? activeModelId)
          : model
        const result = await generateText({
          model: target,
          system: opts?.system,
          prompt,
          maxOutputTokens: opts?.maxTokens,
          temperature: opts?.temperature,
        })
        return result.text
      },
    }
    const compaction_threshold = (this.agent as AgentDefinition & { compaction_threshold?: number }).compaction_threshold ?? 80

    // 3. Get or create conversation
    let conversation = params.conversation_id
      ? await this.storage.getConversation(params.conversation_id)
      : null

    if (!conversation) {
      conversation = await this.storage.createConversation({
        agent_id: this.agent.meta.id,
        mode,
        status: 'active',
        goal: mode === 'task' ? input : undefined,
      })
    }

    const run_id = generateRunId()
    const conversation_id = conversation.id

    // 4. Auto-compact if threshold exceeded. Plan 23 — compaction is now
    // BRANCH-AWARE and APPEND-ONLY:
    //   - Operate on the active branch path only (per-branch token budget).
    //   - Insert the [Context Summary] checkpoint as a NEW assistant message
    //     branched off the current tip via addBranchedMessage. Old messages
    //     stay in the tree so other branches remain navigable. The runner's
    //     `applyCompactBoundary()` helper trims everything before the latest
    //     checkpoint when loading history.
    //   - Skip compaction when the user is forking (params.parent_message_id
    //     points to something other than the current tip) or regenerating —
    //     those flows shouldn't pollute the old branch with a checkpoint
    //     right when the user is moving away from it.
    const preCompactionTip = conversation.active_tip_message_id ?? null
    const isExplicitBranchFork = params.parent_message_id !== undefined
      && params.parent_message_id !== preCompactionTip
    const isRegenerate = params.regenerate === true
    const shouldCompact = !isExplicitBranchFork
      && !isRegenerate
      && await this.checkCompactionThreshold(conversation_id, compaction_threshold, model_id)
    let compactSummary: string | null = null
    let compactRemovedCount = 0
    let compactTokenSaved = 0

    if (shouldCompact) {
      const branchMessages = this.storage.getActivePathMessages
        ? await this.storage.getActivePathMessages(conversation_id)
        : await this.storage.getMessages(conversation_id)
      const result = await compactMessages({
        messages: branchMessages,
        conversation_id,
        keepRecent: 10,
        model,
      })

      if (result.removed_count > 0) {
        // Append-only: branched conversations safe; storage keeps old rows.
        if (this.storage.addBranchedMessage && preCompactionTip) {
          await this.storage.addBranchedMessage({
            conversation_id,
            parent_message_id: preCompactionTip,
            role: 'assistant',
            parts: [{ type: 'text', text: `[Context Summary]\n${result.summary}` }],
          })
          // Reload conversation so subsequent code sees the new active tip
          // (now the checkpoint message we just inserted).
          conversation = await this.storage.getConversation(conversation_id) ?? conversation
        } else {
          // Legacy / in-memory fallback: physically replace the rows.
          await this.storage.replaceMessages(conversation_id, result.compacted)
        }
        compactSummary = result.summary
        compactRemovedCount = result.removed_count
        compactTokenSaved = result.token_saved
        // Plan 19 — fire compaction hook fire-and-forget
        try {
          this.compactionHook?.({
            conversation_id,
            agent_id: this.agent.meta.id,
            summary: result.summary,
            removed_count: result.removed_count,
            raw_system_prompt: result.raw_system_prompt,
            raw_user_message: result.raw_user_message,
            input_tokens: result.input_tokens,
            output_tokens: result.output_tokens,
            duration_ms: result.duration_ms,
          })
        } catch (err) {
          // Hook must never interrupt the run
          console.warn('[runner] compaction hook error:', err)
        }
      }
    }

    // 5. Load persona + memories (if storage supports it + memory config is set)
    let personaSection: string | undefined
    let memorySection: string | undefined
    let accessedMemoryIds: string[] = []
    let loadedMemories: AgentMemory[] = []

    if (this.personaPrompt) {
      // Plain-text persona prompt — injected directly, no memory involved
      personaSection = this.personaPrompt
    } else if (this.runtimeId && this.storage.getMemories) {
      // Legacy: build persona from agent_self memories + seed
      const selfMemories = await this.storage.getMemories({
        runtime_id: this.runtimeId,
        agent_id: this.agent.meta.id,
        scope: 'agent_self',
      })
      const personaText = formatPersonaSection(this.agent.meta.name, selfMemories, this.personaSeed)
      if (personaText) personaSection = personaText
    }

    if (this.memoryConfig && this.runtimeId && this.storage.getMemories) {
      const config = this.memoryConfig
      const runtimeId = this.runtimeId
      const agentId = this.agent.meta.id
      const callerId = caller.user_id

      const [runtimeMems, agentMems, callerMems, extendedMems] = await Promise.all([
        config.policy.read.runtime_global
          ? this.storage.getMemories({ runtime_id: runtimeId, scope: 'runtime_global' })
          : Promise.resolve([]),
        this.storage.getMemories({ runtime_id: runtimeId, agent_id: agentId, scope: 'agent_global' }),
        this.storage.getMemories({ runtime_id: runtimeId, agent_id: agentId, caller_id: callerId, scope: 'agent_caller' }),
        this.storage.getMemories({ runtime_id: runtimeId, agent_id: agentId, caller_id: callerId, scope: ['agent_caller', 'agent_global'], tier: 'extended' }),
      ])

      loadedMemories = [...runtimeMems, ...agentMems, ...callerMems]

      const memoryCtx = await buildMemoryContext({
        memories: {
          runtime_global: runtimeMems,
          agent_global: agentMems,
          agent_caller: callerMems,
          extended_pool: extendedMems,
        },
        current_input: input,
        config,
        semanticScores: params.semantic_scores,
      })

      accessedMemoryIds = [
        ...memoryCtx.runtime_global,
        ...memoryCtx.agent_global,
        ...memoryCtx.agent_caller,
        ...memoryCtx.extended,
      ].map(m => m.id)

      if (accessedMemoryIds.length > 0 && this.storage.touchMemories) {
        this.storage.touchMemories(accessedMemoryIds).catch((err) => {
          console.warn('[memory] touchMemories failed:', err)
        })
      }

      const userName = (caller.user_data.name as string | undefined)
      memorySection = formatMemorySection(memoryCtx, userName) || undefined
    }

    // 6. Build system prompt + history (before stream starts)
    const pluginSegmentsMeta = await this.plugins.getPromptSegmentsWithMetaAsync(this.runtimeId)
    const labeledPluginSegments = pluginSegmentsMeta.map(p => ({
      label: `${p.plugin_name} (${p.plugin_id})`,
      content: p.segment,
    }))
    const systemPrompt = buildSystemPrompt({
      base: this.agent.base_prompt,
      mode,
      active_tools: modeTools,
      caller,
      plugin_segments: labeledPluginSegments,
      prepend_segments: params.extra_system_prepend,
      runtime_segments: params.extra_system_segments,
      memory_section: memorySection,
      persona_section: personaSection,
      skill_section: this.skillSection ?? undefined,
      skill_hint: this.skillHint ?? undefined,
    })

    // Plan 23 — chat conversations load the active branch path (root → tip)
    // instead of the flat message list, so siblings from other branches don't
    // contaminate model context.
    //
    // The "history reference" is whichever parent the about-to-be-saved user
    // message will hang off:
    //   - linear extend (no override OR override === pre-compaction tip)
    //     → walk from the LATEST conversation tip (which now includes any
    //       checkpoint compaction inserted above).
    //   - explicit branch fork (override is a different uuid)
    //     → walk from that override so the model only sees ancestors of the
    //       point being branched from. Otherwise the about-to-be-superseded
    //       turn would still be in the loaded path and the model would treat
    //       the new input as a follow-up rather than a replacement.
    //   - explicit "branch at root" (override is null) → empty history.
    const _wasLinearExtend = params.parent_message_id === undefined
      || params.parent_message_id === preCompactionTip
    const historyRef: string | null = _wasLinearExtend
      ? (conversation.active_tip_message_id ?? null)
      : (params.parent_message_id ?? null)
    let history: Awaited<ReturnType<typeof this.storage.getMessages>>
    if (historyRef === null) {
      history = []
    } else if (this.storage.getMessagesByPath) {
      history = await this.storage.getMessagesByPath(historyRef)
    } else {
      history = await this.storage.getMessages(conversation_id)
    }
    const effectiveHistory = applyCompactBoundary(history)

    // Plan 22 revision — build a lookup of previously-executed side-effectful tool calls
    // keyed by `${toolName}:${hash(args)}`. Used to short-circuit re-execution on edit replay.
    // We scan the FULL history (not effectiveHistory) so dedup survives context compaction.
    const priorSideEffectResults = new Map<string, unknown>()
    const stableStringify = (v: unknown): string => {
      const seen = new WeakSet()
      const walk = (x: unknown): unknown => {
        if (x === null || typeof x !== 'object') return x
        if (seen.has(x as object)) return null
        seen.add(x as object)
        if (Array.isArray(x)) return x.map(walk)
        const o = x as Record<string, unknown>
        return Object.keys(o).sort().reduce<Record<string, unknown>>((acc, k) => {
          acc[k] = walk(o[k]); return acc
        }, {})
      }
      try { return JSON.stringify(walk(v)) } catch { return '' }
    }
    for (const m of history) {
      if (m.role !== 'assistant') continue
      const toolParts = m.parts.filter(p => p.type === 'tool-invocation') as Array<{
        type: 'tool-invocation'; toolName: string; args: unknown; state: string; result?: unknown
      }>
      for (const tp of toolParts) {
        if (tp.state !== 'result') continue
        priorSideEffectResults.set(`${tp.toolName}:${stableStringify(tp.args)}`, tp.result)
      }
    }

    const messages: ModelMessage[] = []
    for (const m of effectiveHistory) {
      if (m.role === 'user') {
        const text = m.parts.find(p => p.type === 'text') as { type: 'text'; text: string } | undefined
        if (text) messages.push({ role: 'user', content: text.text })
      } else if (m.role === 'assistant') {
        // Build rich assistant content preserving tool calls + results
        const toolParts = m.parts.filter(p => p.type === 'tool-invocation') as Array<{
          type: 'tool-invocation'; toolInvocationId: string; toolName: string; args: unknown; state: string; result?: unknown
        }>
        const textPart = m.parts.find(p => p.type === 'text') as { type: 'text'; text: string } | undefined

        if (toolParts.length > 0) {
          // Multi-part: tool calls + optional text
          type AssistantPart = { type: 'text'; text: string } | { type: 'tool-call'; toolCallId: string; toolName: string; input: unknown }
          const content: AssistantPart[] = []
          if (textPart) content.push({ type: 'text', text: textPart.text })
          for (const tp of toolParts) {
            content.push({ type: 'tool-call', toolCallId: tp.toolInvocationId, toolName: tp.toolName, input: tp.args })
          }
          messages.push({ role: 'assistant', content })
          // Add tool results as a tool message
          const toolResults = toolParts
            .filter(tp => tp.state === 'result')
            .map(tp => ({
              type: 'tool-result' as const,
              toolCallId: tp.toolInvocationId,
              toolName: tp.toolName,
              output: { type: 'json' as const, value: tp.result ?? null },
            }))
          if (toolResults.length > 0) {
            messages.push({ role: 'tool', content: toolResults as ToolContent })
          }
        } else if (textPart) {
          messages.push({ role: 'assistant', content: textPart.text })
        }
      }
    }
    // Plan 23 — for regenerate, the user message we're re-running from is
    // ALREADY the last item in `history` (we walked the path ending at that
    // user msg). Pushing `input` again would duplicate it in model context.
    if (params.regenerate) {
      // intentionally skip — model sees history as-is and produces a fresh
      // assistant response; persistence below saves it as a sibling.
    } else
    // Build user message content — text + optional image/file attachments
    if (attachments && attachments.length > 0) {
      type UserContentPart =
        | { type: 'text'; text: string }
        | { type: 'image'; image: string; mimeType?: string }
        | { type: 'file'; data: string; mimeType: string; filename?: string }

      const parts: UserContentPart[] = [{ type: 'text', text: input }]
      for (const att of attachments) {
        if (att.mime_type.startsWith('image/')) {
          parts.push({ type: 'image', image: att.data, mimeType: att.mime_type })
        } else {
          // Non-image: pass as file part (text-based models will see extracted content)
          parts.push({ type: 'file', data: att.data, mimeType: att.mime_type, filename: att.name })
        }
      }
      messages.push({ role: 'user', content: parts })
    } else {
      messages.push({ role: 'user', content: input })
    }

    // Build user message parts: text + original file parts (attachment:// URLs for persistence)
    type UserMessagePart =
      | { type: 'text'; text: string }
      | { type: 'file'; mediaType: string; filename?: string; url: string }
    // File parts first, then text — matches AI SDK's live message part order
    const userParts: UserMessagePart[] = []
    if (params.input_file_parts && params.input_file_parts.length > 0) {
      for (const fp of params.input_file_parts) {
        userParts.push({ type: 'file', mediaType: fp.mediaType, filename: fp.filename, url: fp.url })
      }
    }
    userParts.push({ type: 'text', text: input })

    // Plan 23 — persist user message branched off the requested parent (or
    // current active tip if not specified). When `regenerate: true`, skip the
    // user-save entirely: regenerate replays from an existing user message
    // that's already on the active path and only adds a new assistant sibling.
    // Plan 23 — when the client asked for a "linear extend" (no parent
    // override OR the override matches the pre-compaction tip), we must use
    // the LATEST tip so the new user message chains off any checkpoint that
    // compaction may have just inserted. Otherwise the new message would
    // become a sibling of the checkpoint (orphaning the compaction).
    const desiredParent = _wasLinearExtend
      ? (conversation.active_tip_message_id ?? null)
      : (params.parent_message_id ?? null)

    let lastUserMessageId: string | null = null
    if (params.regenerate) {
      // For regenerate, the supplied parent_message_id MUST be a user message.
      // Active tip on the conversation is set to it before the runner starts so
      // history loading above already returns the path ending at that user msg.
      lastUserMessageId = desiredParent
    } else if (this.storage.addBranchedMessage) {
      const saved = await this.storage.addBranchedMessage({
        conversation_id,
        parent_message_id: desiredParent,
        role: 'user',
        parts: userParts,
      })
      lastUserMessageId = saved.id
    } else {
      const saved = await this.storage.addMessage(conversation_id, {
        conversation_id,
        role: 'user',
        parts: userParts,
      })
      lastUserMessageId = saved.id
    }

    // 7. Build runtime context (shared across the run)
    const runtimeCtx: RuntimeContext = {
      caller,
      agent: { id: this.agent.meta.id, name: this.agent.meta.name, mode },
      conversation_id,
      run_id,
      // project_id mirrors runtimeId so tools can access the project filesystem
      // without needing a separate injection mechanism.
      project_id: this.runtimeId,
      llm: llmBridge,
      // Plan 22 follow-up — caller-supplied runtime keys (e.g. connector_hint
      // from event-router) spread BEFORE plugin providers so a plugin that
      // contributes the same key can intentionally override, not be shadowed.
      ...(params.extra_runtime_context ?? {}),
      ...this.plugins.resolveProviders(caller),
    }

    // 8. Keep a ref to the storage for use in closures below
    const storage = this.storage

    // 9. Build stream using createUIMessageStream
    const stream = createUIMessageStream<JikuUIMessage>({
      execute: async ({ writer }) => {
        const jikuWriter = makeWriter(writer)

        // Emit meta immediately
        jikuWriter.write('jiku-meta', {
          run_id,
          conversation_id,
          agent_id: this.agent.meta.id,
          mode,
        })

        // Emit compaction event if compaction happened before this run
        if (compactSummary !== null) {
          jikuWriter.write('jiku-compact', {
            summary: compactSummary,
            removed_count: compactRemovedCount,
            token_saved: compactTokenSaved,
          })
        }

        // Build AI SDK tools map
        const aiTools: ToolSet = {}
        const toolHooks = this.toolHooks
        const agentId = this.agent.meta.id
        for (const resolvedTool of modeTools) {
          const toolCtx: ToolContext = {
            runtime: runtimeCtx,
            storage: {
              get: (key) => storage.pluginGet(resolvedTool.plugin_id, key),
              set: (key, value) => storage.pluginSet(resolvedTool.plugin_id, key, value),
              delete: (key) => storage.pluginDelete(resolvedTool.plugin_id, key),
              keys: (prefix) => storage.pluginKeys(resolvedTool.plugin_id, prefix),
            },
            writer: jikuWriter,
          }

          const hookInfo = {
            tool_id: resolvedTool.resolved_id,
            tool_name: resolvedTool.tool_name,
            plugin_id: resolvedTool.plugin_id,
            caller,
            agent_id: agentId,
          }

          // Plan 18 — enforce plugin-granted permission before executing.
          const enforcePermission = () => {
            const required = resolvedTool.meta.required_plugin_permission
            if (!required) return
            if (caller.is_superadmin) return
            const granted = caller.granted_plugin_permissions ?? []
            if (!granted.includes(required)) {
              const reason = `Permission '${required}' required to use tool '${resolvedTool.resolved_id}'`
              void toolHooks?.onBlocked?.({ ...hookInfo, reason })
              throw new Error(reason)
            }
          }

          if (resolvedTool.executeStream) {
            // Plan 15.1: Streaming tool — yield progress chunks
            const streamExec = resolvedTool.executeStream
            const toolId = resolvedTool.resolved_id
            aiTools[resolvedTool.tool_name] = tool({
              description: resolvedTool.meta.description,
              inputSchema: toInputSchema(resolvedTool.input),
              execute: async (args: unknown) => {
                enforcePermission()
                void toolHooks?.onInvoke?.({ ...hookInfo, args })
                try {
                  const gen = streamExec(args, toolCtx)
                  let finalValue: unknown
                  for await (const chunk of gen) {
                    jikuWriter.write('jiku-tool-data', { tool_id: toolId, data: chunk })
                  }
                  const result = await gen.return(undefined)
                  finalValue = result.value
                  return finalValue
                } catch (error) {
                  void toolHooks?.onError?.({ ...hookInfo, args, error })
                  throw error
                }
              },
            })
          } else {
            const sideEffectful = resolvedTool.meta.side_effectful === true
            const toolNameKey = resolvedTool.tool_name
            aiTools[resolvedTool.tool_name] = tool({
              description: resolvedTool.meta.description,
              inputSchema: toInputSchema(resolvedTool.input),
              execute: async (args: unknown) => {
                enforcePermission()
                void toolHooks?.onInvoke?.({ ...hookInfo, args })
                // Plan 22 revision — dedup on edit replay: if this exact tool+args
                // was already executed earlier in this conversation, return the cached
                // result instead of re-running (prevents duplicate cron rows / double sends).
                if (sideEffectful) {
                  const key = `${toolNameKey}:${stableStringify(args)}`
                  if (priorSideEffectResults.has(key)) {
                    return priorSideEffectResults.get(key)
                  }
                }
                try {
                  return await resolvedTool.execute(args, toolCtx)
                } catch (error) {
                  void toolHooks?.onError?.({ ...hookInfo, args, error })
                  throw error
                }
              },
            })
          }
        }

        // Plan 21 — persistAssistantMessage helper shared by adapters.
        const persistAssistantMessage = async (steps: StepResult<ToolSet>[]): Promise<void> => {
          type MessagePartLocal =
            | { type: 'text'; text: string }
            | { type: 'tool-invocation'; toolInvocationId: string; toolName: string; args: unknown; state: 'result'; result: unknown }

          const allParts: MessagePartLocal[] = []
          for (const step of steps) {
            for (const tc of step.toolCalls ?? []) {
              const tr = (step.toolResults ?? []).find((r) => r.toolCallId === tc.toolCallId)
              allParts.push({
                type: 'tool-invocation',
                toolInvocationId: tc.toolCallId,
                toolName: tc.toolName,
                args: tc.input,
                state: 'result',
                result: tr?.output ?? null,
              })
            }
            if (step.text) allParts.push({ type: 'text', text: step.text })
          }

          if (allParts.length > 0) {
            // Plan 23 — assistant message hangs off the user message we just saved
            // (or off the supplied `parent_message_id` for regenerate flows).
            if (storage.addBranchedMessage) {
              await storage.addBranchedMessage({
                conversation_id,
                parent_message_id: lastUserMessageId,
                role: 'assistant',
                parts: allParts,
              })
            } else {
              await storage.addMessage(conversation_id, {
                conversation_id,
                role: 'assistant',
                parts: allParts,
              })
            }
          }

          if (mode === 'task') {
            const finalText = steps.map(s => s.text).filter(Boolean).join('')
            await storage.updateConversation(conversation_id, {
              status: 'completed',
              output: finalText || undefined,
            })
          }

          // Plan 19 — fire finalize hook fire-and-forget (reflection enqueue)
          try {
            this.finalizeHook?.({
              conversation_id,
              agent_id: this.agent.meta.id,
              mode,
              turn_count: steps.length,
            })
          } catch (err) {
            console.warn('[runner] finalize hook error:', err)
          }
        }

        // Plan 21 — resolve adapter for this mode.
        const modeConfig = this.agent.mode_configs?.[mode]
        const adapterId = modeConfig?.adapter ?? 'jiku.agent.default'
        const adapter = this.adapterRegistry.resolve(adapterId)

        const adapterCtx: AgentRunContext = {
          systemPrompt,
          messages,
          modeTools,
          aiTools,
          model,
          maxToolCalls: this.agent.max_tool_calls ?? 40,
          mode,
          run_id,
          conversation_id,
          agent_id: this.agent.meta.id,
          storage,
          runtimeCtx,
          writer: jikuWriter,
          sdkWriter: writer,
          modeConfig,
          emitUsage: (usage) => {
            jikuWriter.write('jiku-usage', {
              input_tokens: usage.inputTokens ?? 0,
              output_tokens: usage.outputTokens ?? 0,
            })
          },
          persistAssistantMessage,
        }

        await adapter.execute(adapterCtx, params)
      },

      onError: (err: unknown) => {
        // Surface provider error messages cleanly
        const e = err as Record<string, unknown>
        if (e?.responseBody) {
          try {
            const body = typeof e.responseBody === 'string'
              ? JSON.parse(e.responseBody)
              : e.responseBody
            const msg = (body as Record<string, unknown>)?.error
            if (msg && typeof msg === 'object') {
              const message = (msg as Record<string, unknown>).message
              if (message) return String(message)
            }
          } catch { /* ignore */ }
        }
        if (err instanceof Error) return err.message
        return String(err)
      },
    })

    return {
      run_id,
      conversation_id,
      stream: stream as ReadableStream<JikuStreamChunk>,
    }
  }

  /**
   * Preview the context that would be built for a run, without calling the LLM.
   * Returns token estimates per segment, active tools, and warnings.
   */
  async previewRun(params: {
    caller: JikuRunParams['caller']
    mode: JikuRunParams['mode']
    conversation_id?: string
    rules: PolicyRule[]
    subject_matcher?: SubjectMatcher
    extra_system_segments?: Array<{ label: string; content: string }>
    extra_system_prepend?: Array<{ label: string; content: string }>
  }): Promise<PreviewRunResult> {
    const { caller, mode, rules, subject_matcher } = params
    const extraSystemSegments = params.extra_system_segments ?? []
    const extraSystemPrepend = params.extra_system_prepend ?? []

    const scope = resolveScope({
      caller,
      agent: this.agent,
      rules,
      all_tools: this.plugins.getResolvedTools(this.runtimeId),
      mode,
      subject_matcher,
    })

    if (!scope.accessible) throw new JikuAccessError(scope.denial_reason ?? 'Access denied')

    // Merge built-in tools (same as run())
    const builtInResolved = (this.agent.built_in_tools ?? []).map(t => ({
      ...t,
      plugin_id: '__builtin__',
      resolved_id: `__builtin__:${t.meta.id}`,
      tool_name: t.meta.id,
      resolved_permission: '*',
    }))
    const modeTools = [
      ...scope.active_tools.filter(t => t.modes.includes(mode)),
      ...builtInResolved.filter(t => t.modes.includes(mode)),
    ]

    const model_id = this.agent.model_id ?? 'unknown'
    const pluginSegmentsWithMeta = await this.plugins.getPromptSegmentsWithMetaAsync(this.runtimeId)
    const pluginSegments = pluginSegmentsWithMeta.map(s => s.segment)

    // Build segments with token estimates
    const modeInstructionText = buildModeInstruction(mode)
    const userContextText = buildUserContext(caller)
    const toolHintsText = buildToolHints(modeTools)

    // Load persona for preview
    let personaSection: string | undefined
    if (this.personaPrompt) {
      personaSection = this.personaPrompt
    } else if (this.runtimeId && this.storage.getMemories) {
      const selfMemories = await this.storage.getMemories({
        runtime_id: this.runtimeId,
        agent_id: this.agent.meta.id,
        scope: 'agent_self',
      })
      const personaText = formatPersonaSection(this.agent.meta.name, selfMemories, this.personaSeed)
      if (personaText) personaSection = personaText
    }

    // Load memories for preview (read-only — no touchMemories)
    let memorySection: string | undefined
    if (this.memoryConfig && this.runtimeId && this.storage.getMemories) {
      const config = this.memoryConfig
      const runtimeId = this.runtimeId
      const agentId = this.agent.meta.id
      const callerId = caller.user_id
      const [runtimeMems, agentMems, callerMems] = await Promise.all([
        config.policy.read.runtime_global ? this.storage.getMemories({ runtime_id: runtimeId, scope: 'runtime_global' }) : Promise.resolve([]),
        this.storage.getMemories({ runtime_id: runtimeId, agent_id: agentId, scope: 'agent_global' }),
        this.storage.getMemories({ runtime_id: runtimeId, agent_id: agentId, scope: 'agent_caller', caller_id: callerId }),
      ])
      const memoryCtx = await buildMemoryContext({
        memories: { runtime_global: runtimeMems, agent_global: agentMems, agent_caller: callerMems, extended_pool: [...agentMems, ...callerMems] },
        current_input: '',
        config,
      })
      const userName = (caller.user_data.name as string | undefined)
      memorySection = formatMemorySection(memoryCtx, userName) || undefined
    }

    // Order must match buildSystemPrompt() in resolver/prompt.ts so the preview
    // reflects the actual system prompt layout.
    const segments: ContextSegment[] = [
      ...extraSystemPrepend.map(({ label, content }) => ({
        source: 'runtime' as const,
        label: `${label} (prepend)`,
        content,
        token_estimate: estimateTokens(content),
      })),
      {
        source: 'base_prompt',
        label: 'Base Prompt',
        content: this.agent.base_prompt,
        token_estimate: estimateTokens(this.agent.base_prompt),
      },
      ...(personaSection
        ? [{
            source: 'persona' as const,
            label: 'Persona',
            content: personaSection,
            token_estimate: estimateTokens(personaSection),
          }]
        : []),
      ...(this.skillSection
        ? [{
            source: 'skill' as const,
            label: 'Skills (always)',
            content: this.skillSection,
            token_estimate: estimateTokens(this.skillSection),
          }]
        : []),
      ...(memorySection
        ? [{
            source: 'memory' as const,
            label: 'Memory',
            content: memorySection,
            token_estimate: estimateTokens(memorySection),
          }]
        : []),
      {
        source: 'mode',
        label: `Mode: ${mode}`,
        content: modeInstructionText,
        token_estimate: estimateTokens(modeInstructionText),
      },
      {
        source: 'user_context',
        label: 'User Context',
        content: userContextText,
        token_estimate: estimateTokens(userContextText),
      },
      ...(this.skillHint
        ? [{
            source: 'skill' as const,
            label: 'Skills (on-demand hint)',
            content: this.skillHint,
            token_estimate: estimateTokens(this.skillHint),
          }]
        : []),
      ...(toolHintsText
        ? [{
            source: 'tool_hint' as const,
            label: 'Tool Hints',
            content: toolHintsText,
            token_estimate: estimateTokens(toolHintsText),
          }]
        : []),
      ...pluginSegmentsWithMeta.map(({ plugin_id, plugin_name, segment }) => ({
        source: 'plugin' as const,
        label: `${plugin_name} (${plugin_id})`,
        content: segment,
        token_estimate: estimateTokens(segment),
      })),
      ...extraSystemSegments.map(({ label, content }) => ({
        source: 'runtime' as const,
        label,
        content,
        token_estimate: estimateTokens(content),
      })),
    ]

    const totalTokens = segments.reduce((acc, s) => acc + s.token_estimate, 0)

    // History tokens + compaction count
    let historyTokens = 0
    let compactionCount = 0
    if (params.conversation_id) {
      // Plan 23 — preview reflects the ACTIVE BRANCH the user is currently
      // viewing. Counting tokens across all branches would over-report and
      // misrepresent the per-branch context budget shown in the UI.
      const branchMsgs = this.storage.getActivePathMessages
        ? await this.storage.getActivePathMessages(params.conversation_id)
        : await this.storage.getMessages(params.conversation_id)
      // Count all [Context Summary] checkpoint messages in the active path
      compactionCount = branchMsgs.filter(m =>
        m.role === 'assistant' &&
        m.parts.some(p => p.type === 'text' && (p as { type: 'text'; text: string }).text.startsWith('[Context Summary]'))
      ).length
      const effective = applyCompactBoundary(branchMsgs)
      historyTokens = estimateTokens(JSON.stringify(effective))
    }

    const modelContextWindow = getModelContextWindow(model_id)
    const grandTotal = totalTokens + historyTokens
    const usagePercent = (grandTotal / modelContextWindow) * 100

    const warnings: string[] = []
    if (usagePercent > 95) {
      warnings.push(`Context nearly full (${usagePercent.toFixed(0)}%) — some history may be truncated`)
    } else if (usagePercent > 80) {
      warnings.push(`Context at ${usagePercent.toFixed(0)}% — compaction may trigger soon`)
    }

    const labeledPluginPreview = pluginSegmentsWithMeta.map(p => ({
      label: `${p.plugin_name} (${p.plugin_id})`,
      content: p.segment,
    }))
    const systemPrompt = buildSystemPrompt({
      base: this.agent.base_prompt,
      mode,
      active_tools: modeTools,
      caller,
      plugin_segments: labeledPluginPreview,
      prepend_segments: extraSystemPrepend,
      runtime_segments: extraSystemSegments,
      memory_section: memorySection,
      persona_section: personaSection,
      skill_section: this.skillSection ?? undefined,
      skill_hint: this.skillHint ?? undefined,
    })

    return {
      context: {
        segments,
        total_tokens: totalTokens,
        history_tokens: historyTokens,
        grand_total: grandTotal,
        model_context_window: modelContextWindow,
        usage_percent: usagePercent,
      },
      active_tools: modeTools.map(t => ({
        id: t.resolved_id,
        name: t.meta.name,
        description: t.meta.description,
        permission: t.resolved_permission,
        has_prompt: !!t.prompt,
        token_estimate: t.prompt ? estimateTokens(t.prompt) : 0,
        input_schema: serializeToolSchema(t.input),
        group: t.meta.group,
      })),
      active_plugins: this.plugins.getLoadOrder().map(id => ({
        id,
        name: id,
        segments: [],
      })),
      system_prompt: systemPrompt,
      warnings,
      compaction_count: compactionCount,
    }
  }
}
