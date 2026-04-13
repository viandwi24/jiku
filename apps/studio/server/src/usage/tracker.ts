import { createUsageLog } from '@jiku-studio/db'

/**
 * Plan 19 — Centralized LLM usage tracker.
 *
 * EVERY LLM invocation in jiku-studio — chat runs, reflection, dreaming, flush,
 * title generation, plugin-invoked calls, generic custom — should route through
 * this helper so that `usage_logs` reflects the full cost picture.
 *
 * Usage
 * -----
 * ```ts
 * const { text, usage } = await generateText({ model, ... })
 * recordLLMUsage({
 *   source: 'reflection',
 *   project_id,
 *   agent_id,              // optional
 *   conversation_id,       // optional
 *   model: modelInfo.model_id,
 *   provider: modelInfo.adapter_id,
 *   input_tokens: usage.inputTokens ?? 0,
 *   output_tokens: usage.outputTokens ?? 0,
 *   duration_ms: Date.now() - t0,
 * })
 * ```
 *
 * Fire-and-forget: the returned promise is ignored by convention. Failures
 * are logged but never thrown.
 */
export type UsageSource =
  | 'chat'
  | 'task'
  | 'title'
  | 'reflection'
  | 'dreaming.light'
  | 'dreaming.deep'
  | 'dreaming.rem'
  | 'flush'
  | 'compaction'
  | 'embedding'
  | `plugin:${string}`
  | 'custom'

export interface RecordLLMUsageInput {
  source: UsageSource
  project_id?: string | null
  agent_id?: string | null
  conversation_id?: string | null
  user_id?: string | null
  provider?: string | null
  model?: string | null
  input_tokens: number
  output_tokens: number
  duration_ms?: number | null
  /** mode column — defaults to 'chat' for chat/task rows, 'custom' for others. */
  mode?: string
  raw_system_prompt?: string | null
  raw_messages?: unknown
  raw_response?: string | null
}

export function recordLLMUsage(input: RecordLLMUsageInput): void {
  const mode = input.mode ?? (input.source === 'chat' || input.source === 'task' ? input.source : 'custom')
  void createUsageLog({
    agent_id: input.agent_id ?? null,
    conversation_id: input.conversation_id ?? null,
    project_id: input.project_id ?? null,
    user_id: input.user_id ?? null,
    mode,
    source: input.source,
    provider_id: input.provider ?? null,
    model_id: input.model ?? null,
    input_tokens: Math.max(0, Math.floor(input.input_tokens)),
    output_tokens: Math.max(0, Math.floor(input.output_tokens)),
    duration_ms: input.duration_ms ?? null,
    raw_system_prompt: typeof input.raw_system_prompt === 'string' ? input.raw_system_prompt : null,
    raw_messages: (input.raw_messages ?? null) as Record<string, unknown> | null,
    raw_response: typeof input.raw_response === 'string' ? input.raw_response : null,
  }).catch((err) => {
    console.warn('[usage] failed to record LLM usage:', err instanceof Error ? err.message : err)
  })
}
