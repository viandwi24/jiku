'use client'

import { use } from 'react'
import { useQuery } from '@tanstack/react-query'
import { api } from '@/lib/api'
import { Card, CardContent, CardHeader, CardTitle } from '@jiku/ui'
import { Activity, Bot, FolderKanban, MessageSquare } from 'lucide-react'

interface PageProps {
  params: Promise<{ company: string }>
}

export default function CompanyDashboardPage({ params }: PageProps) {
  const { company: companySlug } = use(params)

  const { data: companyData } = useQuery({
    queryKey: ['companies'],
    queryFn: () => api.companies.list(),
    select: (d) => d.companies.find(c => c.slug === companySlug) ?? null,
  })

  const { data: projectsData, isLoading } = useQuery({
    queryKey: ['projects', companyData?.id],
    queryFn: () => api.projects.list(companyData!.id),
    enabled: !!companyData?.id,
  })

  const projectCount = projectsData?.projects.length ?? 0

  return (
    <div className="p-6 space-y-8">
      <div>
        <h1 className="text-2xl font-bold">{companyData?.name ?? companySlug}</h1>
        <p className="text-muted-foreground text-sm mt-1">Company overview</p>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        {[
          { label: 'Projects', value: isLoading ? '—' : projectCount, icon: FolderKanban, color: 'text-violet-500' },
          { label: 'Agents', value: '—', icon: Bot, color: 'text-emerald-500' },
          { label: 'Active Chats', value: '—', icon: MessageSquare, color: 'text-blue-500' },
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
