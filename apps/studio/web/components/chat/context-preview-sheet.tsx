'use client'

import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { ChevronDown, AlertTriangle, Layers, Wrench, Search, Zap } from 'lucide-react'
import { api } from '@/lib/api'
import type { PreviewRunResult, ConversationContext, ContextSegment } from '@/lib/api'
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle, Progress, Alert, AlertDescription, Badge, Input, cn } from '@jiku/ui'

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
    persona: 'bg-violet-500/10 text-violet-600 dark:text-violet-400',
    mode: 'bg-purple-500/10 text-purple-600 dark:text-purple-400',
    user_context: 'bg-green-500/10 text-green-600 dark:text-green-400',
    plugin: 'bg-orange-500/10 text-orange-600 dark:text-orange-400',
    memory: 'bg-teal-500/10 text-teal-600 dark:text-teal-400',
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

type Tool = PreviewRunResult['active_tools'][number]

function toolGroup(t: Tool): string {
  if (t.group) return t.group
  if (t.id.startsWith('__builtin__:')) return 'built-in'
  const colon = t.id.indexOf(':')
  return colon > -1 ? t.id.slice(0, colon) : 'plugin'
}

function shortToolId(id: string): string {
  if (id.startsWith('__builtin__:')) return id.slice('__builtin__:'.length)
  return id
}


function schemaToParams(schema: unknown): { name: string; type: string; description: string; required: boolean }[] {
  if (!schema || typeof schema !== 'object') return []
  const s = schema as Record<string, unknown>

  // Zod compiled schemas expose ._def, try to handle raw JSON schema shape too
  // Most zod schemas serialise via zodSchema() to standard JSON schema
  const properties = (s['properties'] ?? (s['_def'] as Record<string,unknown> | undefined)?.['shape']) as Record<string, unknown> | undefined
  const required = (s['required'] as string[] | undefined) ?? []

  if (!properties) return []

  return Object.entries(properties).map(([name, def]) => {
    const d = def as Record<string, unknown>
    const type = (d['type'] as string | undefined) ?? (d['_def'] as Record<string,unknown> | undefined)?.['typeName'] as string ?? '?'
    const description = (d['description'] as string | undefined) ?? ''
    return { name, type, description, required: required.includes(name) }
  })
}

function ToolRow({ t }: { t: Tool }) {
  const [open, setOpen] = useState(false)
  const params = schemaToParams(t.input_schema)

  return (
    <div className="border border-border/40 rounded-lg overflow-hidden text-xs">
      {/* Header row */}
      <button
        className="flex items-center gap-2 w-full px-3 py-2.5 hover:bg-muted/40 transition-colors text-left"
        onClick={() => setOpen(o => !o)}
      >
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="font-semibold text-foreground truncate">{t.name}</span>
            {t.has_prompt && (
              <span className="px-1.5 py-0.5 rounded text-[10px] bg-amber-500/10 text-amber-600 dark:text-amber-400 shrink-0">
                hint {t.token_estimate}tok
              </span>
            )}
          </div>
          {!open && t.description && (
            <p className="text-muted-foreground mt-0.5 truncate text-[11px]">{t.description}</p>
          )}
        </div>
        <ChevronDown className={cn('h-3.5 w-3.5 text-muted-foreground shrink-0 transition-transform', open && 'rotate-180')} />
      </button>

      {/* Expanded detail */}
      {open && (
        <div className="border-t border-border/30 bg-muted/10 divide-y divide-border/20">
          {/* Description */}
          <div className="px-3 py-2 space-y-0.5">
            <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Description</p>
            <p className="text-[11px] text-foreground/80 leading-relaxed">{t.description || '—'}</p>
          </div>

          {/* ID */}
          <div className="px-3 py-2 space-y-0.5">
            <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Tool ID</p>
            <code className="font-mono text-[11px] text-foreground/70">{shortToolId(t.id)}</code>
          </div>

          {/* Permission */}
          {t.permission !== '*' && (
            <div className="px-3 py-2 space-y-0.5">
              <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Permission</p>
              <code className="font-mono text-[11px] text-foreground/70">{t.permission}</code>
            </div>
          )}

          {/* Parameters */}
          <div className="px-3 py-2 space-y-1.5">
            <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
              Parameters {params.length > 0 ? `(${params.length})` : ''}
            </p>
            {params.length === 0 ? (
              <p className="text-[11px] text-muted-foreground italic">No parameters</p>
            ) : (
              <div className="space-y-1.5">
                {params.map(p => (
                  <div key={p.name} className="rounded-md bg-muted/40 px-2.5 py-2 space-y-0.5">
                    <div className="flex items-center gap-1.5">
                      <code className="font-mono text-[11px] font-semibold text-foreground/90">{p.name}</code>
                      <span className="text-[10px] px-1 py-px rounded bg-muted text-muted-foreground font-mono">{p.type}</span>
                      {p.required && (
                        <span className="text-[10px] px-1 py-px rounded bg-red-500/10 text-red-500">required</span>
                      )}
                    </div>
                    {p.description && (
                      <p className="text-[11px] text-muted-foreground leading-relaxed">{p.description}</p>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

function ActiveToolsList({ tools }: { tools: Tool[] }) {
  const [query, setQuery] = useState('')

  const filtered = query.trim()
    ? tools.filter(t =>
        t.name.toLowerCase().includes(query.toLowerCase()) ||
        t.id.toLowerCase().includes(query.toLowerCase()) ||
        t.description.toLowerCase().includes(query.toLowerCase())
      )
    : tools

  const grouped = filtered.reduce<Record<string, Tool[]>>((acc, t) => {
    const cat = toolGroup(t)
    if (!acc[cat]) acc[cat] = []
    acc[cat].push(t)
    return acc
  }, {})

  if (tools.length === 0) {
    return <p className="text-xs text-muted-foreground">No active tools in this session.</p>
  }

  return (
    <div className="space-y-3">
      {tools.length > 4 && (
        <div className="relative">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3 w-3 text-muted-foreground pointer-events-none" />
          <Input
            value={query}
            onChange={e => setQuery(e.target.value)}
            placeholder="Filter by name, id, or description…"
            className="h-7 pl-7 text-xs"
          />
        </div>
      )}

      {filtered.length === 0 && (
        <p className="text-xs text-muted-foreground">No tools match &quot;{query}&quot;</p>
      )}

      {Object.entries(grouped).map(([cat, catTools]) => (
        <div key={cat} className="space-y-1">
          <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground px-0.5">
            {cat} <span className="font-normal normal-case">({catTools.length})</span>
          </p>
          {catTools.map(t => <ToolRow key={t.id} t={t} />)}
        </div>
      ))}
    </div>
  )
}

// ─── SegmentGroupList ─────────────────────────────────────────────────────────

const SOURCE_LABELS: Record<string, string> = {
  base_prompt: 'Base Prompt',
  persona: 'Persona',
  mode: 'Mode',
  user_context: 'User Context',
  plugin: 'Plugins',
  memory: 'Memory',
  tool_hint: 'Tool Hints',
}

function SegmentGroupList({ segments }: { segments: ContextSegment[] }) {
  const grouped = segments.reduce<Record<string, ContextSegment[]>>((acc, seg) => {
    if (!acc[seg.source]) acc[seg.source] = []
    acc[seg.source].push(seg)
    return acc
  }, {})

  if (segments.length === 0) {
    return <p className="text-xs text-muted-foreground">No context segments.</p>
  }

  return (
    <div className="space-y-3">
      {Object.entries(grouped).map(([source, segs]) => {
        const total = segs.reduce((sum, s) => sum + s.token_estimate, 0)
        return (
          <div key={source} className="space-y-1">
            <div className="flex items-center gap-1.5 px-0.5">
              <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground flex-1">
                {SOURCE_LABELS[source] ?? source}
              </p>
              <span className="text-[10px] tabular-nums text-muted-foreground">{total.toLocaleString()} tok</span>
              <span className="text-[10px] text-muted-foreground/60">({segs.length})</span>
            </div>
            {segs.map((seg, i) => <SegmentRow key={i} seg={seg} />)}
          </div>
        )
      })}
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

// ─── Tab navigation ───────────────────────────────────────────────────────────

type Tab = 'context' | 'tools'

// ─── PreviewContent ───────────────────────────────────────────────────────────

function PreviewContent({ preview }: { preview: PreviewRunResult }) {
  const [tab, setTab] = useState<Tab>('context')

  return (
    <div className="space-y-4 pt-2">
      {/* Model info */}
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

      <SystemPromptView prompt={preview.system_prompt} />

      {/* Tab switcher */}
      <div className="flex border border-border/40 rounded-lg overflow-hidden text-xs">
        <button
          onClick={() => setTab('context')}
          className={cn(
            'flex-1 flex items-center justify-center gap-1.5 py-1.5 transition-colors font-medium',
            tab === 'context'
              ? 'bg-muted text-foreground'
              : 'text-muted-foreground hover:text-foreground hover:bg-muted/40',
          )}
        >
          <Layers className="h-3 w-3" />
          Context
          <span className="text-muted-foreground font-normal">({preview.context.segments.length})</span>
        </button>
        <button
          onClick={() => setTab('tools')}
          className={cn(
            'flex-1 flex items-center justify-center gap-1.5 py-1.5 transition-colors font-medium border-l border-border/40',
            tab === 'tools'
              ? 'bg-muted text-foreground'
              : 'text-muted-foreground hover:text-foreground hover:bg-muted/40',
          )}
        >
          <Wrench className="h-3 w-3" />
          Tools
          <span className="text-muted-foreground font-normal">({preview.active_tools.length})</span>
        </button>
      </div>

      {tab === 'context' && (
        <section className="space-y-3">
          <SegmentGroupList segments={preview.context.segments} />
        </section>
      )}

      {tab === 'tools' && (
        <section>
          <ActiveToolsList tools={preview.active_tools} />
        </section>
      )}
    </div>
  )
}

// ─── ContextPreviewSheet ──────────────────────────────────────────────────────

interface ContextPreviewSheetProps {
  agentId: string
  conversationId?: string
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Open directly on the tools tab */
  defaultTab?: Tab
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
