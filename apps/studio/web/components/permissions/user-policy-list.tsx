'use client'

import type { UserPolicy } from '@/lib/api'
import { Badge } from '@jiku/ui'
import { Button } from '@jiku/ui'

interface UserPolicyListProps {
  policies: UserPolicy[]
  currentUserId?: string
  onEditMyPermissions: (policy: UserPolicy | null, actualPermissions: string[]) => void
}

export function UserPolicyList({ policies, currentUserId, onEditMyPermissions }: UserPolicyListProps) {
  if (policies.length === 0) {
    return <p className="text-sm text-muted-foreground py-4">No user policies configured</p>
  }

  return (
    <div className="rounded-md border">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b bg-muted/50">
            <th className="px-4 py-2.5 text-left font-medium text-muted-foreground">User</th>
            <th className="px-4 py-2.5 text-left font-medium text-muted-foreground">Allowed Permissions</th>
            <th className="px-4 py-2.5 w-32" />
          </tr>
        </thead>
        <tbody>
          {policies.map(policy => {
            const isMe = policy.user_id === currentUserId
            return (
              <tr key={policy.id} className="border-b last:border-0">
                <td className="px-4 py-2.5">
                  <div className="flex items-center gap-2">
                    <span>{policy.user?.name ?? policy.user_id}</span>
                    {isMe && <Badge variant="secondary" className="text-xs">You</Badge>}
                  </div>
                  <p className="text-xs text-muted-foreground">{policy.user?.email}</p>
                </td>
                <td className="px-4 py-2.5">
                  <div className="flex flex-wrap gap-1">
                    {policy.allowed_permissions.length === 0 ? (
                      <span className="text-xs text-muted-foreground">Full access</span>
                    ) : (
                      policy.allowed_permissions.map(p => (
                        <code key={p} className="text-xs bg-muted px-1.5 py-0.5 rounded">
                          {p.split(':').pop()}
                        </code>
                      ))
                    )}
                  </div>
                </td>
                <td className="px-4 py-2.5 text-right">
                  {isMe && (
                    <Button
                      variant="outline"
                      size="sm"
                      className="text-xs"
                      onClick={() => onEditMyPermissions(policy, policy.allowed_permissions)}
                    >
                      Edit My Permissions
                    </Button>
                  )}
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}
