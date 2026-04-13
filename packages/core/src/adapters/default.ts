import { streamText, stepCountIs } from 'ai'
import type { AgentAdapter, AgentRunContext } from '../adapter.ts'
import type { JikuRunParams, PolicyRule, SubjectMatcher } from '@jiku/types'

export class DefaultAgentAdapter implements AgentAdapter {
  readonly id = 'jiku.agent.default'
  readonly displayName = 'Default Agent'
  readonly description = 'Standard single-turn streaming agent menggunakan streamText.'

  readonly configSchema = {
    type: 'object',
    properties: {
      max_tool_calls: {
        type: 'number',
        default: 40,
        minimum: 1,
        maximum: 200,
        description: 'Maksimum tool call steps per run.',
      },
    },
  }

  async execute(
    ctx: AgentRunContext,
    params: JikuRunParams & { rules: PolicyRule[]; subject_matcher?: SubjectMatcher },
  ): Promise<void> {
    const maxToolCalls: number =
      (ctx.modeConfig?.config?.['max_tool_calls'] as number | undefined) ?? ctx.maxToolCalls

    const result = streamText({
      model: ctx.model,
      system: ctx.systemPrompt,
      messages: ctx.messages,
      tools: Object.keys(ctx.aiTools).length > 0 ? ctx.aiTools : undefined,
      stopWhen: stepCountIs(maxToolCalls),
      abortSignal: params.abort_signal,
      onStepFinish: (event) => {
        ctx.writer.write('jiku-step-usage', {
          step: event.stepNumber,
          input_tokens: event.usage.inputTokens ?? 0,
          output_tokens: event.usage.outputTokens ?? 0,
        })
      },
    })

    ctx.sdkWriter.merge(
      result.toUIMessageStream({ sendFinish: true, sendStart: true, sendReasoning: true, sendSources: true }),
    )

    const [steps, usage] = await Promise.all([result.steps, result.usage])

    const finalResponseText = steps.map(s => s.text).filter(Boolean).join('\n')
    ctx.writer.write('jiku-run-snapshot', {
      system_prompt: ctx.systemPrompt,
      messages: ctx.messages,
      response: finalResponseText,
      tools: Object.keys(ctx.aiTools),
      adapter: this.id,
    })

    await ctx.persistAssistantMessage(steps)
    ctx.emitUsage(usage)
  }
}
