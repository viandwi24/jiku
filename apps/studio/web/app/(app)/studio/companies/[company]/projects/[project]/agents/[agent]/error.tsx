'use client'

import { Button } from '@jiku/ui'
import { AlertCircle } from 'lucide-react'

export default function AgentError({
  error,
  reset,
}: {
  error: Error & { digest?: string }
  reset: () => void
}) {
  return (
    <div className="flex flex-col items-center justify-center h-full gap-3 p-8 text-center">
      <AlertCircle className="h-8 w-8 text-destructive" />
      <p className="font-medium text-sm">Something went wrong</p>
      <p className="text-xs text-muted-foreground max-w-sm">{error.message}</p>
      <Button variant="outline" size="sm" onClick={reset}>Try again</Button>
    </div>
  )
}
