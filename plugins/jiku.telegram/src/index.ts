import { z } from 'zod'
import { definePlugin, ConnectorAdapter } from '@jiku/kit'
import type {
  ConnectorAction, ConnectorEvent, ConnectorContext, ConnectorTarget, ConnectorContent,
  ConnectorSendResult, ConnectorMediaItem, ConnectorEventMedia,
} from '@jiku/types'
import telegramifyMarkdown from 'telegramify-markdown'
import { StudioPlugin } from '@jiku-plugin/studio'
import type { Bot } from 'grammy'
import { getFileByPath, getConnectorEventById, logConnectorEvent } from '@jiku-studio/db'

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

class TelegramAdapter extends ConnectorAdapter {
  readonly id = 'jiku.telegram'
  readonly displayName = 'Telegram'
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
      description: 'Forward a message from one chat to another',
      params: {
        from_chat_id: { type: 'string', description: 'Source chat ID', required: true },
        message_id: { type: 'string', description: 'Message ID to forward', required: true },
        to_chat_id: { type: 'string', description: 'Destination chat ID', required: true },
        thread_id: { type: 'string', description: 'Destination topic thread ID', required: false },
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
        const { from_chat_id, message_id, to_chat_id, thread_id } = params as {
          from_chat_id: string; message_id: string; to_chat_id: string; thread_id?: string
        }
        const opts: Record<string, unknown> = {}
        if (thread_id) opts.message_thread_id = Number(thread_id)
        const sent = await this.bot.api.forwardMessage(to_chat_id, from_chat_id, Number(message_id), opts as any)
        return { success: true, message_id: String(sent.message_id), chat_id: String(sent.chat.id) }
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
    this.bot = new Bot(token)

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
      // 429 too-early is normal if the bot was never polled yet — ignore.
      if (!String(err).includes('429')) {
        console.warn('[telegram] bot.api.close() before polling failed:', err)
      }
    }

    // Telegram's getUpdates omits `my_chat_member`, `channel_post`, and
    // `message_reaction` by default — must be explicitly opted in via
    // allowed_updates. Without this, my_chat_member handler never fires and
    // channel auto-registration silently does nothing.
    this.bot.start({
      drop_pending_updates: true,
      allowed_updates: [
        'message',
        'edited_message',
        'channel_post',
        'edited_channel_post',
        'my_chat_member',
        'chat_member',
        'message_reaction',
      ],
    }).catch((err: unknown) => {
      console.error('[telegram] polling error:', err)
    })

    console.log('[telegram] bot started (polling)')
  }

  async onDeactivate(): Promise<void> {
    if (this.bot) {
      await this.bot.stop().catch(() => {})
      this.bot = null
      this.projectId = null
      this.connectorId = null
      this.botUsername = null
      this.botUserId = null
      console.log('[telegram] bot stopped')
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

    return enqueueForChat(chatId, () => this.sendMessageInner(chatId!, content, commonOpts))
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

      // Plan 22 revision — typing simulation: send placeholder, reveal progressively
      // by editing every ~3s. Only for single-message text (skip when text overflows
      // Telegram's 4000-char limit — falls back to chunked send below).
      if (content.simulate_typing && rawText.length > 0 && rawText.length <= TELEGRAM_MAX_LENGTH) {
        return await this.sendWithTypingSimulation(chatId, rawText, content.markdown === true, commonOpts)
      }

      const text = content.markdown ? telegramifyMarkdown(rawText, 'escape') : rawText
      const chunks = splitMessage(text)
      let lastSent: { message_id: number; chat: { id: number } } | null = null

      for (let i = 0; i < chunks.length; i++) {
        const opts: Record<string, unknown> = { ...commonOpts }
        if (content.markdown) opts.parse_mode = 'MarkdownV2'
        if (i > 0) delete (opts as any).reply_parameters
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
      return { success: false, error: String(err), raw_payload: { error: String(err) } }
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

export const telegramAdapter = new TelegramAdapter()

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
    ctx.connector.register(telegramAdapter)
  },
})
