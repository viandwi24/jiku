'use client'

import { useEffect, useRef, useState, useCallback } from 'react'
import type { UIMessage } from 'ai'
import { api } from '@/lib/api'

const POLL_INTERVAL_MS = 400

/**
 * Reconstructs a partial UIMessage (assistant) from buffered UI stream chunks.
 *
 * The AI SDK UI stream protocol uses chunk types like:
 *   text-start / text-delta / text-end
 *   tool-input-available / tool-output-available
 *   data-* (custom data parts)
 *
 * We accumulate text deltas and tool calls into a single assistant UIMessage.
 */
function chunksToUIMessage(chunks: Record<string, unknown>[]): UIMessage | null {
  if (chunks.length === 0) return null

  // Find the message id from the start chunk
  const startChunk = chunks.find(c => c['type'] === 'start')
  const messageId = (startChunk?.['messageId'] as string | undefined) ?? 'live-assistant'

  // Reconstruct parts
  const textParts: Map<string, { id: string; text: string }> = new Map()
  const toolParts: Map<string, Record<string, unknown>> = new Map()
  const dataParts: { type: string; data: unknown }[] = []

  for (const chunk of chunks) {
    const type = chunk['type'] as string

    if (type === 'text-start') {
      const id = (chunk['id'] as string | undefined) ?? 'text-0'
      textParts.set(id, { id, text: '' })
    } else if (type === 'text-delta') {
      const id = (chunk['id'] as string | undefined) ?? 'text-0'
      const delta = (chunk['delta'] as string | undefined) ?? ''
      const existing = textParts.get(id)
      if (existing) {
        existing.text += delta
      } else {
        textParts.set(id, { id, text: delta })
      }
    } else if (type === 'tool-input-available') {
      // Emit as AI SDK v6 `dynamic-tool` shape directly — matches what
      // `dbPartsToUIParts` produces on post-stream refresh, so the tool
      // accordion renders name/input/output live instead of showing a
      // generic "invocation" label until the refresh swaps shapes.
      const toolCallId = chunk['toolCallId'] as string
      if (toolCallId) {
        toolParts.set(toolCallId, {
          type: 'dynamic-tool',
          toolCallId,
          toolName: (chunk['toolName'] as string) ?? '',
          state: 'input-available',
          input: chunk['input'] ?? {},
        })
      }
    } else if (type === 'tool-output-available') {
      const toolCallId = chunk['toolCallId'] as string
      if (toolCallId) {
        const existing = toolParts.get(toolCallId) ?? {
          type: 'dynamic-tool',
          toolCallId,
          toolName: '',
          state: 'output-available',
          input: {},
        }
        toolParts.set(toolCallId, {
          ...existing,
          state: 'output-available',
          output: chunk['output'],
        })
      }
    } else if (type.startsWith('data-')) {
      dataParts.push({ type, data: chunk['data'] })
    }
  }

  const parts: UIMessage['parts'] = []

  // Add text parts in order
  for (const tp of textParts.values()) {
    if (tp.text) {
      parts.push({ type: 'text', text: tp.text })
    }
  }

  // Add tool parts
  for (const tool of toolParts.values()) {
    parts.push(tool as UIMessage['parts'][number])
  }

  // Add data parts (compaction, usage, etc.)
  for (const dp of dataParts) {
    parts.push(dp as UIMessage['parts'][number])
  }

  if (parts.length === 0) return null

  return {
    id: messageId,
    role: 'assistant',
    parts,
    metadata: {},
  }
}

interface UseLiveConversationOptions {
  conversationId: string
  /** Called when the stream ends — caller should reload messages from DB */
  onDone?: () => void
  /**
   * Called the first time a polling session observes `running:true`. Readonly
   * viewers use this to refresh from DB so the just-persisted user message
   * appears before the assistant stream starts rendering on top of it.
   */
  onStart?: () => void
  /**
   * If true, automatically polls /status every 2s and starts live polling
   * when a run is detected. Useful for readonly tabs that are already open
   * when streaming begins.
   */
  autoDetect?: boolean
}

/**
 * Polls /live-parts while a conversation is streaming.
 * Returns a partial assistant UIMessage reconstructed from in-memory chunks.
 * Returns null when not streaming.
 *
 * Usage: append the returned liveMessage to your existing messages array
 * when it's non-null, replacing it on every update.
 */
export function useLiveConversation({ conversationId, onDone, onStart, autoDetect = false }: UseLiveConversationOptions) {
  const [liveMessage, setLiveMessage] = useState<UIMessage | null>(null)
  const [isStreaming, setIsStreaming] = useState(false)
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const detectTimerRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const onDoneRef = useRef(onDone)
  onDoneRef.current = onDone
  const onStartRef = useRef(onStart)
  onStartRef.current = onStart

  // Tracks whether we've ever observed `running:true` in the current polling
  // session. Without this, callers that start polling BEFORE the server has
  // registered the run (e.g. /regenerate kicked off by the client moments
  // before the server's `streamRegistry.startRun` fires) would see the very
  // first poll return `running:false` and immediately tear down — making the
  // streaming indicator vanish a frame after appearing.
  const seenRunningRef = useRef(false)
  // Hard cap on "waiting for server to register run" — if we never see
  // running=true within this window, give up and call onDone (defensive).
  const startedAtRef = useRef(0)
  const STARTUP_GRACE_MS = 8000

  const stop = useCallback(() => {
    if (timerRef.current) {
      clearInterval(timerRef.current)
      timerRef.current = null
    }
    seenRunningRef.current = false
    setIsStreaming(false)
    setLiveMessage(null)
  }, [])

  const start = useCallback(() => {
    if (timerRef.current) return // already polling

    setIsStreaming(true)
    seenRunningRef.current = false
    startedAtRef.current = Date.now()

    timerRef.current = setInterval(async () => {
      try {
        const { running, chunks } = await api.conversations.liveParts(conversationId)

        if (!running) {
          // Startup grace: tolerate `running:false` until we've either seen
          // `running:true` once OR exhausted the grace window. Prevents the
          // "indicator vanishes a frame after appearing" race where we poll
          // before the server's startRun() has been called.
          if (!seenRunningRef.current && Date.now() - startedAtRef.current < STARTUP_GRACE_MS) {
            return
          }
          stop()
          onDoneRef.current?.()
          return
        }

        const firstObservation = !seenRunningRef.current
        seenRunningRef.current = true
        if (firstObservation) {
          // Fire onStart so readonly viewers can pull the freshly-persisted
          // user message from DB before the assistant stream starts rendering.
          // Without this the assistant response appears first and the user
          // message pops in only after the run finishes + refreshMessages.
          try { onStartRef.current?.() } catch { /* ignore */ }
        }
        const msg = chunksToUIMessage(chunks)
        setLiveMessage(msg)
      } catch {
        // Network error — stop polling, let caller handle
        stop()
      }
    }, POLL_INTERVAL_MS)
  }, [conversationId, stop])

  // Auto-detect: poll /status every 2s and start live polling when a run is detected
  useEffect(() => {
    if (!autoDetect) return

    detectTimerRef.current = setInterval(async () => {
      if (timerRef.current) return // already polling live-parts
      try {
        const { running } = await import('@/lib/api').then(m => m.api.conversations.status(conversationId))
        if (running) start()
      } catch { /* ignore */ }
    }, 2000)

    return () => {
      if (detectTimerRef.current) clearInterval(detectTimerRef.current)
    }
  }, [conversationId, autoDetect, start])

  // Cleanup on unmount or conversationId change
  useEffect(() => {
    return () => {
      if (timerRef.current) clearInterval(timerRef.current)
      if (detectTimerRef.current) clearInterval(detectTimerRef.current)
    }
  }, [conversationId])

  return { liveMessage, isStreaming, start, stop }
}
