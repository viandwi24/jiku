'use client'

import { useState } from 'react'
import { usePathname, useRouter } from 'next/navigation'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { api } from '@/lib/api'
import { Avatar, AvatarFallback, Button, Input, ScrollArea, Empty, EmptyMedia, EmptyTitle, EmptyDescription } from '@jiku/ui'
import { toast } from 'sonner'
import { MessageSquare, Plus } from 'lucide-react'
import { cn } from '@/lib/utils'
import { formatDistanceToNow } from 'date-fns'

interface ConversationListPanelProps {
  companySlug: string
  projectSlug: string
}

export function ConversationListPanel({ companySlug, projectSlug }: ConversationListPanelProps) {
  const router = useRouter()
  const pathname = usePathname()
  const qc = useQueryClient()
  const [search, setSearch] = useState('')

  const { data: companyData } = useQuery({
    queryKey: ['companies'],
    queryFn: () => api.companies.list(),
    select: (d) => d.companies.find(c => c.slug === companySlug) ?? null,
  })

  const { data: projectsData } = useQuery({
    queryKey: ['projects', companyData?.id],
    queryFn: () => api.projects.list(companyData!.id),
    enabled: !!companyData?.id,
  })
  const project = projectsData?.projects.find(p => p.slug === projectSlug)

  const { data, isLoading } = useQuery({
    queryKey: ['conversations', project?.id],
    queryFn: () => api.conversations.listProject(project!.id),
    enabled: !!project?.id,
  })

  const conversations = (data?.conversations ?? []).filter(c =>
    !search || c.agent.name.toLowerCase().includes(search.toLowerCase()) ||
    (c.title ?? '').toLowerCase().includes(search.toLowerCase()),
  )

  const base = `/studio/companies/${companySlug}/projects/${projectSlug}/chats`

  return (
    <div className="flex flex-col h-full border-r">
      <div className="flex items-center justify-between px-3 py-3 border-b shrink-0">
        <h2 className="font-semibold text-sm">Chats</h2>
        <Button size="sm" variant="outline" className="h-7 gap-1 text-xs" onClick={() => router.push(base)}>
          <Plus className="h-3.5 w-3.5" />
          New
        </Button>
      </div>

      <div className="px-2 py-2 border-b shrink-0">
        <Input
          placeholder="Search..."
          value={search}
          onChange={e => setSearch(e.target.value)}
          className="h-7 text-xs"
        />
      </div>

      <ScrollArea className="flex-1">
        {isLoading ? (
          <div className="p-3 space-y-2">
            {[...Array(4)].map((_, i) => (
              <div key={i} className="flex gap-2.5 px-1 py-2">
                <div className="h-7 w-7 rounded-full bg-muted animate-pulse shrink-0" />
                <div className="flex-1 space-y-1.5">
                  <div className="h-3 w-24 bg-muted animate-pulse rounded" />
                  <div className="h-3 w-32 bg-muted animate-pulse rounded" />
                </div>
              </div>
            ))}
          </div>
        ) : conversations.length === 0 ? (
          <Empty className="py-10 border-0">
            <EmptyMedia variant="icon"><MessageSquare /></EmptyMedia>
            <EmptyTitle>{search ? 'No results' : 'No conversations'}</EmptyTitle>
            <EmptyDescription>{search ? 'Try a different search term' : 'Start a new chat'}</EmptyDescription>
          </Empty>
        ) : (
          conversations.map(conv => {
            const href = `${base}/${conv.id}`
            const isActive = pathname === href
            return (
              <button
                key={conv.id}
                type="button"
                onClick={() => router.push(href)}
                className={cn(
                  'w-full flex items-start gap-2.5 px-3 py-2.5 text-left hover:bg-muted/50 transition-colors border-b border-border/40',
                  isActive && 'bg-muted border-l-2 border-l-primary pl-[10px]',
                )}
              >
                <Avatar className="h-7 w-7 mt-0.5 shrink-0">
                  <AvatarFallback className="text-xs">
                    {conv.agent.name.slice(0, 2).toUpperCase()}
                  </AvatarFallback>
                </Avatar>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center justify-between gap-1">
                    <span className="text-xs font-medium truncate">{conv.agent.name}</span>
                    {conv.updated_at && (
                      <span className="text-xs text-muted-foreground shrink-0">
                        {formatDistanceToNow(new Date(conv.updated_at), { addSuffix: false })}
                      </span>
                    )}
                  </div>
                  <p className="text-xs text-muted-foreground truncate mt-0.5">
                    {conv.title ?? conv.last_message ?? 'No messages yet'}
                  </p>
                </div>
              </button>
            )
          })
        )}
      </ScrollArea>
    </div>
  )
}
