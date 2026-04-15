'use client'

import Link from 'next/link'
import { usePathname, useRouter } from 'next/navigation'
import { useQuery } from '@tanstack/react-query'
import {
  Activity,
  BarChart2,
  BookOpen,
  Bot,
  Brain,
  ChevronLeft,
  ChevronsUpDown,
  Clock,
  FolderOpen,
  Globe,
  LayoutDashboard,
  LogOut,
  MessageSquare,
  Puzzle,
  Settings,
  Terminal,
  ScrollText,
  Webhook,
} from 'lucide-react'
import { api } from '@/lib/api'
import { useAuthStore } from '@/lib/store/auth.store'
import { ThemeToggle } from '@/components/theme-toggle'
import { PluginSidebarSlot } from '@/components/plugin/plugin-sidebar-slot'
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
  SidebarGroupLabel,
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

// Nav items grouped into sections. `null` permission = always visible.
// The Dashboard group has no label (shown as a bare top item).
interface NavItem {
  href: string
  label: string
  icon: React.ElementType
  permission: string | null
  badgeKey?: string
}

interface NavSection {
  label: string | null
  items: NavItem[]
}

const NAV_SECTIONS: NavSection[] = [
  {
    label: null,
    items: [
      { href: '', label: 'Dashboard', icon: LayoutDashboard, permission: null },
    ],
  },
  {
    label: 'AI',
    items: [
      { href: '/agents',   label: 'Agents',   icon: Bot,           permission: 'agents:read' },
      { href: '/chats',    label: 'Chats',    icon: MessageSquare, permission: 'chats:read' },
      { href: '/memory',   label: 'Memory',   icon: Brain,         permission: 'memory:read' },
      { href: '/skills',   label: 'Skills',   icon: BookOpen,      permission: 'skills:read' },
      { href: '/commands', label: 'Commands', icon: Terminal,      permission: 'commands:read' },
    ],
  },
  {
    label: 'Tools',
    items: [
      { href: '/channels',   label: 'Channels',   icon: Webhook,    permission: 'channels:read' },
      { href: '/cron-tasks', label: 'Cron Tasks', icon: Clock,      permission: 'cron_tasks:read' },
      { href: '/browser',    label: 'Browser',    icon: Globe,      permission: 'browser:read' },
      { href: '/disk',       label: 'Disk',       icon: FolderOpen, permission: 'disk:read' },
    ],
  },
  {
    label: 'History',
    items: [
      { href: '/runs',  label: 'Runs',  icon: Activity,  permission: 'runs:read' },
      { href: '/usage', label: 'Usage', icon: BarChart2, permission: 'usage:read' },
    ],
  },
  {
    label: 'Config',
    items: [
      { href: '/plugins',  label: 'Plugins',  icon: Puzzle,     permission: 'plugins:read', badgeKey: 'plugins' },
      { href: '/console',  label: 'Console',  icon: ScrollText, permission: 'console:read' },
      { href: '/settings/general', label: 'Settings', icon: Settings, permission: 'settings:read' },
    ],
  },
]

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
  const projectId = projectData?.id ?? ''

  const { data: myPerms } = useQuery({
    queryKey: ['acl-my-perms', projectId],
    queryFn: () => api.acl.getMyPermissions(projectId),
    enabled: !!projectId,
  })

  const { data: agentsData } = useQuery({
    queryKey: ['agents', projectId],
    queryFn: () => api.agents.list(projectId),
    // Only fetch for badge count if user can manage agents; chat-only users don't need the count
    enabled: !!projectId && (!myPerms || myPerms.isSuperadmin || myPerms.permissions.includes('agents:read')),
  })

  const { data: projectPluginsData } = useQuery({
    queryKey: ['project-plugins', projectId],
    queryFn: () => api.plugins.listProject(projectId),
    enabled: !!projectId,
  })

  const isSuperadmin = myPerms?.isSuperadmin ?? false
  const permSet = new Set(myPerms?.permissions ?? [])
  // While loading (myPerms undefined) show all; once loaded restrict by permissions
  const permsLoaded = myPerms != null
  const canSee = (permission: string | null) => {
    if (!permsLoaded) return true
    if (permission === null) return true
    return isSuperadmin || permSet.has(permission)
  }
  const canSeeSettings = !permsLoaded || isSuperadmin || permSet.has('settings:read')

  const activePluginCount = (projectPluginsData?.plugins ?? []).filter(p => p.enabled).length
  const badges: Record<string, number | undefined> = {
    agents: agentsData?.agents.length,
    plugins: activePluginCount || undefined,
  }

  const base = `/studio/companies/${companySlug}/projects/${projectSlug}`
  const isActive = (path: string) => {
    if (path === '') return pathname === base
    // Normalise: settings has a multi-segment href but activates on any /settings path.
    const topSegment = path.startsWith('/settings') ? '/settings' : path
    const full = `${base}${topSegment}`
    return pathname === full || pathname.startsWith(full + '/')
  }

  const visibleSections = NAV_SECTIONS
    .map(s => ({ ...s, items: s.items.filter(i => canSee(i.permission)) }))
    .filter(s => s.items.length > 0)

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
          {canSeeSettings && (
            <Button variant="ghost" size="icon" className="h-7 w-7 shrink-0" asChild>
              <Link href={`${base}/settings/general`}>
                <Settings className="h-3.5 w-3.5" />
              </Link>
            </Button>
          )}
        </div>
      </SidebarHeader>

      <SidebarContent>
        {visibleSections.map((section, idx) => (
          <SidebarGroup key={section.label ?? `_top_${idx}`}>
            {section.label && <SidebarGroupLabel>{section.label}</SidebarGroupLabel>}
            <SidebarGroupContent>
              <SidebarMenu className="gap-0.5">
                {section.items.map(item => (
                  <SidebarMenuItem key={item.href}>
                    <SidebarMenuButton asChild isActive={isActive(item.href)}>
                      <Link href={`${base}${item.href}`}>
                        <item.icon className="h-4 w-4" />
                        {item.label}
                      </Link>
                    </SidebarMenuButton>
                    {item.href === '/agents' && badges.agents !== undefined && (
                      <SidebarMenuBadge>{badges.agents}</SidebarMenuBadge>
                    )}
                    {item.badgeKey === 'plugins' && badges.plugins !== undefined && (
                      <SidebarMenuBadge>{badges.plugins}</SidebarMenuBadge>
                    )}
                  </SidebarMenuItem>
                ))}
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
        ))}

        {/* Plan 17 — plugin sidebar slots. The component already renders its own
            SidebarGroup + "Plugins" label, so do not wrap it. */}
        {projectId && projectData && user && (
          <PluginSidebarSlot
            projectId={projectId}
            projectSlug={projectSlug}
            projectName={projectData.name ?? projectSlug}
            userId={user.id}
            userPermissions={Array.from(permSet)}
            base={base}
          />
        )}
      </SidebarContent>

      <SidebarFooter>
        <SidebarMenu>
          <SidebarMenuItem>
            <div className="flex items-center gap-1">
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <SidebarMenuButton className="h-auto py-2 flex-1">
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
              <ThemeToggle />
            </div>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarFooter>
    </Sidebar>
  )
}
