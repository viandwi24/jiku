'use client'

import { use, useEffect } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useChat } from '@ai-sdk/react'
import { DefaultChatTransport } from 'ai'
import { isToolUIPart, isTextUIPart, isStaticToolUIPart, getToolName } from 'ai'
import type { UIMessage } from 'ai'
import { api } from '@/lib/api'
import { getToken } from '@/lib/auth'
import { Avatar, AvatarFallback, Badge, Empty, EmptyMedia, EmptyTitle, EmptyDescription } from '@jiku/ui'
import { Conversation, ConversationContent, ConversationScrollButton } from '@jiku/ui/components/ai-elements/conversation.tsx'
import { Message, MessageContent, MessageResponse } from '@jiku/ui/components/ai-elements/message.tsx'
import { PromptInput, PromptInputFooter, PromptInputSubmit, PromptInputTextarea } from '@jiku/ui/components/ai-elements/prompt-input.tsx'
import { Tool, ToolContent, ToolHeader } from '@jiku/ui/components/ai-elements/tool.tsx'
import { Bot } from 'lucide-react'

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001'

interface PageProps {
  params: Promise<{ company: string; project: string; conv: string }>
}

export default function ConversationPage({ params }: PageProps) {
  const { conv: convId } = use(params)

  const { data: convData, isLoading: convLoading } = useQuery({
    queryKey: ['conversation', convId],
    queryFn: () => api.conversations.get(convId),
  })

  const { data: historyData, isLoading: historyLoading } = useQuery({
    queryKey: ['conversation-messages', convId],
    queryFn: () => api.conversations.messages(convId),
  })

  if (convLoading || historyLoading || !historyData) {
    return (
      <div className="flex items-center justify-center h-full">
        <p className="text-sm text-muted-foreground">Loading...</p>
      </div>
    )
  }

  const initialMessages: UIMessage[] = historyData.messages.map(m => ({
    id: m.id,
    role: m.role as 'user' | 'assistant',
    parts: m.parts as UIMessage['parts'],
    metadata: {},
  }))

  return (
    <ChatView
      key={convId}
      convId={convId}
      conversation={convData?.conversation ?? null}
      initialMessages={initialMessages}
    />
  )
}

interface ChatViewProps {
  convId: string
  conversation: { agent: { name: string }; title?: string | null; status: string } | null
  initialMessages: UIMessage[]
}

function ChatView({ convId, conversation, initialMessages }: ChatViewProps) {
  const { messages, sendMessage, status, error } = useChat({
    messages: initialMessages,
    transport: new DefaultChatTransport({
      api: `${API_URL}/api/conversations/${convId}/chat`,
      headers: () => ({
        Authorization: `Bearer ${getToken() ?? ''}`,
      }),
    }),
  })

  useEffect(() => {
    const pending = sessionStorage.getItem('pending_message')
    if (pending) {
      sessionStorage.removeItem('pending_message')
      sendMessage({ text: pending })
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [convId])

  const isStreaming = status === 'streaming' || status === 'submitted'

  function handleSend({ text }: { text: string; files: unknown[] }) {
    if (!text.trim() || isStreaming) return
    sendMessage({ text })
  }

  return (
    <div className="flex flex-col h-full">
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
          <Badge variant="outline" className="text-xs ml-auto">
            {conversation.status}
          </Badge>
        </div>
      )}

      <Conversation className="flex-1">
        <ConversationContent className="max-w-3xl mx-auto w-full">
          {messages.length === 0 && !isStreaming && (
            <Empty>
              <EmptyMedia variant="icon"><Bot /></EmptyMedia>
              <EmptyTitle>Start the conversation</EmptyTitle>
              <EmptyDescription>Type a message below to begin</EmptyDescription>
            </Empty>
          )}

          {messages.map(msg => (
            <Message key={msg.id} from={msg.role}>
              <MessageContent>
                {msg.parts.map((part, i) => {
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
                          {'output' in part && part.output !== undefined && (
                            <pre className="text-xs overflow-auto max-h-40 p-2">
                              {JSON.stringify(part.output, null, 2)}
                            </pre>
                          )}
                        </ToolContent>
                      </Tool>
                    )
                  }
                  return null
                })}
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

      <div className="border-t px-4 py-3 shrink-0">
        <div className="max-w-3xl mx-auto">
          <PromptInput onSubmit={handleSend}>
            <PromptInputTextarea placeholder="Type a message..." />
            <PromptInputFooter>
              <div />
              <PromptInputSubmit status={status} onStop={() => {}} />
            </PromptInputFooter>
          </PromptInput>
        </div>
      </div>
    </div>
  )
}
