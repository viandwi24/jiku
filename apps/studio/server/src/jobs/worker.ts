import { claimNextJob, markJobCompleted, markJobFailed } from '@jiku-studio/db'
import type { BackgroundJob } from '@jiku/types'

/**
 * Plan 19 — Durable background job worker.
 *
 * Tick loop picks up one pending job at a time using SELECT ... FOR UPDATE
 * SKIP LOCKED semantics. Handlers run off the request/response lifecycle —
 * the enqueue path only INSERTs to `background_jobs`, never awaits execution.
 *
 * See docs/feats/memory.md "Background Jobs Contract" for the non-blocking
 * UX rule: reflection/dreaming/flush MUST NOT hold user responses.
 */
export type JobHandler = (payload: unknown, job: BackgroundJob) => Promise<void>

export class BackgroundWorker {
  private handlers = new Map<string, JobHandler>()
  private timer: ReturnType<typeof setInterval> | null = null
  private running = false
  private ticking = false

  register(type: string, handler: JobHandler): void {
    this.handlers.set(type, handler)
  }

  start(intervalMs = 5000): void {
    if (this.running) return
    this.running = true
    this.timer = setInterval(() => {
      void this.tick()
    }, intervalMs)
    console.log(`[jobs] BackgroundWorker started (tick=${intervalMs}ms, handlers=${this.handlers.size})`)
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    this.running = false
  }

  /**
   * One tick: attempt to claim a job whose type we can handle, execute it,
   * mark completed or failed. Reentrant-safe via `ticking` guard.
   */
  async tick(): Promise<void> {
    if (this.ticking) return
    this.ticking = true
    try {
      const types = [...this.handlers.keys()]
      if (types.length === 0) return

      const job = await claimNextJob(types)
      if (!job) return

      const handler = this.handlers.get(job.type)
      if (!handler) {
        await markJobFailed(job.id, `No handler registered for type ${job.type}`, true)
        return
      }

      try {
        await handler(job.payload, job as BackgroundJob)
        await markJobCompleted(job.id)
      } catch (err) {
        const msg = err instanceof Error ? err.stack ?? err.message : String(err)
        const terminal = job.attempts >= job.max_attempts
        await markJobFailed(job.id, msg, terminal)
        console.warn(`[jobs] job ${job.id} (${job.type}) failed (attempt ${job.attempts}/${job.max_attempts}):`, err)
      }
    } catch (err) {
      console.error('[jobs] worker tick error:', err)
    } finally {
      this.ticking = false
    }
  }
}

export const backgroundWorker = new BackgroundWorker()
