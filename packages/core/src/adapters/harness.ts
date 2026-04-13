import { streamText, stepCountIs } from 'ai'
import type { ModelMessage, StepResult, ToolSet, JSONValue } from 'ai'
import type { AgentAdapter, AgentRunContext } from '../adapter.ts'
import type { JikuRunParams, PolicyRule, SubjectMatcher } from '@jiku/types'

const DEFAULT_HARNESS_MAX_ITERATIONS = 40
const DEFAULT_MAX_TOOL_CALLS_PER_ITERATION = 1

/**
 * System prompt addendum injected ONLY during phase 1 (narration). Tells the
 * model that tool_choice=none is a temporary harness constraint, not a lack of
 * capability — otherwise GPT will apologize with "I can't access files" which
 * contradicts the phase 2 tool call that follows.
 */
const NARRATION_PHASE_INSTRUCTION = `

---

## HARNESS PHASE 1 — NARRATION ONLY (CRITICAL)

This response is a NARRATION-ONLY turn inside a two-phase harness loop:
- Right now tool calls are temporarily disabled. This is a mechanical constraint for THIS response only.
- In the VERY NEXT response, tool calls will be re-enabled and you WILL be called again with the exact same messages to execute the tool you describe here.
- All the tools you need ARE available in this run. Check the tool list in your context — do not claim you lack capability.

Your job in this narration turn:
1. Write 1–2 short sentences in first person describing what tool you are about to call and why (e.g. "Let me list the files at / to see what's there.").
2. STOP after those 1–2 sentences. Do NOT produce a full answer. Do NOT list options. Do NOT ask the user for clarification unless the request is genuinely ambiguous.
3. Do NOT apologize. Do NOT say "I can't" or "I don't have access" — that is false, tools WILL be available in the next response.
4. Do NOT describe what you already did; describe what you are about to do next.

When to write the FINAL answer directly (instead of a narration):
- The user's question can be fully answered without any tool call (e.g. general knowledge, math, simple greeting).
- All the work the user asked for has already been done in previous tool results — the task is complete.
- The previous tool result already fully answers the user's request and no more tools are needed.

In those cases, write the final summary/answer here (no action-intent phrasing like "I'll…"). In ALL OTHER cases, write a short action-intent narration (e.g. "I'll list the files first.").

CRITICAL:
- Look at the conversation history. If a tool call already accomplished what you're about to announce, DO NOT re-announce it. Skip straight to the final answer.
- Do NOT claim you lack access to tools or files — the tools listed in your context ARE available and have been working in prior turns of this same conversation.
- Never announce a new action unless it is genuinely the next step left to do.`


/**
 * Does the narration text announce an impending tool call?
 * Covers common English + Indonesian phrasings. We use this to decide
 * whether phase 2 should run (action intent present → run phase 2, force
 * tool) or skip (no action intent → narration IS the final answer).
 *
 * Prompt-only "phase 2 please stay silent if already answered" works on
 * Claude but GPT is unreliable — it either duplicates the answer or drops
 * a clearly-requested tool call. Hence the deterministic gate here.
 */
const ACTION_INTENT_RE =
  /\b(i['’]?ll|i will|let me|let['’]s|first[, ]|i['’]?m going to|i am going to|next,? i['’]?ll|now i['’]?ll|now i will|checking|calling|invoking|looking up|fetching|going to (?:call|check|run|list|read|write|open|fetch|search|query)|akan (?:saya|gue|aku)|(?:saya|gue|aku) akan|biar (?:saya|gue|aku)|mari (?:kita|saya)|sebentar,? (?:saya|gue|aku)|(?:gue|saya|aku) (?:cek|baca|panggil|list|lihat|buka|ambil|cari)(?!\w))/i

/**
 * Normalize non-JSON values (Date, undefined, etc.) that tool outputs may
 * return directly from DB queries — AI SDK v6 validates messages against a
 * strict JSONValue schema.
 */
function toJsonValue(v: unknown): JSONValue {
  if (v === undefined) return null
  try {
    return JSON.parse(JSON.stringify(v)) as JSONValue
  } catch {
    return null
  }
}

export class HarnessAgentAdapter implements AgentAdapter {
  readonly id = 'jiku.agent.harness'
  readonly displayName = 'Harness Agent'
  readonly description =
    'Iterative agent. Tiap iterasi dipecah jadi dua fase: (1) narasi dipaksa via tool_choice=none, (2) aksi tool via tool_choice=auto. Pola ini menjamin urutan text → tool → text → tool pada model OpenAI Chat Completions yang secara native tidak bisa mix text+tool_call dalam satu response.'

  readonly configSchema = {
    type: 'object',
    properties: {
      max_iterations: {
        type: 'number',
        default: 40,
        minimum: 1,
        maximum: 100,
        description: 'Maksimum iterasi loop narasi → tool.',
      },
      max_tool_calls_per_iteration: {
        type: 'number',
        default: 1,
        minimum: 1,
        maximum: 40,
        description: 'Maksimum tool call steps di tool phase per iterasi. Default 1 → pattern narasi→1 tool→narasi→1 tool. Naikkan kalau mau phase 2 bisa chain beberapa tool internally (akan batch tanpa narasi di antara).',
      },
      force_narration: {
        type: 'boolean',
        default: true,
        description: 'Paksa narasi (tool_choice=none) sebelum tiap tool phase. Matikan kalau pakai model yang natively interleave (Claude) — hemat 1 LLM call per iterasi.',
      },
    },
  }

  async execute(
    ctx: AgentRunContext,
    params: JikuRunParams & { rules: PolicyRule[]; subject_matcher?: SubjectMatcher },
  ): Promise<void> {
    const cfg = ctx.modeConfig?.config ?? {}
    const maxIterations = (cfg['max_iterations'] as number | undefined) ?? DEFAULT_HARNESS_MAX_ITERATIONS
    const maxToolCallsPerIteration =
      (cfg['max_tool_calls_per_iteration'] as number | undefined) ?? DEFAULT_MAX_TOOL_CALLS_PER_ITERATION
    const forceNarration = (cfg['force_narration'] as boolean | undefined) ?? true

    const tools = Object.keys(ctx.aiTools).length > 0 ? ctx.aiTools : undefined

    let messages: ModelMessage[] = [...ctx.messages]
    let iteration = 0
    let totalInputTokens = 0
    let totalOutputTokens = 0
    const allSteps: StepResult<ToolSet>[] = []
    let streamStarted = false

    const mergePhase = (result: ReturnType<typeof streamText>, sendFinish: boolean) => {
      ctx.sdkWriter.merge(
        result.toUIMessageStream({
          sendStart: !streamStarted,
          sendFinish,
          sendReasoning: true,
          sendSources: true,
        }),
      )
      streamStarted = true
    }

    const runPhase = (toolChoice: 'auto' | 'none', stepBudget: number) => {
      const system =
        toolChoice === 'none'
          ? ctx.systemPrompt + NARRATION_PHASE_INSTRUCTION
          : ctx.systemPrompt
      return streamText({
        model: ctx.model,
        system,
        messages,
        tools,
        toolChoice,
        stopWhen: stepCountIs(stepBudget),
        abortSignal: params.abort_signal,
        onStepFinish: (event) => {
          ctx.writer.write('jiku-step-usage', {
            step: event.stepNumber,
            input_tokens: event.usage.inputTokens ?? 0,
            output_tokens: event.usage.outputTokens ?? 0,
          })
        },
      })
    }

    while (iteration < maxIterations) {
      iteration++

      if (iteration > 1) {
        ctx.writer.write('jiku-harness-iteration', {
          iteration,
          max_iterations: maxIterations,
        })
      }

      // ── Phase 1: forced narration (tool_choice=none) ──────────────────────
      // Merge immediately so phase-1 text chunks reach the UI BEFORE phase 2
      // starts emitting its own chunks. If we deferred the merge, phase 2's
      // tool-call chunks would arrive in the UI stream first and phase 1's
      // text-deltas would reference a text part that's already closed —
      // yielding "Received text-delta for missing text part" errors.
      //
      // NOTE: We deliberately DO NOT append phase-1 narration to `messages`.
      // If we did, phase 2 would see an assistant turn that already "announced"
      // the next action and (on GPT) frequently decide it's done, emitting an
      // empty response and terminating the loop. By keeping `messages`
      // identical across both phases (only `toolChoice` differs), phase 2 is
      // forced to either emit the actual tool call or a genuine final text.
      // The narration still gets persisted to the DB via `allSteps` → the
      // runner's `persistAssistantMessage` pass.
      let skipPhase2 = false
      if (forceNarration && tools) {
        const narrationResult = runPhase('none', 1)
        mergePhase(narrationResult, false)
        const [narrationSteps, narrationUsage] = await Promise.all([
          narrationResult.steps,
          narrationResult.usage,
        ])
        totalInputTokens += narrationUsage.inputTokens ?? 0
        totalOutputTokens += narrationUsage.outputTokens ?? 0
        allSteps.push(...narrationSteps)

        // If narration has no action-intent phrasing (no "I'll…", no "Let
        // me…", no "akan saya…"), it's a direct/final answer — skip phase 2
        // to avoid duplicating the output.
        const narrationText = narrationSteps.map(s => s.text).filter(Boolean).join('\n').trim()
        if (narrationText && !ACTION_INTENT_RE.test(narrationText)) {
          skipPhase2 = true
        }
      }

      if (skipPhase2) break

      // ── Phase 2: action ───────────────────────────────────────────────────
      // Merge immediately (like phase 1) so tool-call chunks stream to the UI
      // as they happen — otherwise the UI sees a long pause followed by all
      // tool calls flushed at once. sendFinish is always false here; we emit
      // a manual `{ type: 'finish' }` chunk after the outer loop exits.
      const actionResult = runPhase('auto', maxToolCallsPerIteration)
      mergePhase(actionResult, false)
      const [actionSteps, actionUsage] = await Promise.all([
        actionResult.steps,
        actionResult.usage,
      ])
      totalInputTokens += actionUsage.inputTokens ?? 0
      totalOutputTokens += actionUsage.outputTokens ?? 0
      allSteps.push(...actionSteps)

      const lastStep = actionSteps[actionSteps.length - 1]
      const hasToolCalls = (lastStep?.toolCalls?.length ?? 0) > 0
      // If phase 2 emitted NO tool call AND NO text, the model obeyed the
      // "don't repeat yourself" rule from ACTION_PHASE_INSTRUCTION — phase 1
      // was the final answer. Terminate cleanly.
      const willContinue = hasToolCalls && iteration < maxIterations

      if (!willContinue) break

      // Append phase 2 assistant turn + tool results to history.
      type AssistantPart =
        | { type: 'text'; text: string }
        | { type: 'tool-call'; toolCallId: string; toolName: string; input: unknown }
      const assistantContent: AssistantPart[] = []
      if (lastStep!.text) assistantContent.push({ type: 'text', text: lastStep!.text })
      for (const tc of lastStep!.toolCalls ?? []) {
        assistantContent.push({
          type: 'tool-call',
          toolCallId: tc.toolCallId,
          toolName: tc.toolName,
          input: tc.input,
        })
      }
      messages = [...messages, { role: 'assistant', content: assistantContent }]

      const toolResults = (lastStep!.toolResults ?? []).map((tr) => ({
        type: 'tool-result' as const,
        toolCallId: tr.toolCallId,
        toolName: tr.toolName,
        output: { type: 'json' as const, value: toJsonValue(tr.output) },
      }))
      if (toolResults.length > 0) {
        messages = [...messages, { role: 'tool', content: toolResults }]
      }
    }

    // Close the UI message manually. We always merge phase streams with
    // sendFinish=false (so chunks can flow in real time); this emits the
    // terminal finish chunk once the outer loop is done.
    if (streamStarted) {
      ctx.sdkWriter.write({ type: 'finish' })
    }

    const finalResponseText = allSteps.map(s => s.text).filter(Boolean).join('\n')
    ctx.writer.write('jiku-run-snapshot', {
      system_prompt: ctx.systemPrompt,
      messages: ctx.messages,
      response: finalResponseText,
    })

    await ctx.persistAssistantMessage(allSteps)
    ctx.emitUsage({ inputTokens: totalInputTokens, outputTokens: totalOutputTokens })
  }
}
