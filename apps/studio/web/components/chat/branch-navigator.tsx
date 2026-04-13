'use client'

import { ChevronLeft, ChevronRight } from 'lucide-react'

export interface BranchNavigatorProps {
  /** 1-based index of the currently active sibling. */
  currentIndex: number
  /** Total siblings at this branch point. */
  total: number
  onPrev: () => void
  onNext: () => void
  disabled?: boolean
  /** Contextual label shown next to the counter, e.g. "Edit" or "Response". */
  label?: string
}

/**
 * Plan 23 — inline navigator rendered above any message whose `sibling_count > 1`.
 * Hidden entirely when there's only one sibling.
 */
export function BranchNavigator({
  currentIndex,
  total,
  onPrev,
  onNext,
  disabled,
  label,
}: BranchNavigatorProps) {
  if (total <= 1) return null
  return (
    <div className="flex items-center gap-1.5 text-xs text-muted-foreground py-1 select-none">
      <button
        type="button"
        onClick={onPrev}
        disabled={disabled || currentIndex <= 1}
        className="p-0.5 rounded hover:text-foreground hover:bg-muted/60 disabled:opacity-30 disabled:hover:bg-transparent"
        title="Previous branch"
      >
        <ChevronLeft className="w-3.5 h-3.5" />
      </button>
      <span className="tabular-nums font-mono">{currentIndex} / {total}</span>
      <button
        type="button"
        onClick={onNext}
        disabled={disabled || currentIndex >= total}
        className="p-0.5 rounded hover:text-foreground hover:bg-muted/60 disabled:opacity-30 disabled:hover:bg-transparent"
        title="Next branch"
      >
        <ChevronRight className="w-3.5 h-3.5" />
      </button>
      {label && (
        <span className="text-[10px] uppercase tracking-wide opacity-60">{label}</span>
      )}
    </div>
  )
}
