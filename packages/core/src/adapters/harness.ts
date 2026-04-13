import { streamText, stepCountIs } from 'ai'
import type { AgentAdapter, AgentRunContext } from '../adapter.ts'
import type { JikuRunParams, PolicyRule, SubjectMatcher } from '@jiku/types'

const DEFAULT_HARNESS_MAX_ITERATIONS = 40
const DEFAULT_STALL_TIMEOUT_MS = 120_000

/**
 * Harness adapter — `jiku.agent.harness`.
 *
 * Mirrors the claude-code / clawcode iterative loop pattern:
 *   - Single agentic loop with `tool_choice: 'auto'` throughout.
 *   - Model natively decides text + tool_use per step.
 *   - Exit condition is structural: when the model stops emitting tool calls
 *     the run is done (AI SDK's `stopWhen` drives this).
 *   - No regex, no forced-narration phase.
 *
 * Architectural value vs. the default adapter:
 *   - **Stall watchdog.** Each model step must complete within
 *     `stall_timeout_ms`; if a step hangs, the watchdog aborts the run and
 *     emits `jiku-harness-stall`. The default adapter has no such safety net.
 *   - **Per-step iteration events.** Emits `jiku-harness-iteration` on every
 *     step completion so operators can observe multi-turn runs.
 *   - **Extension point.** All per-step hooks (future approval prompts,
 *     interrupt checks, per-iteration model switching) go through the single
 *     `onStepFinish` path.
 *
 * We deliberately use a SINGLE `streamText` call with `stopWhen(stepCountIs)`
 * rather than a manual outer `while` loop. An earlier revision did the manual
 * loop (one `streamText` per iteration, merging each into `sdkWriter`) but
 * breaks the AI SDK UI message protocol — merged streams create conflicting
 * part IDs and message boundaries, causing tool-invocation UI to render blank
 * until the page is refreshed. Letting AI SDK drive the step loop keeps the
 * UI stream coherent; we retain harness-level control through `onStepFinish`
 * and the stall watchdog.
 *
 * Reference: `refs-clawcode/rust/crates/runtime/src/conversation.rs:342-500` —
 * same shape (loop; `tool_choice: Auto`; exit when no `ContentBlock::ToolUse`
 * appears in the step).
 */
export class HarnessAgentAdapter implements AgentAdapter {
  readonly id = 'jiku.agent.harness'
  readonly displayName = 'Harness Agent'
  readonly description =
    'Iterative single-phase agent loop (claude-code/clawcode parity). One `streamText` with `tool_choice=auto`; exits when the model emits no more tool calls. Adds per-step stall detection, iteration events, and hook points on top of AI SDK\'s step loop.'

  readonly configSchema = {
    type: 'object',
    properties: {
      max_iterations: {
        type: 'number',
        default: DEFAULT_HARNESS_MAX_ITERATIONS,
        minimum: 1,
        maximum: 100,
        description: 'Maximum number of harness iterations (model steps). A step ends whenever the model either stops emitting tool calls or this budget is exhausted.',
      },
      stall_timeout_ms: {
        type: 'number',
        default: DEFAULT_STALL_TIMEOUT_MS,
        minimum: 10_000,
        maximum: 600_000,
        description: 'Per-step stall timeout in ms. If a single model step takes longer than this, the run is aborted and `jiku-harness-stall` is emitted. Resets on every step completion.',
      },
    },
  }

  async execute(
    ctx: AgentRunContext,
    params: JikuRunParams & { rules: PolicyRule[]; subject_matcher?: SubjectMatcher },
  ): Promise<void> {
    const cfg = ctx.modeConfig?.config ?? {}
    const maxIterations = (cfg['max_iterations'] as number | undefined) ?? DEFAULT_HARNESS_MAX_ITERATIONS
    const stallTimeoutMs = (cfg['stall_timeout_ms'] as number | undefined) ?? DEFAULT_STALL_TIMEOUT_MS

    const tools = Object.keys(ctx.aiTools).length > 0 ? ctx.aiTools : undefined

    // Stall watchdog — aborts the run if no step completes within
    // `stallTimeoutMs`. Resets on every `onStepFinish`. Composed with the
    // caller's abort signal so either trigger cancels the run.
    const stallController = new AbortController()
    let stallTimer: ReturnType<typeof setTimeout> | null = null
    let stalled = false

    const armStallTimer = () => {
      if (stallTimer) clearTimeout(stallTimer)
      stallTimer = setTimeout(() => {
        stalled = true
        ctx.writer.write('jiku-harness-stall', {
          timeout_ms: stallTimeoutMs,
        })
        console.warn(`[harness] step stalled after ${stallTimeoutMs}ms — aborting run`)
        stallController.abort()
      }, stallTimeoutMs)
    }
    const clearStallTimer = () => {
      if (stallTimer) {
        clearTimeout(stallTimer)
        stallTimer = null
      }
    }
    armStallTimer()

    const combinedSignal = params.abort_signal
      ? anySignal([params.abort_signal, stallController.signal])
      : stallController.signal

    let iterationCount = 0

    const result = streamText({
      model: ctx.model,
      system: ctx.systemPrompt,
      messages: ctx.messages,
      tools,
      toolChoice: 'auto',
      stopWhen: stepCountIs(maxIterations),
      abortSignal: combinedSignal,
      onStepFinish: (event) => {
        iterationCount++
        armStallTimer() // reset watchdog — next step gets a fresh budget

        ctx.writer.write('jiku-harness-iteration', {
          iteration: iterationCount,
          max_iterations: maxIterations,
        })
        ctx.writer.write('jiku-step-usage', {
          step: event.stepNumber,
          input_tokens: event.usage.inputTokens ?? 0,
          output_tokens: event.usage.outputTokens ?? 0,
        })
      },
    })

    ctx.sdkWriter.merge(
      result.toUIMessageStream({
        sendStart: true,
        sendFinish: true,
        sendReasoning: true,
        sendSources: true,
      }),
    )

    let steps
    let usage
    try {
      ;[steps, usage] = await Promise.all([result.steps, result.usage])
    } catch (err) {
      clearStallTimer()
      if (stalled) {
        // Stall already signalled via `jiku-harness-stall`. Re-throw anyway so
        // upstream sees the abort and can mark the conversation failed.
        throw err
      }
      throw err
    }
    clearStallTimer()

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

/** Merge multiple AbortSignals into one — aborts as soon as any input aborts. */
function anySignal(signals: AbortSignal[]): AbortSignal {
  const controller = new AbortController()
  for (const sig of signals) {
    if (sig.aborted) {
      controller.abort()
      break
    }
    sig.addEventListener('abort', () => controller.abort(), { once: true })
  }
  return controller.signal
}
