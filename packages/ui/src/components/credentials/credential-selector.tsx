'use client'

import { useState } from 'react'
import { Badge } from '../ui/badge.tsx'
import { Button } from '../ui/button.tsx'
import { cn } from '../../lib/utils.ts'
import { CheckCircle2, Circle } from 'lucide-react'

interface CredentialOption {
  id: string
  name: string
  description?: string | null
  adapter_id: string
  group_id: string
  scope: string
  adapter?: { name: string }
}

interface CredentialSelectorProps {
  credentials: CredentialOption[]
  value?: string | null
  onChange: (id: string) => void
  groupFilter?: string
}

export function CredentialSelector({ credentials, value, onChange, groupFilter }: CredentialSelectorProps) {
  const filtered = groupFilter ? credentials.filter(c => c.group_id === groupFilter) : credentials

  // Group by group_id
  const groups = filtered.reduce<Record<string, CredentialOption[]>>((acc, cred) => {
    if (!acc[cred.group_id]) acc[cred.group_id] = []
    acc[cred.group_id]!.push(cred)
    return acc
  }, {})

  if (filtered.length === 0) {
    return (
      <div className="rounded-md border px-4 py-6 text-center text-sm text-muted-foreground">
        No credentials available. Add one in company or project settings.
      </div>
    )
  }

  return (
    <div className="rounded-md border divide-y divide-border overflow-hidden">
      {Object.entries(groups).map(([groupId, creds]) => (
        <div key={groupId}>
          <div className="px-3 py-1.5 bg-muted/40 text-xs font-medium text-muted-foreground uppercase tracking-wide">
            {groupId}
          </div>
          {creds.map(cred => {
            const selected = cred.id === value
            return (
              <button
                key={cred.id}
                type="button"
                className={cn(
                  'w-full flex items-center gap-3 px-4 py-3 text-left hover:bg-muted/50 transition-colors',
                  selected && 'bg-primary/5'
                )}
                onClick={() => onChange(cred.id)}
              >
                {selected
                  ? <CheckCircle2 className="w-4 h-4 text-primary shrink-0" />
                  : <Circle className="w-4 h-4 text-muted-foreground shrink-0" />
                }
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium">{cred.name}</span>
                    <Badge
                      variant="outline"
                      className={cn('text-xs h-4 px-1', cred.scope === 'company' ? 'border-blue-500/50 text-blue-600' : 'border-purple-500/50 text-purple-600')}
                    >
                      {cred.scope}
                    </Badge>
                  </div>
                  <span className="text-xs text-muted-foreground">{cred.adapter?.name ?? cred.adapter_id}</span>
                </div>
              </button>
            )
          })}
        </div>
      ))}
    </div>
  )
}
