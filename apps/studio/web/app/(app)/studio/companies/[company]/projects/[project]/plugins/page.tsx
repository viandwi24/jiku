'use client'

import { use } from 'react'
import { useQuery } from '@tanstack/react-query'
import { api } from '@/lib/api'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@jiku/ui'
import { ActivePlugins } from '@/components/plugin/active-plugins'
import { Marketplace } from '@/components/plugin/marketplace'

interface PageProps {
  params: Promise<{ company: string; project: string }>
}

export default function PluginsPage({ params }: PageProps) {
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
        <h1 className="text-lg font-semibold">Plugins</h1>
        <p className="text-sm text-muted-foreground">Manage plugins for this project.</p>
      </div>

      <Tabs defaultValue="active" className="flex-1 flex flex-col min-h-0">
        <div className="border-b px-6 py-3">
          <TabsList>
            <TabsTrigger value="active">Active Plugins</TabsTrigger>
            <TabsTrigger value="marketplace">Marketplace</TabsTrigger>
          </TabsList>
        </div>

        <TabsContent value="active" className="flex-1 min-h-0 mt-0">
          <ActivePlugins projectId={project.id} />
        </TabsContent>

        <TabsContent value="marketplace" className="flex-1 min-h-0 mt-0 overflow-auto">
          <Marketplace projectId={project.id} />
        </TabsContent>
      </Tabs>
    </div>
  )
}
