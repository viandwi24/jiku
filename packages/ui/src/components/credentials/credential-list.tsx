'use client'

import { CredentialCard } from './credential-card.tsx'
import type { CredentialCardItem } from './credential-card.tsx'
import { cn } from '../../lib/utils.ts'

interface CredentialListProps {
  credentials: CredentialCardItem[]
  readonly?: boolean
  onEdit?: (credential: CredentialCardItem) => void
  onDelete?: (id: string) => void
  onTest?: (id: string) => void
  emptyText?: string
  className?: string
}

export function CredentialList({
  credentials,
  readonly,
  onEdit,
  onDelete,
  onTest,
  emptyText = 'No credentials yet.',
  className,
}: CredentialListProps) {
  if (credentials.length === 0) {
    return (
      <div className={cn('rounded-md border px-4 py-8 text-center text-sm text-muted-foreground', className)}>
        {emptyText}
      </div>
    )
  }

  return (
    <div className={cn('rounded-md border divide-y divide-border overflow-hidden', className)}>
      {credentials.map(cred => (
        <CredentialCard
          key={cred.id}
          credential={cred}
          readonly={readonly}
          onEdit={onEdit}
          onDelete={onDelete}
          onTest={onTest}
        />
      ))}
    </div>
  )
}
