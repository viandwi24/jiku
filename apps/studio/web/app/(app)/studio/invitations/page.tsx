'use client'

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { api } from '@/lib/api'
import type { InvitationItem } from '@/lib/api'
import { Button, Badge } from '@jiku/ui'
import { CheckCircle2, XCircle, Mail } from 'lucide-react'
import { toast } from 'sonner'
import { formatDistanceToNow } from 'date-fns'

export default function InvitationsPage() {
  const qc = useQueryClient()

  const { data, isLoading } = useQuery({
    queryKey: ['my-invitations'],
    queryFn: () => api.acl.listMyInvitations(),
  })

  const acceptMutation = useMutation({
    mutationFn: (id: string) => api.acl.acceptInvitation(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['my-invitations'] })
      qc.invalidateQueries({ queryKey: ['companies'] })
      toast.success('Invitation accepted')
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : 'Failed'),
  })

  const declineMutation = useMutation({
    mutationFn: (id: string) => api.acl.declineInvitation(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['my-invitations'] })
      toast.success('Invitation declined')
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : 'Failed'),
  })

  const invitations = data?.invitations ?? []
  const pending = invitations.filter(i => i.status === 'pending')
  const past = invitations.filter(i => i.status !== 'pending')

  if (isLoading) return (
    <div className="max-w-2xl mx-auto px-6 py-6">
      <div className="text-sm text-muted-foreground">Loading...</div>
    </div>
  )

  return (
    <div className="max-w-2xl mx-auto px-6 py-6 space-y-6">
      <div>
        <h1 className="text-xl font-semibold">Invitations</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Pending invitations to join companies and projects
        </p>
      </div>

      {invitations.length === 0 && (
        <div className="rounded-lg border p-10 text-center">
          <Mail className="w-8 h-8 mx-auto mb-3 text-muted-foreground/50" />
          <p className="text-sm text-muted-foreground">No invitations</p>
        </div>
      )}

      {pending.length > 0 && (
        <div className="space-y-3">
          <h2 className="text-sm font-medium">Pending ({pending.length})</h2>
          <div className="rounded-lg border divide-y">
            {pending.map((inv: InvitationItem) => (
              <div key={inv.id} className="flex items-start gap-3 px-4 py-4">
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium">
                    {inv.company?.name ?? 'Unknown company'}
                  </p>
                  <p className="text-xs text-muted-foreground mt-0.5">
                    Invited by {inv.invited_by_user?.name ?? inv.invited_by}
                    {' · '}
                    expires {formatDistanceToNow(new Date(inv.expires_at), { addSuffix: true })}
                  </p>
                  {inv.project_grants.length > 0 && (
                    <p className="text-xs text-muted-foreground mt-1">
                      {inv.project_grants.length} project access{inv.project_grants.length !== 1 ? 'es' : ''} included
                    </p>
                  )}
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-7 text-xs"
                    onClick={() => declineMutation.mutate(inv.id)}
                    disabled={declineMutation.isPending}
                  >
                    <XCircle className="w-3.5 h-3.5 mr-1" />
                    Decline
                  </Button>
                  <Button
                    size="sm"
                    className="h-7 text-xs"
                    onClick={() => acceptMutation.mutate(inv.id)}
                    disabled={acceptMutation.isPending}
                  >
                    <CheckCircle2 className="w-3.5 h-3.5 mr-1" />
                    Accept
                  </Button>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {past.length > 0 && (
        <div className="space-y-3">
          <h2 className="text-sm font-medium text-muted-foreground">Past</h2>
          <div className="rounded-lg border divide-y">
            {past.map((inv: InvitationItem) => (
              <div key={inv.id} className="flex items-center gap-3 px-4 py-3">
                <div className="flex-1 min-w-0">
                  <p className="text-sm">{inv.company?.name ?? 'Unknown company'}</p>
                  <p className="text-xs text-muted-foreground">
                    {formatDistanceToNow(new Date(inv.created_at), { addSuffix: true })}
                  </p>
                </div>
                <Badge
                  variant={inv.status === 'accepted' ? 'outline' : 'destructive'}
                  className="text-xs py-0"
                >
                  {inv.status.charAt(0).toUpperCase() + inv.status.slice(1)}
                </Badge>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
