'use client'

import { useEffect, useRef, useState } from 'react'
import { getToken } from '@/lib/auth'

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001'

export type ObserverStatus = 'idle' | 'connecting' | 'streaming' | 'done' | 'error'

export interface ObservedChunk {
  type: string
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  [key: string]: any
}

interface UseConversationObserverOptions {
  conversationId: string
  /** Called for each parsed chunk received from the stream */
  onChunk?: (chunk: ObservedChunk) => void
  /** Called when the stream ends */
  onDone?: () => void
}

/**
 * Attaches to an in-progress server-side run as a read-only observer.
 * Connects to GET /conversations/:id/stream (SSE) and fires onChunk for each event.
 *
 * Returns:
 * - status: current observer state
 * - attach(): manually start observing (call after confirming conversation is running)
 * - detach(): stop observing
 */
export function useConversationObserver({ conversationId, onChunk, onDone }: UseConversationObserverOptions) {
  const [status, setStatus] = useState<ObserverStatus>('idle')
  const esRef = useRef<EventSource | null>(null)

  function attach() {
    if (esRef.current) return // already attached

    setStatus('connecting')

    const token = getToken() ?? ''
    // EventSource doesn't support custom headers — pass token as query param
    const url = `${API_URL}/api/conversations/${conversationId}/stream?token=${encodeURIComponent(token)}`
    const es = new EventSource(url)
    esRef.current = es

    es.onopen = () => setStatus('streaming')

    es.onmessage = (event) => {
      try {
        const chunk = JSON.parse(event.data) as ObservedChunk
        onChunk?.(chunk)
      } catch { /* ignore malformed */ }
    }

    es.addEventListener('done', () => {
      setStatus('done')
      onDone?.()
      detach()
    })

    es.onerror = () => {
      setStatus('error')
      detach()
    }
  }

  function detach() {
    esRef.current?.close()
    esRef.current = null
  }

  useEffect(() => {
    return () => detach()
  }, [conversationId])

  return { status, attach, detach }
}
