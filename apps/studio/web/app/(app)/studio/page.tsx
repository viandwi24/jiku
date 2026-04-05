'use client'

import { useQuery } from '@tanstack/react-query'
import { api } from '@/lib/api'
import { useAuthStore } from '@/lib/store/auth.store'
import { Card, CardContent, CardHeader, CardTitle } from '@jiku/ui'
import { Building2, FolderKanban, Bot, Activity } from 'lucide-react'

export default function StudioDashboardPage() {
  const user = useAuthStore(s => s.user)

  const { data, isLoading } = useQuery({
    queryKey: ['companies'],
    queryFn: () => api.companies.list(),
  })

  const companyCount = data?.companies.length ?? 0

  return (
    <div className="p-6 space-y-8">
      <div>
        <h1 className="text-2xl font-bold">Welcome back, {user?.name ?? 'there'}</h1>
        <p className="text-muted-foreground text-sm mt-1">Here&apos;s an overview of your workspace</p>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        {[
          { label: 'Companies', value: isLoading ? '—' : companyCount, icon: Building2, color: 'text-blue-500' },
          { label: 'Projects', value: '—', icon: FolderKanban, color: 'text-violet-500' },
          { label: 'Agents', value: '—', icon: Bot, color: 'text-emerald-500' },
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
