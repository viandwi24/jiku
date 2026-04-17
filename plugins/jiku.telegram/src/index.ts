/**
 * Telegram plugin entrypoint.
 *
 * Thin wrapper: all adapter implementation lives in `bot-adapter.ts` and
 * `user-adapter.ts`. Shared helpers / queues / constants live under `shared/`.
 * Userbot queue (rate-limit + flood guards) stays in `userbot-queue.ts`.
 *
 * Refactored from a previous 3,487-line monolith.
 */

import { definePlugin } from '@jiku/kit'
import { StudioPlugin } from '@jiku-plugin/studio'
import { telegramBotAdapter, TelegramBotAdapter } from './bot-adapter.ts'
import { telegramUserAdapter, TelegramUserAdapter } from './user-adapter.ts'

// ─── Public re-exports ────────────────────────────────────────────────────────
// Kept for backward-compat — downstream code (e.g. apps/studio/server) imports
// adapters by name.
export { telegramBotAdapter, TelegramBotAdapter }
export { telegramUserAdapter, TelegramUserAdapter }

/** @deprecated Use `telegramBotAdapter`. Kept as alias for backward-compat. */
export const telegramAdapter = telegramBotAdapter

export default definePlugin({
  meta: {
    id: 'jiku.telegram',
    name: 'Telegram',
    version: '1.0.0',
    description: 'Telegram integration — connector adapter, bot polling via grammy, and more.',
    author: 'Jiku',
    icon: '✈️',
    category: 'channel',
  },
  depends: [StudioPlugin],
  setup(ctx) {
    telegramBotAdapter.attachConsole(ctx.console)
    telegramUserAdapter.attachConsole(ctx.console)
    ctx.connector.register(telegramBotAdapter)
    ctx.connector.register(telegramUserAdapter)
  },
})
