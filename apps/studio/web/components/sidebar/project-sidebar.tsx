'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { useQuery } from '@tanstack/react-query'
import {
  Bot,
  ChevronLeft,
  LayoutDashboard,
  MessageSquare,
  Settings,
} from 'lucide-react'
import { api } from '@/lib/api'
import {
  Button,
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarGroupContent,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarSeparator,
  Skeleton,
} from '@jiku/ui'

interface ProjectSidebarProps {
  companySlug: string
  projectSlug: string
}

export function ProjectSidebar({ companySlug, projectSlug }: ProjectSidebarProps) {
  const pathname = usePathname()

  const { data: companyData } = useQuery({
    queryKey: ['companies'],
    queryFn: () => api.companies.list(),
    select: (d) => d.companies.find(c => c.slug === companySlug) ?? null,
  })

  const { data: projectsData, isLoading: projectLoading } = useQuery({
    queryKey: ['projects', companyData?.id],
    queryFn: () => api.projects.list(companyData!.id),
    enabled: !!companyData?.id,
  })

  const projectData = projectsData?.projects.find(p => p.slug === projectSlug) ?? null

  const { data: agentsData } = useQuery({
    queryKey: ['agents', projectData?.id],
    queryFn: () => api.agents.list(projectData!.id),
    enabled: !!projectData?.id,
  })

  const base = `/studio/companies/${companySlug}/projects/${projectSlug}`
  const isActive = (path: string) => {
    const full = `${base}${path}`
    return path === '' ? pathname === base : pathname.startsWith(full)
  }

  const mainNav = [
    { href: '', label: 'Dashboard', icon: LayoutDashboard },
    { href: '/agents', label: 'Agents', icon: Bot, badge: agentsData?.agents.length, exact: false },
    { href: '/chats', label: 'Chats', icon: MessageSquare },
  ]


  return (
    <Sidebar collapsible="icon">
      <SidebarHeader>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton asChild>
              <Link href={`/studio/companies/${companySlug}`}>
                <ChevronLeft className="h-4 w-4" />
                {companyData?.name ?? companySlug}
              </Link>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
        <div className="flex items-center justify-between px-2 py-1 group-data-[collapsible=icon]:hidden">
          {projectLoading
            ? <Skeleton className="h-4 w-28" />
            : <span className="font-semibold text-sm truncate">{projectData?.name ?? projectSlug}</span>}
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
              {mainNav.map(item => (
                <SidebarMenuItem key={item.href}>
                  <SidebarMenuButton asChild isActive={isActive(item.href)}>
                    <Link href={`${base}${item.href}`}>
                      <item.icon className="h-4 w-4" />
                      {item.label}
                    </Link>
                  </SidebarMenuButton>
                  {item.badge !== undefined && (
                    <SidebarMenuBadge>{item.badge}</SidebarMenuBadge>
                  )}
                </SidebarMenuItem>
              ))}
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
