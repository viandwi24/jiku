import React, { useState } from 'react'
import { cn } from '../../lib/utils.ts'
import { ChevronDown, ChevronRight, Wrench } from 'lucide-react'

interface ToolCallViewProps {
  toolName: string
  input?: unknown
  result?: unknown
  className?: string
}

export function ToolCallView({ toolName, input, result, className }: ToolCallViewProps) {
  const [open, setOpen] = useState(false)

  return (
    <div className={cn('rounded-md border bg-muted/30 text-sm overflow-hidden', className)}>
      <button
        type="button"
        onClick={() => setOpen(v => !v)}
        className="flex items-center gap-2 w-full px-3 py-2 text-left hover:bg-muted/50 transition-colors"
      >
        <Wrench className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
        <span className="font-mono text-xs font-medium flex-1">{toolName}</span>
        {open ? (
          <ChevronDown className="w-3.5 h-3.5 text-muted-foreground" />
        ) : (
          <ChevronRight className="w-3.5 h-3.5 text-muted-foreground" />
        )}
      </button>
      {open && (
        <div className="px-3 pb-3 space-y-2 border-t bg-background/50">
          {input !== undefined && (
            <div>
              <p className="text-xs text-muted-foreground mt-2 mb-1">Input</p>
              <pre className="text-xs bg-muted p-2 rounded overflow-x-auto">
                {JSON.stringify(input, null, 2)}
              </pre>
            </div>
          )}
          {result !== undefined && (
            <div>
              <p className="text-xs text-muted-foreground mb-1">Result</p>
              <pre className="text-xs bg-muted p-2 rounded overflow-x-auto">
                {JSON.stringify(result, null, 2)}
              </pre>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
