'use client'

import { use, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { api } from '@/lib/api'
import type { BrowserProfile } from '@/lib/api'
import { Button, Tabs, TabsList, TabsTrigger, TabsContent, EmptyState } from '@jiku/ui'
import { Plus, Globe } from 'lucide-react'
import { AddProfileModal } from './add-profile-modal'
import { ProfileTab } from './profile-tab'

interface PageProps {
  params: Promise<{ company: string; project: string }>
}

function ProjectBrowserPage({ params }: PageProps) {
  const { company: companySlug, project: projectSlug } = use(params)

  const { data: companyData } = useQuery({
    queryKey: ['companies'],
    queryFn: () => api.companies.list(),
    select: (d) => d.companies.find(c => c.slug === companySlug) ?? null,
  })

  const { data: projectsData } = useQuery({
    queryKey: ['projects', companyData?.id],
    queryFn: () => api.projects.list(companyData!.id),
    enabled: !!companyData?.id,
  })
  const project = projectsData?.projects.find(p => p.slug === projectSlug)
  const projectId = project?.id ?? ''

  const { data: profilesData, isLoading } = useQuery({
    queryKey: ['browser-profiles', projectId],
    queryFn: () => api.browser.listProfiles(projectId),
    enabled: !!projectId,
  })

  const profiles: BrowserProfile[] = profilesData?.profiles ?? []
  const [addOpen, setAddOpen] = useState(false)
  const [activeTab, setActiveTab] = useState<string>('')

  // Select default / first profile when the list changes.
  const resolvedActive = activeTab && profiles.some(p => p.id === activeTab)
    ? activeTab
    : (profiles.find(p => p.is_default) ?? profiles[0])?.id ?? ''

  if (isLoading) {
    return <div className="text-sm text-muted-foreground py-4">Loading...</div>
  }

  return (
    <div className="max-w-4xl mx-auto px-6 py-6 space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold">Browser Profiles</h1>
          <p className="text-sm text-muted-foreground mt-1">
            Configure one or more browser profiles for this project. Each profile pins a browser adapter
            (e.g. Jiku Browser Agent, CamoFox) with its own config. Agents route to a profile via the
            <code className="text-xs bg-muted px-1 mx-1 rounded">profile_id</code> argument on the <code className="text-xs bg-muted px-1 rounded">browser</code> tool.
          </p>
        </div>
        <Button onClick={() => setAddOpen(true)} disabled={!projectId} className="shrink-0 gap-1.5">
          <Plus className="w-4 h-4" /> Add Profile
        </Button>
      </div>

      {profiles.length === 0 ? (
        <EmptyState
          icon={<Globe className="w-10 h-10" />}
          title="No browser profiles yet"
          description="Add a profile to give agents in this project access to a real browser. You can add more than one profile (for different adapters or different proxies) and route between them via profile_id."
          action={
            <Button onClick={() => setAddOpen(true)} className="gap-1.5">
              <Plus className="w-4 h-4" /> Add your first browser profile
            </Button>
          }
        />
      ) : (
        <Tabs value={resolvedActive} onValueChange={setActiveTab} className="w-full">
          <TabsList className="w-full justify-start overflow-x-auto">
            {profiles.map((p) => (
              <TabsTrigger key={p.id} value={p.id} className={!p.enabled ? 'opacity-60' : undefined}>
                {p.name}
                {p.is_default && <span className="ml-1.5 text-[10px] uppercase tracking-wide text-muted-foreground">default</span>}
              </TabsTrigger>
            ))}
          </TabsList>
          {profiles.map((p) => (
            <TabsContent key={p.id} value={p.id}>
              <ProfileTab projectId={projectId} profile={p} />
            </TabsContent>
          ))}
        </Tabs>
      )}

      <AddProfileModal projectId={projectId} open={addOpen} onOpenChange={setAddOpen} />
    </div>
  )
}

import { withPermissionGuard } from '@/components/permissions/permission-guard'
export default withPermissionGuard(ProjectBrowserPage, 'agents:read')
