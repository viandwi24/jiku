'use client'

import { use } from 'react'
import { useQuery } from '@tanstack/react-query'
import Link from 'next/link'
import { api } from '@/lib/api'
import { Button } from '@jiku/ui'
import { ArrowLeft, ShieldCheck } from 'lucide-react'

interface PageProps {
  params: Promise<{ company: string; project: string }>
}

export default function ProjectPermissionsPage({ params }: PageProps) {
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

  return (
    <div className="p-6 max-w-3xl mx-auto">
      <div className="flex items-center gap-3 mb-6">
        <Link href={`/${companySlug}/${projectSlug}/settings`}>
          <Button variant="ghost" size="icon" className="h-8 w-8">
            <ArrowLeft className="w-4 h-4" />
          </Button>
        </Link>
        <div>
          <p className="text-xs text-muted-foreground">{companyData?.name} / {project?.name} / Settings</p>
          <h1 className="text-xl font-bold">Project Permissions</h1>
        </div>
      </div>

      <div className="rounded-lg border p-8 text-center">
        <ShieldCheck className="w-10 h-10 mx-auto mb-3 text-muted-foreground/50" />
        <p className="font-medium text-sm mb-1">Coming Soon</p>
        <p className="text-xs text-muted-foreground">Project-level permissions and member management will be available in a future update.</p>
      </div>
    </div>
  )
}
