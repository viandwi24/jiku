'use client'

import { useQuery, useQueries } from '@tanstack/react-query'
import { api } from '@/lib/api'
import { useAuthStore } from '@/lib/store/auth.store'
import { Card, CardContent, CardHeader, CardTitle } from '@jiku/ui'
import { Building2, FolderKanban, Bot, Activity } from 'lucide-react'

export default function StudioDashboardPage() {
  const user = useAuthStore(s => s.user)

  const { data: companiesData, isLoading: companiesLoading } = useQuery({
    queryKey: ['companies'],
    queryFn: () => api.companies.list(),
  })

  const companies = companiesData?.companies ?? []
  const companyCount = companies.length

  const projectQueries = useQueries({
    queries: companies.map(c => ({
      queryKey: ['projects', c.id],
      queryFn: () => api.projects.list(c.id),
      enabled: !companiesLoading,
    })),
  })

  const allProjects = projectQueries.flatMap(q => q.data?.projects ?? [])
  const projectCount = allProjects.length

  const agentQueries = useQueries({
    queries: allProjects.map(p => ({
      queryKey: ['agents', p.id],
      queryFn: () => api.agents.list(p.id),
      enabled: projectQueries.every(q => q.isFetched),
    })),
  })

  const agentCount = agentQueries.reduce((sum, q) => sum + (q.data?.agents.length ?? 0), 0)
  const projectsLoading = projectQueries.some(q => q.isLoading)
  const agentsLoading = agentQueries.some(q => q.isLoading)

  return (
    <div className="p-6 space-y-8">
      <div>
        <h1 className="text-2xl font-bold">Welcome back, {user?.name ?? 'there'}</h1>
        <p className="text-muted-foreground text-sm mt-1">Here&apos;s an overview of your workspace</p>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        {[
          { label: 'Companies', value: companiesLoading ? '—' : companyCount, icon: Building2, color: 'text-blue-500' },
          { label: 'Projects', value: projectsLoading ? '—' : projectCount, icon: FolderKanban, color: 'text-violet-500' },
          { label: 'Agents', value: agentsLoading ? '—' : agentCount, icon: Bot, color: 'text-emerald-500' },
          { label: 'Active Chats', value: '—', icon: Activity, color: 'text-orange-500' },
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
