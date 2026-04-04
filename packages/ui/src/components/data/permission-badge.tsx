import React from 'react'
import { cn } from '../../lib/utils.ts'

interface PermissionBadgeProps {
  permission: string
  className?: string
}

export function PermissionBadge({ permission, className }: PermissionBadgeProps) {
  const parts = permission.split(':')
  const short = parts[parts.length - 1] ?? permission

  return (
    <span
      className={cn(
        'inline-flex items-center px-2 py-0.5 rounded text-xs font-mono font-medium',
        'bg-muted text-muted-foreground border border-border',
        className,
      )}
      title={permission}
    >
      {short}
    </span>
  )
}
