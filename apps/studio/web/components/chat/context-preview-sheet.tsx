'use client'

import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { ChevronDown, AlertTriangle, Layers } from 'lucide-react'
import { api } from '@/lib/api'
import type { PreviewRunResult, ConversationContext, ContextSegment } from '@/lib/api'
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle, Progress, Alert, AlertDescription, Badge, cn } from '@jiku/ui'

// ─── ContextUsageBar ──────────────────────────────────────────────────────────

function ContextUsageBar({ context }: { context: ConversationContext }) {
  const { total_tokens, history_tokens, grand_total, model_context_window, usage_percent } = context

  const barColor =
    usage_percent > 90
      ? '[&>div]:bg-destructive'
      : usage_percent > 70
        ? '[&>div]:bg-amber-500'
        : ''

  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between text-xs">
        <span className="text-muted-foreground">Context usage</span>
        <span className="font-medium tabular-nums">
          {grand_total.toLocaleString()} / {model_context_window.toLocaleString()} tokens
        </span>
      </div>
      <Progress value={Math.min(usage_percent, 100)} className={cn('h-2', barColor)} />
      <div className="flex items-center gap-3 text-xs text-muted-foreground">
        <span>System: {total_tokens.toLocaleString()}</span>
        <span>History: {history_tokens.toLocaleString()}</span>
        <span className="ml-auto font-medium">{usage_percent.toFixed(1)}%</span>
      </div>
    </div>
  )
}

// ─── ContextSegmentList ────────────────────────────────────────────────────────

function SegmentRow({ seg }: { seg: ContextSegment }) {
  const [open, setOpen] = useState(false)

  const sourceColors: Record<string, string> = {
    base_prompt: 'bg-blue-500/10 text-blue-600 dark:text-blue-400',
    mode: 'bg-purple-500/10 text-purple-600 dark:text-purple-400',
    user_context: 'bg-green-500/10 text-green-600 dark:text-green-400',
    plugin: 'bg-orange-500/10 text-orange-600 dark:text-orange-400',
    tool_hint: 'bg-slate-500/10 text-slate-600 dark:text-slate-400',
  }

  return (
    <div className="border border-border/40 rounded-lg overflow-hidden text-xs">
      <button
        className="flex items-center gap-2 w-full px-3 py-2 hover:bg-muted/40 transition-colors text-left"
        onClick={() => setOpen(o => !o)}
      >
        <span className={cn('px-1.5 py-0.5 rounded text-[10px] font-medium shrink-0', sourceColors[seg.source] ?? 'bg-muted text-muted-foreground')}>
          {seg.source.replace('_', ' ')}
        </span>
        <span className="flex-1 truncate text-foreground/80">{seg.label}</span>
        <span className="tabular-nums text-muted-foreground shrink-0">{seg.token_estimate} tok</span>
        <ChevronDown className={cn('h-3 w-3 text-muted-foreground shrink-0 transition-transform', open && 'rotate-180')} />
      </button>
      {open && (
        <div className="px-3 pb-3 pt-1 border-t border-border/30 bg-muted/20">
          <pre className="font-mono text-[11px] text-foreground/70 whitespace-pre-wrap max-h-32 overflow-auto leading-relaxed">
            {seg.content || '(empty)'}
          </pre>
        </div>
      )}
    </div>
  )
}

// ─── ActiveToolsList ──────────────────────────────────────────────────────────

function ActiveToolsList({ tools }: { tools: PreviewRunResult['active_tools'] }) {
  if (tools.length === 0) return (
    <p className="text-xs text-muted-foreground">No active tools</p>
  )

  return (
    <div className="space-y-1">
      {tools.map(t => (
        <div key={t.id} className="flex items-center gap-2 text-xs px-2 py-1.5 rounded-md hover:bg-muted/30">
          <code className="font-mono flex-1 text-foreground/80">{t.name}</code>
          <Badge variant="outline" className="text-[10px] font-normal">{t.permission}</Badge>
          {t.has_prompt && <Badge variant="secondary" className="text-[10px] font-normal">hint</Badge>}
        </div>
      ))}
    </div>
  )
}

// ─── SystemPromptView ─────────────────────────────────────────────────────────

function SystemPromptView({ prompt }: { prompt: string }) {
  const [open, setOpen] = useState(false)

  return (
    <div className="border border-border/40 rounded-lg overflow-hidden">
      <button
        className="flex items-center gap-2 w-full px-3 py-2 text-xs font-medium hover:bg-muted/40 transition-colors text-left"
        onClick={() => setOpen(o => !o)}
      >
        <span className="flex-1">System Prompt</span>
        <ChevronDown className={cn('h-3 w-3 text-muted-foreground transition-transform', open && 'rotate-180')} />
      </button>
      {open && (
        <div className="border-t border-border/30">
          <pre className="font-mono text-[11px] text-foreground/70 whitespace-pre-wrap p-3 max-h-64 overflow-auto leading-relaxed bg-muted/10">
            {prompt}
          </pre>
        </div>
      )}
    </div>
  )
}

// ─── PreviewContent ───────────────────────────────────────────────────────────

function PreviewContent({ preview }: { preview: PreviewRunResult }) {
  return (
    <div className="space-y-4 pt-2">
      {preview.model_info && (
        <div className="rounded-md border border-border/40 px-3 py-2 space-y-1 text-xs">
          <div className="flex items-center justify-between">
            <span className="text-muted-foreground">Provider</span>
            <span className="font-medium">{preview.model_info.provider_name}</span>
          </div>
          <div className="flex items-center justify-between">
            <span className="text-muted-foreground">Model</span>
            <span className="font-mono font-medium">{preview.model_info.model_id}</span>
          </div>
        </div>
      )}

      <ContextUsageBar context={preview.context} />

      {preview.compaction_count > 0 && (
        <div className="flex items-center gap-2 text-xs rounded-md border border-border/40 px-3 py-2 bg-muted/20">
          <span className="h-2 w-2 rounded-full bg-indigo-500 shrink-0" />
          <span className="flex-1 text-muted-foreground">Compacted</span>
          <span className="font-medium tabular-nums">{preview.compaction_count}×</span>
        </div>
      )}

      {preview.warnings.map((w, i) => (
        <Alert key={i} variant="destructive" className="py-2">
          <AlertTriangle className="h-3.5 w-3.5" />
          <AlertDescription className="text-xs">{w}</AlertDescription>
        </Alert>
      ))}

      <section>
        <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-2">Context Segments</h3>
        <div className="space-y-1">
          {preview.context.segments.map((seg, i) => (
            <SegmentRow key={i} seg={seg} />
          ))}
        </div>
      </section>

      <section>
        <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-2">
          Active Tools ({preview.active_tools.length})
        </h3>
        <ActiveToolsList tools={preview.active_tools} />
      </section>

      <SystemPromptView prompt={preview.system_prompt} />
    </div>
  )
}

// ─── ContextPreviewSheet ──────────────────────────────────────────────────────

interface ContextPreviewSheetProps {
  agentId: string
  conversationId?: string
  open: boolean
  onOpenChange: (open: boolean) => void
}

export function ContextPreviewSheet({ agentId, conversationId, open, onOpenChange }: ContextPreviewSheetProps) {
  const { data: preview, isLoading } = useQuery({
    queryKey: ['preview', agentId, conversationId],
    queryFn: () =>
      conversationId
        ? api.conversations.preview(conversationId, { mode: 'chat' })
        : api.agents.preview(agentId, { mode: 'chat' }),
    enabled: open,
    staleTime: 30_000,
  })

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="w-[420px] sm:max-w-[420px] flex flex-col overflow-hidden">
        <SheetHeader>
          <SheetTitle className="flex items-center gap-2 text-sm">
            <Layers className="h-4 w-4" />
            Context Preview
          </SheetTitle>
          <SheetDescription className="text-xs">
            Tokens and context segments sent to the model
          </SheetDescription>
        </SheetHeader>

        <div className="flex-1 overflow-y-auto px-4 pb-4">
          {isLoading && (
            <div className="flex items-center justify-center h-20 text-xs text-muted-foreground">
              Loading preview...
            </div>
          )}

          {preview && <PreviewContent preview={preview} />}
        </div>
      </SheetContent>
    </Sheet>
  )
}
