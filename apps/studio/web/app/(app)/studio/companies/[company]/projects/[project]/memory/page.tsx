'use client'

import { use } from 'react'
import { useQuery } from '@tanstack/react-query'
import { api } from '@/lib/api'
import { MemoryBrowser } from '@/components/memory/memory-browser'
import { MemoryConfig } from '@/components/memory/memory-config'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@jiku/ui'

interface PageProps {
  params: Promise<{ company: string; project: string }>
}

function MemoryPage({ params }: PageProps) {
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

  if (!project) {
    return <div className="flex items-center justify-center h-full text-sm text-muted-foreground">Loading...</div>
  }

  return (
    <div className="flex flex-col h-full">
      <div className="border-b px-6 py-4">
        <h1 className="text-lg font-semibold">Memory</h1>
        <p className="text-sm text-muted-foreground">Browse memories and configure memory settings for this project.</p>
      </div>

      <Tabs defaultValue="memories" className="flex-1 flex flex-col min-h-0">
        <div className="border-b px-6 py-3">
          <TabsList>
            <TabsTrigger value="memories">Memories</TabsTrigger>
            <TabsTrigger value="config">Config</TabsTrigger>
          </TabsList>
        </div>
        <TabsContent value="memories" className="flex-1 min-h-0 mt-0">
          <MemoryBrowser projectId={project.id} />
        </TabsContent>
        <TabsContent value="config" className="mt-0 overflow-auto">
          <MemoryConfig projectId={project.id} />
        </TabsContent>
      </Tabs>
    </div>
  )
}
import { withPermissionGuard } from '@/components/permissions/permission-guard'
export default withPermissionGuard(MemoryPage, 'memory:read')
