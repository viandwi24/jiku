'use client'

import { use } from 'react'
import { useQuery } from '@tanstack/react-query'
import type { UIMessage } from 'ai'
import { api } from '@/lib/api'
import { ConversationViewer } from '@/components/chat/conversation-viewer'

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
    <ConversationViewer
      key={convId}
      convId={convId}
      mode="edit"
      conversation={convData?.conversation ?? null}
      initialMessages={initialMessages}
    />
  )
}
