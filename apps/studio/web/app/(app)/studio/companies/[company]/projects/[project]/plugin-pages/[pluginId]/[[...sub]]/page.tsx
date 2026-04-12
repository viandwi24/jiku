'use client'

import { useParams } from 'next/navigation'
import { useQuery } from '@tanstack/react-query'
import { api } from '@/lib/api'
import { useAuthStore } from '@/lib/store/auth.store'
import { usePluginUIRegistry } from '@/lib/plugins/provider'
import { PluginPageHost } from '@/components/plugin/plugin-page-host'

export default function PluginPageRoute() {
  const params = useParams<{ company: string; project: string; pluginId: string; sub?: string[] }>()
  const user = useAuthStore(s => s.user)
  const company = params?.company ?? ''
  const projectSlug = params?.project ?? ''
  const pluginId = params?.pluginId ?? ''
  const subPath = (params?.sub ?? []).join('/')

  const { data: companyData } = useQuery({
    queryKey: ['companies'],
    queryFn: () => api.companies.list(),
    select: (d) => d.companies.find(c => c.slug === company) ?? null,
    enabled: !!company,
  })
  const { data: projectsData } = useQuery({
    queryKey: ['projects', companyData?.id],
    queryFn: () => api.projects.list(companyData!.id),
    enabled: !!companyData?.id,
  })
  const project = projectsData?.projects.find(p => p.slug === projectSlug) ?? null
  const projectId = project?.id ?? ''

  const { data: perms } = useQuery({
    queryKey: ['acl-my-perms', projectId],
    queryFn: () => api.acl.getMyPermissions(projectId),
    enabled: !!projectId,
  })
  const registry = usePluginUIRegistry()

  if (!projectId || !user) {
    return <div className="p-6 text-sm text-muted-foreground">Loading…</div>
  }

  const pluginEntry = registry.entriesBySlot['project.page']?.find(e => e.pluginId === pluginId)
  const pluginMeta = registry.getPlugin(pluginId)

  if (!pluginEntry || !pluginMeta) {
    return (
      <div className="p-6 text-sm">
        <div className="font-medium">Plugin page not found</div>
        <p className="mt-1 text-muted-foreground">
          No <code>project.page</code> entry registered for <code>{pluginId}</code>.
        </p>
      </div>
    )
  }

  return (
    <PluginPageHost
      entry={pluginEntry}
      subPath={subPath}
      project={{ id: projectId, slug: projectSlug, name: project?.name ?? projectSlug }}
      user={{ id: user.id, role: 'member' }}
      permissions={Array.from(new Set(perms?.permissions ?? []))}
    />
  )
}
