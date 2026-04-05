'use client'

import { use, useEffect, useRef, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { api } from '@/lib/api'
import type { ConnectorEventItem } from '@/lib/api'
import { Badge, Button } from '@jiku/ui'
import { ArrowLeft, Circle } from 'lucide-react'
import Link from 'next/link'
import { getAuthHeaders } from '@/lib/auth'

interface PageProps {
  params: Promise<{ company: string; project: string; connector: string }>
}

const BASE_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001'

const STATUS_COLORS: Record<string, string> = {
  routed: 'text-green-600',
  dropped: 'text-muted-foreground',
  pending_approval: 'text-amber-600',
  rate_limited: 'text-orange-600',
  error: 'text-destructive',
  received: 'text-blue-600',
}

const EVENT_TYPE_COLORS: Record<string, string> = {
  message: 'bg-blue-500/10 text-blue-600',
  reaction: 'bg-amber-500/10 text-amber-600',
  edit: 'bg-violet-500/10 text-violet-600',
  delete: 'bg-red-500/10 text-red-600',
  join: 'bg-green-500/10 text-green-600',
  leave: 'bg-slate-500/10 text-slate-600',
}

function EventRow({ event }: { event: ConnectorEventItem }) {
  const [expanded, setExpanded] = useState(false)
  return (
    <div className="border-b last:border-0">
      <button
        className="w-full flex items-start gap-3 px-4 py-3 text-left hover:bg-muted/30 transition-colors"
        onClick={() => setExpanded(e => !e)}
      >
        <span className="text-[11px] text-muted-foreground/60 font-mono shrink-0 pt-0.5 w-20">
          {new Date(event.created_at).toLocaleTimeString()}
        </span>
        <Badge className={`text-[10px] px-1.5 py-0.5 font-normal shrink-0 ${EVENT_TYPE_COLORS[event.event_type] ?? 'bg-muted text-muted-foreground'}`}>
          {event.event_type}
        </Badge>
        <span className={`text-xs font-mono shrink-0 ${STATUS_COLORS[event.status] ?? 'text-muted-foreground'}`}>
          {event.status}
        </span>
        {event.drop_reason && (
          <span className="text-xs text-muted-foreground/60">({event.drop_reason})</span>
        )}
        <span className="flex-1 text-xs text-muted-foreground font-mono truncate">
          {JSON.stringify(event.ref_keys)}
        </span>
        {event.processing_ms != null && (
          <span className="text-[10px] text-muted-foreground/50 shrink-0">{event.processing_ms}ms</span>
        )}
      </button>
      {expanded && (
        <div className="px-4 pb-3">
          <pre className="text-[11px] font-mono text-muted-foreground bg-muted/20 rounded p-3 overflow-auto max-h-48 whitespace-pre-wrap">
            {JSON.stringify(event.payload, null, 2)}
          </pre>
        </div>
      )}
    </div>
  )
}

export default function EventsPage({ params }: PageProps) {
  const { company: companySlug, project: projectSlug, connector: connectorId } = use(params)
  const [liveEvents, setLiveEvents] = useState<ConnectorEventItem[]>([])
  const [isLive, setIsLive] = useState(false)
  const esRef = useRef<EventSource | null>(null)

  const base = `/studio/companies/${companySlug}/projects/${projectSlug}/channels/${connectorId}`

  const { data, isLoading } = useQuery({
    queryKey: ['connector-events', connectorId],
    queryFn: () => api.connectors.events.list(connectorId, 100),
  })

  function startLive() {
    const headers = getAuthHeaders()
    const token = (headers as Record<string, string>)['Authorization']?.replace('Bearer ', '')
    const url = `${BASE_URL}/api/connectors/${connectorId}/events/stream${token ? `?token=${token}` : ''}`
    const es = new EventSource(url)
    es.onmessage = (e) => {
      try {
        const event = JSON.parse(e.data) as ConnectorEventItem
        setLiveEvents(prev => [event, ...prev].slice(0, 200))
      } catch { /* ignore */ }
    }
    es.onerror = () => { setIsLive(false); esRef.current?.close() }
    esRef.current = es
    setIsLive(true)
  }

  function stopLive() {
    esRef.current?.close()
    esRef.current = null
    setIsLive(false)
  }

  useEffect(() => () => { esRef.current?.close() }, [])

  const historicalEvents = data?.events ?? []
  const allEvents = isLive
    ? [...liveEvents, ...historicalEvents].slice(0, 200)
    : historicalEvents

  return (
    <div className="p-6 space-y-4 max-w-4xl">
      <div className="flex items-center gap-3">
        <Button size="sm" variant="ghost" asChild>
          <Link href={base}>
            <ArrowLeft className="h-4 w-4" />
          </Link>
        </Button>
        <h1 className="text-xl font-semibold flex-1">Event Log</h1>
        <Button
          size="sm"
          variant={isLive ? 'default' : 'outline'}
          className="h-7 text-xs gap-1.5"
          onClick={isLive ? stopLive : startLive}
        >
          <Circle className={`h-2 w-2 ${isLive ? 'fill-current animate-pulse' : ''}`} />
          {isLive ? 'Live' : 'Go Live'}
        </Button>
      </div>

      {isLoading && <p className="text-sm text-muted-foreground">Loading events...</p>}

      {!isLoading && allEvents.length === 0 && (
        <div className="rounded-lg border border-dashed p-8 text-center">
          <p className="text-sm text-muted-foreground">No events yet.</p>
          <p className="text-xs text-muted-foreground mt-1">Events will appear here when your connector receives messages.</p>
        </div>
      )}

      {allEvents.length > 0 && (
        <div className="rounded-lg border overflow-hidden">
          {allEvents.map(event => (
            <EventRow key={event.id} event={event} />
          ))}
        </div>
      )}
    </div>
  )
}
