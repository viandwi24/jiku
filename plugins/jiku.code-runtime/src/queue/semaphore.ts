// Concurrency semaphore with FIFO waiting queue and depth cap.
//
// acquire() resolves when a slot is free or rejects with a typed error:
//   • 'queue_full'    — waiting queue already at maxQueueDepth
//   • 'queue_timeout' — slot didn't free within queueTimeoutMs
// release() must be called in a `finally` from the caller to avoid leaks.

export type SemaphoreError = 'queue_full' | 'queue_timeout'

export interface SemaphoreOptions {
  maxConcurrent: number
  maxQueueDepth: number
  queueTimeoutMs: number
}

interface Waiter {
  resolve: () => void
  reject: (err: SemaphoreError) => void
  timer: ReturnType<typeof setTimeout>
}

export class Semaphore {
  private inFlight = 0
  private readonly waiters: Waiter[] = []

  constructor(private opts: SemaphoreOptions) {}

  /** Update limits at runtime (config change from UI). */
  configure(opts: Partial<SemaphoreOptions>): void {
    this.opts = { ...this.opts, ...opts }
    // If we just raised maxConcurrent, drain waiters up to the new cap.
    while (this.inFlight < this.opts.maxConcurrent && this.waiters.length > 0) {
      const w = this.waiters.shift()!
      clearTimeout(w.timer)
      this.inFlight++
      w.resolve()
    }
  }

  /**
   * Acquire a slot. Caller MUST call the returned release() when done,
   * preferably in a `finally` block.
   * Returns the ms spent waiting in the queue (0 if acquired immediately).
   */
  async acquire(): Promise<{ release: () => void; waitedMs: number }> {
    const t0 = Date.now()
    if (this.inFlight < this.opts.maxConcurrent) {
      this.inFlight++
      return { release: () => this.release(), waitedMs: 0 }
    }
    if (this.waiters.length >= this.opts.maxQueueDepth) {
      throw 'queue_full' as SemaphoreError
    }
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        const idx = this.waiters.findIndex((w) => w.timer === timer)
        if (idx >= 0) this.waiters.splice(idx, 1)
        reject('queue_timeout' as SemaphoreError)
      }, this.opts.queueTimeoutMs)
      this.waiters.push({ resolve, reject, timer })
    })
    return { release: () => this.release(), waitedMs: Date.now() - t0 }
  }

  private release(): void {
    const next = this.waiters.shift()
    if (next) {
      clearTimeout(next.timer)
      // inFlight stays the same — we're handing the slot to the waiter
      next.resolve()
      return
    }
    this.inFlight = Math.max(0, this.inFlight - 1)
  }

  /** Diagnostic snapshot for agent status tools / UI. */
  snapshot(): { in_flight: number; queued: number; opts: SemaphoreOptions } {
    return { in_flight: this.inFlight, queued: this.waiters.length, opts: this.opts }
  }
}
