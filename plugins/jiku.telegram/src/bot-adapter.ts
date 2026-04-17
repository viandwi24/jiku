import { z } from 'zod'
import { ConnectorAdapter } from '@jiku/kit'
import type {
  ConnectorAction, ConnectorEvent, ConnectorContext, ConnectorTarget, ConnectorContent,
  ConnectorSendResult, ConnectorMediaItem, ResolvedEventContext,
} from '@jiku/types'
import telegramifyMarkdown from 'telegramify-markdown'
import { Bot, InputFile } from 'grammy'
import {
  getFileByPath,
  getConnectorEventById,
  logConnectorEvent,
  createConnectorTarget,
  getConnectorTargetByName,
  createBinding,
  getBindings,
  updateBinding,
} from '@jiku-studio/db'
import { getFilesystemService } from '../../../apps/studio/server/src/filesystem/service.ts'
import type { ConnectorEventMedia } from '@jiku/types'
import { TELEGRAM_MAX_LENGTH, REACTIVATE_WAIT_MS, MEDIA_GROUP_DEBOUNCE_MS } from './shared/constants.ts'
import { splitMessage, extractTelegramMedia, withTelegramRetry } from './shared/helpers.ts'
import { enqueueForChat, enqueueInboundEvent, lastDeactivateByConnector } from './shared/queues.ts'
import type { PluginConsoleAPI, PluginConsoleLogger } from '@jiku-plugin/studio'

/** Console id for a given Telegram bot connector instance. Shared shape
 *  `jiku.telegram.bot:connector:<uuid>` — UI panels key off this. */
export function botConsoleId(connectorId: string): string {
  return `jiku.telegram.bot:connector:${connectorId}`
}

/**
 * Non-blocking arrival log.
 *
 * Every inbound event MUST land in the DB the moment it arrives, regardless
 * of whether the router/agent ever gets to process it. Downstream handlers
 * UPDATE the status (`handled`, `dropped`, …); this only INSERTs with
 * `status='received'`. Errors are swallowed — a logging failure must never
 * drop the event or crash the polling loop.
 */
async function logArrivalImmediate(
  connectorId: string | null,
  event: ConnectorEvent,
): Promise<void> {
  if (!connectorId) return
  try {
    const row = await logConnectorEvent({
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
    // Thread the arrival row id into event metadata so the downstream
    // event-router can UPDATE this row instead of INSERTing a duplicate.
    event.metadata = { ...(event.metadata ?? {}), arrival_event_id: row.id }
  } catch (err) {
    console.error('[telegram] logArrivalImmediate failed:', err)
  }
}

/**
 * Inbound media-group (album) buffer.
 *
 * When a user sends an album (multiple photos/videos in one send), Telegram
 * delivers them as N separate `message` updates, each sharing the same
 * `media_group_id`. To avoid the agent receiving N triggers / replying N
 * times, we buffer arrivals per (connector, chat, media_group_id) and emit
 * ONE ConnectorEvent after `MEDIA_GROUP_DEBOUNCE_MS` of silence from the
 * first item.
 *
 * Module-level Map (not per-instance) so the same multi-tenant adapter
 * singleton shape used for `chatSendQueues` / `inboundQueue` applies here.
 */
interface MediaGroupBufferItem {
  msg: any
  gramCtxUpdate: unknown
  media: ConnectorEventMedia | undefined
  mediaMetadata: Record<string, unknown>
  botMentioned: boolean
  isReplyToBot: boolean
}
interface MediaGroupBuffer {
  connectorId: string
  chatId: string
  mediaGroupId: string
  items: MediaGroupBufferItem[]
  timer: ReturnType<typeof setTimeout>
  firstArrivalAt: number
}
const mediaGroupBuffers = new Map<string, MediaGroupBuffer>()
function mediaGroupBufferKey(connectorId: string, chatId: string | number, mediaGroupId: string): string {
  return `${connectorId}:${chatId}:${mediaGroupId}`
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

  // ─── Multi-tenant per-connector state isolation ────────────────────────────
  //
  // BUG fixed here: singleton adapter + scalar `this.bot/botUsername/...` was
  // a multi-tenant data leak. When a 2nd credential activated, it overwrote
  // the 1st's bot fields. Subsequent sends to the 1st connector silently used
  // the 2nd's bot token → "chat not found" because the 2nd bot isn't a
  // member of the 1st's chats.
  //
  // Fix: maintain a per-connectorId Map alongside the legacy scalars (which
  // STAY for code paths not yet updated to pass connector_id, and degrade
  // gracefully to "newest instance" with a warning). New / refactored call
  // sites pass `target.connector_id` and get correct bot via `botFor()`.
  private instances = new Map<string, {
    bot: Bot
    projectId: string
    connectorId: string
    botUsername: string | null
    botUserId: number | null
    activatedAt: number
  }>()

  /** Resolve the right bot for a given connectorId. Returns the matching
   *  instance, or — if connectorId omitted — the most-recently-activated one
   *  (legacy behaviour, with warning when multiple credentials are active). */
  private botFor(connectorId: string | null | undefined): Bot | null {
    if (connectorId) {
      const inst = this.instances.get(connectorId)
      if (inst) return inst.bot
      // Caller passed a connectorId but we don't have it — neighbourly: return null.
      return null
    }
    if (this.instances.size === 0) return this.bot // legacy null
    if (this.instances.size > 1) {
      console.warn(`[telegram] botFor() called WITHOUT connector_id while ${this.instances.size} credentials active — defaulting to legacy fallback bot. This may pick the wrong bot. Caller MUST pass ConnectorTarget.connector_id.`)
    }
    return this.bot
  }

  private consoleApi: PluginConsoleAPI | null = null

  attachConsole(api: PluginConsoleAPI) { this.consoleApi = api }

  /** Resolve a console logger for this connector. No-op if console API not attached. */
  private con(connectorId: string | null | undefined): PluginConsoleLogger | null {
    if (!this.consoleApi || !connectorId) return null
    return this.consoleApi.get(botConsoleId(connectorId), `Telegram Bot ${connectorId.slice(0, 8)}`)
  }

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
      id: 'send_file',
      name: 'Send File',
      description: 'Send a single document/file. Source = one of: `file_path` (project disk), `url` (public URL Telegram will fetch), `file_id` (Telegram file_id from an earlier message — instant reuse, no re-upload). Use for PDFs, archives, generic files. Exactly ONE of the three source params must be set.',
      params: {
        chat_id: { type: 'string', description: 'Telegram chat ID', required: true },
        file_path: { type: 'string', description: 'File path in the project filesystem, e.g. "/reports/output.pdf". Mutually exclusive with `url` / `file_id`.', required: false },
        url: { type: 'string', description: 'Public URL of the file. Mutually exclusive with `file_path` / `file_id`.', required: false },
        file_id: { type: 'string', description: 'Telegram file_id of an already-uploaded document. Only works for file_ids this same bot has seen before (Bot API constraint). Ideal for re-forwarding media the bot received earlier without re-uploading. Mutually exclusive with `file_path` / `url`.', required: false },
        caption: { type: 'string', description: 'Optional caption for the file', required: false },
        caption_markdown: { type: 'boolean', description: 'Parse caption as Markdown', required: false },
        reply_to_message_id: { type: 'string', description: 'Message ID to reply to', required: false },
        thread_id: { type: 'string', description: 'Forum topic thread ID', required: false },
      },
    },
    {
      id: 'send_photo',
      name: 'Send Photo',
      description: 'Send a single photo. Source = one of: `file_path` (project disk), `url` (public URL Telegram will fetch), `file_id` (Telegram file_id from an earlier message — instant reuse, no re-upload). Exactly ONE of the three source params must be set. For sending MULTIPLE photos as one album, use `send_media_group` instead.',
      params: {
        chat_id: { type: 'string', description: 'Telegram chat ID', required: true },
        file_path: { type: 'string', description: 'Image file path in the project filesystem, e.g. "/images/chart.png". Mutually exclusive with `url` / `file_id`.', required: false },
        url: { type: 'string', description: 'Public URL of the image. Mutually exclusive with `file_path` / `file_id`.', required: false },
        file_id: { type: 'string', description: 'Telegram file_id of an already-uploaded photo. Only works for file_ids this same bot has seen before. Mutually exclusive with `file_path` / `url`.', required: false },
        caption: { type: 'string', description: 'Optional caption', required: false },
        caption_markdown: { type: 'boolean', description: 'Parse caption as Markdown', required: false },
        reply_to_message_id: { type: 'string', description: 'Message ID to reply to', required: false },
        thread_id: { type: 'string', description: 'Forum topic thread ID', required: false },
      },
    },
    {
      id: 'send_video',
      name: 'Send Video',
      description: 'Send a single video. Source = one of: `file_path` (project disk), `url` (public URL Telegram will fetch), `file_id` (Telegram file_id from an earlier message — instant reuse, no re-upload). Exactly ONE of the three source params must be set. For sending MULTIPLE videos as one album, use `send_media_group` instead.',
      params: {
        chat_id: { type: 'string', description: 'Telegram chat ID', required: true },
        file_path: { type: 'string', description: 'Video file path in the project filesystem, e.g. "/videos/demo.mp4". Mutually exclusive with `url` / `file_id`.', required: false },
        url: { type: 'string', description: 'Public URL of the video. Mutually exclusive with `file_path` / `file_id`.', required: false },
        file_id: { type: 'string', description: 'Telegram file_id of an already-uploaded video. Only works for file_ids this same bot has seen before. Mutually exclusive with `file_path` / `url`.', required: false },
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
      description: 'Download media from a previously received message and save it to the project filesystem. Use the event_id from the "Media available" hint in the conversation context. For media groups (albums), pass `index` (0-based) to pick which item to download — call once per item to fetch all. Returns the saved file path + size.',
      params: {
        event_id: { type: 'string', description: 'event_id from the inbound message that contained media (from context hint)', required: true },
        save_path: { type: 'string', description: 'Filesystem path to save the file. If omitted, auto-generates under /connector_media/.', required: false },
        index: { type: 'number', description: 'For media groups (albums), the 0-based index of the item to download. Default 0 (first item). Ignored for single-media messages.', required: false },
      },
    },
    {
      id: 'send_media_group',
      name: 'Send Media Group (Album)',
      description: 'Send multiple photos, videos, or documents as a single album message. Photos and videos can be mixed (max 10). Documents cannot mix with photo/video — if mixed, photos/videos go first as album then documents are sent individually. Only the first item caption is shown prominently. Each item\'s source = one of `url` | `file_path` | `file_id` (e.g. re-use a file_id the bot received in an earlier message to forward media without re-upload).',
      params: {
        chat_id: { type: 'string', description: 'Telegram chat ID', required: true },
        media: { type: 'array', description: 'Array of media items: { type: "photo"|"video"|"document", url?: string, file_path?: string, file_id?: string, caption?: string, caption_markdown?: boolean, name?: string }. Max 10 items. Each item must have exactly ONE of `url` / `file_path` / `file_id`.', required: true },
        thread_id: { type: 'string', description: 'Forum topic thread ID', required: false },
      },
    },
    {
      id: 'send_url_media',
      name: 'Send Media from URL',
      description: 'Send a single photo, video, or document from a public URL directly to a chat — no filesystem needed. For single sends, the dedicated actions (`send_photo`, `send_video`, `send_file`) also accept a `url` param and are equally valid.',
      params: {
        chat_id: { type: 'string', description: 'Telegram chat ID', required: true },
        url: { type: 'string', description: 'Public direct URL to the media file', required: true },
        type: { type: 'string', description: '"photo", "video", or "document"', required: true },
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
  ]

  // ─── runAction ──────────────────────────────────────────────────────

  override async runAction(actionId: string, params: Record<string, unknown>, connectorId?: string): Promise<unknown> {
    // Multi-tenant: resolve the right bot for this connector. Fall back to
    // legacy scalar when caller passes no connectorId (with warning inside botFor).
    const bot = this.botFor(connectorId)
    if (!bot) throw new Error('Bot not initialized for this connector')

    // Every outbound API call goes through enqueueForChat (per-chat spacing) +
    // withTelegramRetry (honors 429 retry_after once). Scope-less actions
    // (e.g. fetch_media which is download-only) still use withTelegramRetry.
    const callChat = <T>(chatId: string, label: string, fn: () => Promise<T>): Promise<T> =>
      enqueueForChat(chatId, () => withTelegramRetry(fn, `bot.${label}`))

    switch (actionId) {
      case 'edit_message': {
        const { chat_id, message_id, text, markdown } = params as { chat_id: string; message_id: string; text: string; markdown?: boolean }
        const finalText = markdown ? telegramifyMarkdown(text, 'escape') : text
        await callChat(String(chat_id), 'editMessageText', () =>
          bot.api.editMessageText(chat_id, Number(message_id), finalText, {
            parse_mode: markdown ? 'MarkdownV2' : undefined,
          })
        )
        return { success: true }
      }

      case 'send_file':
      case 'send_photo':
      case 'send_video': {
        const { chat_id, file_path, url, file_id, caption, caption_markdown, reply_to_message_id, thread_id } = params as {
          chat_id: string; file_path?: string; url?: string; file_id?: string
          caption?: string; caption_markdown?: boolean
          reply_to_message_id?: string; thread_id?: string
        }
        const sourceCount = [file_path, url, file_id].filter(Boolean).length
        if (sourceCount === 0) {
          return { success: false, error: `${actionId} requires exactly one of "file_path", "url", or "file_id"` }
        }
        if (sourceCount > 1) {
          return { success: false, error: `${actionId}: pass exactly one of "file_path", "url", or "file_id" — not multiple` }
        }
        // file_path → upload bytes via InputFile.
        // url → pass URL string; Telegram fetches server-side.
        // file_id → pass file_id string; Telegram reuses the stored media. Only
        //           valid for file_ids THIS bot has seen before (Bot API rule).
        const input: InputFile | string = file_path
          ? await this.resolveFilesystemFile(file_path)
          : (url ?? file_id!)
        const extra: Record<string, unknown> = {}
        if (caption) {
          extra.caption = caption_markdown ? telegramifyMarkdown(caption, 'escape') : caption
          if (caption_markdown) extra.parse_mode = 'MarkdownV2'
        }
        if (reply_to_message_id) extra.reply_parameters = { message_id: Number(reply_to_message_id) }
        if (thread_id) extra.message_thread_id = Number(thread_id)

        let sent
        if (actionId === 'send_photo') {
          sent = await callChat(String(chat_id), 'sendPhoto', () => bot.api.sendPhoto(chat_id, input as any, extra as any))
        } else if (actionId === 'send_video') {
          sent = await callChat(String(chat_id), 'sendVideo', () => bot.api.sendVideo(chat_id, input as any, extra as any))
        } else {
          sent = await callChat(String(chat_id), 'sendDocument', () => bot.api.sendDocument(chat_id, input as any, extra as any))
        }
        return { success: true, message_id: String(sent.message_id), chat_id: String(sent.chat.id) }
      }

      case 'get_chat_info': {
        const { chat_id } = params as { chat_id: string }
        const chat = await callChat(String(chat_id), 'getChat', () => bot.api.getChat(chat_id))
        return { success: true, chat }
      }

      // ── Plan 22 handlers ───────────────────────────────────────────
      case 'fetch_media': {
        const { event_id, save_path, index } = params as { event_id: string; save_path?: string; index?: number }
        const row = await getConnectorEventById(event_id)
        if (!row) throw new Error(`connector_event not found: ${event_id}`)
        const md = (row.metadata ?? {}) as Record<string, unknown>

        // Media-group path: metadata.media_items[] carries one entry per album
        // item. Pick by `index` (default 0). Fall back to the singular keys
        // for non-album events.
        const items = Array.isArray(md['media_items']) ? md['media_items'] as Array<Record<string, unknown>> : null
        const idx = Math.max(0, Math.floor(index ?? 0))
        let fileId: string | undefined
        let fileName: string | undefined
        let mimeType: string | undefined
        let mediaType: string | undefined
        if (items && items.length > 0) {
          if (idx >= items.length) {
            throw new Error(`index ${idx} out of range — event ${event_id} has ${items.length} media items (valid: 0..${items.length - 1})`)
          }
          const picked = items[idx]!
          fileId = picked['media_file_id'] as string | undefined
          fileName = picked['media_file_name'] as string | undefined
          mimeType = picked['media_mime_type'] as string | undefined
          mediaType = picked['media_type'] as string | undefined
        } else {
          if (index !== undefined && index > 0) {
            throw new Error(`event ${event_id} is a single-media message; index must be 0 or omitted`)
          }
          fileId = md['media_file_id'] as string | undefined
          fileName = md['media_file_name'] as string | undefined
          mimeType = md['media_mime_type'] as string | undefined
          mediaType = md['media_type'] as string | undefined
        }
        if (!fileId) throw new Error(`No media file_id on event ${event_id}${items ? ` at index ${idx}` : ''}`)

        // getFile goes through retry (no chat scope — session-global)
        const file = await withTelegramRetry(() => bot.api.getFile(fileId), 'bot.getFile')
        if (!file.file_path) throw new Error('Telegram getFile returned no file_path')
        const token = (bot as any).token as string
        const downloadUrl = `https://api.telegram.org/file/bot${token}/${file.file_path}`
        const resp = await fetch(downloadUrl)
        if (!resp.ok) throw new Error(`Failed to download media: ${resp.status}`)
        const buffer = Buffer.from(await resp.arrayBuffer())

        const indexSuffix = items && items.length > 1 ? `_${idx}` : ''
        const defaultName = fileName
          ?? `media_${event_id.slice(0, 8)}${indexSuffix}_${Date.now()}${this.guessExt(mimeType, mediaType)}`
        const targetPath = save_path ?? `/connector_media/${defaultName}`

        if (!this.projectId) throw new Error('Project context not available')
        const fs = await getFilesystemService(this.projectId)
        if (!fs) throw new Error('Filesystem is not configured for this project')
        const b64 = `__b64__:${buffer.toString('base64')}`
        await fs.write(targetPath, b64)
        return { success: true, path: targetPath, size: buffer.length, index: items ? idx : undefined, total_items: items ? items.length : undefined }
      }

      case 'send_media_group': {
        // Delegates to sendMediaGroup which already enqueues per chat.
        const { chat_id, media, thread_id } = params as {
          chat_id: string
          media: Array<{ type: 'photo' | 'video' | 'document'; url?: string; file_path?: string; file_id?: string; caption?: string; caption_markdown?: boolean; name?: string }>
          thread_id?: string
        }
        const items: ConnectorMediaItem[] = await Promise.all(media.map(async (m, i) => {
          const sourceCount = [m.url, m.file_path, m.file_id].filter(Boolean).length
          if (sourceCount === 0) throw new Error(`media[${i}] requires exactly one of "url", "file_path", or "file_id"`)
          if (sourceCount > 1) throw new Error(`media[${i}]: pass exactly one of "url", "file_path", or "file_id"`)
          const item: ConnectorMediaItem = {
            type: m.type === 'photo' ? 'image' : m.type,
            caption: m.caption,
            caption_markdown: m.caption_markdown,
            name: m.name,
          }
          if (m.url) item.url = m.url
          else if (m.file_id) item.file_id = m.file_id
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
        // Delegates to sendSingleMedia which already enqueues per chat.
        const { chat_id, url, type, caption, caption_markdown, thread_id } = params as {
          chat_id: string; url: string; type: 'photo' | 'video' | 'document'; caption?: string; caption_markdown?: boolean; thread_id?: string
        }
        const item: ConnectorMediaItem = {
          type: type === 'photo' ? 'image' : type,
          url,
          caption,
          caption_markdown,
        }
        const commonOpts: Record<string, unknown> = {}
        if (thread_id) commonOpts.message_thread_id = Number(thread_id)
        return this.sendSingleMedia(chat_id, item, undefined, commonOpts)
      }

      case 'send_to_scope': {
        // Delegates to sendMessage which already enqueues per chat.
        const { scope_key, text, markdown } = params as { scope_key: string; text: string; markdown?: boolean }
        const target = this.targetFromScopeKey(scope_key)
        if (!target) throw new Error(`Invalid scope_key: ${scope_key}`)
        if (connectorId) target.connector_id = connectorId
        return this.sendMessage(target, { text, markdown: markdown ?? true })
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
        if (!from_chat_id) return { success: false, error: 'Missing required param: from_chat_id', hint: 'Pass the source chat_id — find it in inbound event raw_payload.chat.id or connector_get_events result.' }
        if (!message_id) return { success: false, error: 'Missing required param: message_id', hint: 'Pass the source message_id — find it in inbound event raw_payload.message.message_id.' }
        if (!to_chat_id) return { success: false, error: 'Missing required param: to_chat_id', hint: 'Pass the destination chat_id. Resolve from target alias via connector_list if needed.' }
        if (!/^-?\d+$/.test(message_id)) return { success: false, error: `message_id must be numeric, got "${message_id}"`, hint: 'Telegram message_ids are integers. Did you pass a uuid or ref_key by mistake?' }

        const opts: Record<string, unknown> = {}
        if (thread_id) opts.message_thread_id = Number(thread_id)
        if (disable_notification) opts.disable_notification = true
        if (protect_content) opts.protect_content = true

        const effectiveHide = hide_sender ?? true
        try {
          const label = effectiveHide ? 'copyMessage' : 'forwardMessage'
          const sent = await callChat(String(to_chat_id), label, () => effectiveHide
            ? bot.api.copyMessage(to_chat_id, from_chat_id, Number(message_id), opts as any)
            : bot.api.forwardMessage(to_chat_id, from_chat_id, Number(message_id), opts as any)
          )
          const sentAny = sent as { message_id: number; chat?: { id: number } }
          const chatIdStr = sentAny.chat ? String(sentAny.chat.id) : String(to_chat_id)
          return { success: true, message_id: String(sentAny.message_id), chat_id: chatIdStr, hidden_sender: effectiveHide }
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
          const sent = await callChat(String(to_chat_id), 'copyMessage', () =>
            bot.api.copyMessage(to_chat_id, from_chat_id, Number(message_id), opts as any)
          )
          return { success: true, message_id: String(sent.message_id), chat_id: String(to_chat_id) }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err)
          const hint = this.hintForTelegramError(msg, { from_chat_id, to_chat_id, message_id })
          return { success: false, error: msg, ...(hint ? { hint } : {}) }
        }
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

  /**
   * Auto-register a forum topic as a `connector_target` on first sighting.
   * Target name = "<chat-slug>__<topic-slug>"; `scope_key` matches
   * `computeScopeKey` so outbound via this target threads into the same
   * scope conversation as inbound events. Idempotent via
   * `getConnectorTargetByName`.
   */
  private async autoRegisterForumTopic(msg: any, forumTopicName: string | undefined, connectorId: string): Promise<void> {
    if (!msg.message_thread_id || !forumTopicName || !this.projectId) return
    const tid = String(msg.message_thread_id)
    const chatSlug = this.slugifyChannelTitle(
      'title' in msg.chat ? (msg.chat.title ?? `chat-${msg.chat.id}`) : `chat-${msg.chat.id}`,
    )
    const topicSlug = this.slugifyChannelTitle(forumTopicName)
    const targetName = `${chatSlug}__${topicSlug}`
    try {
      const existing = await getConnectorTargetByName(this.projectId, targetName, connectorId).catch(() => null)
      if (!existing) {
        await createConnectorTarget({
          connector_id: connectorId,
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

  /**
   * Assemble a single ConnectorEvent from a buffered media-group and hand it
   * off to arrival-log + inbound queue. Caller has already removed the buffer
   * from `mediaGroupBuffers` and cleared its timer.
   *
   * Aggregation rules:
   *  - ref_keys.message_id = first item's message_id (earliest arrival).
   *  - content.text = first non-empty caption across items (Telegram allows
   *    only one caption per album in practice, but the API permits more).
   *  - content.media = item[0].media (back-compat with callers that read
   *    the singular field). content.media_items = all items.
   *  - metadata.media_group_id + metadata.media_items = per-item internal
   *    file ids, used by the `fetch_media` action's `index` param.
   *  - metadata inlines item[0]'s media_file_id/etc. for back-compat with
   *    code paths that read the singular keys (e.g. fetch_media without index).
   *  - bot_mentioned / bot_replied_to = OR-accumulated across items (a
   *    mention in any item's caption counts).
   *  - raw_payload = { media_group: true, media_group_id, updates: [...] }.
   */
  private async flushMediaGroupBuffer(buf: MediaGroupBuffer, ctx: ConnectorContext): Promise<void> {
    if (buf.items.length === 0) return
    const primary = buf.items[0]!
    const msg = primary.msg

    const anyMentioned = buf.items.some(i => i.botMentioned)
    const anyReply = buf.items.some(i => i.isReplyToBot)
    const firstCaptionItem = buf.items.find(i => i.msg.caption !== undefined && i.msg.caption !== '')
    const text = msg.text ?? firstCaptionItem?.msg.caption ?? undefined

    const mediaList: ConnectorEventMedia[] = buf.items
      .map(i => i.media)
      .filter((m): m is ConnectorEventMedia => !!m)

    const mediaItemsInternal = buf.items
      .filter(i => typeof i.mediaMetadata['media_file_id'] === 'string')
      .map(i => ({
        message_id: String(i.msg.message_id),
        media_file_id: i.mediaMetadata['media_file_id'],
        media_type: i.mediaMetadata['media_type'],
        media_file_name: i.mediaMetadata['media_file_name'],
        media_mime_type: i.mediaMetadata['media_mime_type'],
        media_file_size: i.mediaMetadata['media_file_size'],
      }))

    const forumTopicName: string | undefined =
      msg.forum_topic_created?.name
      ?? msg.forum_topic_edited?.name
      ?? msg.reply_to_message?.forum_topic_created?.name
      ?? undefined

    const event: ConnectorEvent = {
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
        is_bot: msg.from?.is_bot,
      },
      content: {
        text,
        media: mediaList[0],
        media_items: mediaList,
      },
      metadata: {
        language_code: msg.from?.language_code ?? null,
        client_timestamp: new Date(msg.date * 1000).toISOString(),
        chat_type: msg.chat.type,
        chat_title: 'title' in msg.chat ? msg.chat.title : undefined,
        ...(forumTopicName ? { thread_title: forumTopicName } : {}),
        ...(msg.is_topic_message ? { is_topic_message: true } : {}),
        ...(anyMentioned ? { bot_mentioned: true } : {}),
        ...(anyReply ? { bot_replied_to: true } : {}),
        ...(msg.reply_to_message ? {
          reply_to: {
            origin: msg.reply_to_message.chat?.id === msg.chat.id ? 'same_chat' : 'other_chat',
            message_id: String(msg.reply_to_message.message_id),
            chat_id: msg.reply_to_message.chat ? String(msg.reply_to_message.chat.id) : null,
            text: msg.reply_to_message.text ?? msg.reply_to_message.caption ?? null,
            sender: msg.reply_to_message.from ? {
              id: String(msg.reply_to_message.from.id),
              username: msg.reply_to_message.from.username ?? null,
              display_name: [msg.reply_to_message.from.first_name, msg.reply_to_message.from.last_name].filter(Boolean).join(' ') || null,
              is_bot: msg.reply_to_message.from.is_bot ?? false,
            } : null,
            is_quote: false,
          },
        } : {}),
        // item[0]'s singular media_* keys inlined for back-compat with
        // fetch_media callers that don't pass `index` (default 0).
        ...primary.mediaMetadata,
        media_group_id: buf.mediaGroupId,
        media_items: mediaItemsInternal,
      },
      timestamp: new Date(msg.date * 1000),
      raw_payload: {
        media_group: true,
        media_group_id: buf.mediaGroupId,
        updates: buf.items.map(i => i.gramCtxUpdate),
      },
    }

    await logArrivalImmediate(buf.connectorId, event)
    await enqueueInboundEvent(() => ctx.onEvent(event).catch(err => {
      console.error('[telegram] inbound event handler error (media group):', err)
    }))

    await this.autoRegisterForumTopic(msg, forumTopicName, ctx.connectorId)
  }

  private async loadFilesystemBuffer(filePath: string): Promise<{ buffer: Buffer; name: string; mime_type: string }> {
    if (!this.projectId) throw new Error('Project context not available')
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
    return new InputFile(buffer, name)
  }

  // ─── Standard ConnectorAdapter methods ─────────────────────────────

  async onActivate(ctx: ConnectorContext): Promise<void> {
    const token = ctx.fields['bot_token']
    if (!token) throw new Error('[telegram] bot_token missing in credentials')

    this.projectId = ctx.projectId
    this.connectorId = ctx.connectorId
    this.pollingStopRequested = false
    this.lastEventAt = null
    this.bot = new Bot(token)
    this.con(ctx.connectorId)?.info('Bot activating', { project_id: ctx.projectId })

    // Multi-tenant fix: register this credential's bot in the per-connector
    // Map. `botFor(connectorId)` looks here first; only falls back to the
    // legacy scalar `this.bot` when caller didn't pass connector_id.
    this.instances.set(ctx.connectorId, {
      bot: this.bot,
      projectId: ctx.projectId,
      connectorId: ctx.connectorId,
      botUsername: null,
      botUserId: null,
      activatedAt: Date.now(),
    })

    // Grammy internal error handler — without this, errors inside async
    // update handlers default to unhandled rejection and can crash the node
    // process (or, worse, silently kill the polling loop). Log + swallow.
    this.bot.catch((err) => {
      console.error('[telegram] grammy handler error:', err.error ?? err)
      this.con(ctx.connectorId)?.error('grammy handler error', { error: String(err.error ?? err) })
    })

    this.bot.on('message', async (gramCtx: any) => {
      const msg = gramCtx.message
      const { media, mediaMetadata, mediaGroupId } = extractTelegramMedia(msg)

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

      // ── Inbound media-group (album) debounce ─────────────────────────
      // Telegram ships albums as N separate updates sharing `media_group_id`.
      // Buffer them per (connector, chat, group) and emit ONE event after
      // MEDIA_GROUP_DEBOUNCE_MS of silence from the first arrival.
      if (mediaGroupId && type === 'message' && this.connectorId) {
        const connectorId = this.connectorId
        const key = mediaGroupBufferKey(connectorId, msg.chat.id, mediaGroupId)
        const item: MediaGroupBufferItem = {
          msg, gramCtxUpdate: gramCtx.update,
          media, mediaMetadata, botMentioned, isReplyToBot,
        }
        const existing = mediaGroupBuffers.get(key)
        if (existing) {
          existing.items.push(item)
        } else {
          const timer = setTimeout(() => {
            const buf = mediaGroupBuffers.get(key)
            if (!buf) return
            mediaGroupBuffers.delete(key)
            this.flushMediaGroupBuffer(buf, ctx).catch(err => {
              console.error('[telegram] media-group flush error:', err)
            })
          }, MEDIA_GROUP_DEBOUNCE_MS)
          mediaGroupBuffers.set(key, {
            connectorId,
            chatId: String(msg.chat.id),
            mediaGroupId,
            items: [item],
            timer,
            firstArrivalAt: Date.now(),
          })
        }
        this.lastEventAt = Date.now()
        return  // arrival log + routing deferred to flush
      }

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
          // Plan 25 add-on — reply context (Bot API gives the parent message
          // verbatim in reply_to_message; no extra fetch needed).
          ...(msg.reply_to_message ? {
            reply_to: {
              origin: msg.reply_to_message.chat?.id === msg.chat.id ? 'same_chat' : 'other_chat',
              message_id: String(msg.reply_to_message.message_id),
              chat_id: msg.reply_to_message.chat ? String(msg.reply_to_message.chat.id) : null,
              text: msg.reply_to_message.text ?? msg.reply_to_message.caption ?? null,
              sender: msg.reply_to_message.from ? {
                id: String(msg.reply_to_message.from.id),
                username: msg.reply_to_message.from.username ?? null,
                display_name: [msg.reply_to_message.from.first_name, msg.reply_to_message.from.last_name].filter(Boolean).join(' ') || null,
                is_bot: msg.reply_to_message.from.is_bot ?? false,
              } : null,
              is_quote: false,
            },
          } : {}),
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

      if (hasContent) await this.autoRegisterForumTopic(msg, forumTopicName, ctx.connectorId)
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
            const refreshed = await getBindings(ctx.connectorId)
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
      // Also write into the per-connector instance entry so getIdentity()
      // returns the right bot identity when looking up by connectorId.
      const inst = this.instances.get(ctx.connectorId)
      if (inst) {
        inst.botUsername = this.botUsername
        inst.botUserId = this.botUserId
      }
      console.log(`[telegram] identity cached for connector=${ctx.connectorId}: @${this.botUsername} (id=${this.botUserId})`)
      this.con(ctx.connectorId)?.info(`Identity cached: @${this.botUsername}`, { user_id: this.botUserId })
    } catch (err) {
      console.warn('[telegram] getMe failed — mention/reply detection disabled:', err)
      this.con(ctx.connectorId)?.warn('getMe failed — mention/reply detection disabled', { error: String(err) })
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
    this.con(ctx.connectorId)?.info('Bot started — polling loop running')
  }

  async onDeactivate(connectorId?: string): Promise<void> {
    // Multi-tenant: server passes the SPECIFIC connectorId being deactivated.
    // Stop ONLY that bot's instance, leave others running. If connectorId
    // omitted (legacy callers), fall back to "the one and only" or warn loudly.
    let targetId: string | null = connectorId ?? null
    if (!targetId) {
      if (this.instances.size === 1) targetId = [...this.instances.keys()][0]!
      else if (this.instances.size > 1) {
        console.warn(`[telegram] onDeactivate() called WITHOUT connectorId while ${this.instances.size} credentials active — refusing to deactivate (would pick wrong one). Caller must pass connectorId.`)
        return
      } else {
        return
      }
    }
    const inst = this.instances.get(targetId)
    if (!inst) return

    this.con(targetId)?.info('Bot deactivating')
    lastDeactivateByConnector.set(targetId, Date.now())
    // Only the matching instance has its polling stopped.
    try { await inst.bot.stop() } catch { /* best-effort */ }
    this.instances.delete(targetId)

    // Drop any in-flight media-group buffers owned by this connector. Firing
    // their flush timers after the bot has stopped would hand events to a
    // teared-down ctx — user will re-send the album if they still want it.
    for (const [key, buf] of mediaGroupBuffers) {
      if (buf.connectorId === targetId) {
        clearTimeout(buf.timer)
        mediaGroupBuffers.delete(key)
      }
    }

    // Clear legacy scalars ONLY when deactivating the credential that owns them
    // (i.e. the most-recent activate) — keeps the legacy fallback usable for
    // any remaining instance.
    if (this.connectorId === targetId) {
      this.pollingStopRequested = true
      this.bot = null
      this.projectId = null
      this.connectorId = null
      this.botUsername = null
      this.botUserId = null
      this.lastEventAt = null
      // Re-point legacy scalars to whatever instance is now newest, if any.
      const remaining = [...this.instances.values()].sort((a, b) => b.activatedAt - a.activatedAt)[0]
      if (remaining) {
        this.bot = remaining.bot
        this.projectId = remaining.projectId
        this.connectorId = remaining.connectorId
        this.botUsername = remaining.botUsername
        this.botUserId = remaining.botUserId
        this.pollingStopRequested = false
      }
    }
    console.log(`[telegram] bot stopped for connector=${targetId} (${this.instances.size} remain)`)
  }

  /** Health snapshot — used by `GET /connectors/:id/health`. */
  getHealth(connectorId?: string): { polling: boolean; last_event_at: string | null; bot_user_id: number | null } {
    // Multi-tenant: report health for the asked connector if specified.
    const inst = connectorId ? this.instances.get(connectorId) : null
    if (inst) {
      return {
        polling: true,
        last_event_at: this.lastEventAt ? new Date(this.lastEventAt).toISOString() : null,
        bot_user_id: inst.botUserId,
      }
    }
    return {
      polling: this.bot !== null && !this.pollingStopRequested,
      last_event_at: this.lastEventAt ? new Date(this.lastEventAt).toISOString() : null,
      bot_user_id: this.botUserId,
    }
  }

  override getIdentity(connectorId?: string) {
    // Multi-tenant: resolve the right bot identity for the asked connector,
    // not the legacy "newest" one.
    const inst = connectorId ? this.instances.get(connectorId) : null
    const username = inst?.botUsername ?? this.botUsername
    const userId = inst?.botUserId ?? this.botUserId
    if (!username && !userId) return null
    return {
      name: username ?? `bot:${userId}`,
      username: username ? `@${username}` : null,
      user_id: userId !== null ? String(userId) : null,
      metadata: {
        kind: 'bot',
        connector_id: inst?.connectorId ?? this.connectorId ?? null,
      },
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
    // Multi-tenant: pick the bot bound to THIS target's connector_id. Falls
    // back to legacy "the only one" when caller didn't pass connector_id.
    const bot = this.botFor(target.connector_id)
    if (!bot) {
      return { success: false, error: target.connector_id
        ? `No active bot instance for connector_id=${target.connector_id}. Was the connector deactivated?`
        : 'Bot not initialized' }
    }

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

    return enqueueForChat(chatId, () => this.sendMessageInner(chatId!, content, commonOpts, bot, target.connector_id))
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
    // Multi-tenant: pick THIS connector's bot, not the singleton fallback.
    const bot = this.botFor(ctx.connectorId) ?? this.bot
    if (!bot) return

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
        () => bot.api.sendMessage(chatId, '⌛', replyTarget as any),
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
    let editCount = 0

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
          await bot.api.editMessageText(chatId, currentMsgId, finalPart).catch(() => {})
          try {
            const sent = await withTelegramRetry(
              () => bot.api.sendMessage(chatId, '⌛', replyTarget as any),
              'telegram:stream:continuation',
            )
            currentMsgId = sent.message_id
          } catch { return }
          segments.length = 0
          toolIndex.clear()
        }
        const indicator = editCount % 2 === 0 ? '⚫' : '⚪'
        const text = `${renderInterim()}\n\n${indicator}`
        try {
          await bot.api.editMessageText(chatId, currentMsgId, text)
          editCount++
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
        () => bot.api.editMessageText(chatId, currentMsgId, finalBody, { parse_mode: 'MarkdownV2' }),
        'telegram:stream:final',
      )
    } catch (err) {
      if (isNotModifiedError(err)) {
        // No-op success — content already on screen. Move on.
      } else {
        console.warn('[telegram] stream final edit (markdown) failed, falling back to plain:', err)
        // Plain fallback: render interim form (no markdown, plain `---`).
        await bot.api.editMessageText(chatId, currentMsgId, renderInterim()).catch(plainErr => {
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
    bot?: Bot | null,
    connectorIdHint?: string | null,
  ): Promise<ConnectorSendResult> {
    // Multi-tenant: prefer the bot passed by the caller (which already
    // resolved via target.connector_id). Fall back to legacy scalar.
    const activeBot: Bot = (bot ?? this.bot) as Bot
    void connectorIdHint
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
        // Tracing: stamp every actual API call with chat_id, len, attempt index,
        // bot identity. Lets operator grep `[telegram]` in server console and
        // Resolve the bot's identity for THIS call's bot (multi-tenant safe).
        const inst = connectorIdHint ? this.instances.get(connectorIdHint) : null
        const botUsernameForLog = inst?.botUsername ?? this.botUsername ?? 'unknown'
        console.log(`[telegram] sendMessage → chat_id=${chatId} bot=@${botUsernameForLog} connector=${connectorIdHint ?? 'legacy'} chunk=${i + 1}/${chunks.length} len=${(chunks[i] ?? '').length} parse_mode=${useMarkdown ? 'MarkdownV2' : 'none'}`)
        this.con(connectorIdHint)?.info(`outbound → chat_id=${chatId} chunk=${i + 1}/${chunks.length} len=${(chunks[i] ?? '').length}`, { chat_id: chatId, parse_mode: useMarkdown ? 'MarkdownV2' : 'none' })
        lastSent = await withTelegramRetry(
          () => activeBot.api.sendMessage(chatId, chunks[i] || '-', opts as any),
          'telegram:sendMessage',
        )
        console.log(`[telegram] sendMessage ← chat_id=${chatId} message_id=${lastSent?.message_id ?? 'n/a'} (tg returned chat_title="${(lastSent as { chat?: { title?: string } } | null)?.chat?.title ?? '?'}")`)
        this.con(connectorIdHint)?.info(`outbound OK message_id=${lastSent?.message_id ?? 'n/a'}`, { chat_id: chatId })
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
      this.con(connectorIdHint)?.error(`outbound FAILED chat_id=${chatId}`, { error: errStr })
      let botUsername: string | null = null
      try {
        const me = await activeBot.api.getMe()
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
    const capped = items.slice(0, 10)

    const resolveMedia = (item: ConnectorMediaItem, idx: number) => {
      // file_id and url are both passed to grammy as bare strings — Telegram
      // Bot API accepts either shape. InputFile wraps raw bytes for upload.
      if (item.url) return item.url
      if (item.file_id) return item.file_id
      return new InputFile(item.data!, item.name ?? `file_${idx}`)
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
    const rawCaption = item.caption ?? fallbackCaption
    const caption = rawCaption && item.caption_markdown
      ? telegramifyMarkdown(rawCaption, 'escape')
      : rawCaption
    const parse_mode = rawCaption && item.caption_markdown ? ('MarkdownV2' as const) : undefined

    const media: InputFile | string = item.url
      ? item.url
      : item.file_id
        ? item.file_id
        : new InputFile(item.data!, item.name ?? 'file')
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
export { TelegramBotAdapter }
