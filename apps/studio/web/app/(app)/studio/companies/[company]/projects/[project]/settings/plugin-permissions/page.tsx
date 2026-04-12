'use client'

import { use, useMemo, useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { api } from '@/lib/api'
import {
  Badge, Button, Input, Label,
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger,
} from '@jiku/ui'
import { Plus, Trash2 } from 'lucide-react'
import { toast } from 'sonner'

interface PageProps {
  params: Promise<{ company: string; project: string }>
}

export default function PluginPermissionsPage({ params }: PageProps) {
  const { company: companySlug, project: projectSlug } = use(params)
  const qc = useQueryClient()

  const { data: companyData } = useQuery({
    queryKey: ['companies'],
    queryFn: () => api.companies.list(),
    select: d => d.companies.find(c => c.slug === companySlug) ?? null,
  })

  const { data: projectsData } = useQuery({
    queryKey: ['projects', companyData?.id],
    queryFn: () => api.projects.list(companyData!.id),
    enabled: !!companyData,
    select: d => d.projects.find(p => p.slug === projectSlug) ?? null,
  })
  const projectId = projectsData?.id ?? null

  const grantsQuery = useQuery({
    queryKey: ['plugin-permissions', projectId],
    queryFn: () => api.pluginPermissions.listProject(projectId!),
    enabled: !!projectId,
  })

  const membersQuery = useQuery({
    queryKey: ['project-members', projectId],
    queryFn: () => api.acl.listMembers(projectId!),
    enabled: !!projectId,
  })

  const [addOpen, setAddOpen] = useState(false)
  const [addUser, setAddUser] = useState('')
  const [addPlugin, setAddPlugin] = useState('')
  const [addPermission, setAddPermission] = useState('')

  const grant = useMutation({
    mutationFn: () => api.pluginPermissions.grant(projectId!, {
      user_id: addUser, plugin_id: addPlugin, permission: addPermission,
    }),
    onSuccess: () => {
      toast.success('Permission granted')
      setAddOpen(false); setAddUser(''); setAddPlugin(''); setAddPermission('')
      qc.invalidateQueries({ queryKey: ['plugin-permissions', projectId] })
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : 'Failed'),
  })

  const revoke = useMutation({
    mutationFn: (id: string) => api.pluginPermissions.revoke(projectId!, id),
    onSuccess: () => {
      toast.success('Permission revoked')
      qc.invalidateQueries({ queryKey: ['plugin-permissions', projectId] })
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : 'Failed'),
  })

  const groupedByPlugin = useMemo(() => {
    const grants = grantsQuery.data?.grants ?? []
    const map = new Map<string, typeof grants>()
    for (const g of grants) {
      const arr = map.get(g.plugin_id) ?? []
      arr.push(g)
      map.set(g.plugin_id, arr)
    }
    return Array.from(map.entries())
  }, [grantsQuery.data])

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold">Plugin Permissions</h2>
          <p className="text-sm text-muted-foreground">
            Grant per-member access to plugin-declared permissions.
          </p>
        </div>
        <Dialog open={addOpen} onOpenChange={setAddOpen}>
          <DialogTrigger asChild>
            <Button size="sm"><Plus className="w-4 h-4 mr-1" />Grant</Button>
          </DialogTrigger>
          <DialogContent>
            <DialogHeader><DialogTitle>Grant plugin permission</DialogTitle></DialogHeader>
            <div className="space-y-3">
              <div>
                <Label>Member</Label>
                <Select value={addUser} onValueChange={setAddUser}>
                  <SelectTrigger><SelectValue placeholder="Select member" /></SelectTrigger>
                  <SelectContent>
                    {(membersQuery.data?.members ?? []).map(m => (
                      <SelectItem key={m.user_id} value={m.user_id}>
                        {m.user?.name ?? m.user_id} ({m.user?.email ?? ''})
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div>
                <Label>Plugin ID</Label>
                <Input value={addPlugin} onChange={e => setAddPlugin(e.target.value)} placeholder="e.g. jiku.telegram" />
              </div>
              <div>
                <Label>Permission</Label>
                <Input value={addPermission} onChange={e => setAddPermission(e.target.value)} placeholder="e.g. telegram:send_message" />
              </div>
              <Button
                onClick={() => grant.mutate()}
                disabled={!addUser || !addPlugin || !addPermission || grant.isPending}
              >
                {grant.isPending ? 'Granting…' : 'Grant'}
              </Button>
            </div>
          </DialogContent>
        </Dialog>
      </div>

      {grantsQuery.isLoading && <div className="text-sm text-muted-foreground">Loading…</div>}

      {!grantsQuery.isLoading && groupedByPlugin.length === 0 && (
        <div className="border border-dashed rounded-md p-8 text-center text-sm text-muted-foreground">
          No plugin permissions granted yet.
        </div>
      )}

      {groupedByPlugin.map(([pluginId, grants]) => (
        <div key={pluginId} className="border rounded-md overflow-hidden">
          <div className="bg-muted/40 px-3 py-2 font-medium text-sm">{pluginId}</div>
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left border-t">
                <th className="px-3 py-2 font-medium">Permission</th>
                <th className="px-3 py-2 font-medium">Member</th>
                <th className="px-3 py-2 font-medium w-24">Actions</th>
              </tr>
            </thead>
            <tbody>
              {grants.map(g => (
                <tr key={g.id} className="border-t">
                  <td className="px-3 py-2"><Badge variant="secondary">{g.permission}</Badge></td>
                  <td className="px-3 py-2">
                    {g.user ? <span><b>{g.user.name}</b> <span className="text-muted-foreground">({g.user.email})</span></span> : '—'}
                  </td>
                  <td className="px-3 py-2">
                    <Button size="sm" variant="ghost" onClick={() => revoke.mutate(g.id)}>
                      <Trash2 className="w-4 h-4" />
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ))}
    </div>
  )
}
