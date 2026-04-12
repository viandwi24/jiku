import { enqueueJob as dbEnqueueJob } from '@jiku-studio/db'

/**
 * Plan 19 — Fire-and-forget enqueue helper.
 *
 * HARD CONTRACT (see §5 of plan 19):
 *   - This helper MUST only INSERT to background_jobs, never process inline.
 *   - Callers at stream/response boundaries MUST close the stream first,
 *     then call enqueue(). User-facing latency must not depend on handler time.
 */
export async function enqueue(params: {
  type: string
  projectId?: string | null
  idempotencyKey?: string
  payload: unknown
  scheduledAt?: Date
  maxAttempts?: number
}): Promise<void> {
  try {
    await dbEnqueueJob({
      type: params.type,
      project_id: params.projectId ?? null,
      idempotency_key: params.idempotencyKey ?? null,
      payload: params.payload,
      scheduled_at: params.scheduledAt,
      max_attempts: params.maxAttempts,
    })
  } catch (err) {
    console.warn(`[jobs] enqueue ${params.type} failed:`, err instanceof Error ? err.message : err)
  }
}

/** Fire-and-forget variant — use when you cannot await (e.g. inside stream callbacks). */
export function enqueueAsync(params: Parameters<typeof enqueue>[0]): void {
  void enqueue(params)
}
