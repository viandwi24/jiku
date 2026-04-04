'use client'

import { useRef, useEffect, useState } from 'react'
import { useChat } from '@ai-sdk/react'
import { DefaultChatTransport } from 'ai'
import { Bot, User } from 'lucide-react'
import { cn } from '@/lib/utils'
import { getToken } from '@/lib/auth'

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001'

interface ChatInterfaceProps {
  conversationId: string
  agentId: string
  projectId: string
  companyId: string
}

export function ChatInterface({ conversationId, agentId, projectId, companyId }: ChatInterfaceProps) {
  const [input, setInput] = useState('')
  const bottomRef = useRef<HTMLDivElement>(null)

  const { messages, sendMessage, status, error } = useChat({
    transport: new DefaultChatTransport({
      api: `${API_URL}/api/conversations/${conversationId}/chat`,
      headers: () => ({
        Authorization: `Bearer ${getToken() ?? ''}`,
      }),
      prepareSendMessagesRequest: ({ id, messages }) => ({
        body: {
          id,
          messages,
          agent_id: agentId,
          project_id: projectId,
          company_id: companyId,
        },
      }),
    }),
  })

  const isLoading = status === 'streaming' || status === 'submitted'

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages])

  function handleSend() {
    if (!input.trim() || isLoading) return
    sendMessage({ text: input })
    setInput('')
  }

  return (
    <div className="flex flex-col h-full">
      {/* Messages */}
      <div className="flex-1 overflow-y-auto p-4 space-y-4">
        {messages.length === 0 && (
          <div className="flex flex-col items-center justify-center h-full text-center gap-2 text-muted-foreground">
            <Bot className="w-8 h-8" />
            <p className="text-sm">Start a conversation</p>
          </div>
        )}
        {messages.map(msg => (
          <div key={msg.id} className={cn('flex gap-2', msg.role === 'user' ? 'justify-end' : 'justify-start')}>
            {msg.role === 'assistant' && (
              <div className="w-7 h-7 rounded-full bg-primary/10 flex items-center justify-center shrink-0 mt-0.5">
                <Bot className="w-4 h-4 text-primary" />
              </div>
            )}
            <div className={cn(
              'max-w-[75%] rounded-xl px-3.5 py-2.5 text-sm',
              msg.role === 'user'
                ? 'bg-primary text-primary-foreground rounded-br-sm'
                : 'bg-muted rounded-bl-sm',
            )}>
              <p className="whitespace-pre-wrap break-words">
                {msg.parts.map((part, i) =>
                  part.type === 'text' ? <span key={i}>{part.text}</span> : null,
                )}
              </p>
            </div>
            {msg.role === 'user' && (
              <div className="w-7 h-7 rounded-full bg-muted flex items-center justify-center shrink-0 mt-0.5">
                <User className="w-4 h-4" />
              </div>
            )}
          </div>
        ))}
        {error && (
          <div className="flex gap-2 items-start">
            <div className="w-7 h-7 rounded-full bg-destructive/10 flex items-center justify-center shrink-0 mt-0.5">
              <Bot className="w-4 h-4 text-destructive" />
            </div>
            <div className="bg-destructive/10 text-destructive rounded-xl rounded-bl-sm px-3.5 py-2.5 text-sm max-w-[75%]">
              <p className="font-medium">Error</p>
              <p className="text-xs mt-0.5 opacity-80">{error.message}</p>
            </div>
          </div>
        )}
        {isLoading && (
          <div className="flex gap-2 items-start">
            <div className="w-7 h-7 rounded-full bg-primary/10 flex items-center justify-center shrink-0">
              <Bot className="w-4 h-4 text-primary" />
            </div>
            <div className="bg-muted rounded-xl rounded-bl-sm px-3.5 py-3 flex gap-1">
              <span className="w-1.5 h-1.5 bg-muted-foreground rounded-full animate-bounce [animation-delay:-0.3s]" />
              <span className="w-1.5 h-1.5 bg-muted-foreground rounded-full animate-bounce [animation-delay:-0.15s]" />
              <span className="w-1.5 h-1.5 bg-muted-foreground rounded-full animate-bounce" />
            </div>
          </div>
        )}
        <div ref={bottomRef} />
      </div>

      {/* Input */}
      <div className="p-4 border-t">
        <div className="flex gap-2">
          <textarea
            className="flex-1 resize-none rounded-lg border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring min-h-[42px] max-h-32"
            value={input}
            onChange={e => setInput(e.target.value)}
            onKeyDown={e => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault()
                handleSend()
              }
            }}
            placeholder="Type a message... (Enter to send)"
            rows={1}
          />
          <button
            type="button"
            onClick={handleSend}
            disabled={isLoading || !input.trim()}
            className="px-3 py-2 rounded-lg bg-primary text-primary-foreground text-sm font-medium disabled:opacity-50 hover:bg-primary/90 transition-colors"
          >
            Send
          </button>
        </div>
      </div>
    </div>
  )
}
