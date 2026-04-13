import type { CompactionHook, FinalizeHook } from '@jiku/core'
import { enqueueAsync } from '../jobs/enqueue.ts'
import { recordLLMUsage } from '../usage/tracker.ts'
import { resolveAgentModel } from '../credentials/service.ts'

/**
 * Plan 19 — Build a compaction hook that enqueues a `memory.flush` job.
 *
 * Triggered whenever the runner produces a compaction checkpoint. The handler
 * embeds + dedups + inserts an episodic memory scoped to the caller.
 * Non-blocking: only a DB INSERT on the job queue happens inline.
 */
export function buildCompactionHook(projectId: string): CompactionHook {
  return (info) => {
    // Idempotency: at most one flush per (conversation, summary-hash).
    // Using summary length + first 40 chars to derive a stable-enough key.
    const summaryFingerprint = hashString(info.summary)
    enqueueAsync({
      type: 'memory.flush',
      projectId,
      idempotencyKey: `flush:${info.conversation_id}:${summaryFingerprint}`,
      payload: {
        conversation_id: info.conversation_id,
        agent_id: info.agent_id,
        project_id: projectId,
        summary: info.summary,
        removed_count: info.removed_count,
      },
    })

    // Plan 20 — log the summarizer LLM call to usage_logs so the compaction cost
    // is visible just like any other LLM invocation.
    if ((info.input_tokens ?? 0) > 0 || (info.output_tokens ?? 0) > 0) {
      void (async () => {
        const modelInfo = await resolveAgentModel(info.agent_id).catch(() => null)
        recordLLMUsage({
          source: 'compaction',
          project_id: projectId,
          agent_id: info.agent_id,
          conversation_id: info.conversation_id,
          provider: modelInfo?.adapter_id ?? null,
          model: modelInfo?.model_id ?? null,
          input_tokens: info.input_tokens ?? 0,
          output_tokens: info.output_tokens ?? 0,
          duration_ms: info.duration_ms ?? null,
          raw_system_prompt: info.raw_system_prompt ?? null,
          raw_messages: info.raw_user_message
            ? [{ role: 'user', content: info.raw_user_message }, { role: 'assistant', content: info.summary }]
            : null,
          raw_response: info.summary,
        })
      })()
    }
  }
}

/**
 * Plan 19 — Build a finalize hook that enqueues a `memory.reflection` job.
 * Only fires when reflection is enabled on the agent (handler re-validates).
 */
export function buildFinalizeHook(projectId: string): FinalizeHook {
  return (info) => {
    // Idempotency keyed on (conversation, timestamp-minute) — one reflection run
    // per conversation per minute max. Handler re-fetches conversation and
    // re-validates `min_conversation_turns` against actual user-message count.
    const minuteBucket = Math.floor(Date.now() / 60_000)
    enqueueAsync({
      type: 'memory.reflection',
      projectId,
      idempotencyKey: `reflection:${info.conversation_id}:${minuteBucket}`,
      payload: {
        conversation_id: info.conversation_id,
        agent_id: info.agent_id,
        project_id: projectId,
        mode: info.mode,
      },
    })
  }
}

/** Tiny deterministic hash (djb2) for idempotency keys — not security-sensitive. */
function hashString(s: string): string {
  let h = 5381
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0
  return (h >>> 0).toString(36)
}
