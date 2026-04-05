'use client'

import { useParams, usePathname } from 'next/navigation'
import { SidebarInset, SidebarProvider } from '@jiku/ui'
import { RootSidebar } from '@/components/sidebar/root-sidebar'
import { CompanySidebar } from '@/components/sidebar/company-sidebar'
import { ProjectSidebar } from '@/components/sidebar/project-sidebar'
import { AppHeader } from '@/components/layout/app-header'

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

export default function StudioShell({ children }: { children: React.ReactNode }) {
  return (
    <SidebarProvider>
      <DynamicSidebar />
      <SidebarInset>
        <AppHeader />
        <main className="flex-1 min-h-0 overflow-y-auto">
          {children}
        </main>
      </SidebarInset>
    </SidebarProvider>
  )
}
