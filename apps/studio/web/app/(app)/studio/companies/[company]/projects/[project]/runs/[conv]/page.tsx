'use client'

import { use } from 'react'
import { useQuery } from '@tanstack/react-query'
import type { UIMessage } from 'ai'
import { api } from '@/lib/api'
import { dbMessageToUIMessage } from '@/lib/messages'
import { Button, Badge, cn } from '@jiku/ui'
import { ArrowLeft, AlertCircle, CheckCircle2, Loader2 } from 'lucide-react'
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

  const meta = conv.metadata ?? {}
  const goal = meta.goal as string | undefined
  const output = meta.output as string | undefined
  const progressLog = (meta.progress_log ?? []) as Array<{ message: string; percent?: number; details?: string; at: string }>
  const currentProgress = meta.current_progress as { step?: string; percentage?: number } | undefined
  const type = conv.type ?? 'chat'
  const runStatus = conv.run_status ?? conv.status

  const startedAt = conv.started_at ? new Date(conv.started_at) : null
  const finishedAt = conv.finished_at ? new Date(conv.finished_at) : null
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
                {conv.error_message}
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

      {/* Progress timeline (Plan 15.8) */}
      {progressLog.length > 0 && (
        <div className="border-b px-4 py-3 shrink-0 space-y-2">
          <div className="flex items-center justify-between">
            <p className="text-xs font-semibold">Progress</p>
            {currentProgress?.percentage != null && (
              <div className="flex items-center gap-2">
                <div className="w-24 h-1.5 bg-muted rounded-full overflow-hidden">
                  <div
                    className="h-full bg-primary rounded-full transition-all"
                    style={{ width: `${currentProgress.percentage}%` }}
                  />
                </div>
                <span className="text-[10px] font-mono text-muted-foreground">{currentProgress.percentage}%</span>
              </div>
            )}
          </div>
          <div className="space-y-1">
            {progressLog.map((entry, i) => (
              <div key={i} className="flex items-start gap-2 text-xs">
                {i === progressLog.length - 1 && runStatus === 'running' ? (
                  <Loader2 className="h-3 w-3 mt-0.5 shrink-0 text-primary animate-spin" />
                ) : (
                  <CheckCircle2 className="h-3 w-3 mt-0.5 shrink-0 text-green-500" />
                )}
                <div className="flex-1 min-w-0">
                  <span className="text-foreground">{entry.message}</span>
                  {entry.details && <span className="text-muted-foreground ml-1">— {entry.details}</span>}
                </div>
                <span className="text-[10px] text-muted-foreground shrink-0 font-mono">
                  {new Date(entry.at).toLocaleTimeString()}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

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
