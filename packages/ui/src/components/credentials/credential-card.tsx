'use client'

import { Badge } from '../ui/badge.tsx'
import { Button } from '../ui/button.tsx'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '../ui/dropdown-menu.tsx'
import { MoreHorizontal, Trash2, Pencil, Zap } from 'lucide-react'
import { cn } from '../../lib/utils.ts'

export interface CredentialCardItem {
  id: string
  name: string
  description: string | null
  adapter_id: string
  group_id: string
  scope: string
  metadata: Record<string, string>
  fields_masked: Record<string, string>
  adapter?: { name: string }
}

interface CredentialCardProps {
  credential: CredentialCardItem
  readonly?: boolean
  onEdit?: (credential: CredentialCardItem) => void
  onDelete?: (id: string) => void
  onTest?: (id: string) => void
}

export function CredentialCard({ credential, readonly, onEdit, onDelete, onTest }: CredentialCardProps) {
  return (
    <div className="flex items-center justify-between px-4 py-3 border-b last:border-b-0">
      <div className="flex items-center gap-3 min-w-0">
        <div className="flex flex-col gap-0.5 min-w-0">
          <span className="font-medium text-sm truncate">{credential.name}</span>
          {credential.description && (
            <span className="text-xs text-muted-foreground truncate">{credential.description}</span>
          )}
          <div className="flex items-center gap-1.5 mt-0.5">
            <span className="text-xs text-muted-foreground">{credential.adapter?.name ?? credential.adapter_id}</span>
            <Badge variant="outline" className={cn('text-xs h-4 px-1', credential.scope === 'company' ? 'border-blue-500/50 text-blue-600' : 'border-purple-500/50 text-purple-600')}>
              {credential.scope}
            </Badge>
          </div>
        </div>
      </div>

      {!readonly && (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon" className="h-7 w-7 shrink-0">
              <MoreHorizontal className="w-4 h-4" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            {onTest && (
              <DropdownMenuItem onClick={() => onTest(credential.id)}>
                <Zap className="w-3.5 h-3.5 mr-2" /> Test Connection
              </DropdownMenuItem>
            )}
            {onEdit && (
              <DropdownMenuItem onClick={() => onEdit(credential)}>
                <Pencil className="w-3.5 h-3.5 mr-2" /> Edit
              </DropdownMenuItem>
            )}
            {onDelete && (
              <DropdownMenuItem variant="destructive" onClick={() => onDelete(credential.id)}>
                <Trash2 className="w-3.5 h-3.5 mr-2" /> Delete
              </DropdownMenuItem>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      )}
    </div>
  )
}
