'use client'

import { use } from 'react'
import { useQuery } from '@tanstack/react-query'
import Link from 'next/link'
import { api } from '@/lib/api'
import { AgentConfigForm } from '@/components/agent/agent-config-form'
import { Tabs, TabsContent, TabsList, TabsTrigger, Button } from '@jiku/ui'
import { ArrowLeft, ShieldCheck } from 'lucide-react'

interface PageProps {
  params: Promise<{ company: string; project: string; agent: string }>
}

export default function AgentSettingsPage({ params }: PageProps) {
  const { company: companySlug, project: projectSlug, agent: agentId } = use(params)

  const { data: companyData } = useQuery({
    queryKey: ['company', companySlug],
    queryFn: async () => {
      const { companies } = await api.companies.list()
      return companies.find(c => c.slug === companySlug) ?? null
    },
  })

  const { data: projectsData } = useQuery({
    queryKey: ['projects', companyData?.id],
    queryFn: () => api.projects.list(companyData!.id),
    enabled: !!companyData?.id,
  })

  const project = projectsData?.projects.find(p => p.slug === projectSlug)

  const { data: agentsData } = useQuery({
    queryKey: ['agents', project?.id],
    queryFn: () => api.agents.list(project!.id),
    enabled: !!project?.id,
  })

  const agent = agentsData?.agents.find(a => a.id === agentId)
  const chatPath = `/${companySlug}/${projectSlug}/agents/${agentId}`
  const permissionsPath = `/${companySlug}/${projectSlug}/agents/${agentId}/settings/permissions`

  return (
    <div className="p-6 max-w-3xl mx-auto">
      <div className="flex items-center gap-3 mb-6">
        <Link href={chatPath}>
          <Button variant="ghost" size="icon" className="h-8 w-8">
            <ArrowLeft className="w-4 h-4" />
          </Button>
        </Link>
        <div>
          <p className="text-xs text-muted-foreground">{companyData?.name} / {project?.name}</p>
          <h1 className="text-xl font-bold">{agent?.name ?? 'Agent'} — Settings</h1>
        </div>
      </div>

      <Tabs defaultValue="config">
        <TabsList className="mb-6">
          <TabsTrigger value="config">Configuration</TabsTrigger>
          <TabsTrigger value="permissions" asChild>
            <Link href={permissionsPath} className="flex items-center gap-1">
              <ShieldCheck className="w-3.5 h-3.5" />
              Permissions
            </Link>
          </TabsTrigger>
        </TabsList>
        <TabsContent value="config">
          {agent && project ? (
            <AgentConfigForm agent={agent} projectId={project.id} />
          ) : (
            <p className="text-muted-foreground text-sm">Loading...</p>
          )}
        </TabsContent>
      </Tabs>
    </div>
  )
}
