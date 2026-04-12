'use client'

import type { ReactNode } from 'react'

/**
 * Standard top-level wrapper for full-page plugin slots (`project.page`, `agent.page`).
 * Provides consistent spacing, heading, and actions layout so every plugin looks
 * native to Studio.
 */
export function PluginPage({
  title,
  description,
  actions,
  children,
}: {
  title: string
  description?: string
  actions?: ReactNode
  children: ReactNode
}) {
  return (
    <div className="flex flex-col gap-6 p-6">
      <header className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
          {description && (
            <p className="mt-1 text-sm text-muted-foreground">{description}</p>
          )}
        </div>
        {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
      </header>
      <div className="flex flex-col gap-6">{children}</div>
    </div>
  )
}

export function PluginSection({
  title,
  description,
  actions,
  children,
}: {
  title?: string
  description?: string
  actions?: ReactNode
  children: ReactNode
}) {
  return (
    <section className="flex flex-col gap-3">
      {(title || actions) && (
        <div className="flex items-center justify-between">
          {title && (
            <div>
              <h2 className="text-base font-medium">{title}</h2>
              {description && (
                <p className="text-xs text-muted-foreground">{description}</p>
              )}
            </div>
          )}
          {actions && <div className="flex items-center gap-2">{actions}</div>}
        </div>
      )}
      {children}
    </section>
  )
}

export function PluginCard({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div
      className={
        'rounded-lg border border-border bg-card p-4 shadow-sm ' + (className ?? '')
      }
    >
      {children}
    </div>
  )
}

/** Standard skeleton used while a plugin module is lazy-loading. */
export function PluginSkeleton({ variant = 'page' }: { variant?: 'page' | 'widget' | 'inline' }) {
  if (variant === 'inline') {
    return <div className="h-4 w-24 animate-pulse rounded bg-muted" />
  }
  if (variant === 'widget') {
    return (
      <div className="rounded-lg border border-border bg-card p-4">
        <div className="h-4 w-32 animate-pulse rounded bg-muted" />
        <div className="mt-3 h-16 w-full animate-pulse rounded bg-muted" />
      </div>
    )
  }
  return (
    <div className="flex flex-col gap-6 p-6">
      <div className="h-8 w-48 animate-pulse rounded bg-muted" />
      <div className="h-4 w-72 animate-pulse rounded bg-muted" />
      <div className="mt-4 grid gap-4 md:grid-cols-3">
        <div className="h-32 animate-pulse rounded bg-muted" />
        <div className="h-32 animate-pulse rounded bg-muted" />
        <div className="h-32 animate-pulse rounded bg-muted" />
      </div>
    </div>
  )
}
