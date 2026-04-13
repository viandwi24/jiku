import {
  createUIMessageStream,
  streamText,
  stepCountIs,
  tool,
  zodSchema,
  jsonSchema,
  type ToolSet,
  type ModelMessage,
  type ToolContent,
} from 'ai'
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

export class AgentRunner {
  private toolHooks?: ToolHooks
  private compactionHook?: CompactionHook
  private finalizeHook?: FinalizeHook

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
  ) {}

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

    const messages = await this.storage.getMessages(conversation_id)
    if (messages.length === 0) return false

    const historyTokens = estimateTokens(JSON.stringify(messages))
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
      all_tools: this.plugins.getResolvedTools(),
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
    const builtInResolved = allBuiltIn.map(t => ({
      ...t,
      plugin_id: '__builtin__',
      resolved_id: `__builtin__:${t.meta.id}`,
      tool_name: `builtin_${t.meta.id}`,
      resolved_permission: '*',
    }))
    let modeTools = [
      ...scope.active_tools.filter(t => t.modes.includes(mode)),
      ...builtInResolved.filter(t => t.modes.includes(mode)),
    ]

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
    const model = this.providers.resolve(
      params.provider_id ?? this.agent.provider_id,
      params.model_id ?? this.agent.model_id,
    )
    const model_id = params.model_id ?? this.agent.model_id ?? 'unknown'
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

    // 4. Auto-compact if threshold exceeded
    const shouldCompact = await this.checkCompactionThreshold(conversation_id, compaction_threshold, model_id)
    let compactSummary: string | null = null
    let compactRemovedCount = 0
    let compactTokenSaved = 0

    if (shouldCompact) {
      const allMessages = await this.storage.getMessages(conversation_id)
      const result = await compactMessages({
        messages: allMessages,
        conversation_id,
        keepRecent: 10,
        model,
      })

      if (result.removed_count > 0) {
        await this.storage.replaceMessages(conversation_id, result.compacted)
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
    const pluginSegments = await this.plugins.getPromptSegmentsAsync()
    const systemPrompt = buildSystemPrompt({
      base: this.agent.base_prompt,
      mode,
      active_tools: modeTools,
      caller,
      plugin_segments: pluginSegments,
      memory_section: memorySection,
      persona_section: personaSection,
      skill_section: this.skillSection ?? undefined,
      skill_hint: this.skillHint ?? undefined,
    })

    const history = await this.storage.getMessages(conversation_id)
    const effectiveHistory = applyCompactBoundary(history)
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

    await this.storage.addMessage(conversation_id, {
      conversation_id,
      role: 'user',
      parts: userParts,
    })

    // 7. Build runtime context (shared across the run)
    const runtimeCtx: RuntimeContext = {
      caller,
      agent: { id: this.agent.meta.id, name: this.agent.meta.name, mode },
      conversation_id,
      run_id,
      // project_id mirrors runtimeId so tools can access the project filesystem
      // without needing a separate injection mechanism.
      project_id: this.runtimeId,
      ...this.plugins.resolveProviders(caller),
    }

    // 8. Keep a ref to the storage for use in closures below
    const storage = this.storage
    const memoryConfig = this.memoryConfig
    const runtimeId = this.runtimeId
    const agentId = this.agent.meta.id

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
            aiTools[resolvedTool.tool_name] = tool({
              description: resolvedTool.meta.description,
              inputSchema: toInputSchema(resolvedTool.input),
              execute: async (args: unknown) => {
                enforcePermission()
                void toolHooks?.onInvoke?.({ ...hookInfo, args })
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

        // Run LLM — merge AI SDK stream directly into the UI stream writer
        const result = streamText({
          model,
          system: systemPrompt,
          messages,
          tools: Object.keys(aiTools).length > 0 ? aiTools : undefined,
          stopWhen: stepCountIs(this.agent.max_tool_calls ?? 40),
          abortSignal: params.abort_signal,
          onStepFinish: (event) => {
            jikuWriter.write('jiku-step-usage', {
              step: event.stepNumber,
              input_tokens: event.usage.inputTokens ?? 0,
              output_tokens: event.usage.outputTokens ?? 0,
            })
          },
        })

        // Drain the streamText output into the UI stream
        writer.merge(
          result.toUIMessageStream({ sendFinish: true, sendStart: true, sendReasoning: true, sendSources: true }),
        )

        // Wait for completion then persist + emit final usage
        const [steps, usage] = await Promise.all([result.steps, result.usage])

        // Aggregate final assistant text across all steps for usage logging.
        const finalResponseText = steps.map(s => s.text).filter(Boolean).join('\n')

        // Emit raw snapshot for usage log debug
        jikuWriter.write('jiku-run-snapshot', {
          system_prompt: systemPrompt,
          messages,
          response: finalResponseText,
        })

        jikuWriter.write('jiku-usage', {
          input_tokens: usage.inputTokens ?? 0,
          output_tokens: usage.outputTokens ?? 0,
        })

        // Build all parts from all steps: text + tool invocations
        type MessagePartLocal =
          | { type: 'text'; text: string }
          | { type: 'tool-invocation'; toolInvocationId: string; toolName: string; args: unknown; state: 'result'; result: unknown }

        const allParts: MessagePartLocal[] = []

        for (const step of steps) {
          // Add tool call+result pairs for this step
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
          // Add text part for this step (if any)
          if (step.text) {
            allParts.push({ type: 'text', text: step.text })
          }
        }

        if (allParts.length > 0) {
          await storage.addMessage(conversation_id, {
            conversation_id,
            role: 'assistant',
            parts: allParts,
          })
        }

        if (mode === 'task') {
          const finalText = steps.map(s => s.text).filter(Boolean).join('')
          await storage.updateConversation(conversation_id, {
            status: 'completed',
            output: finalText || undefined,
          })
        }

        // Note: LLM extraction removed (Plan 15 decision).
        // Memory is saved explicitly via agent tool calls (memory_core_append, etc.)
        // This avoids duplicate memories and saves token costs.

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
  }): Promise<PreviewRunResult> {
    const { caller, mode, rules, subject_matcher } = params

    const scope = resolveScope({
      caller,
      agent: this.agent,
      rules,
      all_tools: this.plugins.getResolvedTools(),
      mode,
      subject_matcher,
    })

    if (!scope.accessible) throw new JikuAccessError(scope.denial_reason ?? 'Access denied')

    // Merge built-in tools (same as run())
    const builtInResolved = (this.agent.built_in_tools ?? []).map(t => ({
      ...t,
      plugin_id: '__builtin__',
      resolved_id: `__builtin__:${t.meta.id}`,
      tool_name: `builtin_${t.meta.id}`,
      resolved_permission: '*',
    }))
    const modeTools = [
      ...scope.active_tools.filter(t => t.modes.includes(mode)),
      ...builtInResolved.filter(t => t.modes.includes(mode)),
    ]

    const model_id = this.agent.model_id ?? 'unknown'
    const pluginSegments = await this.plugins.getPromptSegmentsAsync()

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
      ...pluginSegments.map((seg, i) => ({
        source: 'plugin' as const,
        label: `Plugin Segment ${i + 1}`,
        content: seg,
        token_estimate: estimateTokens(seg),
      })),
    ]

    const totalTokens = segments.reduce((acc, s) => acc + s.token_estimate, 0)

    // History tokens + compaction count
    let historyTokens = 0
    let compactionCount = 0
    if (params.conversation_id) {
      const msgs = await this.storage.getMessages(params.conversation_id)
      // Count all [Context Summary] checkpoint messages in DB
      compactionCount = msgs.filter(m =>
        m.role === 'assistant' &&
        m.parts.some(p => p.type === 'text' && (p as { type: 'text'; text: string }).text.startsWith('[Context Summary]'))
      ).length
      const effective = applyCompactBoundary(msgs)
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

    const systemPrompt = buildSystemPrompt({
      base: this.agent.base_prompt,
      mode,
      active_tools: modeTools,
      caller,
      plugin_segments: pluginSegments,
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
