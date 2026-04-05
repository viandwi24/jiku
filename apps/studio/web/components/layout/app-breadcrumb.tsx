'use client'

import Link from 'next/link'
import { useParams, usePathname } from 'next/navigation'
import { useQuery } from '@tanstack/react-query'
import { api } from '@/lib/api'
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from '@jiku/ui'

export function AppBreadcrumb() {
  const pathname = usePathname()
  const params = useParams() as Record<string, string>
  const { company: companySlug, project: projectSlug, agent: agentSlug } = params

  const { data: companyData } = useQuery({
    queryKey: ['companies'],
    queryFn: () => api.companies.list(),
    select: (d) => d.companies.find(c => c.slug === companySlug) ?? null,
    enabled: !!companySlug,
  })

  const { data: projectsData } = useQuery({
    queryKey: ['projects', companyData?.id],
    queryFn: () => api.projects.list(companyData!.id),
    enabled: !!companyData?.id,
  })
  const projectData = projectsData?.projects.find(p => p.slug === projectSlug) ?? null

  const { data: agentsData } = useQuery({
    queryKey: ['agents', projectData?.id],
    queryFn: () => api.agents.list(projectData!.id),
    enabled: !!projectData?.id && !!agentSlug,
  })
  const agentData = agentsData?.agents.find(a => a.slug === agentSlug) ?? null

  // Determine page label from remaining path segments
  const getPageLabel = () => {
    if (agentSlug) {
      if (pathname.includes('/permissions')) return 'Permissions'
      if (pathname.includes('/settings/model')) return 'Model & Provider'
      if (pathname.includes('/settings')) return 'Settings'
      return agentData?.name ?? agentSlug
    }
    if (projectSlug) {
      if (pathname.includes('/chats/')) return 'Conversation'
      if (pathname.endsWith('/chats')) return 'Chats'
      if (pathname.includes('/settings')) return 'Settings'
      if (pathname.endsWith('/agents')) return 'Agents'
    }
    if (companySlug && !projectSlug) {
      if (pathname.includes('/settings')) return 'Settings'
    }
    return null
  }

  const pageLabel = getPageLabel()

  const segments: { label: string; href: string }[] = [
    { label: 'Home', href: '/studio' },
  ]

  if (companySlug) {
    segments.push({
      label: companyData?.name ?? companySlug,
      href: `/studio/companies/${companySlug}`,
    })
  }

  if (projectSlug) {
    segments.push({
      label: projectData?.name ?? projectSlug,
      href: `/studio/companies/${companySlug}/projects/${projectSlug}`,
    })
  }

  if (agentSlug && !pageLabel) {
    segments.push({
      label: agentData?.name ?? agentSlug,
      href: `/studio/companies/${companySlug}/projects/${projectSlug}/agents/${agentSlug}`,
    })
  }

  // segments = clickable links, finalLabel = current page (bold, no link)
  const linkSegments = pageLabel ? segments : segments.slice(0, -1)
  const finalLabel = pageLabel ?? segments[segments.length - 1]?.label

  return (
    <Breadcrumb>
      <BreadcrumbList>
        {linkSegments.map((seg, i) => (
          <span key={seg.href} className="flex items-center gap-1.5">
            {i > 0 && <BreadcrumbSeparator />}
            <BreadcrumbItem>
              <BreadcrumbLink asChild>
                <Link href={seg.href}>{seg.label}</Link>
              </BreadcrumbLink>
            </BreadcrumbItem>
          </span>
        ))}
        {finalLabel && (
          <span className="flex items-center gap-1.5">
            <BreadcrumbSeparator />
            <BreadcrumbItem>
              <BreadcrumbPage>{finalLabel}</BreadcrumbPage>
            </BreadcrumbItem>
          </span>
        )}
      </BreadcrumbList>
    </Breadcrumb>
  )
}
