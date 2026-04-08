import type { CallerContext, ChatAttachment, ChatFilePart, JikuRunResult } from '@jiku/types'

export interface QueuedMessage {
  input: string
  caller: CallerContext
  attachments?: ChatAttachment[]
  input_file_parts?: ChatFilePart[]
  resolve: (result: JikuRunResult) => void
  reject: (error: Error) => void
  enqueued_at: number
}

const MAX_QUEUE_SIZE = 10
const QUEUE_TIMEOUT_MS = 5 * 60 * 1000 // 5 minutes

class ConversationQueue {
  private queues = new Map<string, QueuedMessage[]>()

  /** Enqueue a message for a conversation that is currently running. */
  enqueue(conversationId: string, msg: Omit<QueuedMessage, 'enqueued_at'>): void {
    let queue = this.queues.get(conversationId)
    if (!queue) {
      queue = []
      this.queues.set(conversationId, queue)
    }

    // Overflow protection
    if (queue.length >= MAX_QUEUE_SIZE) {
      msg.reject(new Error('Queue is full. Please wait for the agent to finish processing.'))
      return
    }

    queue.push({ ...msg, enqueued_at: Date.now() })
  }

  /** Dequeue the next message for a conversation. Returns null if queue is empty. */
  dequeue(conversationId: string): QueuedMessage | null {
    const queue = this.queues.get(conversationId)
    if (!queue || queue.length === 0) {
      this.queues.delete(conversationId)
      return null
    }

    // Skip timed-out messages
    while (queue.length > 0) {
      const next = queue.shift()!
      if (Date.now() - next.enqueued_at > QUEUE_TIMEOUT_MS) {
        next.reject(new Error('Queued message timed out.'))
        continue
      }
      if (queue.length === 0) this.queues.delete(conversationId)
      return next
    }

    this.queues.delete(conversationId)
    return null
  }

  /** Check if there are queued messages for a conversation. */
  hasQueued(conversationId: string): boolean {
    const queue = this.queues.get(conversationId)
    return !!queue && queue.length > 0
  }

  /** Get queue length for a conversation. */
  queueLength(conversationId: string): number {
    return this.queues.get(conversationId)?.length ?? 0
  }

  /** Clear all queued messages for a conversation (e.g. on error). */
  clearQueue(conversationId: string): void {
    const queue = this.queues.get(conversationId)
    if (queue) {
      for (const msg of queue) {
        msg.reject(new Error('Queue cleared due to error.'))
      }
      this.queues.delete(conversationId)
    }
  }
}

export const conversationQueue = new ConversationQueue()
