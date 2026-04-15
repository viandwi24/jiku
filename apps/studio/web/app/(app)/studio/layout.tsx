'use client'

import { useParams } from 'next/navigation'
import { useQuery } from '@tanstack/react-query'
import { SidebarInset, SidebarProvider } from '@jiku/ui'
import { RootSidebar } from '@/components/sidebar/root-sidebar'
import { CompanySidebar } from '@/components/sidebar/company-sidebar'
import { ProjectSidebar } from '@/components/sidebar/project-sidebar'
import { AppHeader } from '@/components/layout/app-header'
import { PluginUIProvider } from '@/lib/plugins/provider'
import { api } from '@/lib/api'

function DynamicSidebar() {
  const params = useParams<{ company?: string; project?: string }>()
  const { company, project } = params

  if (project && company) {
    return <ProjectSidebar companySlug={company} projectSlug={project} />
  }
  if (company) {
    return <CompanySidebar companySlug={company} />
  }
  return <RootSidebar />
}

/** Resolves the current project id from URL params so the plugin UI provider
 *  can fetch the ui-registry. Returns empty string when not on a project route. */
function useProjectIdFromParams(): string {
  const params = useParams<{ company?: string; project?: string }>()
  const company = params.company
  const projectSlug = params.project

  const { data: companyData } = useQuery({
    queryKey: ['companies'],
    queryFn: () => api.companies.list(),
    select: (d) => d.companies.find(c => c.slug === company) ?? null,
    enabled: !!company,
  })
  const { data: projectsData } = useQuery({
    queryKey: ['projects', companyData?.id],
    queryFn: () => api.projects.list(companyData!.id),
    enabled: !!companyData?.id,
  })
  return projectsData?.projects.find(p => p.slug === projectSlug)?.id ?? ''
}

export default function StudioShell({ children }: { children: React.ReactNode }) {
  const projectId = useProjectIdFromParams()
  return (
    <PluginUIProvider projectId={projectId}>
      <SidebarProvider>
        <DynamicSidebar />
        <SidebarInset>
          <AppHeader />
          <main className="flex-1 min-h-0 min-w-0 overflow-y-auto">
            {children}
          </main>
        </SidebarInset>
      </SidebarProvider>
    </PluginUIProvider>
  )
}
