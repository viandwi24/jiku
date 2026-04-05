'use client'

import { use } from 'react'
import { useQuery } from '@tanstack/react-query'
import { api } from '@/lib/api'
import { Card, CardContent, CardHeader, CardTitle } from '@jiku/ui'
import { Activity, Bot, MessageSquare, Wrench } from 'lucide-react'

interface PageProps {
  params: Promise<{ company: string; project: string }>
}

export default function ProjectDashboardPage({ params }: PageProps) {
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

  const { data: agentsData, isLoading: agentsLoading } = useQuery({
    queryKey: ['agents', project?.id],
    queryFn: () => api.agents.list(project!.id),
    enabled: !!project?.id,
  })

  const { data: convsData, isLoading: convsLoading } = useQuery({
    queryKey: ['conversations', project?.id],
    queryFn: () => api.conversations.listProject(project!.id),
    enabled: !!project?.id,
  })

  const agentCount = agentsData?.agents.length ?? 0
  const chatCount = convsData?.conversations.length ?? 0

  return (
    <div className="p-6 space-y-8">
      <div>
        <p className="text-xs text-muted-foreground mb-1">{companyData?.name}</p>
        <h1 className="text-2xl font-bold">{project?.name ?? projectSlug}</h1>
        <p className="text-muted-foreground text-sm mt-1">Project overview</p>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        {[
          { label: 'Agents', value: agentsLoading ? '—' : agentCount, icon: Bot, color: 'text-emerald-500' },
          { label: 'Chats', value: convsLoading ? '—' : chatCount, icon: MessageSquare, color: 'text-blue-500' },
          { label: 'Tools', value: '—', icon: Wrench, color: 'text-violet-500' },
          { label: 'Activity', value: '—', icon: Activity, color: 'text-orange-500' },
        ].map(stat => (
          <Card key={stat.label}>
            <CardHeader className="flex flex-row items-center justify-between pb-2 pt-4 px-4">
              <CardTitle className="text-xs font-medium text-muted-foreground">{stat.label}</CardTitle>
              <stat.icon className={`h-4 w-4 ${stat.color}`} />
            </CardHeader>
            <CardContent className="px-4 pb-4">
              <p className="text-2xl font-bold">{stat.value}</p>
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  )
}
