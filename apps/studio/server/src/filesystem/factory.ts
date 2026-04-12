import {
  getFilesystemConfig,
  getCredentialById,
} from '@jiku-studio/db'
import { decryptFields } from '../credentials/encryption.ts'
import { S3FilesystemAdapter, buildS3Adapter } from './adapter.ts'
import { FilesystemService } from './service.ts'

/**
 * Plan 16 — LRU-cached FilesystemService factory.
 *
 * Before this, every tool call did: config DB query → AES-GCM decrypt →
 * new S3Client → new FilesystemService. With 100 concurrent agents × 10
 * tool calls/min, that's 1000 config queries + 1000 AES decrypts/min.
 *
 * This factory caches the constructed service per project, with a 5-minute
 * TTL and a hard cap of 500 entries. Cache is invalidated explicitly when
 * config changes (PATCH /config, credential rotation) or the project sleeps.
 */

const MAX_ENTRIES = 500
const TTL_MS = 5 * 60 * 1000  // 5 minutes

interface CachedEntry {
  service: FilesystemService
  createdAt: number
}

const cache = new Map<string, CachedEntry>()

/**
 * Get or build a FilesystemService for a project. Returns `null` if the
 * filesystem feature is disabled or no credential is configured.
 *
 * This replaces the old `getFilesystemService()` in `service.ts` — import
 * from here instead.
 */
export async function getFilesystemService(projectId: string): Promise<FilesystemService | null> {
  // Check cache
  const existing = cache.get(projectId)
  if (existing && Date.now() - existing.createdAt < TTL_MS) {
    return existing.service
  }

  // Cache miss or expired — build fresh
  const config = await getFilesystemConfig(projectId)
  if (!config?.enabled || !config.credential_id) return null

  const cred = await getCredentialById(config.credential_id)
  if (!cred || !cred.fields_encrypted) return null

  const fields = decryptFields(cred.fields_encrypted)
  const metadata = (cred.metadata ?? {}) as Record<string, string>
  const adapter = buildS3Adapter(fields, metadata)
  const service = new FilesystemService(projectId, adapter)

  // Evict oldest entry if at capacity
  if (cache.size >= MAX_ENTRIES) {
    let oldestKey: string | null = null
    let oldestTime = Infinity
    for (const [key, entry] of cache) {
      if (entry.createdAt < oldestTime) {
        oldestTime = entry.createdAt
        oldestKey = key
      }
    }
    if (oldestKey) cache.delete(oldestKey)
  }

  cache.set(projectId, { service, createdAt: Date.now() })
  return service
}

/** Invalidate the cached service for a project. */
export function invalidateFilesystemCache(projectId: string): void {
  cache.delete(projectId)
}

/** Invalidate all cached services (e.g. on credential rotation). */
export function invalidateAllFilesystemCaches(): void {
  cache.clear()
}
