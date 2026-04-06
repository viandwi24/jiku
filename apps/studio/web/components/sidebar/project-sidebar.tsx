'use client'

import Link from 'next/link'
import { usePathname, useRouter } from 'next/navigation'
import { useQuery } from '@tanstack/react-query'
import {
  Activity,
  BarChart2,
  Bot,
  Brain,
  ChevronLeft,
  ChevronsUpDown,
  FolderOpen,
  Globe,
  LayoutDashboard,
  LogOut,
  MessageSquare,
  Puzzle,
  Settings,
  Webhook,
} from 'lucide-react'
import { api } from '@/lib/api'
import { useAuthStore } from '@/lib/store/auth.store'
import {
  Avatar,
  AvatarFallback,
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
  Skeleton,
} from '@jiku/ui'

interface ProjectSidebarProps {
  companySlug: string
  projectSlug: string
}

export function ProjectSidebar({ companySlug, projectSlug }: ProjectSidebarProps) {
  const pathname = usePathname()
  const router = useRouter()
  const user = useAuthStore(s => s.user)
  const clearAuth = useAuthStore(s => s.clearAuth)

  function handleSignOut() {
    clearAuth()
    router.replace('/login')
  }

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

  const { data: projectPluginsData } = useQuery({
    queryKey: ['project-plugins', projectData?.id],
    queryFn: () => api.plugins.listProject(projectData!.id),
    enabled: !!projectData?.id,
  })

  const activePluginCount = (projectPluginsData?.plugins ?? []).filter(p => p.enabled).length

  const base = `/studio/companies/${companySlug}/projects/${projectSlug}`
  const isActive = (path: string) => {
    const full = `${base}${path}`
    return path === '' ? pathname === base : pathname.startsWith(full)
  }

  const mainNav = [
    { href: '', label: 'Dashboard', icon: LayoutDashboard },
    { href: '/agents', label: 'Agents', icon: Bot, badge: agentsData?.agents.length, exact: false },
    { href: '/chats', label: 'Chats', icon: MessageSquare },
    { href: '/runs', label: 'Runs', icon: Activity },
    { href: '/memory', label: 'Memory', icon: Brain },
    { href: '/channels', label: 'Channels', icon: Webhook },
    { href: '/browser', label: 'Browser', icon: Globe },
    { href: '/files', label: 'Files', icon: FolderOpen },
    { href: '/plugins', label: 'Plugins', icon: Puzzle, badge: activePluginCount || undefined },
    { href: '/usage', label: 'Usage', icon: BarChart2 },
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

      <SidebarFooter>
        <SidebarMenu>
          <SidebarMenuItem>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <SidebarMenuButton className="h-auto py-2">
                  <Avatar className="h-6 w-6">
                    <AvatarFallback className="text-xs">
                      {user?.name?.[0]?.toUpperCase() ?? 'U'}
                    </AvatarFallback>
                  </Avatar>
                  <span className="flex-1 truncate text-left text-sm">{user?.name}</span>
                  <ChevronsUpDown className="h-4 w-4 shrink-0 opacity-50" />
                </SidebarMenuButton>
              </DropdownMenuTrigger>
              <DropdownMenuContent side="top" align="start" className="w-52">
                <div className="px-2 py-1.5">
                  <p className="text-xs font-medium">{user?.name}</p>
                  <p className="text-xs text-muted-foreground truncate">{user?.email}</p>
                </div>
                <DropdownMenuSeparator />
                <DropdownMenuItem onClick={handleSignOut}>
                  <LogOut className="h-4 w-4 mr-2" />
                  Sign out
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarFooter>
    </Sidebar>
  )
}
