'use client'

import { useState, useEffect } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Layers, ExternalLink, Brain, Wrench } from 'lucide-react'
import { api } from '@/lib/api'
import type { PreviewRunResult } from '@/lib/api'
import { Popover, PopoverContent, PopoverTrigger, Progress, Button, cn } from '@jiku/ui'
import { ContextPreviewSheet } from './context-preview-sheet'

interface ContextBarProps {
  agentId: string
  conversationId?: string
  /** Pass the useChat status — triggers a preview refresh when streaming finishes. */
  isStreaming?: boolean
  onMemoryClick?: () => void
}

const SOURCE_LABELS: Record<string, string> = {
  base_prompt: 'Base prompt',
  persona: 'Persona',
  mode: 'Mode',
  user_context: 'User context',
  plugin: 'Plugins',
  memory: 'Memory',
  tool_hint: 'Tool hints',
}

const SOURCE_COLORS: Record<string, string> = {
  base_prompt: 'bg-blue-500',
  persona: 'bg-violet-500',
  mode: 'bg-purple-500',
  user_context: 'bg-green-500',
  plugin: 'bg-orange-500',
  memory: 'bg-teal-500',
  tool_hint: 'bg-slate-400',
  history: 'bg-indigo-500',
}

function UsagePopover({
  preview,
  onDetails,
  onTools,
}: {
  preview: PreviewRunResult
  onDetails: () => void
  onTools: () => void
}) {
  const { context } = preview
  const { segments, history_tokens, grand_total, model_context_window, usage_percent } = context

  const grouped = segments.reduce<Record<string, number>>((acc, seg) => {
    acc[seg.source] = (acc[seg.source] ?? 0) + seg.token_estimate
    return acc
  }, {})

  const barColor =
    usage_percent > 90 ? '[&>div]:bg-destructive'
    : usage_percent > 70 ? '[&>div]:bg-amber-500'
    : '[&>div]:bg-primary'

  const toolCount = preview.active_tools.length
  const builtInCount = preview.active_tools.filter(t => t.id.startsWith('__builtin__:')).length
  const pluginCount = toolCount - builtInCount

  return (
    <div className="w-64 space-y-3">
      {/* Model info */}
      {preview.model_info && (
        <div className="flex items-center gap-2 text-xs pb-2 border-b border-border/40">
          <span className="text-muted-foreground shrink-0">Model</span>
          <span className="flex-1 truncate font-medium text-right">{preview.model_info.model_id}</span>
          <span className="text-muted-foreground/60 shrink-0">· {preview.model_info.provider_name}</span>
        </div>
      )}

      {/* Usage bar */}
      <div className="space-y-1.5">
        <div className="flex items-center justify-between text-xs">
          <span className="text-muted-foreground">Context usage</span>
          <span className="font-medium tabular-nums">
            {grand_total.toLocaleString()} <span className="text-muted-foreground">/ {model_context_window.toLocaleString()}</span>
          </span>
        </div>
        <Progress value={Math.min(usage_percent, 100)} className={cn('h-1.5', barColor)} />
        <p className="text-xs text-muted-foreground text-right">{usage_percent.toFixed(1)}%</p>
      </div>

      {/* Segment breakdown */}
      <div className="space-y-1 border-t border-border/40 pt-2">
        {Object.entries(grouped).map(([source, tokens]) => (
          <div key={source} className="flex items-center gap-2 text-xs">
            <span className={cn('h-2 w-2 rounded-full shrink-0', SOURCE_COLORS[source] ?? 'bg-muted')} />
            <span className="flex-1 text-muted-foreground">{SOURCE_LABELS[source] ?? source}</span>
            <span className="tabular-nums font-medium">{tokens.toLocaleString()}</span>
          </div>
        ))}
        {history_tokens > 0 && (
          <div className="flex items-center gap-2 text-xs">
            <span className={cn('h-2 w-2 rounded-full shrink-0', SOURCE_COLORS['history'])} />
            <span className="flex-1 text-muted-foreground">History</span>
            <span className="tabular-nums font-medium">{history_tokens.toLocaleString()}</span>
          </div>
        )}
      </div>

      {/* Compaction count */}
      {preview.compaction_count > 0 && (
        <div className="flex items-center gap-2 text-xs border-t border-border/40 pt-2">
          <span className="h-2 w-2 rounded-full shrink-0 bg-indigo-500" />
          <span className="flex-1 text-muted-foreground">Compacted</span>
          <span className="tabular-nums font-medium">{preview.compaction_count}×</span>
        </div>
      )}

      {/* Active tools summary */}
      {toolCount > 0 && (
        <div className="border-t border-border/40 pt-2 space-y-1.5">
          <button
            onClick={onTools}
            className="flex items-center gap-2 text-xs w-full hover:text-foreground transition-colors group"
          >
            <Wrench className="h-3 w-3 text-muted-foreground shrink-0" />
            <span className="flex-1 text-muted-foreground text-left">Active tools</span>
            <span className="tabular-nums font-medium">{toolCount}</span>
            <ExternalLink className="h-3 w-3 text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity" />
          </button>
          <div className="flex gap-1.5 flex-wrap">
            {builtInCount > 0 && (
              <span className="text-[10px] px-1.5 py-0.5 rounded bg-sky-500/10 text-sky-600 dark:text-sky-400">
                {builtInCount} built-in
              </span>
            )}
            {pluginCount > 0 && (
              <span className="text-[10px] px-1.5 py-0.5 rounded bg-orange-500/10 text-orange-600 dark:text-orange-400">
                {pluginCount} plugin
              </span>
            )}
          </div>
        </div>
      )}

      {/* Action buttons */}
      <div className="border-t border-border/40 pt-2 flex gap-1.5">
        <Button
          variant="ghost"
          size="sm"
          className="flex-1 h-7 text-xs gap-1.5 justify-center"
          onClick={onTools}
        >
          <Wrench className="h-3 w-3" />
          Tools
        </Button>
        <Button
          variant="ghost"
          size="sm"
          className="flex-1 h-7 text-xs gap-1.5 justify-center"
          onClick={onDetails}
        >
          <ExternalLink className="h-3 w-3" />
          Details
        </Button>
      </div>
    </div>
  )
}

export function ContextBar({ agentId, conversationId, isStreaming, onMemoryClick }: ContextBarProps) {
  const [popoverOpen, setPopoverOpen] = useState(false)
  const [sheetOpen, setSheetOpen] = useState(false)
  const qc = useQueryClient()
  const queryKey = ['preview', agentId, conversationId]

  const { data: preview } = useQuery({
    queryKey,
    queryFn: () =>
      conversationId
        ? api.conversations.preview(conversationId, { mode: 'chat' })
        : api.agents.preview(agentId, { mode: 'chat' }),
    staleTime: 0,
  })

  useEffect(() => {
    if (!isStreaming) {
      qc.invalidateQueries({ queryKey })
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isStreaming])

  const usagePercent = preview?.context.usage_percent ?? 0
  const grandTotal = preview?.context.grand_total ?? 0
  const contextWindow = preview?.context.model_context_window ?? 128000
  const toolCount = preview?.active_tools.length ?? 0

  const dotColor =
    usagePercent > 90 ? 'bg-destructive'
    : usagePercent > 70 ? 'bg-amber-500'
    : 'bg-muted-foreground/40'

  function openTools() {
    setPopoverOpen(false)
    setSheetOpen(true)
  }

  function openDetails() {
    setPopoverOpen(false)
    setSheetOpen(true)
  }

  return (
    <>
      {/* Model info — left side */}
      {preview?.model_info && (
        <span className="text-xs text-muted-foreground/60 truncate">
          {preview.model_info.model_id}
          <span className="text-muted-foreground/40"> · {preview.model_info.provider_name}</span>
        </span>
      )}

      <div className="flex-1 flex items-center gap-2 divide-x divide-gray-500/50">
        {onMemoryClick && (
          <button
            onClick={onMemoryClick}
            className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-teal-500 transition-colors ml-auto pr-2"
          >
            <Brain className="h-3 w-3" />
            <span>Memory</span>
          </button>
        )}

        {/* Context popover */}
        <Popover open={popoverOpen} onOpenChange={setPopoverOpen}>
          <PopoverTrigger asChild>
            <button
              className={cn(
                'flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors group',
                (!onMemoryClick && toolCount === 0) && 'ml-auto',
              )}
            >
              <Layers className="h-3 w-3" />
              <span className="flex items-center gap-1">
                {preview ? (
                  <>
                    <span className={cn('h-1.5 w-1.5 rounded-full', dotColor)} />
                    <span className="tabular-nums">{grandTotal.toLocaleString()}</span>
                    <span className="text-muted-foreground/60">/ {(contextWindow / 1000).toFixed(0)}k tokens</span>
                  </>
                ) : (
                  <span>Context</span>
                )}
              </span>
            </button>
          </PopoverTrigger>

          <PopoverContent side="top" align="end" sideOffset={8} className="p-3">
            {preview ? (
              <UsagePopover
                preview={preview}
                onDetails={openDetails}
                onTools={openTools}
              />
            ) : (
              <p className="text-xs text-muted-foreground">Loading...</p>
            )}
          </PopoverContent>
        </Popover>

        <ContextPreviewSheet
          agentId={agentId}
          conversationId={conversationId}
          open={sheetOpen}
          onOpenChange={setSheetOpen}
        />
      </div>
    </>
  )
}
