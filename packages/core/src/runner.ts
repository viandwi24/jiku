import {
  createUIMessageStream,
  streamText,
  stepCountIs,
  tool,
  zodSchema,
  type ToolSet,
  type ModelMessage,
} from 'ai'
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
} from '@jiku/types'
import type { JikuUIMessage, JikuUIMessageStreamWriter } from './types.ts'
import { resolveScope } from './resolver/scope.ts'
import { buildSystemPrompt } from './resolver/prompt.ts'
import type { ModelProviders } from './providers.ts'
import type { PluginLoader } from './plugins/loader.ts'

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
  ) {}

  async run(params: JikuRunParams & { rules: PolicyRule[]; subject_matcher?: SubjectMatcher }): Promise<JikuRunResult> {
    const { caller, mode, input, rules, subject_matcher } = params

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

    const modeTools = scope.active_tools.filter(t => t.modes.includes(mode))

    // 2. Resolve model — run-level > agent-level > runtime defaults
    const model = this.providers.resolve(
      params.provider_id ?? this.agent.provider_id,
      params.model_id ?? this.agent.model_id,
    )

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

    // 4. Build system prompt + history (before stream starts)
    const pluginSegments = await this.plugins.getPromptSegmentsAsync()
    const systemPrompt = buildSystemPrompt({
      base: this.agent.base_prompt,
      mode,
      active_tools: modeTools,
      caller,
      plugin_segments: pluginSegments,
    })

    const history = await this.storage.getMessages(conversation_id)
    const messages: ModelMessage[] = []
    for (const m of history) {
      const text = m.content.find(c => c.type === 'text')
      if (!text || text.type !== 'text') continue
      if (m.role === 'user') messages.push({ role: 'user', content: text.text })
      else if (m.role === 'assistant') messages.push({ role: 'assistant', content: text.text })
    }
    messages.push({ role: 'user', content: input })

    await this.storage.addMessage(conversation_id, {
      conversation_id,
      role: 'user',
      content: [{ type: 'text', text: input }],
    })

    // 5. Build runtime context (shared across the run)
    const runtimeCtx: RuntimeContext = {
      caller,
      agent: { id: this.agent.meta.id, name: this.agent.meta.name, mode },
      conversation_id,
      run_id,
      ...this.plugins.resolveProviders(caller),
    }

    // 6. Keep a ref to the storage for use in closures below
    const storage = this.storage

    // 7. Build stream using createUIMessageStream (same pattern as SenkenNeo)
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
            inputSchema: zodSchema(resolvedTool.input),
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
        const [finalText, usage] = await Promise.all([result.text, result.usage])

        jikuWriter.write('jiku-usage', {
          input_tokens: usage.inputTokens ?? 0,
          output_tokens: usage.outputTokens ?? 0,
        })

        if (finalText) {
          await storage.addMessage(conversation_id, {
            conversation_id,
            role: 'assistant',
            content: [{ type: 'text', text: finalText }],
          })
        }

        if (mode === 'task') {
          await storage.updateConversation(conversation_id, {
            status: 'completed',
            output: finalText,
          })
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
      // Cast is safe: JikuStreamChunk = AI SDK base chunks ∪ JikuDataChunk,
      // which is structurally identical to what createUIMessageStream emits.
      stream: stream as ReadableStream<JikuStreamChunk>,
    }
  }
}
