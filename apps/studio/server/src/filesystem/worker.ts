import { eq, and, sql, lt } from '@jiku-studio/db'
import { db, storage_cleanup_queue } from '@jiku-studio/db'
import { getFilesystemService } from './factory.ts'

const MAX_ATTEMPTS = 3
const BATCH_SIZE = 50

/**
 * Plan 16 — Background worker that processes the storage_cleanup_queue.
 *
 * When files are deleted from the virtual filesystem, the DB row is removed
 * immediately but the S3 object is deferred to this worker (tombstone
 * pattern). This decouples the fast user-facing delete from the potentially
 * slow/flaky S3 delete and allows retries on transient errors.
 *
 * The worker runs every `intervalMs` (default 30s). Each tick processes up
 * to `BATCH_SIZE` (50) pending entries. Entries that fail are retried up to
 * `MAX_ATTEMPTS` (3) times, after which they're marked 'failed' for manual
 * review.
 */
export function startStorageCleanupWorker(intervalMs = 30_000): () => void {
  const tick = async () => {
    // Fetch pending entries, oldest first
    const pending = await db
      .select()
      .from(storage_cleanup_queue)
      .where(eq(storage_cleanup_queue.status, 'pending'))
      .orderBy(storage_cleanup_queue.queued_at)
      .limit(BATCH_SIZE)

    if (pending.length === 0) return

    // Group by project so we only build one adapter per project per tick
    const byProject = new Map<string, typeof pending>()
    for (const entry of pending) {
      const list = byProject.get(entry.project_id) ?? []
      list.push(entry)
      byProject.set(entry.project_id, list)
    }

    for (const [projectId, entries] of byProject) {
      const fs = await getFilesystemService(projectId)
      if (!fs) {
        // Filesystem disabled or credential gone — mark all as failed
        for (const entry of entries) {
          await db.update(storage_cleanup_queue).set({
            status: 'failed',
            last_error: 'Filesystem service unavailable (disabled or credential missing)',
            processed_at: new Date(),
          }).where(eq(storage_cleanup_queue.id, entry.id))
        }
        continue
      }

      const adapter = fs.getAdapter()

      for (const entry of entries) {
        try {
          await adapter.delete(entry.storage_key)
          await db.update(storage_cleanup_queue).set({
            status: 'done',
            processed_at: new Date(),
          }).where(eq(storage_cleanup_queue.id, entry.id))
        } catch (err) {
          const attempts = entry.attempts + 1
          const errorMsg = err instanceof Error ? err.message : 'Unknown error'

          if (attempts >= MAX_ATTEMPTS) {
            await db.update(storage_cleanup_queue).set({
              status: 'failed',
              attempts,
              last_error: errorMsg,
              processed_at: new Date(),
            }).where(eq(storage_cleanup_queue.id, entry.id))
            console.warn(
              `[fs-cleanup] giving up on ${entry.storage_key} after ${MAX_ATTEMPTS} attempts: ${errorMsg}`,
            )
          } else {
            await db.update(storage_cleanup_queue).set({
              attempts,
              last_error: errorMsg,
            }).where(eq(storage_cleanup_queue.id, entry.id))
          }
        }
      }
    }
  }

  const handle = setInterval(() => {
    tick().catch(err => console.warn('[fs-cleanup] tick failed:', err))
  }, intervalMs)

  // Don't pin the event loop
  if (typeof handle === 'object' && 'unref' in handle) {
    (handle as { unref: () => void }).unref()
  }

  return () => clearInterval(handle)
}
