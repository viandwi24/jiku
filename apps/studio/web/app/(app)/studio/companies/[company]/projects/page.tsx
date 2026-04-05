'use client'

import { use } from 'react'
import { useQuery } from '@tanstack/react-query'
import { api } from '@/lib/api'
import { ProjectCard } from '@/components/project/project-card'
import { CreateProjectDialog } from '@/components/project/create-project-dialog'
import { Card, CardContent, CardFooter, Skeleton, Empty, EmptyMedia, EmptyTitle, EmptyDescription, EmptyContent } from '@jiku/ui'
import { FolderKanban } from 'lucide-react'

interface PageProps {
  params: Promise<{ company: string }>
}

export default function ProjectsPage({ params }: PageProps) {
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

  const projects = projectsData?.projects ?? []

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <p className="text-xs text-muted-foreground mb-1">{companyData?.name}</p>
          <h1 className="text-2xl font-bold">Projects</h1>
        </div>
        {companyData && <CreateProjectDialog companyId={companyData.id} />}
      </div>

      {isLoading ? (
        <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-4">
          {Array.from({ length: 4 }).map((_, i) => (
            <Card key={i}>
              <CardContent className="pt-4 pb-2 space-y-2">
                <Skeleton className="h-7 w-7 rounded-md" />
                <Skeleton className="h-4 w-24" />
                <Skeleton className="h-3 w-16" />
              </CardContent>
              <CardFooter><Skeleton className="h-7 w-full" /></CardFooter>
            </Card>
          ))}
        </div>
      ) : projects.length === 0 ? (
        <Empty>
          <EmptyMedia variant="icon"><FolderKanban /></EmptyMedia>
          <EmptyTitle>No projects yet</EmptyTitle>
          <EmptyDescription>Create your first project to get started</EmptyDescription>
          <EmptyContent>{companyData && <CreateProjectDialog companyId={companyData.id} />}</EmptyContent>
        </Empty>
      ) : (
        <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-4">
          {projects.map(project => (
            <ProjectCard key={project.id} project={project} companySlug={companySlug} />
          ))}
        </div>
      )}
    </div>
  )
}
