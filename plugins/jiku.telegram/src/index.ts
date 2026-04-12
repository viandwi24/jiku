import { z } from 'zod'
import { definePlugin, ConnectorAdapter } from '@jiku/kit'
import type { ConnectorAction, ConnectorEvent, ConnectorContext, ConnectorTarget, ConnectorContent, ConnectorSendResult } from '@jiku/types'
import telegramifyMarkdown from 'telegramify-markdown'
import { StudioPlugin } from '@jiku-plugin/studio'
import type { Bot } from 'grammy'
import { getFileByPath } from '@jiku-studio/db'

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

class TelegramAdapter extends ConnectorAdapter {
  readonly id = 'jiku.telegram'
  readonly displayName = 'Telegram'
  readonly credentialAdapterId = 'telegram'
  override readonly credentialDisplayName = 'Telegram Bot'
  readonly refKeys = ['message_id', 'chat_id']
  readonly supportedEvents = ['message', 'reaction', 'unreaction', 'edit', 'delete'] as const

  override readonly credentialSchema = z.object({
    bot_token: z.string().min(1).describe('secret|Bot Token obtained from @BotFather'),
  })

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private bot: Bot|null = null
  private projectId: string | null = null

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
        reply_to_message_id: { type: 'string', description: 'Message ID to reply to', required: false },
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
        reply_to_message_id: { type: 'string', description: 'Message ID to reply to', required: false },
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
        if (message_id) {
          await this.bot.api.unpinChatMessage(chat_id, Number(message_id))
        } else {
          await this.bot.api.unpinAllChatMessages(chat_id)
        }
        return { success: true }
      }

      case 'send_file':
      case 'send_photo': {
        const { chat_id, file_path, caption, reply_to_message_id } = params as {
          chat_id: string
          file_path: string
          caption?: string
          reply_to_message_id?: string
        }
        if (!this.projectId) throw new Error('Project context not available')

        // Dynamically import filesystem service from the server
        // (telegram plugin runs inside the server process, so this is safe)
        const { getFilesystemService } = await import('../../../apps/studio/server/src/filesystem/service.ts')
        const fs = await getFilesystemService(this.projectId)
        if (!fs) throw new Error('Filesystem is not configured for this project')

        // Download file content from S3 adapter as buffer
        const adapter = fs.getAdapter()
        const fileRecord = await getFileByPath(this.projectId, file_path)
        if (!fileRecord) throw new Error(`File not found in filesystem: ${file_path}`)

        const buffer = await adapter.download(fileRecord.storage_key)
        const { InputFile } = await import('grammy')
        const inputFile = new InputFile(buffer, fileRecord.name)

        const replyParams = reply_to_message_id
          ? { reply_parameters: { message_id: Number(reply_to_message_id) } }
          : {}

        if (actionId === 'send_photo') {
          const sent = await this.bot.api.sendPhoto(chat_id, inputFile, { caption, ...replyParams })
          return { success: true, message_id: String(sent.message_id), chat_id: String(sent.chat.id) }
        } else {
          const sent = await this.bot.api.sendDocument(chat_id, inputFile, { caption, ...replyParams })
          return { success: true, message_id: String(sent.message_id), chat_id: String(sent.chat.id) }
        }
      }

      case 'get_chat_info': {
        const { chat_id } = params as { chat_id: string }
        const chat = await this.bot.api.getChat(chat_id)
        return { success: true, chat }
      }

      default:
        throw new Error(`Unknown action: ${actionId}`)
    }
  }

  // ─── Standard ConnectorAdapter methods ─────────────────────────────

  async onActivate(ctx: ConnectorContext): Promise<void> {
    const { Bot } = await import('grammy')
    const token = ctx.fields['bot_token']
    if (!token) throw new Error('[telegram] bot_token missing in credentials')

    this.projectId = ctx.projectId
    this.bot = new Bot(token)

    this.bot.on('message', async (gramCtx: any) => {
      const msg = gramCtx.message
      const event: ConnectorEvent = {
        type: 'message',
        connector_id: this.id,
        ref_keys: {
          message_id: String(msg.message_id),
          chat_id: String(msg.chat.id),
        },
        sender: {
          external_id: String(msg.from?.id ?? msg.chat.id),
          display_name: [msg.from?.first_name, msg.from?.last_name].filter(Boolean).join(' ') || undefined,
          username: msg.from?.username,
        },
        content: { text: msg.text ?? msg.caption },
        metadata: {
          language_code: msg.from?.language_code ?? null,
          client_timestamp: new Date(msg.date * 1000).toISOString(),
        },
        timestamp: new Date(msg.date * 1000),
      }
      await ctx.onEvent(event)
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
        sender: {
          external_id: String(update.user?.id ?? update.chat?.id ?? 'unknown'),
        },
        content: { text: emoji, raw: { emoji } },
        timestamp: new Date(update.date * 1000),
      }
      await ctx.onEvent(event)
    })

    this.bot.on('edited_message', async (gramCtx: any) => {
      const msg = gramCtx.editedMessage
      const event: ConnectorEvent = {
        type: 'edit',
        connector_id: this.id,
        ref_keys: {
          message_id: String(msg.message_id),
          chat_id: String(msg.chat.id),
        },
        sender: {
          external_id: String(msg.from?.id ?? msg.chat.id),
          display_name: [msg.from?.first_name, msg.from?.last_name].filter(Boolean).join(' ') || undefined,
          username: msg.from?.username,
        },
        content: { text: msg.text ?? msg.caption, raw: { new_text: msg.text } },
        timestamp: new Date((msg.edit_date ?? msg.date) * 1000),
      }
      await ctx.onEvent(event)
    })

    this.bot.start({ drop_pending_updates: true }).catch((err: unknown) => {
      console.error('[telegram] polling error:', err)
    })

    console.log('[telegram] bot started (polling)')
  }

  async onDeactivate(): Promise<void> {
    if (this.bot) {
      await this.bot.stop().catch(() => {})
      this.bot = null
      this.projectId = null
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
        },
        sender: {
          external_id: String(msg.from?.id ?? msg.chat.id),
          display_name: [msg.from?.first_name, msg.from?.last_name].filter(Boolean).join(' ') || undefined,
          username: msg.from?.username,
        },
        content: { text: msg.text ?? msg.caption },
        timestamp: new Date(msg.date * 1000),
      }
    }
    return null
  }

  async sendMessage(target: ConnectorTarget, content: ConnectorContent): Promise<ConnectorSendResult> {
    if (!this.bot) return { success: false, error: 'Bot not initialized' }
    const chatId = target.ref_keys['chat_id']
    const replyToId = target.reply_to_ref_keys?.['message_id']
    if (!chatId) return { success: false, error: 'Missing chat_id' }

    try {
      const rawText = content.text ?? ''
      const text = content.markdown ? telegramifyMarkdown(rawText, 'escape') : rawText
      const chunks = splitMessage(text)
      let lastSent: { message_id: number; chat: { id: number } } | null = null

      for (let i = 0; i < chunks.length; i++) {
        lastSent = await this.bot.api.sendMessage(
          chatId,
          chunks[i] || '-',
          {
            parse_mode: content.markdown ? 'MarkdownV2' : undefined,
            reply_parameters: i === 0 && replyToId ? { message_id: Number(replyToId) } : undefined,
          }
        )
      }

      return {
        success: true,
        ref_keys: {
          message_id: String(lastSent!.message_id),
          chat_id: String(lastSent!.chat.id),
        },
      }
    } catch (err) {
      return { success: false, error: String(err) }
    }
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
    await this.bot.api.editMessageText(chatId, Number(messageId), content.text ?? '')
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
