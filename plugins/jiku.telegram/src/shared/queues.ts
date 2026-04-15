/**
 * Module-level shared state for the Telegram adapters.
 *
 * IMPORTANT: these singletons MUST stay in this one module so both bot-adapter
 * and user-adapter import the SAME instances. Duplicating them per-file would
 * break the invariants (e.g. two bot adapters inside one process sharing the
 * same outbound chat — they'd race each other).
 */

import { INBOUND_BATCH_SIZE } from './constants.ts'

// ─── Per-chat outbound send queue (bot adapter) ───────────────────────────────
//
// Serialize sends per chat_id so we never race two sends to the same chat.
const chatSendQueues = new Map<string, Promise<unknown>>()

export function enqueueForChat<T>(chatId: string, task: () => Promise<T>): Promise<T> {
  const prev = chatSendQueues.get(chatId) ?? Promise.resolve()
  const next = prev.then(task, task)
  chatSendQueues.set(chatId, next)
  void next.finally(() => {
    if (chatSendQueues.get(chatId) === next) chatSendQueues.delete(chatId)
  })
  return next
}

// ─── Inbound event queue — global FIFO with batched concurrency ───────────────

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

export function enqueueInboundEvent(run: () => Promise<void>): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    inboundQueue.push({ run, resolve, reject })
    void drainInboundQueue()
  })
}

// ─── Per-connector last-deactivate timestamps ─────────────────────────────────
//
// Used by BOTH bot-adapter and user-adapter to compute "wait remainder of 30s
// reactivation window". Single map so both adapters share the same accounting.
export const lastDeactivateByConnector = new Map<string, number>()
