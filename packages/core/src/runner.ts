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

export class AgentRunner {
  constructor(
    private agent: AgentDefinition,
    private plugins: PluginLoader,
    private storage: JikuStorageAdapter,
    private providers: ModelProviders,
    private memoryConfig?: ResolvedMemoryConfig,
    private runtimeId?: string,
    private personaSeed?: PersonaSeed | null,
    private personaPrompt?: string | null,
  ) {}

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

          aiTools[resolvedTool.tool_name] = tool({
            description: resolvedTool.meta.description,
            inputSchema: toInputSchema(resolvedTool.input),
            execute: async (args: unknown) => resolvedTool.execute(args, toolCtx),
          })
        }

        // Run LLM — merge AI SDK stream directly into the UI stream writer
        const result = streamText({
          model,
          system: systemPrompt,
          messages,
          tools: Object.keys(aiTools).length > 0 ? aiTools : undefined,
          stopWhen: stepCountIs(20),
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

        // Emit raw snapshot for usage log debug
        jikuWriter.write('jiku-run-snapshot', {
          system_prompt: systemPrompt,
          messages,
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

        // Post-run memory extraction (fire and forget)
        if (memoryConfig && runtimeId && storage.saveMemory && storage.deleteMemory) {
          const runMessages = await storage.getMessages(conversation_id)
          const { extractMemoriesPostRun } = await import('./memory/extraction.ts')
          extractMemoriesPostRun({
            runtime_id: runtimeId,
            agent_id: agentId,
            caller_id: caller.user_id,
            messages: runMessages.slice(-6),
            existing_memories: loadedMemories,
            config: memoryConfig,
            model,
            storage,
          }).catch(() => {})

          // Post-run persona extraction (fire and forget)
          if (storage.saveMemory !== undefined) {
            const { extractPersonaPostRun } = await import('./memory/persona-extraction.ts')
            extractPersonaPostRun({
              runtime_id: runtimeId,
              agent_id: agentId,
              messages: runMessages.slice(-6),
              model,
              storage,
            }).catch(() => {})
          }
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
      ...pluginSegments.map((seg, i) => ({
        source: 'plugin' as const,
        label: `Plugin Segment ${i + 1}`,
        content: seg,
        token_estimate: estimateTokens(seg),
      })),
      ...(memorySection
        ? [{
            source: 'memory' as const,
            label: 'Memory',
            content: memorySection,
            token_estimate: estimateTokens(memorySection),
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
