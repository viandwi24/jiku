'use client'

import { useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { api } from '@/lib/api'
import { Button } from '@jiku/ui'
import { Checkbox } from '@jiku/ui'
import { Label } from '@jiku/ui'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@jiku/ui'
import { toast } from 'sonner'

interface EditMyPermissionsProps {
  open: boolean
  onClose: () => void
  agentId: string
  userId: string
  companyId: string
  agentName: string
  actualPermissions: string[]
  currentAllowed: string[]
}

export function EditMyPermissions({
  open,
  onClose,
  agentId,
  userId,
  companyId,
  agentName,
  actualPermissions,
  currentAllowed,
}: EditMyPermissionsProps) {
  const qc = useQueryClient()
  const [selected, setSelected] = useState<Set<string>>(() =>
    new Set(currentAllowed.length > 0 ? currentAllowed : actualPermissions)
  )

  const mutation = useMutation({
    mutationFn: () =>
      api.policies.updateUserPolicy(agentId, userId, {
        allowed_permissions: Array.from(selected),
        company_id: companyId,
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['user-policies', agentId] })
      toast.success('Permissions updated')
      onClose()
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : 'Failed to update'),
  })

  function toggle(perm: string) {
    setSelected(prev => {
      const next = new Set(prev)
      if (next.has(perm)) next.delete(perm)
      else next.add(perm)
      return next
    })
  }

  return (
    <Dialog open={open} onOpenChange={v => { if (!v) onClose() }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Edit My Permissions — {agentName}</DialogTitle>
          <DialogDescription>
            Uncheck permissions to restrict your access for this agent. You cannot grant permissions you don't have.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3 py-2">
          {actualPermissions.map(perm => (
            <div key={perm} className="flex items-center gap-2">
              <Checkbox
                id={perm}
                checked={selected.has(perm)}
                onCheckedChange={() => toggle(perm)}
              />
              <Label htmlFor={perm} className="font-mono text-sm cursor-pointer">{perm}</Label>
            </div>
          ))}
          {actualPermissions.length === 0 && (
            <p className="text-sm text-muted-foreground">You have no permissions in this company.</p>
          )}
        </div>
        <div className="flex justify-end gap-2 pt-2">
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button onClick={() => mutation.mutate()} disabled={mutation.isPending}>
            {mutation.isPending ? 'Saving...' : 'Save Changes'}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
