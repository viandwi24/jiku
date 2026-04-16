'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { useInfiniteQuery, useQuery } from '@tanstack/react-query'
import {
  Badge, Button, Input,
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
  Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle,
} from '@jiku/ui'
import { Activity, ArrowDown, ArrowUp, Circle, Filter, RefreshCw, X } from 'lucide-react'
import { api } from '@/lib/api'
import type { ConnectorEventListItem, ConnectorEventFilters } from '@/lib/api'

interface EventsTabProps {
  projectId: string
  initialConnectorId?: string
}

const ALL = '__all__'

const STATUS_COLORS: Record<string, string> = {
  received: 'text-blue-600',
  routed: 'text-green-600',
  unhandled: 'text-amber-600',
  dropped: 'text-muted-foreground',
  rate_limited: 'text-orange-600',
  error: 'text-destructive',
}

const EVENT_TYPE_COLORS: Record<string, string> = {
  message: 'bg-blue-500/10 text-blue-600',
  reaction: 'bg-amber-500/10 text-amber-600',
  edit: 'bg-violet-500/10 text-violet-600',
  delete: 'bg-red-500/10 text-red-600',
  join: 'bg-green-500/10 text-green-600',
  leave: 'bg-slate-500/10 text-slate-600',
}

export function EventsTab({ projectId, initialConnectorId }: EventsTabProps) {
  const [connectorId, setConnectorId] = useState<string>(initialConnectorId ?? ALL)
  const [direction, setDirection] = useState<string>(ALL)
  const [eventType, setEventType] = useState<string>(ALL)
  const [status, setStatus] = useState<string>(ALL)
  const [chatId, setChatId] = useState<string>('')
  const [threadId, setThreadId] = useState<string>('')
  const [userId, setUserId] = useState<string>('')
  const [contentSearch, setContentSearch] = useState<string>('')
  const [from, setFrom] = useState<string>('')
  const [to, setTo] = useState<string>('')

  const [isLive, setIsLive] = useState(false)
  const [liveItems, setLiveItems] = useState<ConnectorEventListItem[]>([])
  const esRef = useRef<EventSource | null>(null)

  const [selected, setSelected] = useState<ConnectorEventListItem | null>(null)

  const filters: ConnectorEventFilters = useMemo(() => ({
    connector_id: connectorId === ALL ? undefined : connectorId,
    direction: (direction === ALL ? undefined : direction) as ConnectorEventFilters['direction'],
    event_type: eventType === ALL ? undefined : eventType,
    status: status === ALL ? undefined : status,
    chat_id: chatId.trim() || undefined,
    thread_id: threadId.trim() || undefined,
    user_id: userId.trim() || undefined,
    content_search: contentSearch.trim() || undefined,
    from: from ? new Date(from).toISOString() : undefined,
    to: to ? new Date(to).toISOString() : undefined,
    limit: 50,
  }), [connectorId, direction, eventType, status, chatId, threadId, userId, contentSearch, from, to])

  const { data: connectorsData } = useQuery({
    queryKey: ['connectors', projectId],
    queryFn: () => api.connectors.list(projectId),
  })

  const query = useInfiniteQuery({
    queryKey: ['project-events', projectId, filters],
    queryFn: ({ pageParam }) =>
      api.connectors.listProjectEvents(projectId, { ...filters, cursor: pageParam ?? null }),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.next_cursor,
  })

  useEffect(() => {
    setLiveItems([])
    if (!isLive) {
      esRef.current?.close()
      esRef.current = null
      return
    }
    const url = api.connectors.projectEventsStreamUrl(projectId, filters)
    const es = new EventSource(url)
    es.onmessage = (e) => {
      try {
        const row = JSON.parse(e.data) as ConnectorEventListItem
        // Upsert by id: arrival broadcasts `received`, routing broadcasts the
        // final status against the SAME row id (single-row pattern). Replace
        // any existing entry instead of appending a duplicate.
        setLiveItems(prev => {
          const idx = prev.findIndex(p => p.id === row.id)
          if (idx >= 0) {
            const next = prev.slice()
            next[idx] = row
            return next
          }
          return [row, ...prev].slice(0, 200)
        })
      } catch { /* ignore */ }
    }
    es.onerror = () => { setIsLive(false) }
    esRef.current = es
    return () => { es.close() }
  }, [isLive, projectId, filters])

  useEffect(() => () => { esRef.current?.close() }, [])

  const persisted = query.data?.pages.flatMap(p => p.events) ?? []
  const liveIds = new Set(liveItems.map(i => i.id))
  const items = [...liveItems, ...persisted.filter(i => !liveIds.has(i.id))]

  const connectors = connectorsData?.connectors ?? []
  const hasFilter = connectorId !== ALL || direction !== ALL || eventType !== ALL || status !== ALL || chatId || threadId || userId || contentSearch || from || to

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <Filter className="h-3.5 w-3.5 text-muted-foreground" />
        <Select value={connectorId} onValueChange={setConnectorId}>
          <SelectTrigger className="h-8 w-[200px] text-xs"><SelectValue placeholder="Connector" /></SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>All connectors</SelectItem>
            {connectors.map(c => (
              <SelectItem key={c.id} value={c.id}>{c.display_name}</SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={direction} onValueChange={setDirection}>
          <SelectTrigger className="h-8 w-[140px] text-xs"><SelectValue placeholder="Direction" /></SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>In + Out</SelectItem>
            <SelectItem value="inbound">Inbound</SelectItem>
            <SelectItem value="outbound">Outbound</SelectItem>
          </SelectContent>
        </Select>
        <Select value={eventType} onValueChange={setEventType}>
          <SelectTrigger className="h-8 w-[140px] text-xs"><SelectValue placeholder="Event type" /></SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>All types</SelectItem>
            <SelectItem value="message">message (in)</SelectItem>
            <SelectItem value="reaction">reaction</SelectItem>
            <SelectItem value="edit">edit</SelectItem>
            <SelectItem value="delete">delete</SelectItem>
            <SelectItem value="join">join</SelectItem>
            <SelectItem value="leave">leave</SelectItem>
            <SelectItem value="send_message">send_message (out)</SelectItem>
          </SelectContent>
        </Select>
        <Select value={status} onValueChange={setStatus}>
          <SelectTrigger className="h-8 w-[160px] text-xs"><SelectValue placeholder="Status" /></SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>Any status</SelectItem>
            <SelectItem value="received">received</SelectItem>
            <SelectItem value="routed">routed</SelectItem>
            <SelectItem value="unhandled">unhandled</SelectItem>
            <SelectItem value="dropped">dropped</SelectItem>
            <SelectItem value="rate_limited">rate_limited</SelectItem>
            <SelectItem value="error">error</SelectItem>
          </SelectContent>
        </Select>
        <Input value={chatId} onChange={(e) => setChatId(e.target.value)}
          className="h-8 w-[140px] text-xs font-mono" placeholder="chat_id" />
        <Input value={threadId} onChange={(e) => setThreadId(e.target.value)}
          className="h-8 w-[130px] text-xs font-mono" placeholder="thread_id" />
        <Input value={userId} onChange={(e) => setUserId(e.target.value)}
          className="h-8 w-[130px] text-xs font-mono" placeholder="user_id" />
        <Input value={contentSearch} onChange={(e) => setContentSearch(e.target.value)}
          className="h-8 w-[180px] text-xs" placeholder="Search content..." />
        <Input type="datetime-local" value={from} onChange={(e) => setFrom(e.target.value)}
          className="h-8 w-[180px] text-xs" />
        <Input type="datetime-local" value={to} onChange={(e) => setTo(e.target.value)}
          className="h-8 w-[180px] text-xs" />
        {hasFilter && (
          <Button size="sm" variant="ghost" className="h-7 text-xs gap-1"
            onClick={() => { setConnectorId(ALL); setDirection(ALL); setEventType(ALL); setStatus(ALL); setChatId(''); setThreadId(''); setUserId(''); setContentSearch(''); setFrom(''); setTo('') }}
          >
            <X className="h-3 w-3" /> Clear
          </Button>
        )}
        <div className="ml-auto flex items-center gap-2">
          <Button size="sm" variant="ghost" className="h-7 text-xs gap-1.5"
            onClick={() => query.refetch()} disabled={query.isFetching}
          >
            <RefreshCw className={`h-3 w-3 ${query.isFetching ? 'animate-spin' : ''}`} />
          </Button>
          <Button size="sm" variant={isLive ? 'default' : 'outline'} className="h-7 text-xs gap-1.5"
            onClick={() => setIsLive(v => !v)}
          >
            <Circle className={`h-2 w-2 ${isLive ? 'fill-current animate-pulse' : ''}`} />
            {isLive ? 'Live' : 'Go Live'}
          </Button>
        </div>
      </div>

      <div className="rounded-lg border overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-muted/40 border-b">
            <tr className="text-xs text-muted-foreground">
              <th className="text-left font-medium px-3 py-2 w-[150px]">Time</th>
              <th className="text-left font-medium px-3 py-2 w-[40px]"></th>
              <th className="text-left font-medium px-3 py-2 w-[110px]">Type</th>
              <th className="text-left font-medium px-3 py-2 w-[160px]">Connector</th>
              <th className="text-left font-medium px-3 py-2 w-[180px]">Refs</th>
              <th className="text-left font-medium px-3 py-2">Drop reason / payload</th>
              <th className="text-left font-medium px-3 py-2 w-[130px]">Status</th>
              <th className="text-left font-medium px-3 py-2 w-[60px]">Took</th>
            </tr>
          </thead>
          <tbody>
            {query.isLoading ? (
              <tr><td colSpan={8} className="text-center py-8 text-xs text-muted-foreground">Loading events...</td></tr>
            ) : items.length === 0 ? (
              <tr><td colSpan={8} className="text-center py-12 text-xs text-muted-foreground">
                <Activity className="h-6 w-6 mx-auto mb-2 opacity-30" />
                No events match the current filters.
              </td></tr>
            ) : items.map(ev => (
              <tr key={ev.id}
                onClick={() => setSelected(ev)}
                className="border-b last:border-0 hover:bg-muted/30 cursor-pointer transition-colors"
              >
                <td className="px-3 py-2 text-xs font-mono text-muted-foreground">
                  {new Date(ev.created_at).toLocaleString()}
                </td>
                <td className="px-3 py-2">
                  {ev.direction === 'outbound'
                    ? <ArrowUp className="h-3 w-3 text-green-600" />
                    : <ArrowDown className="h-3 w-3 text-blue-600" />}
                </td>
                <td className="px-3 py-2">
                  <Badge className={`text-[10px] px-1.5 py-0.5 font-normal ${EVENT_TYPE_COLORS[ev.event_type] ?? 'bg-muted text-muted-foreground'}`}>
                    {ev.event_type}
                  </Badge>
                </td>
                <td className="px-3 py-2 text-xs">{ev.connector_name}</td>
                <td className="px-3 py-2 text-xs">
                  <RefsCell
                    refs={ev.ref_keys}
                    senderId={(ev.payload as { sender?: { external_id?: string } } | null)?.sender?.external_id}
                    onFilterChatId={(id) => setChatId(id)}
                    onFilterThreadId={(id) => setThreadId(id)}
                    onFilterUserId={(id) => setUserId(id)}
                  />
                </td>
                <td className="px-3 py-2 text-xs text-muted-foreground truncate max-w-0">
                  <div className="truncate">
                    {ev.drop_reason ? `(${ev.drop_reason}) ` : ''}
                    {(ev.payload as { content?: { text?: string } } | null)?.content?.text ?? ''}
                  </div>
                </td>
                <td className={`px-3 py-2 text-xs font-mono ${STATUS_COLORS[ev.status] ?? 'text-muted-foreground'}`}>
                  {ev.status}
                </td>
                <td className="px-3 py-2 text-[10px] text-muted-foreground/60">
                  {ev.processing_ms != null ? `${ev.processing_ms}ms` : ''}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {query.hasNextPage && (
          <div className="border-t bg-muted/20 p-2 text-center">
            <Button size="sm" variant="ghost" className="h-7 text-xs"
              disabled={query.isFetchingNextPage}
              onClick={() => query.fetchNextPage()}
            >
              {query.isFetchingNextPage ? 'Loading...' : 'Load more'}
            </Button>
          </div>
        )}
      </div>

      <Sheet open={!!selected} onOpenChange={(o) => !o && setSelected(null)}>
        <SheetContent className="w-[520px] sm:max-w-[520px] overflow-y-auto">
          {selected && (
            <>
              <SheetHeader>
                <SheetTitle className="text-sm">Event Detail</SheetTitle>
                <SheetDescription className="text-xs">
                  {new Date(selected.created_at).toLocaleString()} · {selected.connector_name}
                </SheetDescription>
              </SheetHeader>
              <div className="px-4 pb-6 space-y-4 text-xs">
                <DetailField label="ID" value={selected.id} mono />
                <DetailField label="Direction" value={selected.direction} />
                <DetailField label="Type" value={selected.event_type} />
                <DetailField label="Status" value={selected.status} />
                {selected.drop_reason && <DetailField label="Drop reason" value={selected.drop_reason} />}
                {selected.processing_ms != null && (
                  <DetailField label="Processing" value={`${selected.processing_ms}ms`} />
                )}
                <DetailField label="Ref Keys" json={selected.ref_keys} />
                {selected.target_ref_keys && (
                  <DetailField label="Target Ref Keys" json={selected.target_ref_keys} />
                )}
                {selected.raw_payload != null && (
                  <DetailField label="Raw Payload (platform-side)" json={selected.raw_payload} />
                )}
                <DetailField label="Parsed Payload" json={selected.payload} />
                {selected.metadata && <DetailField label="Metadata" json={selected.metadata} />}
              </div>
            </>
          )}
        </SheetContent>
      </Sheet>
    </div>
  )
}

interface RefsCellProps {
  refs: Record<string, string> | null | undefined
  senderId?: string | null | undefined
  onFilterChatId?: (id: string) => void
  onFilterThreadId?: (id: string) => void
  onFilterUserId?: (id: string) => void
}

function RefsCell({ refs, senderId, onFilterChatId, onFilterThreadId, onFilterUserId }: RefsCellProps) {
  const chatId = refs?.['chat_id']
  const threadId = refs?.['thread_id']
  const hasAny = chatId || threadId || senderId
  if (!hasAny) return <span className="text-muted-foreground/50">—</span>
  return (
    <div className="flex flex-col gap-0.5 font-mono text-[10px]">
      {chatId && (
        <button type="button"
          onClick={(e) => { e.stopPropagation(); onFilterChatId?.(chatId) }}
          className="inline-flex items-center gap-1 rounded px-1 py-0.5 hover:bg-muted text-left w-fit max-w-full"
          title="Filter by chat_id"
        >
          <span className="text-muted-foreground/70 shrink-0">chat:</span>
          <span className="truncate">{chatId}</span>
        </button>
      )}
      {threadId && (
        <button type="button"
          onClick={(e) => { e.stopPropagation(); onFilterThreadId?.(threadId) }}
          className="inline-flex items-center gap-1 rounded px-1 py-0.5 hover:bg-muted text-left w-fit max-w-full"
          title="Filter by thread_id"
        >
          <span className="text-muted-foreground/70 shrink-0">thread:</span>
          <span className="truncate">{threadId}</span>
        </button>
      )}
      {senderId && (
        <button type="button"
          onClick={(e) => { e.stopPropagation(); onFilterUserId?.(senderId) }}
          className="inline-flex items-center gap-1 rounded px-1 py-0.5 hover:bg-muted text-left w-fit max-w-full"
          title="Filter by sender user_id"
        >
          <span className="text-muted-foreground/70 shrink-0">user:</span>
          <span className="truncate">{senderId}</span>
        </button>
      )}
    </div>
  )
}

function DetailField({ label, value, json, mono }: {
  label: string
  value?: string
  json?: unknown
  mono?: boolean
}) {
  return (
    <div>
      <p className="text-[11px] text-muted-foreground/70 mb-1">{label}</p>
      {json !== undefined ? (
        <pre className="font-mono text-[11px] bg-muted/30 rounded p-2 overflow-x-auto whitespace-pre-wrap max-h-64">
          {JSON.stringify(json, null, 2)}
        </pre>
      ) : (
        <p className={`${mono ? 'font-mono' : ''} text-xs bg-muted/30 rounded px-2 py-1`}>{value}</p>
      )}
    </div>
  )
}
