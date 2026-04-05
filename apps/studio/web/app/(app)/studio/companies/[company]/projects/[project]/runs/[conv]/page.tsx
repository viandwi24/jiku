'use client'

import { use } from 'react'
import { useQuery } from '@tanstack/react-query'
import type { UIMessage } from 'ai'
import { api } from '@/lib/api'
import { dbMessageToUIMessage } from '@/lib/messages'
import { Button, Badge } from '@jiku/ui'
import { ArrowLeft, AlertCircle } from 'lucide-react'
import Link from 'next/link'
import { ConversationViewer } from '@/components/chat/conversation-viewer'

interface PageProps {
  params: Promise<{ company: string; project: string; conv: string }>
}

function formatDuration(ms: number | null): string {
  if (ms == null) return '—'
  if (ms < 1000) return `${ms}ms`
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`
  const m = Math.floor(ms / 60000)
  const s = Math.floor((ms % 60000) / 1000)
  return `${m}m ${s}s`
}

function formatDate(d: string | null): string {
  if (!d) return '—'
  return new Date(d).toLocaleString()
}

export default function RunDetailPage({ params }: PageProps) {
  const { company: companySlug, project: projectSlug, conv: convId } = use(params)
  const base = `/studio/companies/${companySlug}/projects/${projectSlug}`

  const { data: rawConv, isLoading: convLoading } = useQuery({
    queryKey: ['conversation', convId],
    queryFn: () => api.conversations.get(convId),
  })

  const conv = rawConv?.conversation

  const { data: historyData, isLoading: historyLoading } = useQuery({
    queryKey: ['conversation-messages', convId],
    queryFn: () => api.conversations.messages(convId),
    enabled: !!conv,
  })

  if (convLoading || historyLoading || !historyData) {
    return (
      <div className="flex items-center justify-center h-full">
        <p className="text-sm text-muted-foreground">Loading...</p>
      </div>
    )
  }

  if (!conv) {
    return (
      <div className="p-6 space-y-4">
        <Button variant="ghost" size="sm" asChild>
          <Link href={`${base}/runs`}><ArrowLeft className="h-4 w-4 mr-1" />Back to Runs</Link>
        </Button>
        <div className="flex items-center gap-2 text-destructive text-sm">
          <AlertCircle className="h-4 w-4" />
          Conversation not found
        </div>
      </div>
    )
  }

  const meta = (conv?.metadata ?? {}) as Record<string, unknown>
  const goal = meta.goal as string | undefined
  const output = meta.output as string | undefined
  const type = (conv as Record<string, unknown>).type as string ?? 'chat'
  const runStatus = (conv as Record<string, unknown>).run_status as string ?? conv.status

  const startedAt = conv.started_at ? new Date(conv.started_at as string) : null
  const finishedAt = conv.finished_at ? new Date(conv.finished_at as string) : null
  const durationMs = startedAt && finishedAt ? finishedAt.getTime() - startedAt.getTime() : null

  const initialMessages: UIMessage[] = historyData.messages.map(dbMessageToUIMessage)

  return (
    <div className="flex flex-col overflow-hidden" style={{ height: 'calc(100svh - 3rem)' }}>
      {/* Back bar + run metadata */}
      <div className="border-b px-4 py-2 shrink-0 space-y-2">
        <div className="flex items-center gap-2">
          <Button variant="ghost" size="sm" asChild className="-ml-2">
            <Link href={`${base}/runs`}><ArrowLeft className="h-4 w-4 mr-1" />Runs</Link>
          </Button>
          <div className="flex items-center gap-2 ml-auto">
            <Badge variant="outline" className="font-mono text-[10px]">{type}</Badge>
            <Badge variant="outline" className={`font-mono text-[10px] ${
              runStatus === 'running' ? 'text-green-600 border-green-500/40' :
              runStatus === 'failed' ? 'text-destructive border-destructive/40' : ''
            }`}>{runStatus}</Badge>
            {durationMs != null && (
              <span className="text-xs text-muted-foreground font-mono">{formatDuration(durationMs)}</span>
            )}
          </div>
        </div>

        {(goal || output || conv.error_message) && (
          <div className="text-xs text-muted-foreground space-y-1 pb-1">
            {goal && <p><span className="font-medium text-foreground">Goal:</span> {goal}</p>}
            {conv.error_message && (
              <p className="text-destructive flex items-center gap-1">
                <AlertCircle className="h-3 w-3 shrink-0" />
                {conv.error_message as string}
              </p>
            )}
            {output && (
              <details className="text-xs">
                <summary className="cursor-pointer font-medium text-foreground">Output</summary>
                <pre className="mt-1 bg-muted/30 rounded p-2 whitespace-pre-wrap">{output}</pre>
              </details>
            )}
          </div>
        )}
      </div>

      {/* Full conversation viewer in readonly mode */}
      <div className="flex-1 min-h-0">
        <ConversationViewer
          key={convId}
          convId={convId}
          mode="readonly"
          conversation={conv}
          initialMessages={initialMessages}
        />
      </div>
    </div>
  )
}
