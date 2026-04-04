'use client'

import { use } from 'react'
import { useQuery } from '@tanstack/react-query'
import Link from 'next/link'
import { api } from '@/lib/api'
import { AgentCard } from '@/components/agent/agent-card'
import { CreateAgentDialog } from '@/components/agent/create-agent-dialog'
import { Button, Skeleton } from '@jiku/ui'
import { Settings } from 'lucide-react'

interface PageProps {
  params: Promise<{ company: string; project: string }>
}

export default function ProjectPage({ params }: PageProps) {
  const { company: companySlug, project: projectSlug } = use(params)

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

  const { data: agentsData, isLoading } = useQuery({
    queryKey: ['agents', project?.id],
    queryFn: () => api.agents.list(project!.id),
    enabled: !!project?.id,
  })

  return (
    <div className="p-6 max-w-5xl mx-auto">
      <div className="flex items-center justify-between mb-6">
        <div>
          <p className="text-sm text-muted-foreground">{companyData?.name}</p>
          <h1 className="text-2xl font-bold">{project?.name ?? projectSlug}</h1>
          <p className="text-sm text-muted-foreground">Agents</p>
        </div>
        <div className="flex items-center gap-2">
          <Link href={`/${companySlug}/${projectSlug}/settings`}>
            <Button variant="outline" size="icon" className="h-8 w-8">
              <Settings className="w-4 h-4" />
            </Button>
          </Link>
          {project && <CreateAgentDialog projectId={project.id} />}
        </div>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-4">
        {isLoading
          ? Array.from({ length: 3 }).map((_, i) => (
            <Skeleton key={i} className="h-[120px] rounded-lg" />
          ))
          : agentsData?.agents.map(agent => (
            <AgentCard
              key={agent.id}
              agent={agent}
              companySlug={companySlug}
              projectSlug={projectSlug}
            />
          ))}
      </div>

      {!isLoading && agentsData?.agents.length === 0 && (
        <p className="text-center text-muted-foreground py-16">No agents yet. Create your first agent.</p>
      )}
    </div>
  )
}
