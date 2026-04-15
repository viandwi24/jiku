'use client'

import { useEffect, useMemo, useRef, useState, useCallback } from 'react'
import { Badge, Button, ScrollArea, Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@jiku/ui'
import { Pause, Play, RefreshCw, Trash2 } from 'lucide-react'
import { api, type ConsoleEntry } from '@/lib/api'

type Level = ConsoleEntry['level']
const ALL = '__all__'

const LEVEL_STYLE: Record<Level, string> = {
  info: 'text-foreground',
  warn: 'text-amber-600',
  error: 'text-destructive',
  debug: 'text-muted-foreground',
}

const LEVEL_BADGE: Record<Level, string> = {
  info: 'bg-blue-500/10 text-blue-600',
  warn: 'bg-amber-500/10 text-amber-600',
  error: 'bg-red-500/10 text-red-600',
  debug: 'bg-slate-500/10 text-slate-600',
}

interface ConsolePanelProps {
  consoleId: string
  title?: string
  className?: string
  /** Height for the scrollable log area. Default 420px. */
  height?: number | string
  /** Visual style. 'terminal' = black background, green time stamps (classic console). */
  variant?: 'default' | 'terminal'
}

const VARIANT_BG: Record<NonNullable<ConsolePanelProps['variant']>, string> = {
  default: 'bg-muted/30',
  terminal: 'bg-black text-green-400 border-neutral-800',
}

const TERMINAL_LEVEL_STYLE: Record<Level, string> = {
  info: 'text-green-300',
  warn: 'text-amber-300',
  error: 'text-red-400',
  debug: 'text-neutral-500',
}

const TERMINAL_LEVEL_BADGE: Record<Level, string> = {
  info: 'bg-green-500/20 text-green-300',
  warn: 'bg-amber-500/20 text-amber-300',
  error: 'bg-red-500/20 text-red-300',
  debug: 'bg-neutral-700/50 text-neutral-400',
}

/**
 * Read-only live console for any in-process log stream.
 *
 * On mount: loads `/console/:id/snapshot` (up to ~200 latest entries from
 * memory), then subscribes via SSE to `/console/:id/stream`. Scrolling to the
 * top triggers reverse-pagination against `/console/:id/history?before_ts=`
 * which reads the session tempfile.
 *
 * Logs are session-scoped — machine restart = clean slate.
 */
export function ConsolePanel({ consoleId, title, className, height = 420, variant = 'default' }: ConsolePanelProps) {
  const isTerminal = variant === 'terminal'
  const levelStyle = isTerminal ? TERMINAL_LEVEL_STYLE : LEVEL_STYLE
  const levelBadge = isTerminal ? TERMINAL_LEVEL_BADGE : LEVEL_BADGE
  const tsColor = isTerminal ? 'text-green-500/60' : 'text-muted-foreground'
  const metaColor = isTerminal ? 'text-neutral-500' : 'text-muted-foreground'
  const emptyColor = isTerminal ? 'text-neutral-600' : 'text-muted-foreground'
  const [entries, setEntries] = useState<ConsoleEntry[]>([])
  const [loadingMore, setLoadingMore] = useState(false)
  const [noMoreHistory, setNoMoreHistory] = useState(false)
  const [paused, setPaused] = useState(false)
  const [levelFilter, setLevelFilter] = useState<Level | typeof ALL>(ALL)
  const esRef = useRef<EventSource | null>(null)
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const autoScrollRef = useRef(true)

  const loadSnapshot = useCallback(async () => {
    try {
      const res = await api.console.snapshot(consoleId)
      setEntries(res.entries)
      setNoMoreHistory(false)
    } catch { /* ignore — console may not exist yet */ }
  }, [consoleId])

  // Initial snapshot + live SSE
  useEffect(() => {
    loadSnapshot()
  }, [loadSnapshot])

  useEffect(() => {
    if (paused) { esRef.current?.close(); esRef.current = null; return }
    const es = new EventSource(api.console.streamUrl(consoleId))
    es.onmessage = (e) => {
      try {
        const entry = JSON.parse(e.data) as ConsoleEntry
        setEntries(prev => {
          // Cap at 500 in-browser to avoid runaway DOM
          const next = [...prev, entry]
          return next.length > 500 ? next.slice(-500) : next
        })
      } catch { /* ignore */ }
    }
    es.onerror = () => { /* keep the connection open; browser auto-retries */ }
    esRef.current = es
    return () => { es.close() }
  }, [consoleId, paused])

  // Autoscroll to bottom when new entries arrive, unless user scrolled up
  useEffect(() => {
    if (!autoScrollRef.current) return
    const el = scrollRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [entries])

  const onScroll = (e: React.UIEvent<HTMLDivElement>) => {
    const el = e.currentTarget
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40
    autoScrollRef.current = atBottom

    // Trigger history pagination when user scrolls near the top
    if (el.scrollTop < 80 && !loadingMore && !noMoreHistory && entries.length > 0) {
      const oldestTs = entries[0]!.ts
      setLoadingMore(true)
      api.console.history(consoleId, oldestTs, 100)
        .then(res => {
          if (res.entries.length === 0) setNoMoreHistory(true)
          else setEntries(prev => [...res.entries, ...prev])
        })
        .catch(() => { /* ignore */ })
        .finally(() => setLoadingMore(false))
    }
  }

  const filtered = useMemo(() => {
    if (levelFilter === ALL) return entries
    return entries.filter(e => e.level === levelFilter)
  }, [entries, levelFilter])

  const heightStyle = typeof height === 'number' ? `${height}px` : height

  return (
    <div className={className}>
      <div className="flex items-center gap-2 pb-2">
        {title && <span className="text-sm font-medium mr-auto">{title}</span>}
        <Badge variant="outline" className="font-mono text-[10px]">{consoleId}</Badge>
        <Select value={levelFilter} onValueChange={(v) => setLevelFilter(v as Level | typeof ALL)}>
          <SelectTrigger className="h-7 w-[100px] text-xs"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>All levels</SelectItem>
            <SelectItem value="info">info</SelectItem>
            <SelectItem value="warn">warn</SelectItem>
            <SelectItem value="error">error</SelectItem>
            <SelectItem value="debug">debug</SelectItem>
          </SelectContent>
        </Select>
        <Button size="sm" variant="ghost" className="h-7 px-2" onClick={() => setPaused(p => !p)} title={paused ? 'Resume' : 'Pause'}>
          {paused ? <Play className="h-3.5 w-3.5" /> : <Pause className="h-3.5 w-3.5" />}
        </Button>
        <Button size="sm" variant="ghost" className="h-7 px-2" onClick={loadSnapshot} title="Reload snapshot">
          <RefreshCw className="h-3.5 w-3.5" />
        </Button>
        <Button size="sm" variant="ghost" className="h-7 px-2" onClick={() => setEntries([])} title="Clear view">
          <Trash2 className="h-3.5 w-3.5" />
        </Button>
      </div>
      <div
        ref={scrollRef}
        onScroll={onScroll}
        style={{ height: heightStyle }}
        className={`rounded-md border font-mono text-xs overflow-auto p-2 space-y-0.5 ${VARIANT_BG[variant]}`}
      >
        {loadingMore && <div className={`text-center py-1 ${emptyColor}`}>Loading older entries…</div>}
        {noMoreHistory && entries.length > 0 && <div className={`text-center py-1 opacity-60 ${emptyColor}`}>— start of session —</div>}
        {filtered.length === 0 && !loadingMore && (
          <div className={`text-center py-8 ${emptyColor}`}>No logs yet.</div>
        )}
        {filtered.map((e, i) => (
          <div key={i} className={`flex items-start gap-2 ${levelStyle[e.level]}`}>
            <span className={`tabular-nums shrink-0 ${tsColor}`}>
              {new Date(e.ts).toISOString().slice(11, 23)}
            </span>
            <span className={`px-1 rounded text-[10px] uppercase shrink-0 ${levelBadge[e.level]}`}>{e.level}</span>
            <span className="break-all whitespace-pre-wrap min-w-0 flex-1">
              {e.msg}
              {e.meta && Object.keys(e.meta).length > 0 && (
                <span className={`ml-2 opacity-70 ${metaColor}`}>{JSON.stringify(e.meta)}</span>
              )}
            </span>
          </div>
        ))}
      </div>
    </div>
  )
}
