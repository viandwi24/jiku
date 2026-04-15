import type { ConnectorEventMedia } from '@jiku/types'
import { TELEGRAM_MAX_LENGTH, MAX_RETRY_WAIT_MS } from './constants.ts'

/**
 * Split a long text into Telegram-sized chunks. Prefers to break on the last
 * newline within the limit so we don't split in the middle of a sentence.
 */
export function splitMessage(text: string, maxLength = TELEGRAM_MAX_LENGTH): string[] {
  if (text.length <= maxLength) return [text]
  const chunks: string[] = []
  let remaining = text
  while (remaining.length > 0) {
    if (remaining.length <= maxLength) {
      chunks.push(remaining)
      break
    }
    let splitAt = remaining.lastIndexOf('\n', maxLength)
    if (splitAt <= 0) splitAt = maxLength
    chunks.push(remaining.slice(0, splitAt))
    remaining = remaining.slice(splitAt).replace(/^\n/, '')
  }
  return chunks
}

/**
 * Extract media from a Telegram message.
 * Returns:
 *  - media: public metadata (no file_id) for ConnectorEvent.content.media
 *  - mediaMetadata: internal data (file_id etc.) for connector_events.metadata
 * file_id NEVER leaves this adapter/DB — AI only gets event_id + summary hint.
 */
export function extractTelegramMedia(msg: any): {
  media: ConnectorEventMedia | undefined
  mediaMetadata: Record<string, unknown>
} {
  if (msg.photo?.length) {
    const largest = msg.photo[msg.photo.length - 1]
    return {
      media: { type: 'photo', file_size: largest.file_size },
      mediaMetadata: {
        media_file_id: largest.file_id,
        media_type: 'photo',
        media_file_size: largest.file_size,
      },
    }
  }
  if (msg.document) {
    return {
      media: {
        type: 'document',
        file_name: msg.document.file_name,
        mime_type: msg.document.mime_type,
        file_size: msg.document.file_size,
      },
      mediaMetadata: {
        media_file_id: msg.document.file_id,
        media_type: 'document',
        media_file_name: msg.document.file_name,
        media_mime_type: msg.document.mime_type,
        media_file_size: msg.document.file_size,
      },
    }
  }
  if (msg.voice) {
    return {
      media: { type: 'voice', mime_type: msg.voice.mime_type, file_size: msg.voice.file_size },
      mediaMetadata: {
        media_file_id: msg.voice.file_id,
        media_type: 'voice',
        media_mime_type: msg.voice.mime_type,
        media_file_size: msg.voice.file_size,
      },
    }
  }
  if (msg.video) {
    return {
      media: {
        type: 'video',
        file_name: msg.video.file_name,
        mime_type: msg.video.mime_type,
        file_size: msg.video.file_size,
      },
      mediaMetadata: {
        media_file_id: msg.video.file_id,
        media_type: 'video',
        media_file_name: msg.video.file_name,
        media_mime_type: msg.video.mime_type,
        media_file_size: msg.video.file_size,
      },
    }
  }
  if (msg.sticker) {
    return {
      media: { type: 'sticker', file_size: msg.sticker.file_size },
      mediaMetadata: {
        media_file_id: msg.sticker.file_id,
        media_type: 'sticker',
        media_file_size: msg.sticker.file_size,
      },
    }
  }
  return { media: undefined, mediaMetadata: {} }
}

export function extractRetryAfterSeconds(err: unknown): number | null {
  const e = err as { error_code?: number; parameters?: { retry_after?: number } } | undefined
  if (!e || e.error_code !== 429) return null
  const ra = e.parameters?.retry_after
  return typeof ra === 'number' && ra > 0 ? ra : null
}

/**
 * Wrap a Telegram Bot API call; on 429 retry once after honoring
 * `parameters.retry_after` up to `MAX_RETRY_WAIT_MS`. Callers past that cap
 * receive the original error and can degrade gracefully.
 */
export async function withTelegramRetry<T>(fn: () => Promise<T>, label = 'telegram'): Promise<T> {
  try {
    return await fn()
  } catch (err) {
    const retryAfter = extractRetryAfterSeconds(err)
    if (retryAfter === null) throw err
    const waitMs = retryAfter * 1000
    if (waitMs > MAX_RETRY_WAIT_MS) {
      console.warn(`[${label}] 429 retry_after=${retryAfter}s exceeds cap, giving up`)
      throw err
    }
    console.warn(`[${label}] 429, waiting ${retryAfter}s before retry`)
    await new Promise<void>(r => setTimeout(r, waitMs + 250))
    return await fn()
  }
}
