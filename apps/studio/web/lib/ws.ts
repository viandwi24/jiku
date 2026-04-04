'use client'

import { useState, useEffect, useRef, useCallback } from 'react'
import { getToken } from './auth'

const WS_URL = process.env.NEXT_PUBLIC_WS_URL ?? 'ws://localhost:3001'

export interface ChatMessageWS {
  id: string
  role: 'user' | 'assistant'
  content: string
}

interface WsEvent {
  type: 'start' | 'chunk' | 'done' | 'error'
  text?: string
  message?: string
}

export function useChat({
  conversationId,
  agentId,
  projectId,
  companyId,
}: {
  conversationId: string
  agentId: string
  projectId: string
  companyId: string
}) {
  const [messages, setMessages] = useState<ChatMessageWS[]>([])
  const [input, setInput] = useState('')
  const [isLoading, setIsLoading] = useState(false)
  const wsRef = useRef<WebSocket | null>(null)
  const pendingAssistantRef = useRef<string>('')
  const pendingIdRef = useRef<string>(crypto.randomUUID())

  useEffect(() => {
    const token = getToken() ?? ''
    const ws = new WebSocket(`${WS_URL}/ws/chat/${conversationId}`, [token])
    wsRef.current = ws

    ws.onmessage = (event) => {
      const data = JSON.parse(event.data as string) as WsEvent
      if (data.type === 'start') {
        pendingAssistantRef.current = ''
        pendingIdRef.current = crypto.randomUUID()
        setIsLoading(true)
      } else if (data.type === 'chunk' && data.text) {
        pendingAssistantRef.current += data.text
        const id = pendingIdRef.current
        setMessages(prev => {
          const last = prev[prev.length - 1]
          if (last?.id === id) {
            return [...prev.slice(0, -1), { ...last, content: pendingAssistantRef.current }]
          }
          return [...prev, { id, role: 'assistant', content: pendingAssistantRef.current }]
        })
      } else if (data.type === 'done') {
        setIsLoading(false)
      } else if (data.type === 'error') {
        setIsLoading(false)
        console.error('[ws] error:', data.message)
      }
    }

    ws.onerror = () => setIsLoading(false)
    ws.onclose = () => setIsLoading(false)

    return () => ws.close()
  }, [conversationId])

  const send = useCallback((text: string) => {
    if (!text.trim() || !wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) return
    const userMessage: ChatMessageWS = { id: crypto.randomUUID(), role: 'user', content: text }
    setMessages(prev => [...prev, userMessage])
    setInput('')
    wsRef.current.send(JSON.stringify({
      input: text,
      agent_id: agentId,
      project_id: projectId,
      company_id: companyId,
    }))
  }, [agentId, projectId, companyId])

  return { messages, input, setInput, send, isLoading }
}
