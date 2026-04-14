import { and, eq, lt } from 'drizzle-orm'
import { db } from '../client.ts'
import { conversation_fs_reads } from '../schema/conversation-fs-reads.ts'

/** Upsert a (conversation, path) read record after a successful fs_read. */
export async function recordFsRead(data: {
  conversation_id: string
  path: string
  version: number
  content_hash?: string | null
}) {
  await db
    .insert(conversation_fs_reads)
    .values({
      conversation_id: data.conversation_id,
      path: data.path,
      version: data.version,
      content_hash: data.content_hash ?? null,
    })
    .onConflictDoUpdate({
      target: [conversation_fs_reads.conversation_id, conversation_fs_reads.path],
      set: {
        version: data.version,
        content_hash: data.content_hash ?? null,
        read_at: new Date(),
      },
    })
}

/** Get the read record for a (conversation, path), or null if never read. */
export async function getFsRead(conversation_id: string, path: string) {
  const rows = await db
    .select()
    .from(conversation_fs_reads)
    .where(and(
      eq(conversation_fs_reads.conversation_id, conversation_id),
      eq(conversation_fs_reads.path, path),
    ))
    .limit(1)
  return rows[0] ?? null
}

/** Drop a tracker row — used when a file is deleted or moved. */
export async function forgetFsRead(conversation_id: string, path: string) {
  await db
    .delete(conversation_fs_reads)
    .where(and(
      eq(conversation_fs_reads.conversation_id, conversation_id),
      eq(conversation_fs_reads.path, path),
    ))
}

/** Cleanup helper: prune tracker rows older than cutoff. Call from a cron job. */
export async function pruneOldFsReads(olderThan: Date) {
  await db.delete(conversation_fs_reads).where(lt(conversation_fs_reads.read_at, olderThan))
}
