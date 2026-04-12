'use client'

// ErrorBoundary used to wrap each plugin island. Host-side — never inside
// plugin bundles.

import { Component, type ReactNode } from 'react'

interface EBProps {
  pluginId: string
  entryId: string
  children: ReactNode
}

interface EBState {
  err: Error | null
}

export class PluginErrorBoundary extends Component<EBProps, EBState> {
  state: EBState = { err: null }
  static getDerivedStateFromError(err: Error): EBState { return { err } }
  componentDidCatch(err: Error, info: unknown): void {
    console.error(`[plugin-ui] ${this.props.pluginId} (${this.props.entryId}) crashed:`, err, info)
  }

  reset = () => this.setState({ err: null })

  override render() {
    if (!this.state.err) return this.props.children
    return (
      <div
        role="alert"
        className="rounded-md border border-destructive/40 bg-destructive/5 p-4 text-sm"
      >
        <div className="font-medium text-destructive">
          Plugin "{this.props.pluginId}" failed
        </div>
        <div className="mt-1 text-xs text-muted-foreground">{this.state.err.message}</div>
        <div className="mt-3 flex gap-2">
          <button
            type="button"
            onClick={this.reset}
            className="rounded border px-2 py-1 text-xs hover:bg-accent"
          >
            Reload
          </button>
        </div>
      </div>
    )
  }
}
