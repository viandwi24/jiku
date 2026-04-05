'use client'

import { use } from 'react'
import { useQuery } from '@tanstack/react-query'
import { api } from '@/lib/api'
import { AgentCard } from '@/components/agent/agent-card'
import { CreateAgentDialog } from '@/components/agent/create-agent-dialog'
import { Card, CardContent, CardFooter, Skeleton, Empty, EmptyMedia, EmptyTitle, EmptyDescription, EmptyContent } from '@jiku/ui'
import { Bot } from 'lucide-react'

interface PageProps {
  params: Promise<{ company: string; project: string }>
}

export default function AgentsPage({ params }: PageProps) {
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

  const { data: agentsData, isLoading } = useQuery({
    queryKey: ['agents', project?.id],
    queryFn: () => api.agents.list(project!.id),
    enabled: !!project?.id,
  })

  const agents = agentsData?.agents ?? []

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <p className="text-xs text-muted-foreground mb-1">{companyData?.name} / {project?.name}</p>
          <h1 className="text-2xl font-bold">Agents</h1>
        </div>
        {project && <CreateAgentDialog projectId={project.id} companySlug={companySlug} projectSlug={projectSlug} />}
      </div>

      {isLoading ? (
        <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-4">
          {Array.from({ length: 3 }).map((_, i) => (
            <Card key={i}>
              <CardContent className="pt-4 pb-3">
                <div className="flex items-start gap-3">
                  <Skeleton className="h-9 w-9 rounded-full shrink-0" />
                  <div className="flex-1 space-y-1.5">
                    <Skeleton className="h-4 w-28" />
                    <Skeleton className="h-3 w-36" />
                  </div>
                </div>
              </CardContent>
              <CardFooter className="pt-0 gap-2">
                <Skeleton className="h-8 flex-1" />
                <Skeleton className="h-8 flex-1" />
              </CardFooter>
            </Card>
          ))}
        </div>
      ) : agents.length === 0 ? (
        <Empty>
          <EmptyMedia variant="icon"><Bot /></EmptyMedia>
          <EmptyTitle>No agents yet</EmptyTitle>
          <EmptyDescription>Create your first agent to get started</EmptyDescription>
          <EmptyContent>{project && <CreateAgentDialog projectId={project.id} companySlug={companySlug} projectSlug={projectSlug} />}</EmptyContent>
        </Empty>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-4">
          {agents.map(agent => (
            <AgentCard
              key={agent.id}
              agent={agent}
              companySlug={companySlug}
              projectSlug={projectSlug}
            />
          ))}
        </div>
      )}
    </div>
  )
}
