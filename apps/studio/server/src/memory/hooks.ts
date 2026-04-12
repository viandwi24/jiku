import type { CompactionHook, FinalizeHook } from '@jiku/core'
import { enqueueAsync } from '../jobs/enqueue.ts'

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
