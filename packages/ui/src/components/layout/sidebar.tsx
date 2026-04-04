import React from 'react'
import { cn } from '../../lib/utils.ts'

interface SidebarProps {
  children: React.ReactNode
  className?: string
  collapsed?: boolean
}

export function Sidebar({ children, className, collapsed = false }: SidebarProps) {
  return (
    <aside
      className={cn(
        'flex flex-col h-full border-r bg-sidebar text-sidebar-foreground transition-all duration-300',
        collapsed ? 'w-14' : 'w-60',
        className,
      )}
    >
      {children}
    </aside>
  )
}

export function SidebarHeader({ children, className }: { children: React.ReactNode; className?: string }) {
  return <div className={cn('p-4 border-b', className)}>{children}</div>
}

export function SidebarContent({ children, className }: { children: React.ReactNode; className?: string }) {
  return <div className={cn('flex-1 overflow-y-auto p-2', className)}>{children}</div>
}

export function SidebarFooter({ children, className }: { children: React.ReactNode; className?: string }) {
  return <div className={cn('p-4 border-t', className)}>{children}</div>
}

export function SidebarItem({
  icon,
  label,
  active,
  onClick,
  className,
}: {
  icon?: React.ReactNode
  label: string
  active?: boolean
  onClick?: () => void
  className?: string
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'flex items-center gap-3 w-full px-3 py-2 rounded-md text-sm font-medium transition-colors',
        'hover:bg-sidebar-accent hover:text-sidebar-accent-foreground',
        active && 'bg-sidebar-accent text-sidebar-accent-foreground',
        className,
      )}
    >
      {icon && <span className="shrink-0">{icon}</span>}
      <span className="truncate">{label}</span>
    </button>
  )
}
