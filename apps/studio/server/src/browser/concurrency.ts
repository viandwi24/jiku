/**
 * Lightweight async mutex keyed by string (project ID).
 *
 * Why this exists: agent-browser operates on a single active tab per CDP
 * endpoint. If two agents in the same project run browser commands
 * concurrently, they race on that shared state — element refs go stale, fills
 * overwrite each other, navigations interleave. We serialize all commands
 * for a given project so that each command sees a consistent browser state.
 *
 * The mutex is per-project, not per-server, so it does NOT protect against
 * multiple Studio server instances pointing at the same CDP endpoint. For
 * single-server Studio (the current deployment shape) this is sufficient.
 *
 * Implementation: a per-key promise chain. `acquire(key, fn)` chains `fn`
 * after the previous promise for that key. When the chain becomes settled
 * (no waiters), the entry is dropped from the map to avoid leaking memory.
 */
export class KeyedAsyncMutex {
  private chains = new Map<string, Promise<unknown>>()

  /**
   * Run `fn` exclusively for the given key. Returns a promise that resolves
   * to `fn`'s return value (or rejects with its error). Calls with different
   * keys do NOT block each other.
   */
  async acquire<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.chains.get(key) ?? Promise.resolve()

    // Run after the previous holder finishes — but never propagate the
    // previous holder's error to this caller.
    const next = previous.catch(() => {}).then(fn)

    // Track the new tail. We strip the result type so the chain Map stays
    // homogeneous; the typed result is returned to the caller separately.
    this.chains.set(key, next)

    try {
      return await next
    } finally {
      // If we're still the tail, drop the entry so an idle key doesn't leak.
      if (this.chains.get(key) === next) {
        this.chains.delete(key)
      }
    }
  }

  /** Returns true if there is at least one in-flight or queued holder. */
  isBusy(key: string): boolean {
    return this.chains.has(key)
  }
}

/** Singleton mutex shared across the browser tool dispatcher and routes. */
export const browserMutex = new KeyedAsyncMutex()
