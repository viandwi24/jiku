'use client'

import { use } from 'react'
import { useQuery } from '@tanstack/react-query'
import type { UIMessage } from 'ai'
import { api } from '@/lib/api'
import { dbMessageToUIMessage } from '@/lib/messages'
import { ConversationViewer } from '@/components/chat/conversation-viewer'

interface PageProps {
  params: Promise<{ company: string; project: string; conv: string }>
}

export default function ConversationPage({ params }: PageProps) {
  const { company: companySlug, project: projectSlug, conv: convId } = use(params)

  const { data: companyData } = useQuery({
    queryKey: ['companies'],
    queryFn: () => api.companies.list(),
    select: d => d.companies.find(c => c.slug === companySlug) ?? null,
  })

  const { data: projectsData } = useQuery({
    queryKey: ['projects', companyData?.id],
    queryFn: () => api.projects.list(companyData!.id),
    enabled: !!companyData?.id,
  })
  const project = projectsData?.projects.find(p => p.slug === projectSlug)

  const { data: convData, isLoading: convLoading } = useQuery({
    queryKey: ['conversation', convId],
    queryFn: () => api.conversations.get(convId),
  })

  const { data: historyData, isLoading: historyLoading } = useQuery({
    queryKey: ['conversation-messages', convId],
    queryFn: () => api.conversations.messages(convId),
    // Always refetch when component mounts — prevents stale cache after navigation
    refetchOnMount: 'always',
  })

  if (convLoading || historyLoading || !historyData) {
    return (
      <div className="flex items-center justify-center h-full">
        <p className="text-sm text-muted-foreground">Loading...</p>
      </div>
    )
  }

  const initialMessages: UIMessage[] = historyData.messages.map(dbMessageToUIMessage)

  return (
    <ConversationViewer
      key={convId}
      convId={convId}
      mode="edit"
      conversation={convData?.conversation ?? null}
      initialMessages={initialMessages}
      projectId={project?.id}
    />
  )
}
