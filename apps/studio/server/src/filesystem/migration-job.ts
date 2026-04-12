import { eq } from 'drizzle-orm'
import {
  db,
  filesystem_migrations,
  getAllProjectFiles,
  updateFileStorageKey,
  getCredentialById,
} from '@jiku-studio/db'
import { decryptFields } from '../credentials/encryption.ts'
import { buildS3Adapter } from './adapter.ts'
import type { FilesystemMigration } from '@jiku-studio/db'

/**
 * Plan 16 — Async filesystem adapter migration.
 *
 * Runs in the background after the POST /filesystem/migrate endpoint returns
 * `{ job_id, status: 'pending' }` to the caller. Iterates over all project
 * files, downloads from the old adapter, uploads to the new adapter (with
 * UUID-based keys), updates the DB storage_key, and tracks progress in the
 * `filesystem_migrations` table so the UI can poll.
 */
export async function runFilesystemMigration(migrationId: string): Promise<void> {
  // 1. Mark in_progress
  const [migration] = await db.update(filesystem_migrations)
    .set({ status: 'in_progress', started_at: new Date() })
    .where(eq(filesystem_migrations.id, migrationId))
    .returning()

  if (!migration) {
    console.error(`[fs-migration] Migration ${migrationId} not found`)
    return
  }

  try {
    // 2. Build old + new adapters
    const [oldCred, newCred] = await Promise.all([
      migration.from_credential_id ? getCredentialById(migration.from_credential_id) : null,
      getCredentialById(migration.to_credential_id),
    ])

    if (!newCred?.fields_encrypted) {
      throw new Error('New credential not found or missing encrypted fields')
    }

    const newAdapter = buildS3Adapter(
      decryptFields(newCred.fields_encrypted),
      (newCred.metadata ?? {}) as Record<string, string>,
    )

    // Old adapter may be null (first-time setup → no files to migrate)
    let oldAdapter = newAdapter
    if (oldCred?.fields_encrypted) {
      oldAdapter = buildS3Adapter(
        decryptFields(oldCred.fields_encrypted),
        (oldCred.metadata ?? {}) as Record<string, string>,
      )
    }

    // 3. Load all project files
    const allFiles = await getAllProjectFiles(migration.project_id)

    await db.update(filesystem_migrations)
      .set({ total_files: allFiles.length })
      .where(eq(filesystem_migrations.id, migrationId))

    // 4. Migrate each file
    let migrated = 0
    let failed = 0

    for (const file of allFiles) {
      try {
        const content = await oldAdapter.download(file.storage_key)
        const newKey = newAdapter.buildKeyFromId(file.id)
        await newAdapter.upload(newKey, content, file.mime_type)
        await updateFileStorageKey(file.id, newKey)
        migrated++

        // Update progress every 10 files (avoid DB spam)
        if (migrated % 10 === 0 || migrated === allFiles.length) {
          await db.update(filesystem_migrations)
            .set({ migrated_files: migrated, failed_files: failed })
            .where(eq(filesystem_migrations.id, migrationId))
        }
      } catch (err) {
        failed++
        console.warn(`[fs-migration] file ${file.path} failed:`, err instanceof Error ? err.message : err)
      }
    }

    // 5. Mark completed
    await db.update(filesystem_migrations)
      .set({
        status: failed > 0 ? 'completed' : 'completed',
        migrated_files: migrated,
        failed_files: failed,
        completed_at: new Date(),
        error_message: failed > 0 ? `${failed} file(s) failed to migrate` : null,
      })
      .where(eq(filesystem_migrations.id, migrationId))

    console.log(`[fs-migration] ${migrationId} completed: ${migrated} migrated, ${failed} failed`)
  } catch (err) {
    // 6. Fatal error — mark failed
    const message = err instanceof Error ? err.message : 'Unknown error'
    console.error(`[fs-migration] ${migrationId} fatal:`, message)
    await db.update(filesystem_migrations)
      .set({
        status: 'failed',
        error_message: message,
        completed_at: new Date(),
      })
      .where(eq(filesystem_migrations.id, migrationId))
  }
}
