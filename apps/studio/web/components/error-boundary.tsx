'use client'

import { Component } from 'react'
import type { ReactNode, ErrorInfo } from 'react'
import { Button } from '@jiku/ui'
import { AlertCircle } from 'lucide-react'

interface Props {
  children: ReactNode
  fallback?: ReactNode
}

interface State {
  hasError: boolean
  error: Error | null
}

export class ErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props)
    this.state = { hasError: false, error: null }
  }

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error }
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('ErrorBoundary caught:', error, info)
  }

  render() {
    if (this.state.hasError) {
      if (this.props.fallback) return this.props.fallback
      return (
        <div className="flex flex-col items-center justify-center h-full gap-3 p-8 text-center">
          <AlertCircle className="h-8 w-8 text-destructive" />
          <p className="font-medium text-sm">Something went wrong</p>
          {this.state.error && (
            <p className="text-xs text-muted-foreground max-w-sm">{this.state.error.message}</p>
          )}
          <Button variant="outline" size="sm" onClick={() => this.setState({ hasError: false, error: null })}>
            Try again
          </Button>
        </div>
      )
    }
    return this.props.children
  }
}
