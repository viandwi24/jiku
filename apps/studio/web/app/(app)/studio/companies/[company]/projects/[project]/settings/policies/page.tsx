'use client'

import { use, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { api } from '@/lib/api'
import { AgentPolicyConfig } from '@/components/permissions/agent-policy-config'
import { Bot, ChevronDown, ChevronRight } from 'lucide-react'

interface PageProps {
  params: Promise<{ company: string; project: string }>
}

interface AgentRowProps {
  agentId: string
  agentName: string
  agentSlug: string
  companyId: string
  projectId: string
}

function AgentRow({ agentId, agentName, agentSlug, companyId, projectId }: AgentRowProps) {
  const [open, setOpen] = useState(false)

  return (
    <div className="rounded-lg border">
      <button
        className="w-full flex items-center gap-3 px-4 py-3 text-left hover:bg-muted/30 transition-colors"
        onClick={() => setOpen(v => !v)}
      >
        {open
          ? <ChevronDown className="w-4 h-4 text-muted-foreground shrink-0" />
          : <ChevronRight className="w-4 h-4 text-muted-foreground shrink-0" />
        }
        <Bot className="w-4 h-4 text-muted-foreground shrink-0" />
        <div className="flex-1 min-w-0">
          <p className="text-sm font-medium">{agentName}</p>
          <p className="text-xs text-muted-foreground">{agentSlug}</p>
        </div>
      </button>
      {open && (
        <div className="border-t px-4 py-4">
          <AgentPolicyConfig
            agentId={agentId}
            companyId={companyId}
            projectId={projectId}
            compact
          />
        </div>
      )}
    </div>
  )
}

export default function ProjectPoliciesPage({ params }: PageProps) {
  const { company: companySlug, project: projectSlug } = use(params)

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

  const projectId = projectData?.id ?? ''
  const companyId = companyData?.id ?? ''

  const { data: agentsData, isLoading } = useQuery({
    queryKey: ['agents', projectId],
    queryFn: () => api.agents.list(projectId),
    enabled: !!projectId,
  })

  const agents = agentsData?.agents ?? []

  return (
    <div className="space-y-6">
      <div>
        <p className="text-sm text-muted-foreground">
          Configure tool access policies per agent. Policies control which tools each caller (user/role/permission) can invoke.
          You can also configure policies directly from each agent's settings page.
        </p>
      </div>

      {isLoading ? (
        <div className="text-sm text-muted-foreground">Loading agents...</div>
      ) : agents.length === 0 ? (
        <div className="rounded-lg border px-4 py-8 text-center text-sm text-muted-foreground">
          No agents in this project yet.
        </div>
      ) : (
        <div className="space-y-3">
          {agents.map(agent => (
            <AgentRow
              key={agent.id}
              agentId={agent.id}
              agentName={agent.name}
              agentSlug={agent.slug}
              companyId={companyId}
              projectId={projectId}
            />
          ))}
        </div>
      )}
    </div>
  )
}
