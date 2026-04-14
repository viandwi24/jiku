import { z } from 'zod'
import { definePlugin, ConnectorAdapter } from '@jiku/kit'
import type {
  ConnectorAction, ConnectorEvent, ConnectorContext, ConnectorTarget, ConnectorContent,
  ConnectorSendResult, ConnectorMediaItem, ConnectorEventMedia, ResolvedEventContext,
  ConnectorSetupSessionState, ConnectorSetupStepResult,
} from '@jiku/types'
import telegramifyMarkdown from 'telegramify-markdown'
import { StudioPlugin } from '@jiku-plugin/studio'
import type { Bot } from 'grammy'
import { getFileByPath, getConnectorEventById, logConnectorEvent } from '@jiku-studio/db'
import { UserbotQueue, type UserbotQueuePolicy } from './userbot-queue.ts'

const TELEGRAM_MAX_LENGTH = 4000

function splitMessage(text: string, maxLength = TELEGRAM_MAX_LENGTH): string[] {
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
function extractTelegramMedia(msg: any): {
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

/**
 * Telegram rate limit handling.
 *
 * Why: the Bot API enforces per-chat and global limits. Busy chats — especially
 * groups with typing simulation (send + 2 edits + final edit per message) — will
 * hit 429 and the current code either swallows the error or lets it bubble up
 * as a send failure. Both cost us delivered messages.
 *
 * Strategy:
 *   1. Serialize API calls per chat with a promise chain — no two sends/edits
 *      for the same chat run concurrently.
 *   2. When a 429 is thrown, honor `parameters.retry_after` and retry once.
 *      Cap the wait so a runaway retry_after (Telegram has returned values
 *      like 38s, 60s+) doesn't block the whole chain forever — callers above
 *      a threshold get the error and can degrade gracefully.
 */
const MAX_RETRY_WAIT_MS = 45_000

function extractRetryAfterSeconds(err: unknown): number | null {
  const e = err as { error_code?: number; parameters?: { retry_after?: number } } | undefined
  if (!e || e.error_code !== 429) return null
  const ra = e.parameters?.retry_after
  return typeof ra === 'number' && ra > 0 ? ra : null
}

async function withTelegramRetry<T>(fn: () => Promise<T>, label = 'telegram'): Promise<T> {
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

const chatSendQueues = new Map<string, Promise<unknown>>()

/**
 * Inbound event queue — global FIFO with batched concurrency.
 *
 * Why: Telegram updates (messages, reactions, edits, deletes, my_chat_member)
 * all call `ctx.onEvent(event)` which hands the event to the event-router.
 * That router spins up agents, hits the DB, and sends outbound replies — each
 * event can take seconds. When a burst of ~30 messages arrives in <1s, firing
 * them all concurrently floods the runtime, thrashes the DB, and amplifies
 * outbound rate-limit pressure on Telegram.
 *
 * Strategy: take the first N pending events, run them in parallel via
 * Promise.allSettled, and only start the next batch after the current one
 * fully drains. FIFO order preserved across batches. Failures are isolated
 * (allSettled) so one bad event doesn't poison the batch.
 */
const INBOUND_BATCH_SIZE = 5

type InboundTask = {
  run: () => Promise<void>
  resolve: () => void
  reject: (err: unknown) => void
}

const inboundQueue: InboundTask[] = []
let inboundDraining = false

async function drainInboundQueue(): Promise<void> {
  if (inboundDraining) return
  inboundDraining = true
  try {
    while (inboundQueue.length > 0) {
      const batch = inboundQueue.splice(0, INBOUND_BATCH_SIZE)
      const results = await Promise.allSettled(batch.map(t => t.run()))
      for (let i = 0; i < batch.length; i++) {
        const r = results[i]!
        if (r.status === 'fulfilled') batch[i]!.resolve()
        else batch[i]!.reject(r.reason)
      }
    }
  } finally {
    inboundDraining = false
  }
}

/**
 * Per-connector "last deactivate" timestamps.
 *
 * Why: Telegram's Bot API keeps a bot's long-poll slot reserved for ~30s after
 * our process stops polling. Reactivating the same token inside that window
 * results in `getUpdates` returning 409 Conflict — and grammy retries silently
 * without our code noticing. The visible symptom is "bot started (polling)"
 * in logs but zero inbound updates. We track last-deactivate per connectorId
 * and, on reactivate, await the remainder of the 30s window before calling
 * `bot.start()`.
 */
const lastDeactivateByConnector = new Map<string, number>()
const REACTIVATE_WAIT_MS = 30_000

function enqueueInboundEvent(run: () => Promise<void>): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    inboundQueue.push({ run, resolve, reject })
    void drainInboundQueue()
  })
}

/**
 * Non-blocking arrival log.
 *
 * Why: the processing queue (enqueueInboundEvent) can stall under rate-limit /
 * bug scenarios. When that happens, the old code also lost observability —
 * nothing hit `connector_events` because logging lived inside the queued task.
 * Per ops requirement: every inbound event MUST land in the DB the moment it
 * arrives, regardless of whether the router/agent ever gets to process it.
 * Downstream handlers UPDATE the status (`handled`, `dropped`, …); this only
 * INSERTs with `status='received'`.
 *
 * This helper awaits the insert so FIFO ordering of arrival rows matches the
 * wire order, but any error is swallowed — a logging failure must never drop
 * the event or crash the polling loop.
 */
async function logArrivalImmediate(
  connectorId: string | null,
  event: ConnectorEvent,
): Promise<void> {
  if (!connectorId) return
  try {
    await logConnectorEvent({
      connector_id: connectorId,
      event_type: event.type,
      direction: 'inbound',
      ref_keys: event.ref_keys,
      payload: {
        sender: event.sender,
        content: event.content,
        scope_key: event.scope_key,
      },
      raw_payload: event.raw_payload,
      metadata: event.metadata,
      status: 'received',
    })
  } catch (err) {
    console.error('[telegram] logArrivalImmediate failed:', err)
  }
}

function enqueueForChat<T>(chatId: string, task: () => Promise<T>): Promise<T> {
  const prev = chatSendQueues.get(chatId) ?? Promise.resolve()
  const next = prev.then(task, task)
  chatSendQueues.set(chatId, next)
  void next.finally(() => {
    if (chatSendQueues.get(chatId) === next) chatSendQueues.delete(chatId)
  })
  return next
}

class TelegramBotAdapter extends ConnectorAdapter {
  // Plan 24 Phase 2 — connector_id renamed from `jiku.telegram` → `jiku.telegram.bot`
  // to free `jiku.telegram` as the parent plugin id and let `jiku.telegram.user`
  // (MTProto userbot) live alongside as a separate adapter. Backward-compat alias
  // in `connectorRegistry.get` for one release cycle.
  readonly id = 'jiku.telegram.bot'
  readonly displayName = 'Telegram Bot'
  readonly credentialAdapterId = 'telegram'
  override readonly credentialDisplayName = 'Telegram Bot'
  readonly refKeys = ['message_id', 'chat_id', 'thread_id']
  readonly supportedEvents = ['message', 'reaction', 'unreaction', 'edit', 'delete'] as const

  override readonly credentialSchema = z.object({
    bot_token: z.string().min(1).describe('secret|Bot Token obtained from @BotFather'),
  })

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private bot: Bot | null = null
  private projectId: string | null = null
  private connectorId: string | null = null  // UUID — needed for non-blocking raw event logging
  private lastEventAt: number | null = null  // epoch ms of last inbound update (for health checks)
  private pollingStopRequested = false      // set by onDeactivate so the reconnect loop exits cleanly
  private botUsername: string | null = null  // cached @username (lowercased, no '@') for mention detection
  private botUserId: number | null = null    // cached numeric id for text_mention + reply-to-bot detection

  // ─── Plan 22: scope_key helpers ─────────────────────────────────────

  override computeScopeKey(event: { ref_keys: Record<string, string>; metadata?: Record<string, unknown> }): string | undefined {
    const chatId = event.ref_keys['chat_id']
    const chatType = event.metadata?.['chat_type'] as string | undefined
    const threadId = event.ref_keys['thread_id']
    if (!chatId) return undefined
    if (chatType === 'private') return undefined  // DM
    const base = `group:${chatId}`
    if (threadId) return `${base}:topic:${threadId}`
    return base
  }

  override targetFromScopeKey(scopeKey: string): ConnectorTarget | null {
    const parts = scopeKey.split(':')
    if (parts[0] !== 'group') return null
    const chatId = parts[1]
    if (!chatId) return null
    const ref_keys: Record<string, string> = { chat_id: chatId }
    const topicIdx = parts.indexOf('topic')
    if (topicIdx !== -1 && parts[topicIdx + 1]) {
      ref_keys['thread_id'] = parts[topicIdx + 1]!
    }
    return { ref_keys }
  }

  // ─── Actions registry ───────────────────────────────────────────────

  override readonly actions: ConnectorAction[] = [
    {
      id: 'send_reaction',
      name: 'Send Reaction',
      description: 'React to a message with an emoji',
      params: {
        chat_id: { type: 'string', description: 'Telegram chat ID', required: true },
        message_id: { type: 'string', description: 'Message ID to react to', required: true },
        emoji: { type: 'string', description: 'Emoji to react with, e.g. "👍"', required: true },
      },
    },
    {
      id: 'delete_message',
      name: 'Delete Message',
      description: 'Delete a message from the chat',
      params: {
        chat_id: { type: 'string', description: 'Telegram chat ID', required: true },
        message_id: { type: 'string', description: 'Message ID to delete', required: true },
      },
    },
    {
      id: 'edit_message',
      name: 'Edit Message',
      description: 'Edit the text of a previously sent message',
      params: {
        chat_id: { type: 'string', description: 'Telegram chat ID', required: true },
        message_id: { type: 'string', description: 'Message ID to edit', required: true },
        text: { type: 'string', description: 'New message text', required: true },
        markdown: { type: 'boolean', description: 'Whether to parse text as Markdown', required: false },
      },
    },
    {
      id: 'pin_message',
      name: 'Pin Message',
      description: 'Pin a message in the chat',
      params: {
        chat_id: { type: 'string', description: 'Telegram chat ID', required: true },
        message_id: { type: 'string', description: 'Message ID to pin', required: true },
        disable_notification: { type: 'boolean', description: 'Pin silently without notification', required: false },
      },
    },
    {
      id: 'unpin_message',
      name: 'Unpin Message',
      description: 'Unpin a message in the chat',
      params: {
        chat_id: { type: 'string', description: 'Telegram chat ID', required: true },
        message_id: { type: 'string', description: 'Message ID to unpin (omit to unpin all)', required: false },
      },
    },
    {
      id: 'send_file',
      name: 'Send File',
      description: 'Send a file from the project filesystem to a Telegram chat. The agent should write the file to the filesystem first using fs_write, then pass the file path here.',
      params: {
        chat_id: { type: 'string', description: 'Telegram chat ID', required: true },
        file_path: { type: 'string', description: 'File path in the project filesystem, e.g. "/reports/output.pdf"', required: true },
        caption: { type: 'string', description: 'Optional caption for the file', required: false },
        caption_markdown: { type: 'boolean', description: 'Parse caption as Markdown', required: false },
        reply_to_message_id: { type: 'string', description: 'Message ID to reply to', required: false },
        thread_id: { type: 'string', description: 'Forum topic thread ID', required: false },
      },
    },
    {
      id: 'send_photo',
      name: 'Send Photo',
      description: 'Send an image file from the project filesystem to a Telegram chat',
      params: {
        chat_id: { type: 'string', description: 'Telegram chat ID', required: true },
        file_path: { type: 'string', description: 'Image file path in the project filesystem, e.g. "/images/chart.png"', required: true },
        caption: { type: 'string', description: 'Optional caption', required: false },
        caption_markdown: { type: 'boolean', description: 'Parse caption as Markdown', required: false },
        reply_to_message_id: { type: 'string', description: 'Message ID to reply to', required: false },
        thread_id: { type: 'string', description: 'Forum topic thread ID', required: false },
      },
    },
    {
      id: 'get_chat_info',
      name: 'Get Chat Info',
      description: 'Get information about a Telegram chat (title, type, member count, etc.)',
      params: {
        chat_id: { type: 'string', description: 'Telegram chat ID', required: true },
      },
    },

    // ── Plan 22 — new actions ─────────────────────────────────────────
    {
      id: 'fetch_media',
      name: 'Fetch Media from Message',
      description: 'Download media from a previously received message and save it to the project filesystem. Use the event_id from the "Media available" hint in the conversation context. Returns the saved file path + size.',
      params: {
        event_id: { type: 'string', description: 'event_id from the inbound message that contained media (from context hint)', required: true },
        save_path: { type: 'string', description: 'Filesystem path to save the file. If omitted, auto-generates under /connector_media/.', required: false },
      },
    },
    {
      id: 'send_media_group',
      name: 'Send Media Group (Album)',
      description: 'Send multiple photos, videos, or documents as a single album message. Photos and videos can be mixed (max 10). Documents cannot mix with photo/video — if mixed, photos/videos go first as album then documents are sent individually. Only the first item caption is shown prominently.',
      params: {
        chat_id: { type: 'string', description: 'Telegram chat ID', required: true },
        media: { type: 'array', description: 'Array of media items: { type: "photo"|"video"|"document", url?: string, file_path?: string, caption?: string, caption_markdown?: boolean }. Max 10 items.', required: true },
        thread_id: { type: 'string', description: 'Forum topic thread ID', required: false },
      },
    },
    {
      id: 'send_url_media',
      name: 'Send Media from URL',
      description: 'Send a single image or document from a public URL directly to a chat — no filesystem needed',
      params: {
        chat_id: { type: 'string', description: 'Telegram chat ID', required: true },
        url: { type: 'string', description: 'Public direct URL to the media file', required: true },
        type: { type: 'string', description: '"photo" or "document"', required: true },
        caption: { type: 'string', description: 'Optional caption', required: false },
        caption_markdown: { type: 'boolean', description: 'Parse caption as Markdown', required: false },
        thread_id: { type: 'string', description: 'Forum topic thread ID', required: false },
      },
    },
    {
      id: 'send_to_scope',
      name: 'Send to Scope',
      description: 'Send a message to a specific scope (group, topic, or thread) using a scope_key, e.g. "group:-1001234:topic:42".',
      params: {
        scope_key: { type: 'string', description: 'Scope key, e.g. "group:-1001234" or "group:-1001234:topic:42"', required: true },
        text: { type: 'string', description: 'Message text', required: true },
        markdown: { type: 'boolean', description: 'Parse text as Markdown (default true)', required: false },
      },
    },
    {
      id: 'get_chat_members',
      name: 'Get Chat Administrators',
      description: 'Get the list of administrators in a Telegram group or channel',
      params: {
        chat_id: { type: 'string', description: 'Telegram chat ID', required: true },
      },
    },
    {
      id: 'create_invite_link',
      name: 'Create Invite Link',
      description: 'Create an invite link for a Telegram group or channel',
      params: {
        chat_id: { type: 'string', description: 'Telegram chat ID', required: true },
        name: { type: 'string', description: 'Link name/label', required: false },
        expire_date: { type: 'string', description: 'ISO date when link expires', required: false },
        member_limit: { type: 'number', description: 'Max uses (1–99999)', required: false },
      },
    },
    {
      id: 'forward_message',
      name: 'Forward Message',
      description: 'Forward a message from one chat to another. IMPORTANT TRADE-OFF: `hide_sender` controls whether the "Forwarded from" header is shown, but this interacts with how Telegram renders custom_emoji (animated Premium emoji). Premium custom_emoji only render when attributed to a Premium user — bots are not Premium accounts. So: (a) hide_sender=true → pesan muncul seolah bot yang author, NO "Forwarded from" header, but custom_emoji fallback ke glyph Unicode statis (kehilangan animasi); (b) hide_sender=false → native forward dengan header "Forwarded from <original sender>", custom_emoji animate utuh karena atribusi ke sender asli yang Premium. Default hide_sender=true. If the source message contains custom_emoji and visual fidelity matters, set hide_sender=false.',
      params: {
        from_chat_id: { type: 'string', description: 'Source chat ID', required: true },
        message_id: { type: 'string', description: 'Message ID to forward', required: true },
        to_chat_id: { type: 'string', description: 'Destination chat ID', required: true },
        hide_sender: { type: 'boolean', description: 'Hide original sender — no "Forwarded from" header. Default: true. WARNING: hiding the sender routes to copyMessage internally, which makes the bot the new author — Premium custom_emoji in the source will fallback to static Unicode glyphs. To preserve animated custom_emoji set this to false (shows the forward header).', required: false },
        thread_id: { type: 'string', description: 'Destination topic thread ID', required: false },
        disable_notification: { type: 'boolean', description: 'Send silently (no notification sound)', required: false },
        protect_content: { type: 'boolean', description: 'Prevent the forwarded copy from being forwarded/saved again', required: false },
      },
    },
    {
      id: 'copy_message',
      name: 'Copy Message',
      description: 'Copy a message to another chat WITHOUT the "Forwarded from" header — bot becomes the new author. CAVEAT: Premium custom_emoji in the source will NOT animate (bots aren\'t Premium accounts, and Telegram renders custom_emoji based on sender identity). Regular formatting (bold, italic, url, mention) IS preserved. Use this to repost "as-if-bot-authored" content where custom_emoji isn\'t critical, or when you want to override the caption while keeping media. If the source uses Premium custom_emoji and fidelity matters, use forward_message with hide_sender=false instead.',
      params: {
        from_chat_id: { type: 'string', description: 'Source chat ID', required: true },
        message_id: { type: 'string', description: 'Message ID to copy', required: true },
        to_chat_id: { type: 'string', description: 'Destination chat ID', required: true },
        thread_id: { type: 'string', description: 'Destination topic thread ID', required: false },
        caption: { type: 'string', description: 'Override caption for media messages. Omit to keep the original caption.', required: false },
        caption_markdown: { type: 'boolean', description: 'Parse override caption as Markdown. Mutually exclusive with caption_entities.', required: false },
        caption_entities: { type: 'array', description: 'Raw Telegram MessageEntity[] for the override caption — use when you need custom_emoji / text_mention that markdown can\'t express. Mutually exclusive with caption_markdown.', required: false },
        show_caption_above_media: { type: 'boolean', description: 'Show the caption above the media instead of below (for photo/video messages).', required: false },
        reply_to_message_id: { type: 'string', description: 'Make the copy a reply to this message_id in the destination chat', required: false },
        disable_notification: { type: 'boolean', description: 'Send silently (no notification sound)', required: false },
        protect_content: { type: 'boolean', description: 'Prevent the copy from being forwarded/saved', required: false },
      },
    },
    {
      id: 'set_chat_description',
      name: 'Set Chat Description',
      description: 'Update the description of a group or channel',
      params: {
        chat_id: { type: 'string', description: 'Telegram chat ID', required: true },
        description: { type: 'string', description: 'New description (max 255 chars)', required: true },
      },
    },
    {
      id: 'ban_member',
      name: 'Ban Member',
      description: 'Ban a user from the group. Use with caution.',
      params: {
        chat_id: { type: 'string', description: 'Telegram chat ID', required: true },
        user_id: { type: 'string', description: 'User ID to ban', required: true },
        until_date: { type: 'string', description: 'ISO date when ban expires (omit = permanent)', required: false },
      },
    },
  ]

  // ─── runAction ──────────────────────────────────────────────────────

  override async runAction(actionId: string, params: Record<string, unknown>): Promise<unknown> {
    if (!this.bot) throw new Error('Bot not initialized')

    switch (actionId) {
      case 'send_reaction': {
        const { chat_id, message_id, emoji } = params as { chat_id: string; message_id: string; emoji: string }
        await this.bot.api.setMessageReaction(chat_id, Number(message_id), [{ type: 'emoji', emoji: emoji as any }])
        return { success: true }
      }

      case 'delete_message': {
        const { chat_id, message_id } = params as { chat_id: string; message_id: string }
        await this.bot.api.deleteMessage(chat_id, Number(message_id))
        return { success: true }
      }

      case 'edit_message': {
        const { chat_id, message_id, text, markdown } = params as { chat_id: string; message_id: string; text: string; markdown?: boolean }
        const finalText = markdown ? telegramifyMarkdown(text, 'escape') : text
        await this.bot.api.editMessageText(chat_id, Number(message_id), finalText, {
          parse_mode: markdown ? 'MarkdownV2' : undefined,
        })
        return { success: true }
      }

      case 'pin_message': {
        const { chat_id, message_id, disable_notification } = params as { chat_id: string; message_id: string; disable_notification?: boolean }
        await this.bot.api.pinChatMessage(chat_id, Number(message_id), {
          disable_notification: disable_notification ?? false,
        })
        return { success: true }
      }

      case 'unpin_message': {
        const { chat_id, message_id } = params as { chat_id: string; message_id?: string }
        if (message_id) await this.bot.api.unpinChatMessage(chat_id, Number(message_id))
        else await this.bot.api.unpinAllChatMessages(chat_id)
        return { success: true }
      }

      case 'send_file':
      case 'send_photo': {
        const { chat_id, file_path, caption, caption_markdown, reply_to_message_id, thread_id } = params as {
          chat_id: string; file_path: string; caption?: string; caption_markdown?: boolean
          reply_to_message_id?: string; thread_id?: string
        }
        const inputFile = await this.resolveFilesystemFile(file_path)
        const extra: Record<string, unknown> = {}
        if (caption) {
          extra.caption = caption_markdown ? telegramifyMarkdown(caption, 'escape') : caption
          if (caption_markdown) extra.parse_mode = 'MarkdownV2'
        }
        if (reply_to_message_id) extra.reply_parameters = { message_id: Number(reply_to_message_id) }
        if (thread_id) extra.message_thread_id = Number(thread_id)

        if (actionId === 'send_photo') {
          const sent = await this.bot.api.sendPhoto(chat_id, inputFile, extra as any)
          return { success: true, message_id: String(sent.message_id), chat_id: String(sent.chat.id) }
        }
        const sent = await this.bot.api.sendDocument(chat_id, inputFile, extra as any)
        return { success: true, message_id: String(sent.message_id), chat_id: String(sent.chat.id) }
      }

      case 'get_chat_info': {
        const { chat_id } = params as { chat_id: string }
        const chat = await this.bot.api.getChat(chat_id)
        return { success: true, chat }
      }

      // ── Plan 22 handlers ───────────────────────────────────────────
      case 'fetch_media': {
        const { event_id, save_path } = params as { event_id: string; save_path?: string }
        const row = await getConnectorEventById(event_id)
        if (!row) throw new Error(`connector_event not found: ${event_id}`)
        const md = (row.metadata ?? {}) as Record<string, unknown>
        const fileId = md['media_file_id'] as string | undefined
        if (!fileId) throw new Error(`No media file_id on event ${event_id}`)

        const file = await this.bot.api.getFile(fileId)
        if (!file.file_path) throw new Error('Telegram getFile returned no file_path')
        const token = (this.bot as any).token as string
        const downloadUrl = `https://api.telegram.org/file/bot${token}/${file.file_path}`
        const resp = await fetch(downloadUrl)
        if (!resp.ok) throw new Error(`Failed to download media: ${resp.status}`)
        const buffer = Buffer.from(await resp.arrayBuffer())

        const defaultName = (md['media_file_name'] as string | undefined)
          ?? `media_${event_id.slice(0, 8)}_${Date.now()}${this.guessExt(md['media_mime_type'] as string | undefined, md['media_type'] as string | undefined)}`
        const targetPath = save_path ?? `/connector_media/${defaultName}`

        if (!this.projectId) throw new Error('Project context not available')
        const { getFilesystemService } = await import('../../../apps/studio/server/src/filesystem/service.ts')
        const fs = await getFilesystemService(this.projectId)
        if (!fs) throw new Error('Filesystem is not configured for this project')
        // Binary write via __b64__: prefix convention (matches fs read path)
        const b64 = `__b64__:${buffer.toString('base64')}`
        await fs.write(targetPath, b64)
        return { success: true, path: targetPath, size: buffer.length }
      }

      case 'send_media_group': {
        const { chat_id, media, thread_id } = params as {
          chat_id: string
          media: Array<{ type: 'photo' | 'video' | 'document'; url?: string; file_path?: string; caption?: string; caption_markdown?: boolean; name?: string }>
          thread_id?: string
        }
        const items: ConnectorMediaItem[] = await Promise.all(media.map(async (m) => {
          const item: ConnectorMediaItem = {
            type: m.type === 'photo' ? 'image' : m.type,
            caption: m.caption,
            caption_markdown: m.caption_markdown,
            name: m.name,
          }
          if (m.url) item.url = m.url
          else if (m.file_path) {
            const buf = await this.loadFilesystemBuffer(m.file_path)
            item.data = buf.buffer
            item.name = m.name ?? buf.name
          }
          return item
        }))
        const commonOpts: Record<string, unknown> = {}
        if (thread_id) commonOpts.message_thread_id = Number(thread_id)
        return this.sendMediaGroup(chat_id, items, commonOpts)
      }

      case 'send_url_media': {
        const { chat_id, url, type, caption, caption_markdown, thread_id } = params as {
          chat_id: string; url: string; type: 'photo' | 'document'; caption?: string; caption_markdown?: boolean; thread_id?: string
        }
        const item: ConnectorMediaItem = {
          type: type === 'photo' ? 'image' : 'document',
          url,
          caption,
          caption_markdown,
        }
        const commonOpts: Record<string, unknown> = {}
        if (thread_id) commonOpts.message_thread_id = Number(thread_id)
        return this.sendSingleMedia(chat_id, item, undefined, commonOpts)
      }

      case 'send_to_scope': {
        const { scope_key, text, markdown } = params as { scope_key: string; text: string; markdown?: boolean }
        const target = this.targetFromScopeKey(scope_key)
        if (!target) throw new Error(`Invalid scope_key: ${scope_key}`)
        return this.sendMessage(target, { text, markdown: markdown ?? true })
      }

      case 'get_chat_members': {
        const { chat_id } = params as { chat_id: string }
        const admins = await this.bot.api.getChatAdministrators(chat_id)
        return { success: true, administrators: admins }
      }

      case 'create_invite_link': {
        const { chat_id, name, expire_date, member_limit } = params as {
          chat_id: string; name?: string; expire_date?: string; member_limit?: number
        }
        const opts: Record<string, unknown> = {}
        if (name) opts.name = name
        if (expire_date) opts.expire_date = Math.floor(new Date(expire_date).getTime() / 1000)
        if (member_limit) opts.member_limit = member_limit
        const link = await this.bot.api.createChatInviteLink(chat_id, opts as any)
        return { success: true, invite_link: link }
      }

      case 'forward_message': {
        const {
          from_chat_id, message_id, to_chat_id, thread_id,
          hide_sender, disable_notification, protect_content,
        } = params as {
          from_chat_id?: string; message_id?: string; to_chat_id?: string
          hide_sender?: boolean; thread_id?: string
          disable_notification?: boolean; protect_content?: boolean
        }

        // Predicted errors — return with actionable hint so the agent can self-recover.
        if (!from_chat_id) return { success: false, error: 'Missing required param: from_chat_id', hint: 'Pass the source chat_id — find it in inbound event raw_payload.chat.id or connector_get_events result.' }
        if (!message_id) return { success: false, error: 'Missing required param: message_id', hint: 'Pass the source message_id — find it in inbound event raw_payload.message.message_id.' }
        if (!to_chat_id) return { success: false, error: 'Missing required param: to_chat_id', hint: 'Pass the destination chat_id. Resolve from target alias via connector_list if needed.' }
        if (!/^-?\d+$/.test(message_id)) return { success: false, error: `message_id must be numeric, got "${message_id}"`, hint: 'Telegram message_ids are integers. Did you pass a uuid or ref_key by mistake?' }

        const opts: Record<string, unknown> = {}
        if (thread_id) opts.message_thread_id = Number(thread_id)
        if (disable_notification) opts.disable_notification = true
        if (protect_content) opts.protect_content = true

        // Default: hide sender → route to copyMessage (no "Forwarded from" header).
        // Both APIs preserve entities server-side (including custom_emoji).
        const effectiveHide = hide_sender ?? true
        try {
          const sent = effectiveHide
            ? await this.bot.api.copyMessage(to_chat_id, from_chat_id, Number(message_id), opts as any)
            : await this.bot.api.forwardMessage(to_chat_id, from_chat_id, Number(message_id), opts as any)

          // copyMessage returns MessageId { message_id }, forwardMessage returns full Message.
          const sentAny = sent as { message_id: number; chat?: { id: number } }
          const chatIdStr = sentAny.chat ? String(sentAny.chat.id) : String(to_chat_id)
          return {
            success: true,
            message_id: String(sentAny.message_id),
            chat_id: chatIdStr,
            hidden_sender: effectiveHide,
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err)
          const hint = this.hintForTelegramError(msg, { from_chat_id, to_chat_id, message_id })
          return { success: false, error: msg, ...(hint ? { hint } : {}) }
        }
      }

      case 'copy_message': {
        const {
          from_chat_id, message_id, to_chat_id, thread_id,
          caption, caption_markdown, caption_entities, show_caption_above_media,
          reply_to_message_id,
          disable_notification, protect_content,
        } = params as {
          from_chat_id?: string; message_id?: string; to_chat_id?: string; thread_id?: string
          caption?: string; caption_markdown?: boolean; caption_entities?: unknown[]
          show_caption_above_media?: boolean; reply_to_message_id?: string
          disable_notification?: boolean; protect_content?: boolean
        }

        if (!from_chat_id) return { success: false, error: 'Missing required param: from_chat_id', hint: 'Pass the source chat_id.' }
        if (!message_id) return { success: false, error: 'Missing required param: message_id', hint: 'Pass the source message_id (numeric).' }
        if (!to_chat_id) return { success: false, error: 'Missing required param: to_chat_id', hint: 'Pass the destination chat_id.' }
        if (!/^-?\d+$/.test(message_id)) return { success: false, error: `message_id must be numeric, got "${message_id}"`, hint: 'Telegram message_ids are integers.' }
        if (caption_markdown && caption_entities) return { success: false, error: 'caption_markdown and caption_entities are mutually exclusive', hint: 'Pick one: caption_markdown (convenience) or caption_entities (precise control, required for custom_emoji in caption).' }

        const opts: Record<string, unknown> = {}
        if (thread_id) opts.message_thread_id = Number(thread_id)
        if (disable_notification) opts.disable_notification = true
        if (protect_content) opts.protect_content = true
        if (show_caption_above_media) opts.show_caption_above_media = true
        if (reply_to_message_id) opts.reply_parameters = { message_id: Number(reply_to_message_id) }
        if (caption !== undefined) {
          if (caption_entities) {
            opts.caption = caption
            opts.caption_entities = caption_entities
          } else if (caption_markdown) {
            opts.caption = telegramifyMarkdown(caption, 'escape')
            opts.parse_mode = 'MarkdownV2'
          } else {
            opts.caption = caption
          }
        }
        try {
          const sent = await this.bot.api.copyMessage(to_chat_id, from_chat_id, Number(message_id), opts as any)
          return { success: true, message_id: String(sent.message_id), chat_id: String(to_chat_id) }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err)
          const hint = this.hintForTelegramError(msg, { from_chat_id, to_chat_id, message_id })
          return { success: false, error: msg, ...(hint ? { hint } : {}) }
        }
      }

      case 'set_chat_description': {
        const { chat_id, description } = params as { chat_id: string; description: string }
        await this.bot.api.setChatDescription(chat_id, description)
        return { success: true }
      }

      case 'ban_member': {
        const { chat_id, user_id, until_date } = params as { chat_id: string; user_id: string; until_date?: string }
        const opts: Record<string, unknown> = {}
        if (until_date) opts.until_date = Math.floor(new Date(until_date).getTime() / 1000)
        await this.bot.api.banChatMember(chat_id, Number(user_id), opts as any)
        return { success: true }
      }

      default:
        throw new Error(`Unknown action: ${actionId}`)
    }
  }

  // ─── Helpers ───────────────────────────────────────────────────────

  /**
   * Map common Telegram Bot API error messages to actionable hints for agents.
   * Returns undefined when the error isn't a known pattern — caller should pass
   * the raw message through unchanged.
   */
  private hintForTelegramError(
    message: string,
    ctx: { from_chat_id?: string; to_chat_id?: string; message_id?: string },
  ): string | undefined {
    const m = message.toLowerCase()
    if (m.includes('chat not found')) {
      return `Bot can't see chat_id ${ctx.to_chat_id ?? ctx.from_chat_id}. Either the bot isn't a member there, the ID is wrong, or the chat was deleted. Check connector_list for known targets.`
    }
    if (m.includes('message to forward not found') || m.includes('message to copy not found') || m.includes('message not found')) {
      return `Message ${ctx.message_id} doesn't exist in chat ${ctx.from_chat_id}, or it was deleted. Verify the message_id from connector_get_events raw_payload.message.message_id.`
    }
    if (m.includes('forward_from_chat') || m.includes('forwarding is not allowed') || m.includes('message can\'t be forwarded') || m.includes('forward restricted')) {
      return `The source chat has "restrict forwarding" enabled, or the message is protected. Try copy_message with hide_sender=true, or send a fresh message using connector_send + params.entities to preserve custom_emoji.`
    }
    if (m.includes('bot was blocked') || m.includes('user is deactivated')) {
      return `The destination user blocked the bot or deactivated their account. Skip and move on.`
    }
    if (m.includes('not enough rights') || m.includes('need administrator rights') || m.includes('chat_admin_required')) {
      return `Bot lacks permission in destination chat ${ctx.to_chat_id}. Ask the admin to promote the bot (and grant "Post Messages" if channel).`
    }
    if (m.includes('too many requests') || m.includes('retry after')) {
      return `Telegram rate limit hit. The send queue already retries — if this still surfaces, throttle your send rate or batch with longer intervals.`
    }
    if (m.includes('message_thread_not_found') || m.includes('message thread not found')) {
      return `The destination topic thread doesn't exist in chat ${ctx.to_chat_id}. Omit thread_id to send to the general channel, or verify the topic ID.`
    }
    if (m.includes('bad request: message text is empty')) {
      return `Source message has no text body — probably a media-only message. Use copy_message with a caption override, or fetch the media via fetch_media first.`
    }
    return undefined
  }

  private guessExt(mime: string | undefined, type: string | undefined): string {
    if (mime) {
      if (mime.includes('jpeg')) return '.jpg'
      if (mime.includes('png')) return '.png'
      if (mime.includes('webp')) return '.webp'
      if (mime.includes('mp4')) return '.mp4'
      if (mime.includes('ogg')) return '.ogg'
      if (mime.includes('pdf')) return '.pdf'
    }
    if (type === 'photo') return '.jpg'
    if (type === 'voice') return '.ogg'
    if (type === 'video') return '.mp4'
    return ''
  }

  /** Produce a stable, filesystem-friendly target name from a channel title. */
  private slugifyChannelTitle(title: string): string {
    const slug = title
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9\s-_]/g, '')
      .replace(/\s+/g, '-')
      .replace(/-+/g, '-')
      .slice(0, 60)
    return slug || `channel-${Date.now()}`
  }

  private async loadFilesystemBuffer(filePath: string): Promise<{ buffer: Buffer; name: string; mime_type: string }> {
    if (!this.projectId) throw new Error('Project context not available')
    const { getFilesystemService } = await import('../../../apps/studio/server/src/filesystem/service.ts')
    const fs = await getFilesystemService(this.projectId)
    if (!fs) throw new Error('Filesystem is not configured for this project')
    const adapter = fs.getAdapter()
    const fileRecord = await getFileByPath(this.projectId, filePath)
    if (!fileRecord) throw new Error(`File not found in filesystem: ${filePath}`)
    const buffer = await adapter.download(fileRecord.storage_key)
    return { buffer: Buffer.from(buffer), name: fileRecord.name, mime_type: fileRecord.mime_type }
  }

  private async resolveFilesystemFile(filePath: string) {
    const { buffer, name } = await this.loadFilesystemBuffer(filePath)
    const { InputFile } = await import('grammy')
    return new InputFile(buffer, name)
  }

  // ─── Standard ConnectorAdapter methods ─────────────────────────────

  async onActivate(ctx: ConnectorContext): Promise<void> {
    const { Bot } = await import('grammy')
    const token = ctx.fields['bot_token']
    if (!token) throw new Error('[telegram] bot_token missing in credentials')

    this.projectId = ctx.projectId
    this.connectorId = ctx.connectorId
    this.pollingStopRequested = false
    this.lastEventAt = null
    this.bot = new Bot(token)

    // Grammy internal error handler — without this, errors inside async
    // update handlers default to unhandled rejection and can crash the node
    // process (or, worse, silently kill the polling loop). Log + swallow.
    this.bot.catch((err) => {
      console.error('[telegram] grammy handler error:', err.error ?? err)
    })

    this.bot.on('message', async (gramCtx: any) => {
      const msg = gramCtx.message
      const { media, mediaMetadata } = extractTelegramMedia(msg)

      // Classify: real message vs service message. Telegram sends many
      // service messages (new_chat_members, left_chat_member, new_chat_title,
      // pinned_message, migrate_to_chat_id, voice_chat_*, etc.) on the same
      // `message` event; the agent should NOT treat those as user input.
      const hasContent = msg.text !== undefined || msg.caption !== undefined || media !== undefined

      let type: ConnectorEvent['type']
      if (hasContent) {
        type = 'message'
      } else if (msg.new_chat_members) {
        type = 'join'
      } else if (msg.left_chat_member) {
        type = 'leave'
      } else {
        // Other service messages (title/photo changes, pinned, migrate, voice_chat_*) —
        // nothing the agent can act on. Drop silently (still visible in raw Telegram logs).
        return
      }

      // Bot-mention detection — explicit: matches only when THIS bot is mentioned.
      //  - text entity type='mention' with substring "@<botUsername>" (case-insensitive)
      //  - text entity type='text_mention' with user.id === bot id (mention without @, e.g. picked from contacts)
      // Covers both `text` and `caption` entities (photo/doc captions can mention too).
      let botMentioned = false
      const scanEntities = (entities: any[] | undefined, sourceText: string | undefined) => {
        if (!entities || !sourceText) return
        for (const ent of entities) {
          if (ent.type === 'mention' && this.botUsername) {
            const raw = sourceText.slice(ent.offset, ent.offset + ent.length).toLowerCase()
            if (raw === `@${this.botUsername}`) { botMentioned = true; return }
          }
          if (ent.type === 'text_mention' && this.botUserId && ent.user?.id === this.botUserId) {
            botMentioned = true
            return
          }
        }
      }
      scanEntities(msg.entities, msg.text)
      scanEntities(msg.caption_entities, msg.caption)

      // Reply-to-bot detection — true when this message is a direct reply to
      // one of the bot's own messages. Ignores the synthetic reply_to_message
      // pointer Telegram attaches for forum-topic membership.
      const isReplyToBot =
        !!this.botUserId
        && !!msg.reply_to_message?.from?.is_bot
        && msg.reply_to_message.from?.id === this.botUserId
        && !msg.reply_to_message.forum_topic_created

      // Forum topic name — Telegram embeds the topic name in a few places depending on the message shape.
      //   - msg.forum_topic_created.name      → this IS the topic-creation event
      //   - msg.forum_topic_edited.name       → topic was renamed
      //   - msg.reply_to_message.forum_topic_created.name → regular message in a topic (Bot API
      //     synthesises a reply-to pointer to the topic-creation service msg so bots can identify it)
      //   - msg.is_topic_message              → flag set on ALL messages in a topic
      // General Chat (topic_id = null in a forum supergroup) has no topic name.
      const forumTopicName: string | undefined =
        msg.forum_topic_created?.name
        ?? msg.forum_topic_edited?.name
        ?? msg.reply_to_message?.forum_topic_created?.name
        ?? undefined

      const event: ConnectorEvent = {
        type,
        connector_id: this.id,
        ref_keys: {
          message_id: String(msg.message_id),
          chat_id: String(msg.chat.id),
          ...(msg.message_thread_id ? { thread_id: String(msg.message_thread_id) } : {}),
        },
        sender: {
          external_id: String(msg.from?.id ?? msg.chat.id),
          display_name: [msg.from?.first_name, msg.from?.last_name].filter(Boolean).join(' ') || undefined,
          username: msg.from?.username,
          is_bot: msg.from?.is_bot,
        },
        content: hasContent
          ? { text: msg.text ?? msg.caption, media }
          : { raw: msg.new_chat_members ?? msg.left_chat_member },
        metadata: {
          language_code: msg.from?.language_code ?? null,
          client_timestamp: new Date(msg.date * 1000).toISOString(),
          chat_type: msg.chat.type,
          chat_title: 'title' in msg.chat ? msg.chat.title : undefined,
          ...(forumTopicName ? { thread_title: forumTopicName } : {}),
          ...(msg.is_topic_message ? { is_topic_message: true } : {}),
          ...(botMentioned ? { bot_mentioned: true } : {}),
          ...(isReplyToBot ? { bot_replied_to: true } : {}),
          ...mediaMetadata,
        },
        timestamp: new Date(msg.date * 1000),
        raw_payload: gramCtx.update,
      }
      // Heartbeat for health endpoint — set BEFORE any await so even if DB is
      // slow, the "last event" timestamp reflects true Telegram activity.
      this.lastEventAt = Date.now()
      // 1) Always record arrival immediately, OUTSIDE the queue, so ops can
      //    see inbound traffic in connector_events even if the routing queue
      //    stalls. Downstream handlers log subsequent status rows.
      await logArrivalImmediate(this.connectorId, event)
      // 2) Route through the queue (batched concurrency) for agent processing.
      await enqueueInboundEvent(() => ctx.onEvent(event).catch(err => {
        console.error('[telegram] inbound event handler error:', err)
      }))

      // Auto-register forum topic as connector_target the first time we see
      // one with a known title. Target name: "<chat-slug>__<topic-slug>".
      // scope_key matches computeScopeKey format so outbound via this target
      // joins the same scope conversation as inbound events.
      if (msg.message_thread_id && forumTopicName && this.projectId && hasContent) {
        const tid = String(msg.message_thread_id)
        const chatSlug = this.slugifyChannelTitle(
          'title' in msg.chat ? (msg.chat.title ?? `chat-${msg.chat.id}`) : `chat-${msg.chat.id}`,
        )
        const topicSlug = this.slugifyChannelTitle(forumTopicName)
        const targetName = `${chatSlug}__${topicSlug}`
        try {
          const { createConnectorTarget, getConnectorTargetByName } = await import('@jiku-studio/db')
          const existing = await getConnectorTargetByName(this.projectId, targetName, ctx.connectorId).catch(() => null)
          if (!existing) {
            await createConnectorTarget({
              connector_id: ctx.connectorId,
              name: targetName,
              display_name: `${msg.chat.title ?? msg.chat.id} → ${forumTopicName}`,
              description: `Auto-registered forum topic — first seen ${new Date().toISOString()}`,
              ref_keys: { chat_id: String(msg.chat.id), thread_id: tid },
              scope_key: `group:${msg.chat.id}:topic:${tid}`,
              metadata: {
                auto_registered: true,
                chat_type: msg.chat.type,
                chat_title: 'title' in msg.chat ? msg.chat.title : undefined,
                thread_title: forumTopicName,
                registered_at: new Date().toISOString(),
              },
            })
            console.log(`[telegram] auto-registered topic target "${targetName}" (group:${msg.chat.id}:topic:${tid})`)
          }
        } catch (err) {
          console.warn('[telegram] failed to auto-register topic target:', err)
        }
      }
    })

    this.bot.on('message_reaction', async (gramCtx: any) => {
      const update = gramCtx.update.message_reaction
      const added = update.new_reaction?.find((r: any) => r.type === 'emoji')
      const removed = update.old_reaction?.find((r: any) => r.type === 'emoji')
      const emoji = added?.emoji ?? removed?.emoji ?? '👍'
      const type: ConnectorEvent['type'] = added ? 'reaction' : 'unreaction'
      const event: ConnectorEvent = {
        type,
        connector_id: this.id,
        ref_keys: {
          message_id: String(update.message_id),
          chat_id: String(update.chat.id),
        },
        sender: { external_id: String(update.user?.id ?? update.chat?.id ?? 'unknown') },
        content: { text: emoji, raw: { emoji } },
        metadata: { chat_type: update.chat?.type },
        timestamp: new Date(update.date * 1000),
        raw_payload: gramCtx.update,
      }
      // Heartbeat for health endpoint — set BEFORE any await so even if DB is
      // slow, the "last event" timestamp reflects true Telegram activity.
      this.lastEventAt = Date.now()
      // 1) Always record arrival immediately, OUTSIDE the queue, so ops can
      //    see inbound traffic in connector_events even if the routing queue
      //    stalls. Downstream handlers log subsequent status rows.
      await logArrivalImmediate(this.connectorId, event)
      // 2) Route through the queue (batched concurrency) for agent processing.
      await enqueueInboundEvent(() => ctx.onEvent(event).catch(err => {
        console.error('[telegram] inbound event handler error:', err)
      }))
    })

    this.bot.on('edited_message', async (gramCtx: any) => {
      const msg = gramCtx.editedMessage
      const event: ConnectorEvent = {
        type: 'edit',
        connector_id: this.id,
        ref_keys: {
          message_id: String(msg.message_id),
          chat_id: String(msg.chat.id),
          ...(msg.message_thread_id ? { thread_id: String(msg.message_thread_id) } : {}),
        },
        sender: {
          external_id: String(msg.from?.id ?? msg.chat.id),
          display_name: [msg.from?.first_name, msg.from?.last_name].filter(Boolean).join(' ') || undefined,
          username: msg.from?.username,
        },
        content: { text: msg.text ?? msg.caption, raw: { new_text: msg.text } },
        metadata: { chat_type: msg.chat.type, chat_title: 'title' in msg.chat ? msg.chat.title : undefined },
        timestamp: new Date((msg.edit_date ?? msg.date) * 1000),
        raw_payload: gramCtx.update,
      }
      // Heartbeat for health endpoint — set BEFORE any await so even if DB is
      // slow, the "last event" timestamp reflects true Telegram activity.
      this.lastEventAt = Date.now()
      // 1) Always record arrival immediately, OUTSIDE the queue, so ops can
      //    see inbound traffic in connector_events even if the routing queue
      //    stalls. Downstream handlers log subsequent status rows.
      await logArrivalImmediate(this.connectorId, event)
      // 2) Route through the queue (batched concurrency) for agent processing.
      await enqueueInboundEvent(() => ctx.onEvent(event).catch(err => {
        console.error('[telegram] inbound event handler error:', err)
      }))
    })

    // ── Channel posts — treat as messages so AI can read channel content ────
    // `channel_post` fires for new posts in channels/supergroups where the bot
    // is present. We normalize to a `message` event so bindings + routing work
    // the same as DM/group messages. `msg.from` is typically null for channel
    // broadcasts (posts are signed by the channel, not a user).
    this.bot.on('channel_post', async (gramCtx: any) => {
      const msg = gramCtx.channelPost
      const { media, mediaMetadata } = extractTelegramMedia(msg)
      const event: ConnectorEvent = {
        type: 'message',
        connector_id: this.id,
        ref_keys: {
          message_id: String(msg.message_id),
          chat_id: String(msg.chat.id),
          ...(msg.message_thread_id ? { thread_id: String(msg.message_thread_id) } : {}),
        },
        sender: {
          external_id: String(msg.sender_chat?.id ?? msg.chat.id),
          display_name: msg.sender_chat?.title ?? ('title' in msg.chat ? msg.chat.title : undefined),
          username: msg.sender_chat?.username,
        },
        content: { text: msg.text ?? msg.caption, media },
        metadata: {
          client_timestamp: new Date(msg.date * 1000).toISOString(),
          chat_type: msg.chat.type,
          chat_title: 'title' in msg.chat ? msg.chat.title : undefined,
          is_channel_post: true,
          ...mediaMetadata,
        },
        timestamp: new Date(msg.date * 1000),
        raw_payload: gramCtx.update,
      }
      // Heartbeat for health endpoint — set BEFORE any await so even if DB is
      // slow, the "last event" timestamp reflects true Telegram activity.
      this.lastEventAt = Date.now()
      // 1) Always record arrival immediately, OUTSIDE the queue, so ops can
      //    see inbound traffic in connector_events even if the routing queue
      //    stalls. Downstream handlers log subsequent status rows.
      await logArrivalImmediate(this.connectorId, event)
      // 2) Route through the queue (batched concurrency) for agent processing.
      await enqueueInboundEvent(() => ctx.onEvent(event).catch(err => {
        console.error('[telegram] inbound event handler error:', err)
      }))
    })

    // ── Bot membership changes — auto-register channels as named targets ────
    // Telegram sends `my_chat_member` when the bot's status in a chat changes
    // (added/removed/promoted/demoted). When the bot becomes an administrator
    // in a channel or supergroup, we auto-create a `connector_target` so the
    // AI can address it by name via `connector_send_to_target`. Removal
    // results in a `leave` event for observability (target is kept in DB so
    // the admin can decide whether to re-enable or clean up manually).
    this.bot.on('my_chat_member', async (gramCtx: any) => {
      const update = gramCtx.update.my_chat_member
      const chat = update.chat
      const newStatus = update.new_chat_member?.status as string | undefined
      const oldStatus = update.old_chat_member?.status as string | undefined

      const isAdminNow = newStatus === 'administrator' || newStatus === 'creator'
      const wasAdminBefore = oldStatus === 'administrator' || oldStatus === 'creator'
      const isMemberNow = newStatus === 'member' || isAdminNow
      const wasMemberBefore = oldStatus === 'member' || wasAdminBefore
      const isChannelOrSupergroup = chat.type === 'channel' || chat.type === 'supergroup'
      const isGroupOrSupergroup = chat.type === 'group' || chat.type === 'supergroup'

      // Bot added to a group/supergroup → auto-create a DRAFT binding so the
      // admin can approve it with one click (pick agent + member_mode) and turn
      // it into a live group binding. The binding is created `enabled=false`
      // with empty output_config.agent_id so it won't match anything until
      // approved. Channels use the target-auto-register flow below instead.
      if (isMemberNow && !wasMemberBefore && isGroupOrSupergroup) {
        try {
          const { createBinding, getBindings } = await import('@jiku-studio/db')
          const scopeKey = `group:${chat.id}`
          const existingBindings = await getBindings(ctx.connectorId).catch(() => [])
          const alreadyHas = existingBindings.some(b => b.scope_key_pattern === scopeKey)
          if (!alreadyHas) {
            await createBinding({
              connector_id: ctx.connectorId,
              display_name: `Pending group pairing: ${chat.title ?? chat.id}`,
              source_type: 'group',
              scope_key_pattern: scopeKey,
              output_adapter: 'conversation',
              output_config: {},
              member_mode: 'require_approval',
            })
            // Mark disabled — createBinding defaults enabled=true, but a draft
            // should never match until admin picks an agent.
            const { updateBinding, getBindings: refetch } = await import('@jiku-studio/db')
            const refreshed = await refetch(ctx.connectorId)
            const draft = refreshed.find(b => b.scope_key_pattern === scopeKey)
            if (draft) await updateBinding(draft.id, { enabled: false })
            console.log(`[telegram] auto-registered group pairing draft "${chat.title}" (${scopeKey})`)
          }
        } catch (err) {
          console.warn('[telegram] failed to auto-register group pairing draft:', err)
        }
      }

      // Bot added/promoted to admin in a channel → auto-create target.
      if (isAdminNow && !wasAdminBefore && isChannelOrSupergroup) {
        try {
          const { createConnectorTarget, getConnectorTargetByName } = await import('@jiku-studio/db')
          const targetName = this.slugifyChannelTitle(chat.title ?? `channel-${chat.id}`)
          const existing = await getConnectorTargetByName(this.projectId!, targetName, ctx.connectorId).catch(() => null)
          if (!existing) {
            await createConnectorTarget({
              connector_id: ctx.connectorId,
              name: targetName,
              display_name: chat.title ?? null,
              description: `Auto-registered ${chat.type} — bot became admin on ${new Date().toISOString()}`,
              ref_keys: { chat_id: String(chat.id) },
              // Use 'group:' prefix to match computeScopeKey output — otherwise
              // outbound-via-target would create a scope conversation under
              // 'chat:<id>' that never matches inbound events keyed 'group:<id>'.
              scope_key: `group:${chat.id}`,
              metadata: {
                auto_registered: true,
                chat_type: chat.type,
                chat_title: chat.title,
                registered_at: new Date().toISOString(),
              },
            })
            console.log(`[telegram] auto-registered channel target "${targetName}" (chat_id=${chat.id})`)
          }
        } catch (err) {
          console.warn('[telegram] failed to auto-register channel target:', err)
        }
      }

      // Emit join/leave event for routing + audit trail.
      const eventType: ConnectorEvent['type'] =
        isAdminNow && !wasAdminBefore ? 'join'
        : !isAdminNow && wasAdminBefore ? 'leave'
        : 'custom'

      const event: ConnectorEvent = {
        type: eventType,
        connector_id: this.id,
        ref_keys: {
          chat_id: String(chat.id),
        },
        sender: {
          external_id: String(update.from?.id ?? chat.id),
          display_name: [update.from?.first_name, update.from?.last_name].filter(Boolean).join(' ') || undefined,
          username: update.from?.username,
        },
        content: {
          text: `Bot status in ${chat.type} "${chat.title ?? chat.id}" changed: ${oldStatus ?? '(none)'} → ${newStatus ?? '(none)'}`,
          raw: { old_status: oldStatus, new_status: newStatus },
        },
        metadata: {
          chat_type: chat.type,
          chat_title: 'title' in chat ? chat.title : undefined,
          membership_change: true,
        },
        timestamp: new Date(update.date * 1000),
        raw_payload: gramCtx.update,
      }
      // Heartbeat for health endpoint — set BEFORE any await so even if DB is
      // slow, the "last event" timestamp reflects true Telegram activity.
      this.lastEventAt = Date.now()
      // 1) Always record arrival immediately, OUTSIDE the queue, so ops can
      //    see inbound traffic in connector_events even if the routing queue
      //    stalls. Downstream handlers log subsequent status rows.
      await logArrivalImmediate(this.connectorId, event)
      // 2) Route through the queue (batched concurrency) for agent processing.
      await enqueueInboundEvent(() => ctx.onEvent(event).catch(err => {
        console.error('[telegram] inbound event handler error:', err)
      }))
    })

    // Belt-and-braces reset:
    //  - deleteWebhook: evicts a stale webhook registration that would block polling.
    //  - close: asks Telegram to release this bot token's current long-poll slot
    //    (important when a previous connector was just deleted — the server-side
    //    slot can linger for up to 30s, causing 409 on our new getUpdates).
    // Both are idempotent and safe to fail; log and continue.
    // Cache bot identity (@username + numeric id) so we can detect when the
    // bot is mentioned or replied-to at event-parse time.
    try {
      const me = await this.bot.api.getMe()
      this.botUsername = me.username?.toLowerCase() ?? null
      this.botUserId = me.id ?? null
      console.log(`[telegram] identity cached: @${this.botUsername} (id=${this.botUserId})`)
    } catch (err) {
      console.warn('[telegram] getMe failed — mention/reply detection disabled:', err)
    }

    try {
      await this.bot.api.deleteWebhook({ drop_pending_updates: true })
    } catch (err) {
      console.warn('[telegram] deleteWebhook before polling failed:', err)
    }
    try {
      await this.bot.api.close()
    } catch (err) {
      // Two expected/harmless outcomes we intentionally swallow:
      //   429 — bot was never polled in the last 10 min, Telegram refuses close().
      //   400 "already been closed" — grammy's `bot.stop()` in a recent deactivate
      //   already issued close() on our behalf; re-closing is a no-op.
      const s = String(err)
      const benign = s.includes('429') || s.includes('already been closed')
      if (!benign) {
        console.warn('[telegram] bot.api.close() before polling failed:', err)
      }
    }

    // Pre-polling wait. Two separate cases:
    //
    //   (a) Reactivation inside the same process (Stop+Start / Restart button /
    //       connector settings save). `lastDeactivateByConnector` has an entry,
    //       wait out the remainder of Telegram's ~30s slot reservation.
    //
    //   (b) Fresh boot — no entry in the map. Under zero-downtime deploys the
    //       new container is up and healthy BEFORE the old container is told
    //       to terminate. During that overlap both containers poll the same
    //       bot token and the new one loses with 409. Add a boot delay so the
    //       old container has time to shut down and release its long-poll slot
    //       before we attempt `getUpdates`. Configurable via
    //       TELEGRAM_BOOT_POLL_DELAY_MS (default 10s). Set to 0 in dev to skip.
    if (this.connectorId) {
      const lastDeact = lastDeactivateByConnector.get(this.connectorId)
      if (lastDeact) {
        const elapsed = Date.now() - lastDeact
        const remain = REACTIVATE_WAIT_MS - elapsed
        if (remain > 0) {
          console.log(`[telegram] waiting ${Math.ceil(remain / 1000)}s for Telegram poll-slot release before starting`)
          await new Promise<void>(r => setTimeout(r, remain))
        }
      } else {
        const bootDelayMs = Number(process.env['TELEGRAM_BOOT_POLL_DELAY_MS'] ?? 10_000)
        if (bootDelayMs > 0) {
          console.log(`[telegram] fresh-boot wait ${Math.ceil(bootDelayMs / 1000)}s before polling (lets old zero-downtime container release its slot)`)
          await new Promise<void>(r => setTimeout(r, bootDelayMs))
        }
      }
    }

    // Auto-reconnect polling loop. `bot.start()` returns a promise that only
    // resolves/rejects when polling terminates. Old code fire-and-forgot with
    // `.catch(log)` — any rejection (409 Conflict, 401, network drop) meant
    // permanent silence. Now we loop with exponential backoff until either
    // polling runs normally or onDeactivate sets pollingStopRequested.
    const allowed_updates = [
      'message',
      'edited_message',
      'channel_post',
      'edited_channel_post',
      'my_chat_member',
      'chat_member',
      'message_reaction',
    ] as const

    const startedBot = this.bot
    void (async () => {
      let backoffMs = 1_000
      const MAX_BACKOFF = 60_000
      while (!this.pollingStopRequested && this.bot === startedBot) {
        try {
          await startedBot.start({
            drop_pending_updates: true,
            allowed_updates: allowed_updates as unknown as string[],
          } as any)
          // `start()` resolved without throwing. There are TWO scenarios:
          //   (a) WE called bot.stop() — explicit shutdown, exit cleanly.
          //   (b) grammy internally stopped (e.g. Telegram dropped the long-poll
          //       connection, an unhandled handler error bubbled, network blip).
          //       The bot is now silently dead. Previously we treated this as
          //       (a) and exited — leaving the bot offline forever. Now we only
          //       trust it as (a) when `pollingStopRequested === true`.
          if (this.pollingStopRequested) {
            console.log('[telegram] polling loop exited cleanly (deactivate requested)')
            return
          }
          console.warn(`[telegram] polling stopped unexpectedly without explicit deactivate — restarting in ${backoffMs}ms`)
          await new Promise<void>(r => setTimeout(r, backoffMs))
          backoffMs = Math.min(backoffMs * 2, MAX_BACKOFF)
          continue
        } catch (err) {
          if (this.pollingStopRequested) return
          const isConflict = String(err).includes('409')
          console.error(
            `[telegram] polling error (retry in ${backoffMs}ms, 409=${isConflict}):`,
            err,
          )
          if (isConflict) {
            // Slot still held by a previous instance. `close()` asks Telegram to
            // release it. Returns 429 early on — we don't care, just try.
            await startedBot.api.close().catch(() => {})
          }
          await new Promise<void>(r => setTimeout(r, backoffMs))
          backoffMs = Math.min(backoffMs * 2, MAX_BACKOFF)
        }
      }
    })().catch(err => {
      // Defence in depth — the IIFE itself should never reject because both
      // paths inside the loop are wrapped, but if a future refactor introduces
      // an un-handled await this prevents an unhandled-rejection from killing
      // the process.
      console.error('[telegram] polling supervisor crashed (this should NEVER happen):', err)
    })

    console.log('[telegram] bot started (polling loop running with auto-reconnect)')
  }

  async onDeactivate(): Promise<void> {
    if (this.bot) {
      this.pollingStopRequested = true
      if (this.connectorId) lastDeactivateByConnector.set(this.connectorId, Date.now())
      await this.bot.stop().catch(() => {})
      this.bot = null
      this.projectId = null
      this.connectorId = null
      this.botUsername = null
      this.botUserId = null
      this.lastEventAt = null
      console.log('[telegram] bot stopped')
    }
  }

  /** Health snapshot — used by `GET /connectors/:id/health`. */
  getHealth(): { polling: boolean; last_event_at: string | null; bot_user_id: number | null } {
    return {
      polling: this.bot !== null && !this.pollingStopRequested,
      last_event_at: this.lastEventAt ? new Date(this.lastEventAt).toISOString() : null,
      bot_user_id: this.botUserId,
    }
  }

  override getIdentity() {
    if (!this.botUsername && !this.botUserId) return null
    return {
      name: this.botUsername ?? `bot:${this.botUserId}`,
      username: this.botUsername ? `@${this.botUsername}` : null,
      user_id: this.botUserId !== null ? String(this.botUserId) : null,
      metadata: { kind: 'bot' },
    }
  }

  parseEvent(raw: unknown): ConnectorEvent | null {
    const update = raw as any
    const msg = update?.message
    if (msg?.text !== undefined) {
      return {
        type: 'message',
        connector_id: this.id,
        ref_keys: {
          message_id: String(msg.message_id),
          chat_id: String(msg.chat.id),
          ...(msg.message_thread_id ? { thread_id: String(msg.message_thread_id) } : {}),
        },
        sender: {
          external_id: String(msg.from?.id ?? msg.chat.id),
          display_name: [msg.from?.first_name, msg.from?.last_name].filter(Boolean).join(' ') || undefined,
          username: msg.from?.username,
        },
        content: { text: msg.text ?? msg.caption },
        metadata: { chat_type: msg.chat.type, chat_title: 'title' in msg.chat ? msg.chat.title : undefined },
        timestamp: new Date(msg.date * 1000),
      }
    }
    return null
  }

  async sendMessage(target: ConnectorTarget, content: ConnectorContent): Promise<ConnectorSendResult> {
    if (!this.bot) return { success: false, error: 'Bot not initialized' }

    // Plan 22 — resolve thread_id: explicit ref_keys > scope_key > content.target_scope_key
    let chatId = target.ref_keys['chat_id']
    let threadId = target.ref_keys['thread_id']
    const scope = content.target_scope_key ?? target.scope_key
    if (scope) {
      const resolved = this.targetFromScopeKey(scope)
      if (resolved) {
        chatId = chatId ?? resolved.ref_keys['chat_id']
        threadId = threadId ?? resolved.ref_keys['thread_id']
      }
    }
    const replyToId = target.reply_to_ref_keys?.['message_id']
    if (!chatId) return { success: false, error: 'Missing chat_id' }

    const commonOpts: Record<string, unknown> = {}
    if (threadId) commonOpts.message_thread_id = Number(threadId)
    if (replyToId) commonOpts.reply_parameters = { message_id: Number(replyToId) }

    // Plan 27 — merge platform-specific extras into commonOpts so Telegram
    // Bot API receives them. Agent-facing keys are documented via getParamSchema().
    if (content.params) {
      for (const [k, v] of Object.entries(content.params)) {
        if (v === undefined || v === null) continue
        if (k === 'reply_to_message_id') {
          // Translate to modern reply_parameters shape.
          commonOpts.reply_parameters = { message_id: Number(v) }
        } else if (k === 'message_thread_id') {
          commonOpts.message_thread_id = Number(v)
        } else {
          commonOpts[k] = v
        }
      }
    }

    return enqueueForChat(chatId, () => this.sendMessageInner(chatId!, content, commonOpts))
  }

  /** Plan 27 — Telegram send param schema surfaced to agents via connector_list. */
  override getParamSchema() {
    return [
      {
        name: 'reply_to_message_id',
        type: 'number' as const,
        description: 'Make this message a reply to an existing Telegram message_id in the same chat. Prefer using connector_send\'s `reply_to_ref_keys` when you already have a message_id — use this param when you only know the numeric id (e.g. from connector_get_event.raw_payload).',
        example: 1042,
      },
      {
        name: 'parse_mode',
        type: 'enum' as const,
        enum_values: ['MarkdownV2', 'HTML'],
        description: 'Override the default parse mode. The top-level `markdown:true` field already handles MarkdownV2 escape; set this to "HTML" when you need to send raw HTML. MUTUALLY EXCLUSIVE with `entities` — if both are supplied, `entities` wins and parse_mode is ignored.',
        example: 'HTML',
      },
      {
        name: 'entities',
        type: 'array' as const,
        description: 'Raw Telegram MessageEntity[] for precise formatting control. Required for `custom_emoji` (animated premium) and `text_mention` by user_id — these cannot be expressed via markdown/HTML. When supplied: (a) `parse_mode` and top-level `markdown` are auto-ignored, (b) `text` must be raw (no markdown syntax), (c) entity `offset`/`length` are in UTF-16 code units (use string `.length`), (d) only applies to the first chunk if the message is split. Forwarding a received message verbatim? Prefer the `forward_message` or `copy_message` action — Telegram preserves all entities natively without you having to rebuild them.',
        example: [{ type: 'bold', offset: 0, length: 5 }, { type: 'custom_emoji', offset: 6, length: 2, custom_emoji_id: '5370870691140737817' }],
      },
      {
        name: 'disable_web_page_preview',
        type: 'boolean' as const,
        description: 'Suppress link previews in the message.',
        example: true,
      },
      {
        name: 'message_thread_id',
        type: 'number' as const,
        description: 'Forum topic thread_id. Usually inferred from target.ref_keys.thread_id — pass explicitly when the thread differs from the target context.',
        example: 42,
      },
      {
        name: 'protect_content',
        type: 'boolean' as const,
        description: 'Prevent Telegram clients from forwarding/saving the message.',
        example: true,
      },
      {
        name: 'disable_notification',
        type: 'boolean' as const,
        description: 'Send the message silently — no notification sound for recipients.',
        example: true,
      },
      {
        name: 'allow_sending_without_reply',
        type: 'boolean' as const,
        description: 'If the reply target is missing/deleted, send anyway (default: false).',
        example: true,
      },
    ]
  }

  /**
   * Plan 28 — Real-time streaming outbound for resolved inbound events.
   *
   * Event-router hands off here after binding + identity + conversation are
   * resolved. We own:
   *   1. Sending the initial "⌛" placeholder as a reply to the user's message.
   *   2. Consuming the agent stream natively — edit placeholder on each batch
   *      of text-delta chunks (debounced 700ms to respect Telegram's edit rate).
   *   3. Rendering tool-call chunks as `[🔧] tool_name` in a header block above
   *      the response; flipping to `[☑️]` on tool result, `[❌]` on error.
   *   4. Splitting at Telegram's 4000-char cap — finalize current message, open
   *      a fresh "⌛" placeholder, continue there.
   *   5. Final edit applies MarkdownV2 escaping; falls back to plain on parse fail.
   *   6. Logging outbound message + event + usage via the ctx callables, so the
   *      Messages UI / Usage dashboard stay in parity with the HTTP /chat path.
   *   7. Tee a branch of the stream back to the host for SSE observers (chat web).
   */
  override async handleResolvedEvent(ctx: ResolvedEventContext): Promise<void> {
    if (!this.bot) return

    const chatId = ctx.event.ref_keys['chat_id']
    if (!chatId) return
    const threadId = ctx.event.ref_keys['thread_id']
    const replyToMsgId = ctx.event.ref_keys['message_id']

    const replyTarget: Record<string, unknown> = {}
    if (threadId) replyTarget['message_thread_id'] = Number(threadId)
    if (replyToMsgId) replyTarget['reply_parameters'] = { message_id: Number(replyToMsgId) }

    // 1. Initial placeholder.
    let currentMsgId: number
    try {
      const sent = await withTelegramRetry(
        () => this.bot!.api.sendMessage(chatId, '⌛', replyTarget as any),
        'telegram:stream:placeholder',
      )
      currentMsgId = sent.message_id
    } catch (err) {
      console.warn('[telegram] handleResolvedEvent: placeholder send failed', err)
      return
    }

    // 2. Start run + tee stream.
    const run = await ctx.startRun()
    const [selfStream, observerStream] = run.stream.tee()
    const observer = ctx.registerObserverStream(observerStream)

    // 3. Streaming render state.
    // Plan 28 revision — interleaved segment model. Text and tool groups render
    // in chronological order, separated by `---` dividers so users see the
    // narrative: "bot said X → called tool Y → said Z". Consecutive tools merge
    // into one group; consecutive text deltas append to the same text segment.
    type ToolItem = { id: string; name: string; status: 'running' | 'done' | 'error' }
    type Segment = { type: 'text'; content: string } | { type: 'tools'; items: ToolItem[] }
    const segments: Segment[] = []
    const toolIndex = new Map<string, { groupIdx: number; itemIdx: number }>()

    const appendText = (delta: string): void => {
      if (!delta) return
      const last = segments[segments.length - 1]
      if (last && last.type === 'text') last.content += delta
      else segments.push({ type: 'text', content: delta })
    }

    const pushTool = (id: string, name: string): void => {
      if (toolIndex.has(id)) return
      const last = segments[segments.length - 1]
      if (last && last.type === 'tools') {
        last.items.push({ id, name, status: 'running' })
        toolIndex.set(id, { groupIdx: segments.length - 1, itemIdx: last.items.length - 1 })
      } else {
        segments.push({ type: 'tools', items: [{ id, name, status: 'running' }] })
        toolIndex.set(id, { groupIdx: segments.length - 1, itemIdx: 0 })
      }
    }

    const updateToolStatus = (id: string | undefined, status: 'done' | 'error'): void => {
      const pos = id ? toolIndex.get(id) : undefined
      if (pos) {
        const group = segments[pos.groupIdx]
        if (group?.type === 'tools') {
          const item = group.items[pos.itemIdx]
          if (item) item.status = status
        }
        return
      }
      // Fallback — flip the newest still-running tool anywhere in segments.
      for (let i = segments.length - 1; i >= 0; i--) {
        const s = segments[i]
        if (s?.type !== 'tools') continue
        for (let j = s.items.length - 1; j >= 0; j--) {
          if (s.items[j]!.status === 'running') { s.items[j]!.status = status; return }
        }
      }
    }

    const iconFor = (s: 'running' | 'done' | 'error'): string =>
      s === 'done' ? '[☑️]' : s === 'error' ? '[❌]' : '[🔧]'

    const allTools = (): ToolItem[] => {
      const out: ToolItem[] = []
      for (const seg of segments) if (seg.type === 'tools') out.push(...seg.items)
      return out
    }

    let usageInput = 0
    let usageOutput = 0
    let providerId: string | null = null
    let modelId: string | null = null
    let runSnapshot: { system_prompt?: string; messages?: unknown[]; response?: string; tools?: string[]; adapter?: string } | null = null

    const DEBOUNCE_MS = 700
    let editChain: Promise<void> = Promise.resolve()
    let pendingTimer: NodeJS.Timeout | null = null
    let finalizing = false

    const renderInterim = (): string => {
      if (segments.length === 0) return '⌛'
      const parts = segments.map(seg => {
        if (seg.type === 'text') return seg.content
        return seg.items.map(t => `${iconFor(t.status)} ${t.name}`).join('\n')
      })
      return parts.join('\n---\n')
    }

    const overflow = (): boolean => renderInterim().length > TELEGRAM_MAX_LENGTH - 200

    const flushEdit = () => {
      pendingTimer = null
      if (finalizing) return
      editChain = editChain.then(async () => {
        if (finalizing) return
        if (overflow()) {
          // Finalize what we have; open a fresh placeholder for continuation.
          const finalPart = renderInterim()
          await this.bot!.api.editMessageText(chatId, currentMsgId, finalPart).catch(() => {})
          try {
            const sent = await withTelegramRetry(
              () => this.bot!.api.sendMessage(chatId, '⌛', replyTarget as any),
              'telegram:stream:continuation',
            )
            currentMsgId = sent.message_id
          } catch { return }
          segments.length = 0
          toolIndex.clear()
        }
        const text = renderInterim()
        try {
          await this.bot!.api.editMessageText(chatId, currentMsgId, text)
        } catch {
          // Swallow — transient rate-limit / no-change. Next tick retries.
        }
      })
    }

    const scheduleEdit = () => {
      if (pendingTimer || finalizing) return
      pendingTimer = setTimeout(flushEdit, DEBOUNCE_MS)
    }

    // 4. Consume stream.
    const reader = selfStream.getReader()
    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        const v = value as {
          type: string
          delta?: string
          textDelta?: string
          data?: { input_tokens?: number; output_tokens?: number; provider_id?: string; model_id?: string; system_prompt?: string; messages?: unknown[]; response?: string; tools?: string[]; adapter?: string }
          toolCallId?: string
          toolName?: string
        }

        if (v.type === 'text-delta' || v.type === 'text' || v.type === 'text-start') {
          const delta = v.delta ?? v.textDelta ?? ''
          appendText(delta)
          if (delta) scheduleEdit()
        } else if (
          v.type === 'tool-call' ||
          v.type === 'tool-input-start' ||
          v.type === 'tool-input-available' ||
          v.type === 'data-jiku-tool-start'
        ) {
          const id = v.toolCallId ?? `tool-${toolIndex.size}`
          const name = v.toolName ?? (v.data as { tool_id?: string } | undefined)?.tool_id ?? 'tool'
          pushTool(id, name)
          scheduleEdit()
        } else if (
          v.type === 'tool-result' ||
          v.type === 'tool-output-available' ||
          v.type === 'data-jiku-tool-end'
        ) {
          updateToolStatus(v.toolCallId ?? (v.data as { tool_call_id?: string } | undefined)?.tool_call_id, 'done')
          scheduleEdit()
        } else if (v.type === 'tool-error' || v.type === 'data-jiku-tool-error') {
          updateToolStatus(v.toolCallId, 'error')
          scheduleEdit()
        } else if (v.type === 'data-jiku-usage') {
          usageInput = v.data?.input_tokens ?? 0
          usageOutput = v.data?.output_tokens ?? 0
        } else if (v.type === 'data-jiku-meta') {
          providerId = v.data?.provider_id ?? providerId
          modelId = v.data?.model_id ?? modelId
        } else if (v.type === 'data-jiku-run-snapshot') {
          runSnapshot = v.data as NonNullable<typeof runSnapshot>
        }
      }
    } finally {
      reader.releaseLock()
      observer.done()
    }

    // 5. Final edit — wait for any pending debounced edit, then do the clean
    // MarkdownV2 render.
    finalizing = true
    if (pendingTimer) { clearTimeout(pendingTimer); pendingTimer = null }
    await editChain

    // Assemble final text: empty → "(no response)"; else render segments with
    // MarkdownV2, italic-wrap tool lines, escaped `---` separators between
    // segments.
    const hasContent = segments.some(s => (s.type === 'text' && s.content.trim() !== '') || (s.type === 'tools' && s.items.length > 0))
    const escapeMdV2 = (s: string): string => s.replace(/([_*\[\]()~`>#+\-=|{}.!\\])/g, '\\$1')
    const finalBody = hasContent
      ? segments.map(seg => {
          if (seg.type === 'text') return telegramifyMarkdown(seg.content, 'escape')
          // Italic tool lines — _[icon] name_ (MarkdownV2). Tool names often have
          // underscores so escape them before wrapping.
          return seg.items
            .map(t => `_${escapeMdV2(iconFor(t.status))} ${escapeMdV2(t.name)}_`)
            .join('\n')
        }).join('\n\\-\\-\\-\n')
      : escapeMdV2('(no response)')

    // "message is not modified" means the interim edit already landed the exact
    // same content — that's a success condition, not a failure. Happens when a
    // response has no MarkdownV2-escapable characters (so escaped === plain) and
    // the last debounced edit already rendered the full text.
    const isNotModifiedError = (err: unknown): boolean => {
      const desc = (err as { description?: string; error_code?: number } | null)?.description ?? ''
      return desc.includes('message is not modified')
    }

    try {
      await withTelegramRetry(
        () => this.bot!.api.editMessageText(chatId, currentMsgId, finalBody, { parse_mode: 'MarkdownV2' }),
        'telegram:stream:final',
      )
    } catch (err) {
      if (isNotModifiedError(err)) {
        // No-op success — content already on screen. Move on.
      } else {
        console.warn('[telegram] stream final edit (markdown) failed, falling back to plain:', err)
        // Plain fallback: render interim form (no markdown, plain `---`).
        await this.bot!.api.editMessageText(chatId, currentMsgId, renderInterim()).catch(plainErr => {
          if (!isNotModifiedError(plainErr)) {
            console.warn('[telegram] stream final plain fallback also failed:', plainErr)
          }
        })
      }
    }

    // 6. Log outbound + record usage.
    const sendResult: ConnectorSendResult = {
      success: true,
      ref_keys: { message_id: String(currentMsgId), chat_id: chatId },
      raw_payload: { streamed: true, message_id: currentMsgId },
    }
    // Snapshot for outbound log / usage — use the plain interim form for
    // `content_snapshot` so DB rows stay human-readable without MarkdownV2 escapes.
    const plainSnapshot = renderInterim()
    await ctx.logOutboundMessage({
      ref_keys: sendResult.ref_keys!,
      content_snapshot: plainSnapshot,
      raw_payload: sendResult,
      status: 'sent',
    }).catch(() => null)
    await ctx.logOutboundEvent({
      event_type: 'send_message',
      ref_keys: sendResult.ref_keys!,
      payload: { text: plainSnapshot, markdown: true, source: 'resolved_event_stream', tools: allTools().map(s => ({ name: s.name, status: s.status })) },
      raw_payload: sendResult,
      status: 'routed',
    }).catch(() => null)

    if (usageInput > 0 || usageOutput > 0) {
      ctx.recordUsage({
        input_tokens: usageInput,
        output_tokens: usageOutput,
        provider: providerId,
        model: modelId,
        raw_system_prompt: runSnapshot?.system_prompt ?? null,
        raw_messages: runSnapshot?.messages ?? null,
        raw_response: runSnapshot?.response ?? plainSnapshot,
        active_tools: runSnapshot?.tools ?? null,
        agent_adapter: runSnapshot?.adapter ?? null,
      })
    }
  }

  private async sendMessageInner(
    chatId: string,
    content: ConnectorContent,
    commonOpts: Record<string, unknown>,
  ): Promise<ConnectorSendResult> {
    try {
      // Media group (album)
      if (content.media_group?.length) {
        return await this.sendMediaGroup(chatId, content.media_group, commonOpts)
      }
      // Single media
      if (content.media) {
        return await this.sendSingleMedia(chatId, content.media, content.text, commonOpts)
      }

      // Text
      const rawText = content.text ?? ''

      // Mutual exclusion: Telegram Bot API doesn't allow `parse_mode` and
      // `entities` in the same request. When the agent supplies `params.entities`
      // explicitly (needed for custom_emoji / text_mention which markdown can't
      // express), we bypass the markdown escaping path entirely. The
      // user-provided entities take precedence.
      const hasExplicitEntities = Array.isArray((commonOpts as { entities?: unknown }).entities)
      const useMarkdown = content.markdown === true && !hasExplicitEntities

      // Plan 22 revision — typing simulation: send placeholder, reveal progressively
      // by editing every ~3s. Only for single-message text (skip when text overflows
      // Telegram's 4000-char limit — falls back to chunked send below).
      if (content.simulate_typing && rawText.length > 0 && rawText.length <= TELEGRAM_MAX_LENGTH) {
        return await this.sendWithTypingSimulation(chatId, rawText, useMarkdown, commonOpts)
      }

      const text = useMarkdown ? telegramifyMarkdown(rawText, 'escape') : rawText
      const chunks = splitMessage(text)
      let lastSent: { message_id: number; chat: { id: number } } | null = null

      for (let i = 0; i < chunks.length; i++) {
        const opts: Record<string, unknown> = { ...commonOpts }
        if (useMarkdown) opts.parse_mode = 'MarkdownV2'
        // When entities is supplied, it only applies to the first chunk (offset
        // base is the start of the message). Subsequent chunks send raw.
        if (i > 0) {
          delete (opts as any).reply_parameters
          delete (opts as any).entities
        }
        lastSent = await withTelegramRetry(
          () => this.bot!.api.sendMessage(chatId, chunks[i] || '-', opts as any),
          'telegram:sendMessage',
        )
      }

      return {
        success: true,
        ref_keys: { message_id: String(lastSent!.message_id), chat_id: String(lastSent!.chat.id) },
        raw_payload: lastSent,
      }
    } catch (err) {
      // Diagnostic envelope so agents (and the operator inspecting tool output)
      // can see EXACTLY what was about to hit Telegram. "chat not found" with
      // chat_id X usually means the bot configured here isn't a member of
      // chat X — verify with `getMe` against the bot's token, then check
      // membership in the Telegram client.
      const errStr = String(err)
      let botUsername: string | null = null
      try {
        const me = await this.bot!.api.getMe()
        botUsername = me.username ?? `id_${me.id}`
      } catch { /* best-effort */ }
      return {
        success: false,
        error: errStr,
        raw_payload: {
          error: errStr,
          debug: {
            method: 'sendMessage',
            chat_id: chatId,
            opts_sent: commonOpts,
            text_length: (content.text ?? '').length,
            had_media: !!content.media || !!content.media_group,
            bot_username: botUsername,
            hint: errStr.includes('chat not found')
              ? `Telegram returned "chat not found". Verify the BOT (@${botUsername ?? 'unknown'}) is a member/admin of chat_id=${chatId}. Run \`curl https://api.telegram.org/bot<THIS_BOT_TOKEN>/getChat?chat_id=${chatId}\` with the SAME token configured in this connector — if that succeeds while sendMessage fails, bot is NOT admin OR has no post permission. If it also returns "chat not found", the bot was never added to the chat (or was kicked).`
              : undefined,
          },
        },
      }
    }
  }

  /**
   * Plan 22 revision — simulate typing by progressive reveal of full text.
   * Send "⌛" placeholder, then edit every ~3s with a longer slice until full.
   * Loading indicator (`\n\n⚪`) appended on each interim edit; final edit is clean.
   */
  private async sendWithTypingSimulation(
    chatId: string,
    fullText: string,
    markdown: boolean,
    commonOpts: Record<string, unknown>,
  ): Promise<ConnectorSendResult> {
    const TICK_MS = 2000
    const sent = await withTelegramRetry(
      () => this.bot!.api.sendMessage(chatId, '⌛', commonOpts as any),
      'telegram:simulate_typing:placeholder',
    )
    const messageId = sent.message_id

    // Reveal in 3 progressive slices (start, mid, full). Tweak: split by sentence-ish
    // boundaries (newlines / periods) so the reveal feels natural rather than mid-word.
    const sliceAt = (fraction: number): number => {
      const target = Math.max(1, Math.floor(fullText.length * fraction))
      // Look for a sentence/word boundary near the target
      const window = fullText.slice(0, Math.min(target + 60, fullText.length))
      const lastBreak = Math.max(
        window.lastIndexOf('\n'),
        window.lastIndexOf('. '),
        window.lastIndexOf(', '),
        window.lastIndexOf(' '),
      )
      return lastBreak > target * 0.6 ? lastBreak + 1 : target
    }

    const stops = [sliceAt(0.33), sliceAt(0.66)].filter(s => s > 0 && s < fullText.length)

    for (const stop of stops) {
      await new Promise<void>(r => setTimeout(r, TICK_MS))
      const partial = fullText.slice(0, stop)
      try {
        await this.bot!.api.editMessageText(chatId, messageId, `${partial}\n\n⚪`)
      } catch { /* swallow rate-limit / parse errors */ }
    }

    // Final: clean text with markdown if requested
    await new Promise<void>(r => setTimeout(r, TICK_MS))
    const finalText = markdown ? telegramifyMarkdown(fullText, 'escape') : fullText
    try {
      await withTelegramRetry(
        () => this.bot!.api.editMessageText(chatId, messageId, finalText, {
          parse_mode: markdown ? 'MarkdownV2' : undefined,
        }),
        'telegram:simulate_typing:final',
      )
    } catch (err) {
      // Final edit failed after retry — fall back to plain text so the user still sees the message.
      console.warn('[telegram] simulate_typing final edit failed, falling back to plain:', err)
      await withTelegramRetry(
        () => this.bot!.api.editMessageText(chatId, messageId, fullText),
        'telegram:simulate_typing:fallback',
      ).catch(() => {})
    }

    return {
      success: true,
      ref_keys: { message_id: String(messageId), chat_id: String(sent.chat.id) },
    }
  }

  /** Send multiple media items as a Telegram album. Max 10. Documents split from photo/video. */
  private async sendMediaGroup(
    chatId: string,
    items: ConnectorMediaItem[],
    commonOpts: Record<string, unknown>,
  ): Promise<ConnectorSendResult> {
    const { InputFile } = await import('grammy')
    const capped = items.slice(0, 10)

    const resolveMedia = (item: ConnectorMediaItem, idx: number) => {
      return item.url ? item.url : new InputFile(item.data!, item.name ?? `file_${idx}`)
    }

    const buildInputMedia = (item: ConnectorMediaItem, idx: number) => {
      const media = resolveMedia(item, idx)
      const rawCaption = idx === 0 ? item.caption : undefined
      const caption = rawCaption && item.caption_markdown
        ? telegramifyMarkdown(rawCaption, 'escape')
        : rawCaption
      const parse_mode = rawCaption && item.caption_markdown ? ('MarkdownV2' as const) : undefined

      if (item.type === 'image') return { type: 'photo' as const, media, caption, parse_mode }
      if (item.type === 'video') return { type: 'video' as const, media, caption, parse_mode }
      return { type: 'document' as const, media, caption, parse_mode }
    }

    const inputMedia = capped.map((item, idx) => buildInputMedia(item, idx))
    const hasPhotoOrVideo = inputMedia.some(m => m.type === 'photo' || m.type === 'video')
    const hasDocument = inputMedia.some(m => m.type === 'document')

    if (hasPhotoOrVideo && hasDocument) {
      const pvItems = inputMedia.filter(m => m.type !== 'document')
      const docOriginals = capped.filter(item => item.type === 'document')

      let firstRef: ConnectorSendResult | null = null
      if (pvItems.length > 0) {
        const sent = await this.bot!.api.sendMediaGroup(chatId, pvItems as any, commonOpts as any)
        firstRef = {
          success: true,
          ref_keys: { message_id: String(sent[0]!.message_id), chat_id: chatId },
        }
      }
      for (const docItem of docOriginals) {
        const res = await this.sendSingleMedia(chatId, docItem, undefined, commonOpts)
        if (!firstRef) firstRef = res
      }
      return firstRef ?? { success: false, error: 'No items sent' }
    }

    const sent = await this.bot!.api.sendMediaGroup(chatId, inputMedia as any, commonOpts as any)
    return {
      success: true,
      ref_keys: { message_id: String(sent[0]!.message_id), chat_id: chatId },
    }
  }

  /** Send a single media item (photo, document, voice, video). */
  private async sendSingleMedia(
    chatId: string,
    item: ConnectorMediaItem,
    fallbackCaption: string | undefined,
    commonOpts: Record<string, unknown>,
  ): Promise<ConnectorSendResult> {
    const { InputFile } = await import('grammy')
    const rawCaption = item.caption ?? fallbackCaption
    const caption = rawCaption && item.caption_markdown
      ? telegramifyMarkdown(rawCaption, 'escape')
      : rawCaption
    const parse_mode = rawCaption && item.caption_markdown ? ('MarkdownV2' as const) : undefined

    const media = item.url ? item.url : new InputFile(item.data!, item.name ?? 'file')
    const opts: Record<string, unknown> = { ...commonOpts }
    if (caption) opts.caption = caption
    if (parse_mode) opts.parse_mode = parse_mode

    if (item.type === 'image') {
      const sent = await this.bot!.api.sendPhoto(chatId, media as any, opts as any)
      return { success: true, ref_keys: { message_id: String(sent.message_id), chat_id: String(sent.chat.id) } }
    }
    if (item.type === 'voice') {
      const sent = await this.bot!.api.sendVoice(chatId, media as any, opts as any)
      return { success: true, ref_keys: { message_id: String(sent.message_id), chat_id: String(sent.chat.id) } }
    }
    if (item.type === 'video') {
      const sent = await this.bot!.api.sendVideo(chatId, media as any, opts as any)
      return { success: true, ref_keys: { message_id: String(sent.message_id), chat_id: String(sent.chat.id) } }
    }
    const sent = await this.bot!.api.sendDocument(chatId, media as any, opts as any)
    return { success: true, ref_keys: { message_id: String(sent.message_id), chat_id: String(sent.chat.id) } }
  }

  override async sendReaction(target: ConnectorTarget, emoji: string): Promise<void> {
    if (!this.bot) return
    const chatId = target.ref_keys['chat_id']
    const messageId = target.ref_keys['message_id']
    if (!chatId || !messageId) return
    await this.bot.api.setMessageReaction(chatId, Number(messageId), [{ type: 'emoji', emoji: emoji as any }])
      .catch((err: unknown) => console.warn('[telegram] sendReaction error:', err))
  }

  override async deleteMessage(target: ConnectorTarget): Promise<void> {
    if (!this.bot) return
    const chatId = target.ref_keys['chat_id']
    const messageId = target.ref_keys['message_id']
    if (!chatId || !messageId) return
    await this.bot.api.deleteMessage(chatId, Number(messageId))
      .catch((err: unknown) => console.warn('[telegram] deleteMessage error:', err))
  }

  override async editMessage(target: ConnectorTarget, content: ConnectorContent): Promise<void> {
    if (!this.bot) return
    const chatId = target.ref_keys['chat_id']
    const messageId = target.ref_keys['message_id']
    if (!chatId || !messageId) return
    const rawText = content.text ?? ''
    const text = content.markdown ? telegramifyMarkdown(rawText, 'escape') : rawText
    await this.bot.api.editMessageText(chatId, Number(messageId), text || '⋯', {
      parse_mode: content.markdown ? 'MarkdownV2' : undefined,
    })
      .catch((err: unknown) => console.warn('[telegram] editMessage error:', err))
  }

  override async sendTyping(target: ConnectorTarget): Promise<void> {
    if (!this.bot) return
    const chatId = target.ref_keys['chat_id']
    if (!chatId) return
    await this.bot.api.sendChatAction(chatId, 'typing')
      .catch((err: unknown) => console.warn('[telegram] sendTyping error:', err))
  }
}

export const telegramBotAdapter = new TelegramBotAdapter()
/** @deprecated Use `telegramBotAdapter`. Kept as alias for backward-compat. */
export const telegramAdapter = telegramBotAdapter

// ─── Plan 24 Phase 3 — TelegramUserAdapter (MTProto via @mtcute/bun) ──────────
//
// Userbot connector. Real-account session — Telegram is sensitive to automation
// patterns on user accounts; queue management (Phase 5) is mandatory before
// shipping at scale. Phase 3 = MVP: setup wizard works, can connect, can send
// + forward (drop_author) + read history. Phase 4 adds action parity. Phase 5
// adds queue management + flood-wait handling.

// `unknown` typing for the mtcute client because the plugin file would need
// every mtcute type imported just to satisfy TS. Lazy-imported below.
type MtcuteClient = {
  start: (opts: { phone: () => Promise<string>; code: () => Promise<string>; password: () => Promise<string> }) => Promise<unknown>
  sendCode: (opts: { phone: string }) => Promise<{ phoneCodeHash: string }>
  signIn: (opts: { phone: string; phoneCodeHash: string; phoneCode: string }) => Promise<unknown>
  checkPassword: (password: string) => Promise<unknown>
  exportSession: () => Promise<string>
  getMe: () => Promise<{ id: number | bigint; username?: string | null; isPremium?: boolean; firstName?: string }>
  connect: () => Promise<void>
  disconnect: () => Promise<void>
  close?: () => Promise<void>
  on: (event: string, handler: (msg: unknown) => void) => void
  sendText: (peer: string | number | bigint, text: string, opts?: Record<string, unknown>) => Promise<unknown>
  forwardMessages: (opts: { fromChatId: string | number | bigint; messages: number[]; toChatId: string | number | bigint; forwardSenders?: boolean; noForwardHeader?: boolean }) => Promise<unknown>
  getHistory: (peer: string | number | bigint, opts?: { limit?: number; offsetId?: number }) => Promise<Array<Record<string, unknown>>>
}

class TelegramUserAdapter extends ConnectorAdapter {
  readonly id = 'jiku.telegram.user'
  readonly displayName = 'Telegram User (Self-Bot)'
  readonly credentialAdapterId = 'telegram-user'
  override readonly credentialDisplayName = 'Telegram User (Self-Bot)'
  readonly refKeys = ['message_id', 'chat_id', 'thread_id', 'user_id']
  readonly supportedEvents = ['message', 'reaction', 'unreaction', 'edit', 'delete'] as const

  override readonly requiresInteractiveSetup = true

  override readonly credentialSchema = z.object({
    api_id: z.string().min(1).describe('API ID from my.telegram.org'),
    api_hash: z.string().min(1).describe('secret|API Hash from my.telegram.org'),
    phone_number: z.string().min(1).describe('Phone number with country code, e.g. +628123456789'),
    session_string: z.string().optional().describe('secret|Session (auto-generated by Setup wizard, do not edit)'),
    user_id: z.string().optional().describe('Logged-in user ID (auto)'),
    username: z.string().optional().describe('Username (auto)'),
    is_premium: z.string().optional().describe('Premium account (auto)'),
  })

  /**
   * Per-wizard mtcute clients. Keyed by `setup_session_id`. Each entry is the
   * client we stood up for `request_code` and re-use across `verify_code` /
   * `verify_password`. Cleared on completion or wizard cancel.
   *
   * NOT used at runtime — the runtime client lives in `this.client` and is
   * scoped to one credential.
   */
  private setupClients = new Map<string, MtcuteClient>()

  // Runtime state (set in onActivate / cleared in onDeactivate).
  private client: MtcuteClient | null = null
  private projectId: string | null = null
  private connectorId: string | null = null
  private myUserId: string | null = null
  /**
   * Plan 24 Phase 5 — All outbound API calls go through this queue. NOT
   * bypassable. Reduces chance of Telegram banning the user account due to
   * automation patterns. See `userbot-queue.ts` for the policy.
   */
  private queue = new UserbotQueue()

  override getSetupSpec() {
    return {
      title: 'Telegram User Account Setup',
      intro: 'You will receive a one-time code on your Telegram app. If you have 2FA enabled, the wizard will ask for your password after the code.',
      steps: [
        {
          id: 'request_code',
          title: 'Send verification code',
          description: 'Telegram will send a one-time code to your phone (via SMS or the Telegram app).',
          inputs: [],
        },
        {
          id: 'verify_code',
          title: 'Enter verification code',
          description: 'Enter the code Telegram just sent to your account.',
          inputs: [
            { name: 'code', type: 'string' as const, required: true, secret: false, label: 'OTP code', placeholder: '12345' },
          ],
        },
        {
          id: 'verify_password',
          title: 'Enter 2FA password',
          description: 'Your account has two-factor authentication enabled.',
          conditional: true,
          inputs: [
            { name: 'password', type: 'string' as const, required: true, secret: true, label: '2FA password' },
          ],
        },
      ],
    }
  }

  override async runSetupStep(stepId: string, input: Record<string, unknown>, state: ConnectorSetupSessionState): Promise<ConnectorSetupStepResult> {
    const fields = state.credential_fields ?? {}
    const apiIdRaw = fields['api_id']
    const apiHash = fields['api_hash']
    const phone = fields['phone_number']
    if (!apiIdRaw || !apiHash || !phone) {
      return { ok: false, error: 'Missing api_id, api_hash, or phone_number on the credential. Save those fields first, then re-run setup.' }
    }
    const apiId = Number(apiIdRaw)
    if (!Number.isFinite(apiId)) {
      return { ok: false, error: 'api_id must be numeric. Get it from my.telegram.org → API Development.' }
    }

    if (stepId === 'request_code') {
      try {
        const { TelegramClient } = await import('@mtcute/bun') as { TelegramClient: new (opts: { apiId: number; apiHash: string; storage?: string }) => MtcuteClient }
        const client = new TelegramClient({ apiId, apiHash })
        await client.connect()
        const sent = await client.sendCode({ phone })
        // Stash phone_code_hash + client until the user enters the code.
        state.scratch['phone_code_hash'] = sent.phoneCodeHash
        this.setupClients.set(state.session_id, client)
        return { ok: true, next_step: 'verify_code', ui_message: 'Code sent. Check your Telegram app or SMS.' }
      } catch (err) {
        return {
          ok: false,
          error: err instanceof Error ? err.message : String(err),
          hint: 'Verify api_id, api_hash, and phone_number are correct. Phone needs country code (e.g. +628123…).',
        }
      }
    }

    if (stepId === 'verify_code') {
      const client = this.setupClients.get(state.session_id)
      if (!client) {
        return { ok: false, error: 'Setup session expired or `request_code` was never run. Start over from step 1.' }
      }
      const code = String(input['code'] ?? '').trim()
      if (!code) return { ok: false, error: 'OTP code is required.', retry_step: 'verify_code' }
      const phoneCodeHash = String(state.scratch['phone_code_hash'] ?? '')
      try {
        await client.signIn({ phone, phoneCodeHash, phoneCode: code })
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        if (msg.includes('SESSION_PASSWORD_NEEDED')) {
          return { ok: true, next_step: 'verify_password', ui_message: '2FA enabled. Enter your password.' }
        }
        if (msg.includes('PHONE_CODE_INVALID') || msg.includes('PHONE_CODE_EXPIRED')) {
          return { ok: false, error: msg, hint: 'OTP code wrong or expired. Re-check the code and try again.', retry_step: 'verify_code' }
        }
        return { ok: false, error: msg }
      }
      return this.finalizeLogin(client, state)
    }

    if (stepId === 'verify_password') {
      const client = this.setupClients.get(state.session_id)
      if (!client) {
        return { ok: false, error: 'Setup session expired. Start over.' }
      }
      const password = String(input['password'] ?? '')
      if (!password) return { ok: false, error: '2FA password is required.', retry_step: 'verify_password' }
      try {
        await client.checkPassword(password)
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        if (msg.includes('PASSWORD_HASH_INVALID')) {
          return { ok: false, error: msg, hint: 'Wrong 2FA password. Try again.', retry_step: 'verify_password' }
        }
        return { ok: false, error: msg }
      }
      return this.finalizeLogin(client, state)
    }

    return { ok: false, error: `Unknown step: ${stepId}` }
  }

  private async finalizeLogin(client: MtcuteClient, state: ConnectorSetupSessionState): Promise<ConnectorSetupStepResult> {
    try {
      const me = await client.getMe()
      const session = await client.exportSession()
      try { await client.disconnect() } catch { /* best-effort */ }
      this.setupClients.delete(state.session_id)
      return {
        ok: true,
        complete: true,
        fields: {
          session_string: session,
          user_id: String(me.id),
          username: me.username ?? '',
          is_premium: me.isPremium ? 'true' : 'false',
        },
        ui_message: `Logged in as @${me.username ?? me.id} (${me.isPremium ? 'Premium' : 'Free'}). Setup complete — credential is now ready to activate.`,
      }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  }

  // ─── Runtime ──────────────────────────────────────────────────────────────

  override async onActivate(ctx: ConnectorContext): Promise<void> {
    const session = ctx.fields['session_string']
    const apiIdRaw = ctx.fields['api_id']
    const apiHash = ctx.fields['api_hash']
    if (!session) {
      throw new Error('No session_string on the credential. Run the interactive Setup wizard first.')
    }
    if (!apiIdRaw || !apiHash) throw new Error('Missing api_id / api_hash on the credential.')
    const apiId = Number(apiIdRaw)
    if (!Number.isFinite(apiId)) throw new Error('api_id must be numeric.')

    const { TelegramClient } = await import('@mtcute/bun') as { TelegramClient: new (opts: { apiId: number; apiHash: string; sessionString?: string }) => MtcuteClient }
    this.client = new TelegramClient({ apiId, apiHash, sessionString: session })
    this.projectId = ctx.projectId
    this.connectorId = ctx.connectorId

    // Apply per-credential queue_policy override if present.
    const policyRaw = ctx.fields['queue_policy']
    if (policyRaw) {
      try {
        const parsed = JSON.parse(policyRaw) as Partial<UserbotQueuePolicy>
        this.queue.setPolicy(parsed)
      } catch { /* ignore — keep defaults */ }
    }
    // Wire queue events to console + future audit hookup.
    this.queue.onEvent((event) => {
      console.log(`[telegram.user] queue event:`, event)
    })

    try {
      await this.client.connect()
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      if (msg.includes('AUTH_KEY_UNREGISTERED') || msg.includes('AUTH_KEY_DUPLICATED')) {
        this.queue.markSessionExpired()
        // Surface a clear "session expired" so the credential UI prompts re-setup.
        throw new Error(`SESSION_EXPIRED: ${msg} — re-run the Setup wizard.`)
      }
      throw err
    }

    try {
      const me = await this.client.getMe()
      this.myUserId = String(me.id)
      this.myUsername = me.username ?? null
      this.myIsPremium = me.isPremium === true
    } catch { /* non-fatal */ }

    // Inbound — wire 'new_message' to ConnectorEvent shape.
    this.client.on('new_message', (raw) => {
      try {
        const event = this.normalizeInbound(raw)
        if (event) ctx.onEvent(event).catch(err => console.warn('[telegram.user] onEvent error:', err))
      } catch (err) {
        console.warn('[telegram.user] inbound normalize error:', err)
      }
    })

    console.log(`[telegram.user] activated — logged in as user_id=${this.myUserId}`)
  }

  override async onDeactivate(): Promise<void> {
    if (this.client) {
      try { await this.client.disconnect() } catch { /* best-effort */ }
      try { if (this.client.close) await this.client.close() } catch { /* best-effort */ }
    }
    this.client = null
    this.projectId = null
    this.connectorId = null
    this.myUserId = null
  }

  private myUsername: string | null = null
  private myIsPremium: boolean = false

  override getIdentity() {
    if (!this.myUserId && !this.myUsername) return null
    return {
      name: this.myUsername ?? `user:${this.myUserId}`,
      username: this.myUsername ? `@${this.myUsername}` : null,
      user_id: this.myUserId,
      metadata: { kind: 'userbot', is_premium: this.myIsPremium },
    }
  }

  override parseEvent(): ConnectorEvent | null {
    // Inbound events come through `client.on('new_message')` in onActivate
    // (push model, not pull). External webhook adapters use parseEvent; userbot
    // doesn't have one.
    return null
  }

  /**
   * Map an mtcute incoming message into the canonical ConnectorEvent shape.
   * This is best-effort — mtcute's wrapped Message has many fields; we pull
   * the ones the Jiku event-router cares about.
   */
  private normalizeInbound(raw: unknown): ConnectorEvent | null {
    const m = raw as Record<string, unknown> & {
      id?: number
      chat?: { id?: number | bigint; chatType?: string; title?: string; username?: string }
      sender?: { id?: number | bigint; isBot?: boolean; username?: string; firstName?: string }
      text?: string
      date?: Date | number
    }
    if (!m || typeof m !== 'object' || !m.id || !m.chat) return null
    const chatId = String(m.chat.id ?? '')
    if (!chatId) return null
    // Skip our own outbound — userbot also receives its own sent messages.
    if (m.sender && this.myUserId && String(m.sender.id ?? '') === this.myUserId) return null

    const isGroup = m.chat.chatType === 'group' || m.chat.chatType === 'supergroup' || m.chat.chatType === 'channel'
    const scopeKey = isGroup ? `group:${chatId}` : undefined

    return {
      type: 'message',
      connector_id: this.connectorId ?? '',
      ref_keys: { message_id: String(m.id), chat_id: chatId },
      scope_key: scopeKey,
      sender: {
        external_id: String(m.sender?.id ?? ''),
        display_name: m.sender?.firstName ?? m.sender?.username ?? undefined,
        username: m.sender?.username ?? undefined,
        is_bot: m.sender?.isBot === true,
      },
      content: { text: m.text ?? '', raw: m },
      metadata: {
        chat_title: m.chat.title,
        chat_type: m.chat.chatType,
      },
      raw_payload: m,
      timestamp: m.date instanceof Date ? m.date : new Date((Number(m.date ?? 0)) * 1000),
    }
  }

  override async sendMessage(target: ConnectorTarget, content: ConnectorContent): Promise<ConnectorSendResult> {
    if (!this.client) return { success: false, error: 'Userbot client not connected' }
    const chatId = target.ref_keys['chat_id']
    if (!chatId) return { success: false, error: 'Missing chat_id' }
    const text = content.text ?? ''
    if (!text) return { success: false, error: 'Empty text' }

    const finalText = content.markdown ? telegramifyMarkdown(text, 'escape') : text
    const opts: Record<string, unknown> = {}
    if (content.markdown) opts['parseMode'] = 'MarkdownV2'
    if (content.params) {
      for (const [k, v] of Object.entries(content.params)) {
        if (v === undefined || v === null) continue
        opts[k] = v
      }
    }
    const peer = chatId.startsWith('-') || /^\d+$/.test(chatId) ? Number(chatId) : chatId

    try {
      const queued = await this.queue.enqueue<{ id?: number; chat?: { id?: number | bigint } } | undefined>(
        { chatId },
        () => this.client!.sendText(peer, finalText, opts) as Promise<{ id?: number; chat?: { id?: number | bigint } } | undefined>,
        'send_message',
      )
      const res = queued.result
      return {
        success: true,
        ref_keys: {
          message_id: String(res?.id ?? ''),
          chat_id: String(res?.chat?.id ?? chatId),
        },
        raw_payload: { ...res, queue: { delay_ms_applied: queued.delay_ms_applied } },
      }
    } catch (err) {
      return mapQueueError(err)
    }
  }

  /**
   * Userbot-exclusive action: forward with `drop_author` (hide sender + preserve
   * Premium animated custom_emoji). Phase 4 will register this as a proper
   * `connector_run_action` entry; for now it's a method other code can call.
   */
  async forwardDropAuthor(opts: { from_chat_id: string | number; message_ids: number[]; to_chat_id: string | number }): Promise<ConnectorSendResult> {
    if (!this.client) return { success: false, error: 'Userbot client not connected' }
    try {
      const res = await this.client.forwardMessages({
        fromChatId: opts.from_chat_id,
        messages: opts.message_ids,
        toChatId: opts.to_chat_id,
        forwardSenders: false,
        noForwardHeader: true,
      })
      return { success: true, raw_payload: res }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      return { success: false, error: msg }
    }
  }

  /**
   * Userbot-exclusive: read full chat history past Bot API's 100-message cap.
   */
  async getChatHistory(peer: string | number, limit = 50, offsetId = 0): Promise<Array<Record<string, unknown>>> {
    if (!this.client) throw new Error('Userbot client not connected')
    return this.client.getHistory(peer, { limit, offsetId })
  }

  // ─── Plan 24 Phase 4 — Action registry ────────────────────────────────────

  override readonly actions: ConnectorAction[] = [
    {
      id: 'forward_message',
      name: 'Forward Message',
      description: 'Forward one or more messages from a source chat to a destination chat. With hide_sender:true (USERBOT-ONLY: works correctly), the "Forwarded from" header is suppressed AND animated Premium custom_emoji are preserved — Bot API copyMessage cannot do this.',
      params: {
        from_chat_id: { type: 'string', description: 'Source chat_id (where the messages came from)', required: true },
        to_chat_id: { type: 'string', description: 'Destination chat_id', required: true },
        message_ids: { type: 'string', description: 'Comma-separated message IDs to forward, e.g. "123,124,125"', required: true },
        hide_sender: { type: 'boolean', description: 'Hide the "Forwarded from" header AND preserve Premium custom_emoji animation. Default true on userbot.', required: false },
      },
    },
    {
      id: 'get_chat_history',
      name: 'Get Chat History',
      description: 'Read past N messages from a chat. Supports arbitrary offset (Bot API limited to ~100). USERBOT-ONLY.',
      params: {
        peer: { type: 'string', description: 'Chat ID, username, or invite link', required: true },
        limit: { type: 'number', description: 'Number of messages to fetch (default 50, max 200)', required: false },
        offset_id: { type: 'number', description: 'Start offset — fetch messages BEFORE this message_id (for pagination)', required: false },
      },
    },
    {
      id: 'join_chat',
      name: 'Join Chat',
      description: 'Join a Telegram chat by username or invite link. USERBOT-ONLY. Subject to per-action cooldown (max 10/hour) — over-use triggers Telegram spam flag.',
      params: {
        target: { type: 'string', description: 'Username (e.g. "@channel") or invite link (e.g. "https://t.me/+abc...")', required: true },
      },
    },
    {
      id: 'leave_chat',
      name: 'Leave Chat',
      description: 'Leave a chat. USERBOT-ONLY. Same cooldown as join_chat.',
      params: {
        chat_id: { type: 'string', description: 'Chat ID to leave', required: true },
      },
    },
    {
      id: 'get_dialogs',
      name: 'Get Dialogs',
      description: 'List all chats this account is currently in. USERBOT-ONLY.',
      params: {
        limit: { type: 'number', description: 'Max number of dialogs to return (default 30)', required: false },
      },
    },
    {
      id: 'set_typing',
      name: 'Set Typing',
      description: 'Show "typing…" indicator in a chat. USERBOT-ONLY (longer-running than Bot API).',
      params: {
        chat_id: { type: 'string', description: 'Chat to show typing in', required: true },
      },
    },
    {
      id: 'delete_message',
      name: 'Delete Message',
      description: 'Delete one or more messages by id. Shared with bot adapter.',
      params: {
        chat_id: { type: 'string', description: 'Chat ID', required: true },
        message_ids: { type: 'string', description: 'Comma-separated message IDs', required: true },
      },
    },
    {
      id: 'edit_message',
      name: 'Edit Message',
      description: 'Edit the text of a previously sent message.',
      params: {
        chat_id: { type: 'string', description: 'Chat ID', required: true },
        message_id: { type: 'string', description: 'Message ID', required: true },
        text: { type: 'string', description: 'New text', required: true },
        markdown: { type: 'boolean', description: 'Parse text as MarkdownV2', required: false },
      },
    },
  ]

  /** Snapshot of the userbot queue — surfaced to agents via `connector_get_queue_status`. */
  getQueueStatus() { return this.queue.status() }

  override async runAction(actionId: string, params: Record<string, unknown>): Promise<unknown> {
    if (!this.client) throw new Error('Userbot client not connected')
    const c = this.client as MtcuteClient & {
      // Optional methods used by Phase 4 actions. Lazy-typed because mtcute's
      // surface is large; unsupported method names will throw TypeError at
      // runtime which we wrap as a structured error.
      joinChat?: (target: string) => Promise<unknown>
      leaveChat?: (chatId: string | number | bigint) => Promise<unknown>
      getDialogs?: (opts?: { limit?: number }) => Promise<Array<Record<string, unknown>>>
      sendTyping?: (peer: string | number | bigint, status?: string) => Promise<unknown>
      deleteMessages?: (chatId: string | number | bigint, ids: number[]) => Promise<unknown>
      editMessage?: (opts: { chatId: string | number | bigint; message: number; text: string; parseMode?: string }) => Promise<unknown>
    }

    const peerOf = (raw: unknown): string | number => {
      const s = String(raw ?? '')
      if (!s) throw new Error('Missing peer / chat_id')
      return /^-?\d+$/.test(s) ? Number(s) : s
    }
    const idsOf = (raw: unknown): number[] => String(raw ?? '').split(',').map(s => Number(s.trim())).filter(n => Number.isFinite(n))

    // Phase 5 — every action goes through the queue. Scope is chat-level when
    // the action targets a specific chat, '_global' for session-wide ones.
    const enqueue = <T>(scope: { chatId: string | '_global' }, fn: () => Promise<T>) =>
      this.queue.enqueue(scope, fn, actionId)

    try {
      if (actionId === 'forward_message') {
        const hideSender = params['hide_sender'] !== false
        const queued = await enqueue({ chatId: String(params['from_chat_id']) }, () => c.forwardMessages({
          fromChatId: peerOf(params['from_chat_id']),
          messages: idsOf(params['message_ids']),
          toChatId: peerOf(params['to_chat_id']),
          forwardSenders: !hideSender,
          noForwardHeader: hideSender,
        }))
        return { success: true, hide_sender: hideSender, result: queued.result, delay_ms_applied: queued.delay_ms_applied }
      }

      if (actionId === 'get_chat_history') {
        const limit = Math.min(Number(params['limit'] ?? 50), 200)
        const offsetId = Number(params['offset_id'] ?? 0)
        const queued = await enqueue({ chatId: String(params['peer']) }, () => c.getHistory(peerOf(params['peer']), { limit, offsetId }))
        return { success: true, count: queued.result.length, messages: queued.result, delay_ms_applied: queued.delay_ms_applied }
      }

      if (actionId === 'join_chat') {
        if (!c.joinChat) return { success: false, error: 'mtcute client does not expose joinChat in this build' }
        const queued = await enqueue({ chatId: '_global' }, () => c.joinChat!(String(params['target'] ?? '')))
        return { success: true, result: queued.result, delay_ms_applied: queued.delay_ms_applied }
      }

      if (actionId === 'leave_chat') {
        if (!c.leaveChat) return { success: false, error: 'mtcute client does not expose leaveChat in this build' }
        const queued = await enqueue({ chatId: '_global' }, () => c.leaveChat!(peerOf(params['chat_id'])))
        return { success: true, result: queued.result, delay_ms_applied: queued.delay_ms_applied }
      }

      if (actionId === 'get_dialogs') {
        if (!c.getDialogs) return { success: false, error: 'mtcute client does not expose getDialogs in this build' }
        const limit = Math.min(Number(params['limit'] ?? 30), 200)
        const queued = await enqueue({ chatId: '_global' }, () => c.getDialogs!({ limit }))
        return { success: true, count: queued.result.length, dialogs: queued.result, delay_ms_applied: queued.delay_ms_applied }
      }

      if (actionId === 'set_typing') {
        if (!c.sendTyping) return { success: false, error: 'mtcute client does not expose sendTyping in this build' }
        const queued = await enqueue({ chatId: String(params['chat_id']) }, () => c.sendTyping!(peerOf(params['chat_id']), 'typing'))
        return { success: true, delay_ms_applied: queued.delay_ms_applied }
      }

      if (actionId === 'delete_message') {
        if (!c.deleteMessages) return { success: false, error: 'mtcute client does not expose deleteMessages in this build' }
        const queued = await enqueue({ chatId: String(params['chat_id']) }, () => c.deleteMessages!(peerOf(params['chat_id']), idsOf(params['message_ids'])))
        return { success: true, result: queued.result, delay_ms_applied: queued.delay_ms_applied }
      }

      if (actionId === 'edit_message') {
        if (!c.editMessage) return { success: false, error: 'mtcute client does not expose editMessage in this build' }
        const text = String(params['text'] ?? '')
        const useMd = params['markdown'] === true
        const finalText = useMd ? telegramifyMarkdown(text, 'escape') : text
        const queued = await enqueue({ chatId: String(params['chat_id']) }, () => c.editMessage!({
          chatId: peerOf(params['chat_id']),
          message: Number(params['message_id']),
          text: finalText,
          parseMode: useMd ? 'MarkdownV2' : undefined,
        }))
        return { success: true, result: queued.result, delay_ms_applied: queued.delay_ms_applied }
      }

      return { success: false, error: `Unknown action: ${actionId}` }
    } catch (err) {
      return mapQueueError(err)
    }
  }

  override async sendTyping(target: ConnectorTarget): Promise<void> {
    const chatId = target.ref_keys['chat_id']
    if (!chatId || !this.client) return
    const c = this.client as MtcuteClient & { sendTyping?: (peer: string | number | bigint, status?: string) => Promise<unknown> }
    if (c.sendTyping) {
      await c.sendTyping(/^-?\d+$/.test(chatId) ? Number(chatId) : chatId, 'typing').catch(() => {})
    }
  }
}

export const telegramUserAdapter = new TelegramUserAdapter()

/**
 * Map an error thrown by the userbot queue into a structured ConnectorSendResult /
 * action-result envelope. The queue throws errors with `code` annotations
 * (FLOOD_WAIT, PEER_FLOOD_LATCHED, SESSION_EXPIRED) — translate to fields agents
 * + the route layer can read without parsing strings.
 */
function mapQueueError(err: unknown): ConnectorSendResult & { code?: string; wait_seconds?: number; scope?: string } {
  const e = err as { code?: string; wait_seconds?: number; scope?: string; message?: string } | null
  const message = e?.message ?? (err instanceof Error ? err.message : String(err))
  if (e?.code === 'FLOOD_WAIT') {
    return { success: false, code: 'FLOOD_WAIT', wait_seconds: e.wait_seconds ?? 0, scope: e.scope ?? 'chat', error: message }
  }
  if (e?.code === 'PEER_FLOOD' || e?.code === 'PEER_FLOOD_LATCHED') {
    return { success: false, code: 'PEER_FLOOD', error: 'Session is spam-restricted by Telegram. Auto-send disabled until admin clears the latch.' }
  }
  if (e?.code === 'SESSION_EXPIRED') {
    return { success: false, code: 'SESSION_EXPIRED', error: 'Userbot session expired — re-run the Setup wizard on the credential.' }
  }
  return { success: false, error: message }
}

export default definePlugin({
  meta: {
    id: 'jiku.telegram',
    name: 'Telegram',
    version: '1.0.0',
    description: 'Telegram integration — connector adapter, bot polling via grammy, and more.',
    author: 'Jiku',
    icon: 'telegram',
    category: 'channel',
  },
  depends: [StudioPlugin],
  setup(ctx) {
    ctx.connector.register(telegramBotAdapter)
    ctx.connector.register(telegramUserAdapter)
  },
})
