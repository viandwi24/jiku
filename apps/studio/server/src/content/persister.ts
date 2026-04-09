import { randomUUID } from 'crypto'
import type { ContentPersistOptions, ContentPersistResult } from '@jiku/types'
import { getFilesystemService } from '../filesystem/service.ts'
import { createAttachment } from '@jiku-studio/db'

const MIME_TO_EXT: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'application/pdf': 'pdf',
  'audio/mpeg': 'mp3',
  'audio/wav': 'wav',
  'audio/ogg': 'ogg',
  'application/json': 'json',
  'text/plain': 'txt',
  'text/csv': 'csv',
}

export async function persistContentToAttachment(
  opts: ContentPersistOptions,
): Promise<ContentPersistResult> {
  const fs = await getFilesystemService(opts.projectId)
  if (!fs) {
    throw new Error('Filesystem not configured for project')
  }

  const ext = MIME_TO_EXT[opts.mimeType] ?? 'bin'
  const scope = opts.conversationId ?? opts.sourceType
  const uuid = randomUUID()
  const storageKey = `jiku/attachments/${opts.projectId}/${scope}/${uuid}.${ext}`

  // 1. Upload to S3
  await fs.getAdapter().upload(storageKey, opts.data, opts.mimeType)

  // 2. Create DB record
  const record = await createAttachment({
    project_id: opts.projectId,
    agent_id: opts.agentId ?? null,
    conversation_id: opts.conversationId ?? null,
    user_id: opts.userId ?? null,
    storage_key: storageKey,
    filename: opts.filename,
    mime_type: opts.mimeType,
    size_bytes: opts.data.length,
    scope: opts.scope ?? 'shared',
    source_type: opts.sourceType,
    metadata: opts.metadata ?? {},
  })

  // 3. Return reference only -- NO URL
  return {
    attachmentId: record.id,
    storageKey,
    mimeType: opts.mimeType,
    sizeBytes: opts.data.length,
  }
}
