import React from 'react'
import { cn } from '../../lib/utils.ts'

export function ThinkingIndicator({ className }: { className?: string }) {
  return (
    <div className={cn('flex justify-start', className)}>
      <div className="bg-muted rounded-lg rounded-bl-sm px-4 py-3 flex items-center gap-1">
        <span className="w-1.5 h-1.5 rounded-full bg-muted-foreground animate-bounce [animation-delay:-0.3s]" />
        <span className="w-1.5 h-1.5 rounded-full bg-muted-foreground animate-bounce [animation-delay:-0.15s]" />
        <span className="w-1.5 h-1.5 rounded-full bg-muted-foreground animate-bounce" />
      </div>
    </div>
  )
}
