import React from 'react'
import { cn } from '../../lib/utils.ts'

interface HeaderProps {
  children?: React.ReactNode
  className?: string
}

export function Header({ children, className }: HeaderProps) {
  return (
    <header
      className={cn(
        'flex items-center justify-between h-14 px-4 border-b bg-background shrink-0',
        className,
      )}
    >
      {children}
    </header>
  )
}

export function Breadcrumb({ items }: { items: { label: string; href?: string }[] }) {
  return (
    <nav className="flex items-center gap-1 text-sm">
      {items.map((item, i) => (
        <React.Fragment key={i}>
          {i > 0 && <span className="text-muted-foreground">/</span>}
          {item.href ? (
            <a href={item.href} className="text-muted-foreground hover:text-foreground transition-colors">
              {item.label}
            </a>
          ) : (
            <span className="text-foreground font-medium">{item.label}</span>
          )}
        </React.Fragment>
      ))}
    </nav>
  )
}
