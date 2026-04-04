import React from 'react'
import { cn } from '../../lib/utils.ts'

interface StatCardProps {
  label: string
  value: string | number
  icon?: React.ReactNode
  description?: string
  className?: string
}

export function StatCard({ label, value, icon, description, className }: StatCardProps) {
  return (
    <div className={cn('rounded-lg border bg-card p-4 space-y-2', className)}>
      <div className="flex items-center justify-between">
        <p className="text-sm text-muted-foreground">{label}</p>
        {icon && <span className="text-muted-foreground">{icon}</span>}
      </div>
      <p className="text-2xl font-bold">{value}</p>
      {description && <p className="text-xs text-muted-foreground">{description}</p>}
    </div>
  )
}
