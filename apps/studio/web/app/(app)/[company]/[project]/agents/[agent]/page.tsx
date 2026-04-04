'use client'

import { use, useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { api } from '@/lib/api'
import { useAuthStore } from '@/lib/store/auth.store'
import { ChatInterface } from '@/components/agent/chat/chat-interface'
import { Button } from '@jiku/ui'
import { Settings, MessageSquarePlus } from 'lucide-react'
import Link from 'next/link'

interface PageProps {
  params: Promise<{ company: string; project: string; agent: string }>
}

export default function AgentChatPage({ params }: PageProps) {
  const { company: companySlug, project: projectSlug, agent: agentId } = use(params)
  const user = useAuthStore(s => s.user)
  const qc = useQueryClient()

  const { data: companyData } = useQuery({
    queryKey: ['company', companySlug],
    queryFn: async () => {
      const { companies } = await api.companies.list()
      return companies.find(c => c.slug === companySlug) ?? null
    },
  })

  const { data: projectsData } = useQuery({
    queryKey: ['projects', companyData?.id],
    queryFn: () => api.projects.list(companyData!.id),
    enabled: !!companyData?.id,
  })

  const project = projectsData?.projects.find(p => p.slug === projectSlug)

  const { data: agentsData } = useQuery({
    queryKey: ['agents', project?.id],
    queryFn: () => api.agents.list(project!.id),
    enabled: !!project?.id,
  })

  const agent = agentsData?.agents.find(a => a.id === agentId)

  const { data: convsData } = useQuery({
    queryKey: ['conversations', agentId],
    queryFn: () => api.conversations.list(agentId),
    enabled: !!agentId,
  })

  const [activeConvId, setActiveConvId] = useState<string | null>(null)
  const activeConversation = activeConvId
    ? convsData?.conversations.find(c => c.id === activeConvId)
    : convsData?.conversations[0]

  const createConv = useMutation({
    mutationFn: () => api.conversations.create(agentId),
    onSuccess: (data) => {
      qc.invalidateQueries({ queryKey: ['conversations', agentId] })
      setActiveConvId(data.conversation.id)
    },
  })

  const settingsPath = `/${companySlug}/${projectSlug}/agents/${agentId}/settings`

  return (
    <div className="flex h-[calc(100vh-56px)]">
      {/* Conversation sidebar */}
      <div className="w-56 border-r flex flex-col bg-sidebar shrink-0">
        <div className="flex items-center justify-between px-3 py-2 border-b">
          <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">Conversations</span>
          <button
            type="button"
            onClick={() => createConv.mutate()}
            className="p-1 hover:bg-sidebar-accent rounded"
            title="New conversation"
          >
            <MessageSquarePlus className="w-3.5 h-3.5" />
          </button>
        </div>
        <div className="flex-1 overflow-y-auto p-1 space-y-0.5">
          {convsData?.conversations.map(conv => (
            <button
              key={conv.id}
              type="button"
              onClick={() => setActiveConvId(conv.id)}
              className={`w-full text-left px-2.5 py-2 rounded text-xs truncate transition-colors ${
                activeConversation?.id === conv.id
                  ? 'bg-sidebar-accent text-sidebar-accent-foreground'
                  : 'hover:bg-sidebar-accent/50'
              }`}
            >
              {conv.title ?? 'New conversation'}
            </button>
          ))}
          {(!convsData?.conversations.length) && (
            <p className="text-xs text-muted-foreground text-center py-4">No conversations yet</p>
          )}
        </div>
      </div>

      {/* Chat area */}
      <div className="flex-1 flex flex-col min-w-0">
        {/* Agent header */}
        <div className="flex items-center justify-between px-4 py-2.5 border-b shrink-0">
          <div>
            <p className="font-medium text-sm">{agent?.name ?? agentId}</p>
            <p className="text-xs text-muted-foreground">{agent?.model_id}</p>
          </div>
          <Link href={settingsPath}>
            <Button variant="ghost" size="sm">
              <Settings className="w-4 h-4 mr-1" />
              Settings
            </Button>
          </Link>
        </div>

        {activeConversation && companyData && project ? (
          <ChatInterface
            conversationId={activeConversation.id}
            agentId={agentId}
            projectId={project.id}
            companyId={companyData.id}
          />
        ) : (
          <div className="flex-1 flex flex-col items-center justify-center gap-3 text-muted-foreground">
            <p className="text-sm">No conversation selected</p>
            <Button size="sm" onClick={() => createConv.mutate()} disabled={createConv.isPending}>
              <MessageSquarePlus className="w-4 h-4 mr-1" />
              Start a conversation
            </Button>
          </div>
        )}
      </div>
    </div>
  )
}
