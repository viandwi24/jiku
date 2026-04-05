'use client'

import { useState } from 'react'
import { usePathname, useRouter } from 'next/navigation'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '@/lib/api'
import type { ConversationItemWithAgent } from '@/lib/api'
import { Avatar, AvatarFallback, Button, Input, Empty, EmptyMedia, EmptyTitle, EmptyDescription } from '@jiku/ui'
import { MessageSquare, Plus, ChevronDown } from 'lucide-react'
import { cn } from '@/lib/utils'
import { isToday, isYesterday, isThisWeek, isThisMonth, subDays } from 'date-fns'

const PAGE_SIZE = 10

interface ConversationListPanelProps {
  companySlug: string
  projectSlug: string
}

// ── Group label ────────────────────────────────────────────────────────────────

function getGroupLabel(date: Date): string {
  if (isToday(date)) return 'Today'
  if (isYesterday(date)) return 'Yesterday'
  if (isThisWeek(date)) return 'This week'
  if (isThisMonth(date)) return 'This month'
  if (date >= subDays(new Date(), 90)) return 'Last 3 months'
  return 'Older'
}

const GROUP_ORDER = ['Today', 'Yesterday', 'This week', 'This month', 'Last 3 months', 'Older']

function groupConversations(convs: ConversationItemWithAgent[]): { label: string; items: ConversationItemWithAgent[] }[] {
  const map = new Map<string, ConversationItemWithAgent[]>()
  for (const conv of convs) {
    const label = getGroupLabel(new Date(conv.updated_at ?? conv.created_at ?? Date.now()))
    if (!map.has(label)) map.set(label, [])
    map.get(label)!.push(conv)
  }
  return GROUP_ORDER
    .filter(l => map.has(l))
    .map(l => ({ label: l, items: map.get(l)! }))
}

// ── Conversation item ──────────────────────────────────────────────────────────

function ConvItem({ conv, base, isActive, onClick }: {
  conv: ConversationItemWithAgent
  base: string
  isActive: boolean
  onClick: () => void
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'w-full flex items-start gap-2.5 px-3 py-2.5 text-left hover:bg-muted/50 transition-colors border-b border-border/40 overflow-hidden',
        isActive && 'bg-muted border-l-2 border-l-primary pl-2.5',
      )}
    >
      <Avatar className="h-7 w-7 mt-0.5 shrink-0">
        <AvatarFallback className="text-xs">
          {conv.agent.name.slice(0, 2).toUpperCase()}
        </AvatarFallback>
      </Avatar>
      <div className="flex-1 overflow-hidden" style={{ minWidth: 0 }}>
        <div className="flex items-center gap-1">
          <span className="text-xs font-medium flex-1 overflow-hidden text-ellipsis whitespace-nowrap">
            {conv.agent.name}
          </span>
        </div>
        <p className="text-xs text-muted-foreground mt-0.5 overflow-hidden text-ellipsis whitespace-nowrap">
          {conv.title ?? conv.last_message ?? 'No messages yet'}
        </p>
      </div>
    </button>
  )
}

// ── Group section ──────────────────────────────────────────────────────────────

function GroupSection({ label, items, base, pathname, router, isFirst }: {
  label: string
  items: ConversationItemWithAgent[]
  base: string
  pathname: string
  router: ReturnType<typeof useRouter>
  isFirst: boolean
}) {
  // Today starts expanded, rest collapsed
  const [expanded, setExpanded] = useState(isFirst)
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE)

  const visible = items.slice(0, visibleCount)
  const hasMore = visibleCount < items.length

  return (
    <div>
      {/* Section header */}
      <button
        type="button"
        onClick={() => setExpanded(e => !e)}
        className="w-full flex items-center justify-between px-3 py-1.5 text-left hover:bg-muted/30 transition-colors"
      >
        <span className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground/60">
          {label}
        </span>
        <ChevronDown className={cn(
          'h-3 w-3 text-muted-foreground/40 transition-transform',
          expanded && 'rotate-180',
        )} />
      </button>

      {/* Items */}
      {expanded && (
        <>
          {visible.map(conv => (
            <ConvItem
              key={conv.id}
              conv={conv}
              base={base}
              isActive={pathname === `${base}/${conv.id}`}
              onClick={() => router.push(`${base}/${conv.id}`)}
            />
          ))}

          {hasMore && (
            <button
              type="button"
              onClick={() => setVisibleCount(c => c + PAGE_SIZE)}
              className="w-full px-3 py-2 text-xs text-muted-foreground hover:text-foreground hover:bg-muted/30 transition-colors text-center border-b border-border/40"
            >
              Load more
            </button>
          )}
        </>
      )}
    </div>
  )
}

// ── Main panel ─────────────────────────────────────────────────────────────────

export function ConversationListPanel({ companySlug, projectSlug }: ConversationListPanelProps) {
  const router = useRouter()
  const pathname = usePathname()
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

  const filtered = (data?.conversations ?? []).filter(c =>
    !search ||
    c.agent.name.toLowerCase().includes(search.toLowerCase()) ||
    (c.title ?? '').toLowerCase().includes(search.toLowerCase()) ||
    (c.last_message ?? '').toLowerCase().includes(search.toLowerCase()),
  )

  const groups = groupConversations(filtered)
  const base = `/studio/companies/${companySlug}/projects/${projectSlug}/chats`

  return (
    <div className="flex flex-col h-full border-r">
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-3 border-b shrink-0">
        <h2 className="font-semibold text-sm">Chats</h2>
        <Button size="sm" variant="outline" className="h-7 gap-1 text-xs" onClick={() => router.push(base)}>
          <Plus className="h-3.5 w-3.5" />
          New
        </Button>
      </div>

      {/* Search */}
      <div className="px-2 py-2 border-b shrink-0">
        <Input
          placeholder="Search..."
          value={search}
          onChange={e => setSearch(e.target.value)}
          className="h-7 text-xs"
        />
      </div>

      {/* List */}
      <div className="flex-1 overflow-y-auto">
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
        ) : filtered.length === 0 ? (
          <Empty className="py-10 border-0">
            <EmptyMedia variant="icon"><MessageSquare /></EmptyMedia>
            <EmptyTitle>{search ? 'No results' : 'No conversations'}</EmptyTitle>
            <EmptyDescription>{search ? 'Try a different search' : 'Start a new chat'}</EmptyDescription>
          </Empty>
        ) : (
          groups.map((group, i) => (
            <GroupSection
              key={group.label}
              label={group.label}
              items={group.items}
              base={base}
              pathname={pathname}
              router={router}
              isFirst={i === 0}
            />
          ))
        )}
      </div>
    </div>
  )
}
