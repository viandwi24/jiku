'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { useQuery } from '@tanstack/react-query'
import {
  ChevronLeft,
  FolderKanban,
  KeyRound,
  LayoutDashboard,
  Settings,
} from 'lucide-react'
import { api } from '@/lib/api'
import {
  Button,
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarSeparator,
  Skeleton,
} from '@jiku/ui'

interface CompanySidebarProps {
  companySlug: string
}

export function CompanySidebar({ companySlug }: CompanySidebarProps) {
  const pathname = usePathname()

  const { data: companyData, isLoading: companyLoading } = useQuery({
    queryKey: ['companies'],
    queryFn: () => api.companies.list(),
    select: (d) => d.companies.find(c => c.slug === companySlug) ?? null,
  })

  const { data: projectsData } = useQuery({
    queryKey: ['projects', companyData?.id],
    queryFn: () => api.projects.list(companyData!.id),
    enabled: !!companyData?.id,
  })

  const base = `/studio/companies/${companySlug}`
  const isActive = (path: string) => {
    const full = `${base}${path}`
    return path === '' ? pathname === base : pathname.startsWith(full)
  }

  return (
    <Sidebar collapsible="icon">
      <SidebarHeader>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton asChild>
              <Link href="/studio">
                <ChevronLeft className="h-4 w-4" />
                Home
              </Link>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
        <div className="flex items-center justify-between px-2 py-1 group-data-[collapsible=icon]:hidden">
          {companyLoading
            ? <Skeleton className="h-4 w-28" />
            : <span className="font-semibold text-sm truncate">{companyData?.name ?? companySlug}</span>}
          <Button variant="ghost" size="icon" className="h-7 w-7 shrink-0" asChild>
            <Link href={`${base}/settings/general`}>
              <Settings className="h-3.5 w-3.5" />
            </Link>
          </Button>
        </div>
      </SidebarHeader>

      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupContent>
            <SidebarMenu className="gap-0.5">
              <SidebarMenuItem>
                <SidebarMenuButton asChild isActive={isActive('')}>
                  <Link href={base}>
                    <LayoutDashboard className="h-4 w-4" />
                    Dashboard
                  </Link>
                </SidebarMenuButton>
              </SidebarMenuItem>
              <SidebarMenuItem>
                <SidebarMenuButton asChild isActive={isActive('/projects')}>
                  <Link href={`${base}/projects`}>
                    <FolderKanban className="h-4 w-4" />
                    Projects
                  </Link>
                </SidebarMenuButton>
                {projectsData && (
                  <SidebarMenuBadge>{projectsData.projects.length}</SidebarMenuBadge>
                )}
              </SidebarMenuItem>
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>

        <SidebarSeparator />

        <SidebarGroup>
          <SidebarGroupContent>
            <SidebarMenu className="gap-0.5">
              <SidebarMenuItem>
                <SidebarMenuButton asChild isActive={isActive('/settings')}>
                  <Link href={`${base}/settings/general`}>
                    <Settings className="h-4 w-4" />
                    Settings
                  </Link>
                </SidebarMenuButton>
              </SidebarMenuItem>
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>
    </Sidebar>
  )
}
