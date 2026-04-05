'use client'

import { useEffect, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useChat } from '@ai-sdk/react'
import { DefaultChatTransport } from 'ai'
import { isToolUIPart, isTextUIPart, isStaticToolUIPart, getToolName } from 'ai'
import type { UIMessage } from 'ai'
import { api } from '@/lib/api'
import { getToken } from '@/lib/auth'
import { useConversationObserver } from '@/hooks/use-conversation-observer'
import { Avatar, AvatarFallback, Badge, Empty, EmptyMedia, EmptyTitle, EmptyDescription } from '@jiku/ui'
import { Conversation, ConversationContent, ConversationScrollButton } from '@jiku/ui/components/ai-elements/conversation.tsx'
import { Message, MessageContent, MessageResponse } from '@jiku/ui/components/ai-elements/message.tsx'
import { PromptInput, PromptInputFooter, PromptInputSubmit, PromptInputTextarea } from '@jiku/ui/components/ai-elements/prompt-input.tsx'
import { Tool, ToolContent, ToolHeader, ToolInput, ToolOutput } from '@jiku/ui/components/ai-elements/tool.tsx'
import { Bot } from 'lucide-react'
import { ContextBar } from './context-bar'
import { CompactionIndicator } from './compaction-indicator'
import { MemoryPreviewSheet } from './memory-preview-sheet'

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001'

interface CompactionEvent {
  summary: string
  removed_count: number
  token_saved: number
}

export interface ConversationViewerProps {
  convId: string
  /**
   * edit — full chat UI with input bar (default for chat page)
   * readonly — messages + context bar, no input bar (for run detail)
   */
  mode: 'edit' | 'readonly'
  conversation: {
    agent: { id: string; name: string }
    title?: string | null
    status: string
  } | null
  initialMessages: UIMessage[]
}

export function ConversationViewer({ convId, mode, conversation, initialMessages }: ConversationViewerProps) {
  const [compactionEvents, setCompactionEvents] = useState<CompactionEvent[]>([])
  const [memorySheetOpen, setMemorySheetOpen] = useState(false)
  const qc = useQueryClient()

  const { messages, sendMessage, status, error, setMessages } = useChat({
    messages: initialMessages,
    transport: new DefaultChatTransport({
      api: `${API_URL}/api/conversations/${convId}/chat`,
      headers: () => ({
        Authorization: `Bearer ${getToken() ?? ''}`,
      }),
    }),
  })

  const isStreaming = status === 'streaming' || status === 'submitted'

  // Detect jiku-compact data parts in assistant messages
  useEffect(() => {
    const lastMsg = messages[messages.length - 1]
    if (!lastMsg || lastMsg.role !== 'assistant') return
    for (const part of lastMsg.parts) {
      if (part.type === 'data-jiku-compact') {
        const d = (part as { type: string; data: CompactionEvent }).data
        setCompactionEvents(prev => {
          const key = `${d.removed_count}:${d.token_saved}`
          if (prev.some(e => `${e.removed_count}:${e.token_saved}` === key)) return prev
          return [...prev, d]
        })
      }
    }
  }, [messages])

  // Observer: attach as SSE observer if already running
  const { attach } = useConversationObserver({
    conversationId: convId,
    onDone: async () => {
      const fresh = await api.conversations.messages(convId)
      setMessages(fresh.messages.map(m => ({
        id: m.id,
        role: m.role as 'user' | 'assistant',
        parts: m.parts as UIMessage['parts'],
        metadata: {},
      })))
      qc.invalidateQueries({ queryKey: ['conversations'] })
    },
  })

  useEffect(() => {
    api.conversations.status(convId).then(({ running }) => {
      if (running) attach()
    }).catch(() => { /* ignore */ })
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [convId])

  // In edit mode: check for pending message from session storage
  useEffect(() => {
    if (mode !== 'edit') return
    const pending = sessionStorage.getItem('pending_message')
    if (pending) {
      sessionStorage.removeItem('pending_message')
      sendMessage({ text: pending })
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [convId, mode])

  // Refresh sidebar after each turn (edit mode only)
  useEffect(() => {
    if (mode === 'edit' && !isStreaming) {
      qc.invalidateQueries({ queryKey: ['conversations'] })
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isStreaming])

  function handleSend({ text }: { text: string; files: unknown[] }) {
    if (!text.trim() || isStreaming || mode !== 'edit') return
    sendMessage({ text })
  }

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      {conversation && (
        <div className="flex items-center gap-2 px-4 py-2.5 border-b shrink-0">
          <Avatar className="h-6 w-6">
            <AvatarFallback className="text-xs">
              {conversation.agent.name.slice(0, 2).toUpperCase()}
            </AvatarFallback>
          </Avatar>
          <span className="font-medium text-sm">{conversation.agent.name}</span>
          {conversation.title && (
            <span className="text-xs text-muted-foreground truncate">— {conversation.title}</span>
          )}
          <div className="ml-auto flex items-center gap-2">
            {mode === 'readonly' && (
              <Badge variant="outline" className="text-xs text-muted-foreground">readonly</Badge>
            )}
            <Badge variant="outline" className="text-xs">
              {conversation.status}
            </Badge>
          </div>
        </div>
      )}

      {/* Message list */}
      <Conversation className="flex-1">
        <ConversationContent className="max-w-3xl mx-auto w-full">
          {messages.length === 0 && !isStreaming && (
            <Empty>
              <EmptyMedia variant="icon"><Bot /></EmptyMedia>
              <EmptyTitle>{mode === 'readonly' ? 'No messages' : 'Start the conversation'}</EmptyTitle>
              {mode === 'edit' && <EmptyDescription>Type a message below to begin</EmptyDescription>}
            </Empty>
          )}

          {compactionEvents.map((ev, i) => (
            <CompactionIndicator
              key={`compact-${i}`}
              summary={ev.summary}
              removedCount={ev.removed_count}
              tokenSaved={ev.token_saved}
            />
          ))}

          {messages.map(msg => (
            <Message key={msg.id} from={msg.role}>
              <MessageContent>
                {msg.role === 'assistant' && msg.parts.some(p =>
                  p.type === 'text' && (p as { type: 'text'; text: string }).text.startsWith('[Context Summary]')
                ) ? (
                  <CompactionIndicator
                    summary={(() => {
                      const part = msg.parts.find(p => p.type === 'text') as { type: 'text'; text: string } | undefined
                      return part?.text.replace('[Context Summary]\n', '') ?? ''
                    })()}
                    removedCount={0}
                    tokenSaved={0}
                  />
                ) : (
                  msg.parts.map((part, i) => {
                    if (isTextUIPart(part)) {
                      return msg.role === 'assistant'
                        ? <MessageResponse key={i}>{part.text}</MessageResponse>
                        : <span key={i} className="whitespace-pre-wrap">{part.text}</span>
                    }
                    if (isToolUIPart(part)) {
                      const toolName = getToolName(part)
                      return (
                        <Tool key={i}>
                          {isStaticToolUIPart(part) ? (
                            <ToolHeader type={part.type} state={part.state} />
                          ) : (
                            <ToolHeader type={part.type} state={part.state} toolName={toolName} />
                          )}
                          <ToolContent>
                            {'input' in part && part.input !== undefined && (
                              <ToolInput input={part.input} />
                            )}
                            {'output' in part && (
                              <ToolOutput output={part.output} errorText={part.errorText} />
                            )}
                          </ToolContent>
                        </Tool>
                      )
                    }
                    return null
                  })
                )}
              </MessageContent>
            </Message>
          ))}

          {error && (
            <div className="text-sm text-destructive bg-destructive/10 rounded-lg px-3 py-2">
              {error.message}
            </div>
          )}
        </ConversationContent>
        <ConversationScrollButton />
      </Conversation>

      {/* Footer: input bar (edit) or context bar only (readonly) */}
      <div className="border-t px-4 py-3 shrink-0">
        <div className="max-w-3xl mx-auto">
          {mode === 'edit' && (
            <PromptInput onSubmit={handleSend}>
              <PromptInputTextarea placeholder="Type a message..." />
              <PromptInputFooter>
                <div />
                <PromptInputSubmit status={status} onStop={() => {}} />
              </PromptInputFooter>
            </PromptInput>
          )}

          {conversation && (
            <div className={`flex items-center gap-3 ${mode === 'edit' ? 'mt-2 px-1' : ''}`}>
              <ContextBar
                agentId={conversation.agent.id}
                conversationId={convId}
                isStreaming={isStreaming}
                onMemoryClick={() => setMemorySheetOpen(true)}
              />
            </div>
          )}
        </div>
      </div>

      <MemoryPreviewSheet
        agentId={conversation?.agent.id ?? ''}
        conversationId={convId}
        open={memorySheetOpen}
        onOpenChange={setMemorySheetOpen}
      />
    </div>
  )
}
