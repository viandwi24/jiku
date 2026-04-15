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
  /** When provided, "Setup" / "Re-run Setup" item appears in each row's dropdown for credentials whose adapter requires interactive setup. Caller decides eligibility (e.g. via adapter.requires_interactive_setup) and passes-through the credential. */
  onSetup?: (credential: CredentialCardItem) => void
  /** Returns true when the given credential is eligible for the Setup action (e.g. adapter requires it). When undefined, `onSetup` shows for ALL rows. */
  isSetupEligible?: (credential: CredentialCardItem) => boolean
  /** Returns true when setup has already been completed for the given credential — flips the label to "Re-run Setup". */
  isSetupCompleted?: (credential: CredentialCardItem) => boolean
  emptyText?: string
  className?: string
}

export function CredentialList({
  credentials,
  readonly,
  onEdit,
  onDelete,
  onTest,
  onSetup,
  isSetupEligible,
  isSetupCompleted,
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
      {credentials.map(cred => {
        const eligible = onSetup ? (isSetupEligible ? isSetupEligible(cred) : true) : false
        return (
          <CredentialCard
            key={cred.id}
            credential={cred}
            readonly={readonly}
            onEdit={onEdit}
            onDelete={onDelete}
            onTest={onTest}
            onSetup={eligible ? onSetup : undefined}
            setupCompleted={eligible && isSetupCompleted ? isSetupCompleted(cred) : false}
          />
        )
      })}
    </div>
  )
}
