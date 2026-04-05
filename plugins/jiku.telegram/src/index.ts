import { z } from 'zod'
import { definePlugin, ConnectorAdapter } from '@jiku/kit'
import type { ConnectorEvent, ConnectorContext, ConnectorTarget, ConnectorContent, ConnectorSendResult } from '@jiku/types'
import telegramifyMarkdown from 'telegramify-markdown'
import ConnectorPlugin from '@jiku/plugin-connector'

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
    // Try to split on newline near the boundary
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
  private bot: any = null

  async onActivate(ctx: ConnectorContext): Promise<void> {
    const { Bot } = await import('grammy')
    const token = ctx.fields['bot_token']
    if (!token) throw new Error('[telegram] bot_token missing in credentials')

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

    // Start polling
    this.bot.start({ drop_pending_updates: false }).catch((err: unknown) => {
      console.error('[telegram] polling error:', err)
    })

    console.log('[telegram] bot started (polling)')
  }

  async onDeactivate(): Promise<void> {
    if (this.bot) {
      await this.bot.stop().catch(() => {})
      this.bot = null
      console.log('[telegram] bot stopped')
    }
  }

  parseEvent(raw: unknown): ConnectorEvent | null {
    // Used for webhook mode — parse raw Telegram Update object
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
          chunks[i],
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
    await this.bot.api.setMessageReaction(chatId, Number(messageId), [{ type: 'emoji', emoji }])
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
  depends: [ConnectorPlugin],
  setup(ctx) {
    ctx.connector.register(telegramAdapter)
  },
})
