'use client'

import { use } from 'react'
import { useQuery } from '@tanstack/react-query'
import { api } from '@/lib/api'
import { Separator } from '@jiku/ui'
import { AgentPolicyConfig } from '@/components/permissions/agent-policy-config'
import { AgentVisibilityConfig } from '@/components/permissions/agent-visibility-config'

interface PageProps {
  params: Promise<{ company: string; project: string; agent: string }>
}

export default function PermissionsPage({ params }: PageProps) {
  const { company: companySlug, project: projectSlug, agent: agentSlug } = use(params)

  const { data: companyData } = useQuery({
    queryKey: ['companies'],
    queryFn: () => api.companies.list(),
    select: d => d.companies.find(c => c.slug === companySlug) ?? null,
  })

  const { data: projectData } = useQuery({
    queryKey: ['projects', companyData?.id],
    queryFn: () => api.projects.list(companyData!.id),
    enabled: !!companyData?.id,
    select: d => d.projects.find(p => p.slug === projectSlug) ?? null,
  })

  const { data: agentsData } = useQuery({
    queryKey: ['agents', projectData?.id],
    queryFn: () => api.agents.list(projectData!.id),
    enabled: !!projectData?.id,
  })

  const agent = agentsData?.agents.find(a => a.slug === agentSlug)
  const agentId = agent?.id ?? ''
  const companyId = companyData?.id ?? ''
  const projectId = projectData?.id ?? ''

  if (!agentId || !companyId || !projectId) {
    return <div className="p-6 text-sm text-muted-foreground">Loading...</div>
  }

  return (
    <div className="p-6 max-w-4xl mx-auto space-y-8">
      <div className="space-y-3">
        <div>
          <h3 className="text-sm font-semibold">Member Visibility</h3>
          <p className="text-xs text-muted-foreground mt-0.5">
            Control which members can see and use this agent. Hidden agents won&apos;t appear in sidebars or chat selectors for that member.
          </p>
        </div>
        <AgentVisibilityConfig agentId={agentId} projectId={projectId} />
      </div>

      <Separator />

      <AgentPolicyConfig agentId={agentId} companyId={companyId} projectId={projectId} />
    </div>
  )
}
