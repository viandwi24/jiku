import { backgroundWorker } from './worker.ts'
import { flushHandler } from './handlers/flush.ts'
import { reflectionHandler } from './handlers/reflection.ts'
import { dreamingHandler } from './handlers/dreaming.ts'

/**
 * Plan 19 — Wire up all job-type handlers in one place.
 * Call once at boot BEFORE worker.start() so the worker only picks types it can handle.
 */
export function registerAllJobHandlers(): void {
  backgroundWorker.register('memory.flush', flushHandler)
  backgroundWorker.register('memory.reflection', reflectionHandler)
  backgroundWorker.register('memory.dream', dreamingHandler)
}
