'use client'

import { useState } from 'react'
import { Minimize2, ChevronDown } from 'lucide-react'
import { cn } from '@jiku/ui'

interface CompactionIndicatorProps {
  summary: string
  removedCount: number
  tokenSaved: number
}

export function CompactionIndicator({ summary, removedCount, tokenSaved }: CompactionIndicatorProps) {
  const [open, setOpen] = useState(false)

  return (
    <div className="my-2 rounded-lg border border-dashed border-border bg-muted/30 text-xs text-muted-foreground overflow-hidden">
      <div className="flex items-center gap-2 px-3 py-2">
        <Minimize2 className="h-3.5 w-3.5 shrink-0" />
        <span className="flex-1">
          Context compacted — {removedCount} message{removedCount !== 1 ? 's' : ''} summarized
          {tokenSaved > 0 && <span className="text-muted-foreground/60"> (~{tokenSaved.toLocaleString()} tokens saved)</span>}
        </span>
        {summary && (
          <button
            className="text-xs underline underline-offset-2 hover:text-foreground transition-colors shrink-0 flex items-center gap-1"
            onClick={() => setOpen(o => !o)}
          >
            View summary
            <ChevronDown className={cn('h-3 w-3 transition-transform', open && 'rotate-180')} />
          </button>
        )}
      </div>
      {open && summary && (
        <div className="px-3 pb-3 pt-0 border-t border-dashed border-border/50">
          <p className="text-foreground/70 leading-relaxed">{summary}</p>
        </div>
      )}
    </div>
  )
}
