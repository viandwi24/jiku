'use client'

import { useQuery } from '@tanstack/react-query'
import { use } from 'react'
import { api } from '@/lib/api'
import { ProjectCard } from '@/components/project/project-card'
import { CreateProjectDialog } from '@/components/project/create-project-dialog'
import { Skeleton } from '@jiku/ui'

interface PageProps {
  params: Promise<{ company: string }>
}

export default function CompanyPage({ params }: PageProps) {
  const { company: companySlug } = use(params)

  const { data: companyData } = useQuery({
    queryKey: ['company', companySlug],
    queryFn: async () => {
      const companies = await api.companies.list()
      return companies.companies.find(c => c.slug === companySlug) ?? null
    },
  })

  const { data: projectsData, isLoading } = useQuery({
    queryKey: ['projects', companyData?.id],
    queryFn: () => api.projects.list(companyData!.id),
    enabled: !!companyData?.id,
  })

  return (
    <div className="p-6 max-w-5xl mx-auto">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold">{companyData?.name ?? companySlug}</h1>
          <p className="text-muted-foreground text-sm">Projects</p>
        </div>
        {companyData && <CreateProjectDialog companyId={companyData.id} />}
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-4">
        {isLoading
          ? Array.from({ length: 3 }).map((_, i) => (
            <Skeleton key={i} className="h-[100px] rounded-lg" />
          ))
          : projectsData?.projects.map(project => (
            <ProjectCard key={project.id} project={project} companySlug={companySlug} />
          ))}
      </div>

      {!isLoading && projectsData?.projects.length === 0 && (
        <p className="text-center text-muted-foreground py-16">No projects yet. Create your first project.</p>
      )}
    </div>
  )
}
