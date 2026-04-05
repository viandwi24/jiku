'use client'

import { useQuery } from '@tanstack/react-query'
import { Brain, ChevronDown } from 'lucide-react'
import { useState } from 'react'
import { api } from '@/lib/api'
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle, Badge, cn } from '@jiku/ui'

const SCOPE_LABELS: Record<string, string> = {
  agent_caller: 'User-Scoped',
  agent_global: 'Agent-Global',
  runtime_global: 'Project-Global',
}

const TIER_COLORS: Record<string, string> = {
  core: 'bg-teal-500/10 text-teal-600 dark:text-teal-400',
  extended: 'bg-slate-500/10 text-slate-600 dark:text-slate-400',
}

const IMPORTANCE_VARIANT: Record<string, 'default' | 'secondary'> = {
  high: 'default',
  medium: 'secondary',
  low: 'secondary',
}

interface MemoryBlock {
  scope: string
  tier: string
  content: string
  importance: string
}

function parseMemorySection(raw: string): MemoryBlock[] {
  const blocks: MemoryBlock[] = []
  if (!raw) return blocks

  let currentScope = 'agent_global'
  let currentTier = 'core'

  for (const line of raw.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue

    // Detect scope headings: ## Project Memory, ## About {User}, etc.
    if (trimmed.startsWith('##')) {
      const heading = trimmed.replace(/^##\s*/, '').toLowerCase()
      if (heading.includes('project')) currentScope = 'runtime_global'
      else if (heading.includes('about') || heading.includes('user')) currentScope = 'agent_caller'
      else if (heading.includes('relevant') || heading.includes('context')) {
        currentScope = 'agent_global'
        currentTier = 'extended'
      } else {
        currentScope = 'agent_global'
        currentTier = 'core'
      }
      continue
    }

    // Bullet items are memory entries
    if (trimmed.startsWith('-') || trimmed.startsWith('•')) {
      const content = trimmed.replace(/^[-•]\s*/, '')
      if (content) {
        blocks.push({ scope: currentScope, tier: currentTier, content, importance: 'medium' })
      }
    }
  }

  return blocks
}

interface MemoryPreviewSheetProps {
  agentId: string
  conversationId?: string
  open: boolean
  onOpenChange: (open: boolean) => void
}

export function MemoryPreviewSheet({ agentId, conversationId, open, onOpenChange }: MemoryPreviewSheetProps) {
  const [expandedScope, setExpandedScope] = useState<string | null>(null)

  const { data: preview, isLoading } = useQuery({
    queryKey: ['preview', agentId, conversationId],
    queryFn: () =>
      conversationId
        ? api.conversations.preview(conversationId, { mode: 'chat' })
        : api.agents.preview(agentId, { mode: 'chat' }),
    enabled: open,
    staleTime: 30_000,
  })

  // Extract memory segment from preview
  const memorySeg = preview?.context.segments.find(s => s.source === 'memory')
  const blocks = memorySeg ? parseMemorySection(memorySeg.content) : []

  // Group by scope
  const grouped = blocks.reduce<Record<string, MemoryBlock[]>>((acc, b) => {
    acc[b.scope] ??= []
    acc[b.scope]!.push(b)
    return acc
  }, {})

  const scopeOrder = ['runtime_global', 'agent_global', 'agent_caller']

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="w-[400px] sm:max-w-[400px] flex flex-col overflow-hidden">
        <SheetHeader>
          <SheetTitle className="flex items-center gap-2 text-sm">
            <Brain className="h-4 w-4 text-teal-500" />
            Memory Preview
          </SheetTitle>
          <SheetDescription className="text-xs">
            Memory injected into this conversation's context
          </SheetDescription>
        </SheetHeader>

        <div className="flex-1 overflow-y-auto px-4 pb-4 space-y-4 pt-2">
          {isLoading && (
            <div className="flex items-center justify-center h-20 text-xs text-muted-foreground">
              Loading memory...
            </div>
          )}

          {!isLoading && !memorySeg && (
            <div className="flex flex-col items-center justify-center h-32 gap-2 text-muted-foreground">
              <Brain className="h-8 w-8 opacity-25" />
              <p className="text-xs">No memory injected in this session.</p>
              <p className="text-xs opacity-60">Memory extraction may not be enabled for this project.</p>
            </div>
          )}

          {memorySeg && (
            <>
              {/* Token summary */}
              <div className="flex items-center justify-between rounded-md border border-border/40 px-3 py-2 text-xs">
                <span className="text-muted-foreground">Memory tokens</span>
                <span className="font-medium tabular-nums text-teal-600 dark:text-teal-400">
                  {memorySeg.token_estimate.toLocaleString()} tok
                </span>
              </div>

              {/* Total count */}
              <div className="flex items-center gap-2 text-xs text-muted-foreground px-1">
                <span>{blocks.length} memories injected</span>
                <span className="ml-auto">
                  {Object.entries(grouped).map(([scope, items]) => (
                    <span key={scope} className="ml-2">
                      {SCOPE_LABELS[scope] ?? scope}: {items.length}
                    </span>
                  ))}
                </span>
              </div>

              {/* Grouped by scope */}
              {scopeOrder.filter(s => grouped[s]?.length).map(scope => {
                const items = grouped[scope]!
                const isOpen = expandedScope === scope
                return (
                  <div key={scope} className="border border-border/40 rounded-lg overflow-hidden">
                    <button
                      className="flex items-center gap-2 w-full px-3 py-2 hover:bg-muted/40 transition-colors text-left"
                      onClick={() => setExpandedScope(isOpen ? null : scope)}
                    >
                      <span className="h-2 w-2 rounded-full bg-teal-500 shrink-0" />
                      <span className="flex-1 text-xs font-medium">{SCOPE_LABELS[scope] ?? scope}</span>
                      <Badge variant="secondary" className="text-[10px] font-normal">{items.length}</Badge>
                      <ChevronDown className={cn('h-3 w-3 text-muted-foreground transition-transform shrink-0', isOpen && 'rotate-180')} />
                    </button>
                    {isOpen && (
                      <div className="border-t border-border/30 divide-y divide-border/20">
                        {items.map((block, i) => (
                          <div key={i} className="px-3 py-2 flex flex-col gap-1 bg-muted/10">
                            <div className="flex items-center gap-1.5">
                              <span className={cn('text-[10px] px-1.5 py-0.5 rounded font-medium', TIER_COLORS[block.tier] ?? 'bg-muted text-muted-foreground')}>
                                {block.tier}
                              </span>
                              <Badge variant={IMPORTANCE_VARIANT[block.importance] ?? 'secondary'} className="text-[10px] font-normal">
                                {block.importance}
                              </Badge>
                            </div>
                            <p className="text-xs leading-relaxed text-foreground/80">{block.content}</p>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                )
              })}

              {/* Raw content toggle */}
              <RawMemorySection content={memorySeg.content} />
            </>
          )}
        </div>
      </SheetContent>
    </Sheet>
  )
}

function RawMemorySection({ content }: { content: string }) {
  const [open, setOpen] = useState(false)
  return (
    <div className="border border-border/40 rounded-lg overflow-hidden">
      <button
        className="flex items-center gap-2 w-full px-3 py-2 text-xs font-medium hover:bg-muted/40 transition-colors text-left"
        onClick={() => setOpen(o => !o)}
      >
        <span className="flex-1 text-muted-foreground">Raw injected text</span>
        <ChevronDown className={cn('h-3 w-3 text-muted-foreground transition-transform', open && 'rotate-180')} />
      </button>
      {open && (
        <div className="border-t border-border/30">
          <pre className="font-mono text-[11px] text-foreground/70 whitespace-pre-wrap p-3 max-h-48 overflow-auto leading-relaxed bg-muted/10">
            {content}
          </pre>
        </div>
      )}
    </div>
  )
}
