/**
 * Shared constants for the Telegram plugin.
 *
 * Extracted from the original monolith so both bot-adapter and user-adapter can
 * reference the SAME values without duplication.
 */

export const TELEGRAM_MAX_LENGTH = 4000

/**
 * Cap on how long we're willing to honor a Telegram `retry_after` before
 * giving up and letting the caller degrade. See `withTelegramRetry`.
 */
export const MAX_RETRY_WAIT_MS = 45_000

/**
 * Telegram keeps a bot's long-poll slot reserved ~30s after stop. Reactivating
 * before this window expires yields 409 Conflict on `getUpdates`. We also
 * apply the same wait to userbot (AUTH_KEY_DUPLICATED risk).
 */
export const REACTIVATE_WAIT_MS = 30_000

/**
 * Inbound batch size — bursts from Telegram are processed in parallel groups
 * of N, with the next batch only starting after the current fully drains.
 * FIFO order preserved across batches.
 */
export const INBOUND_BATCH_SIZE = 5

/**
 * Album debounce window — when a user sends multiple photos/videos as a
 * single "album", Telegram emits one update per item sharing the same
 * `media_group_id`. Adapter buffers them under that key and flushes ONE
 * ConnectorEvent after this many ms of silence (measured from first arrival).
 * 5s = generous safety margin; in practice Telegram ships the full album
 * within <1s of the first item.
 */
export const MEDIA_GROUP_DEBOUNCE_MS = 5_000
