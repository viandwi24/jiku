import type { Response } from 'express'

/**
 * StreamRegistry
 *
 * Solves two problems:
 * 1. Concurrent run lock — only one chat run per conversation at a time.
 *    A second POST /chat while one is running gets 409.
 * 2. Observer broadcast — any number of clients can subscribe to
 *    GET /conversations/:id/stream and receive the same SSE chunks
 *    as the original caller.
 */

interface ActiveRun {
  /** SSE observer responses waiting for chunks */
  observers: Set<Response>
  /** Resolve called when the run finishes — cleans up the entry */
  finish: () => void
}

class StreamRegistry {
  private runs = new Map<string, ActiveRun>()

  /** Returns true if the conversation already has a run in progress. */
  isRunning(conversationId: string): boolean {
    return this.runs.has(conversationId)
  }

  /**
   * Start tracking a run for conversationId.
   * Returns a `broadcast` function to push raw SSE lines to all observers,
   * and a `done` function to call when the run finishes.
   */
  startRun(conversationId: string): {
    broadcast: (chunk: string) => void
    done: () => void
  } {
    const observers: Set<Response> = new Set()

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

    this.runs.set(conversationId, { observers, finish })

    return {
      broadcast: (chunk: string) => {
        for (const res of observers) {
          try {
            res.write(chunk)
          } catch { /* client disconnected, will be cleaned on close */ }
        }
      },
      done: finish,
    }
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
