'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { useInfiniteQuery, useQuery } from '@tanstack/react-query'
import {
  Badge, Button, Input,
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
  Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle,
} from '@jiku/ui'
import { ArrowDown, ArrowUp, Circle, Filter, MessageSquare, RefreshCw, X } from 'lucide-react'
import { api } from '@/lib/api'
import type { ConnectorMessageListItem, ConnectorMessageFilters } from '@/lib/api'

interface MessagesTabProps {
  projectId: string
  initialConnectorId?: string
}

const ALL = '__all__'

export function MessagesTab({ projectId, initialConnectorId }: MessagesTabProps) {
  const [connectorId, setConnectorId] = useState<string>(initialConnectorId ?? ALL)
  const [direction, setDirection] = useState<string>(ALL)
  const [status, setStatus] = useState<string>(ALL)
  const [from, setFrom] = useState<string>('')
  const [to, setTo] = useState<string>('')

  const [isLive, setIsLive] = useState(false)
  const [liveItems, setLiveItems] = useState<ConnectorMessageListItem[]>([])
  const esRef = useRef<EventSource | null>(null)

  const [selected, setSelected] = useState<ConnectorMessageListItem | null>(null)

  const filters: ConnectorMessageFilters = useMemo(() => ({
    connector_id: connectorId === ALL ? undefined : connectorId,
    direction: (direction === ALL ? undefined : direction) as ConnectorMessageFilters['direction'],
    status: status === ALL ? undefined : status,
    from: from ? new Date(from).toISOString() : undefined,
    to: to ? new Date(to).toISOString() : undefined,
    limit: 50,
  }), [connectorId, direction, status, from, to])

  const { data: connectorsData } = useQuery({
    queryKey: ['connectors', projectId],
    queryFn: () => api.connectors.list(projectId),
  })

  const query = useInfiniteQuery({
    queryKey: ['project-messages', projectId, filters],
    queryFn: ({ pageParam }) =>
      api.connectors.listProjectMessages(projectId, { ...filters, cursor: pageParam ?? null }),
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
    const url = api.connectors.projectMessagesStreamUrl(projectId, filters)
    const es = new EventSource(url)
    es.onmessage = (e) => {
      try {
        const row = JSON.parse(e.data) as ConnectorMessageListItem
        setLiveItems(prev => [row, ...prev].slice(0, 200))
      } catch { /* ignore */ }
    }
    es.onerror = () => { setIsLive(false) }
    esRef.current = es
    return () => { es.close() }
  }, [isLive, projectId, filters])

  useEffect(() => () => { esRef.current?.close() }, [])

  const persisted = query.data?.pages.flatMap(p => p.messages) ?? []
  const liveIds = new Set(liveItems.map(i => i.id))
  const items = [...liveItems, ...persisted.filter(i => !liveIds.has(i.id))]

  const connectors = connectorsData?.connectors ?? []
  const hasFilter = connectorId !== ALL || direction !== ALL || status !== ALL || from || to

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
            <SelectItem value={ALL}>All directions</SelectItem>
            <SelectItem value="inbound">Inbound</SelectItem>
            <SelectItem value="outbound">Outbound</SelectItem>
          </SelectContent>
        </Select>
        <Select value={status} onValueChange={setStatus}>
          <SelectTrigger className="h-8 w-[120px] text-xs"><SelectValue placeholder="Status" /></SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>Any status</SelectItem>
            <SelectItem value="handled">handled (agent ran)</SelectItem>
            <SelectItem value="unhandled">unhandled (no binding)</SelectItem>
            <SelectItem value="pending">pending approval</SelectItem>
            <SelectItem value="dropped">dropped (blocked)</SelectItem>
            <SelectItem value="rate_limited">rate_limited</SelectItem>
            <SelectItem value="sent">sent (outbound)</SelectItem>
            <SelectItem value="failed">failed (outbound)</SelectItem>
          </SelectContent>
        </Select>
        <Input
          type="datetime-local"
          value={from}
          onChange={(e) => setFrom(e.target.value)}
          className="h-8 w-[180px] text-xs"
          placeholder="From"
        />
        <Input
          type="datetime-local"
          value={to}
          onChange={(e) => setTo(e.target.value)}
          className="h-8 w-[180px] text-xs"
          placeholder="To"
        />
        {hasFilter && (
          <Button size="sm" variant="ghost" className="h-7 text-xs gap-1"
            onClick={() => { setConnectorId(ALL); setDirection(ALL); setStatus(ALL); setFrom(''); setTo('') }}
          >
            <X className="h-3 w-3" /> Clear
          </Button>
        )}
        <div className="ml-auto flex items-center gap-2">
          <Button size="sm" variant="ghost" className="h-7 text-xs gap-1.5"
            onClick={() => query.refetch()}
            disabled={query.isFetching}
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
              <th className="text-left font-medium px-3 py-2 w-[100px]">Direction</th>
              <th className="text-left font-medium px-3 py-2 w-[160px]">Connector</th>
              <th className="text-left font-medium px-3 py-2">Content</th>
              <th className="text-left font-medium px-3 py-2 w-[90px]">Status</th>
            </tr>
          </thead>
          <tbody>
            {query.isLoading ? (
              <tr><td colSpan={5} className="text-center py-8 text-xs text-muted-foreground">Loading messages...</td></tr>
            ) : items.length === 0 ? (
              <tr><td colSpan={5} className="text-center py-12 text-xs text-muted-foreground">
                <MessageSquare className="h-6 w-6 mx-auto mb-2 opacity-30" />
                No messages match the current filters.
              </td></tr>
            ) : items.map(m => {
              const inbound = m.direction === 'inbound'
              return (
                <tr key={m.id}
                  onClick={() => setSelected(m)}
                  className="border-b last:border-0 hover:bg-muted/30 cursor-pointer transition-colors"
                >
                  <td className="px-3 py-2 text-xs font-mono text-muted-foreground">
                    {new Date(m.created_at).toLocaleString()}
                  </td>
                  <td className="px-3 py-2">
                    <Badge variant="outline" className={`text-[10px] px-1.5 py-0.5 font-normal gap-1 ${
                      inbound
                        ? 'border-blue-500/40 text-blue-600 bg-blue-500/5'
                        : 'border-green-500/40 text-green-600 bg-green-500/5'
                    }`}>
                      {inbound ? <ArrowDown className="h-3 w-3" /> : <ArrowUp className="h-3 w-3" />}
                      {m.direction}
                    </Badge>
                  </td>
                  <td className="px-3 py-2 text-xs">{m.connector_name}</td>
                  <td className="px-3 py-2 text-xs text-muted-foreground truncate max-w-0">
                    <div className="truncate">{m.content_snapshot ?? JSON.stringify(m.ref_keys)}</div>
                  </td>
                  <td className="px-3 py-2 text-xs font-mono text-muted-foreground">{m.status}</td>
                </tr>
              )
            })}
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
        <SheetContent className="w-[480px] sm:max-w-[480px] overflow-y-auto">
          {selected && (
            <>
              <SheetHeader>
                <SheetTitle className="text-sm">Message Detail</SheetTitle>
                <SheetDescription className="text-xs">
                  {new Date(selected.created_at).toLocaleString()} · {selected.connector_name}
                </SheetDescription>
              </SheetHeader>
              <div className="px-4 pb-6 space-y-4 text-xs">
                <DetailField label="ID" value={selected.id} mono />
                <DetailField label="Direction" value={selected.direction} />
                <DetailField label="Status" value={selected.status} />
                {selected.conversation_id && (
                  <DetailField label="Conversation" value={selected.conversation_id} mono />
                )}
                <DetailField label="Ref Keys" json={selected.ref_keys} />
                {selected.content_snapshot && (
                  <DetailField label="Content" value={selected.content_snapshot} pre />
                )}
                {selected.raw_payload != null && (
                  <DetailField label="Raw Payload (platform-side)" json={selected.raw_payload} />
                )}
              </div>
            </>
          )}
        </SheetContent>
      </Sheet>
    </div>
  )
}

function DetailField({ label, value, json, mono, pre }: {
  label: string
  value?: string
  json?: unknown
  mono?: boolean
  pre?: boolean
}) {
  return (
    <div>
      <p className="text-[11px] text-muted-foreground/70 mb-1">{label}</p>
      {json !== undefined ? (
        <pre className="font-mono text-[11px] bg-muted/30 rounded p-2 overflow-x-auto whitespace-pre-wrap">
          {JSON.stringify(json, null, 2)}
        </pre>
      ) : pre ? (
        <pre className="font-mono text-[11px] bg-muted/30 rounded p-2 overflow-x-auto whitespace-pre-wrap max-h-64">
          {value}
        </pre>
      ) : (
        <p className={`${mono ? 'font-mono' : ''} text-xs bg-muted/30 rounded px-2 py-1`}>{value}</p>
      )}
    </div>
  )
}
