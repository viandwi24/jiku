import type { Response } from 'express'

/**
 * StreamRegistry
 *
 * Solves three problems:
 * 1. Concurrent run lock — only one chat run per conversation at a time.
 *    A second POST /chat while one is running gets 409.
 * 2. Observer broadcast — any number of clients can subscribe to
 *    GET /conversations/:id/stream and receive the same SSE chunks
 *    as the original caller.
 * 3. In-memory parts buffer — chunks are accumulated here during streaming.
 *    Other tabs poll GET /conversations/:id/live-parts to get realtime updates
 *    without hitting the DB on every chunk. DB write happens only once at the end.
 */

interface StreamChunk {
  type: string
  [key: string]: unknown
}

interface ActiveRun {
  /** SSE observer responses waiting for chunks */
  observers: Set<Response>
  /** Accumulated chunks since stream started — for polling consumers */
  buffer: StreamChunk[]
  /** Resolve called when the run finishes — cleans up the entry */
  finish: () => void
  /** AbortController for the underlying runtime run. Triggering abort stops
   *  the LLM stream consumer (which then unwinds the run). Set by startRun. */
  abortController: AbortController
  /** True once `abort()` was called — consumers can check to skip redundant
   *  signals and log the final state as 'cancelled' rather than 'completed'. */
  aborted: boolean
}

class StreamRegistry {
  private runs = new Map<string, ActiveRun>()

  /** Returns true if the conversation already has a run in progress. */
  isRunning(conversationId: string): boolean {
    return this.runs.has(conversationId)
  }

  /**
   * Get current buffered chunks for a running conversation.
   * Returns null if no active run.
   */
  getBuffer(conversationId: string): StreamChunk[] | null {
    const run = this.runs.get(conversationId)
    return run ? [...run.buffer] : null
  }

  /**
   * Start tracking a run for conversationId.
   * Returns a `broadcast` function to push raw SSE lines to all observers,
   * a `bufferChunk` function to accumulate chunks in memory,
   * a `done` function to call when the run finishes, and an `abortSignal`
   * the caller should thread into the reader so aborts actually interrupt
   * the LLM stream consumer.
   */
  startRun(conversationId: string): {
    broadcast: (chunk: string) => void
    bufferChunk: (chunk: StreamChunk) => void
    done: () => void
    abortSignal: AbortSignal
    isAborted: () => boolean
  } {
    const observers: Set<Response> = new Set()
    const buffer: StreamChunk[] = []
    const abortController = new AbortController()

    const finish = () => {
      // Send SSE close signal then end all observer responses
      for (const res of observers) {
        try {
          res.write('event: done\ndata: {}\n\n')
          res.end()
        } catch { /* client disconnected */ }
      }
      observers.clear()
      this.runs.delete(conversationId)
    }

    this.runs.set(conversationId, { observers, buffer, finish, abortController, aborted: false })

    return {
      broadcast: (chunk: string) => {
        for (const res of observers) {
          try {
            res.write(chunk)
          } catch { /* client disconnected, will be cleaned on close */ }
        }
      },
      bufferChunk: (chunk: StreamChunk) => {
        buffer.push(chunk)
      },
      done: finish,
      abortSignal: abortController.signal,
      isAborted: () => this.runs.get(conversationId)?.aborted ?? false,
    }
  }

  /**
   * Signal the active run for this conversation to abort. Returns true if a
   * run was signalled, false if no run was active. The reader loop should
   * observe `abortSignal` (via `reader.cancel()` or abort-aware await) and
   * unwind the run so the DB `run_status='cancelled'` label reflects reality.
   */
  abort(conversationId: string): boolean {
    const run = this.runs.get(conversationId)
    if (!run) return false
    if (run.aborted) return true
    run.aborted = true
    try { run.abortController.abort() } catch { /* already aborted */ }
    // Tell observers something stopped — they'll see the stream close too
    for (const res of run.observers) {
      try { res.write('event: aborted\ndata: {}\n\n') } catch { /* ignore */ }
    }
    return true
  }

  /** Attach an SSE observer response to an active run. Returns false if no active run. */
  subscribe(conversationId: string, res: Response): boolean {
    const run = this.runs.get(conversationId)
    if (!run) return false

    run.observers.add(res)

    // Remove observer when client disconnects
    res.on('close', () => {
      run.observers.delete(res)
    })

    return true
  }
}

export const streamRegistry = new StreamRegistry()
