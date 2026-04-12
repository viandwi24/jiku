'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { Puzzle } from 'lucide-react'
import {
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from '@jiku/ui'
import { useOptionalPluginUIRegistry } from '@/lib/plugins/provider'
import { Slot } from '@/lib/plugins/slot'

export interface PluginSidebarSlotProps {
  projectId: string
  projectSlug: string
  projectName: string
  userId: string
  userPermissions: string[]
  base: string  // e.g. /studio/companies/acme/projects/prod
}

export function PluginSidebarSlot(props: PluginSidebarSlotProps) {
  const registry = useOptionalPluginUIRegistry()
  const pathname = usePathname()
  // If the sidebar mounts above the per-project <PluginUIProvider>, registry is null.
  // Render nothing — the provider-scoped tree will re-render the slot correctly.
  if (!registry) return null
  const { entriesBySlot } = registry
  const sidebarEntries = entriesBySlot['sidebar.item'] ?? []
  const pageEntries = entriesBySlot['project.page'] ?? []

  if (sidebarEntries.length === 0 && pageEntries.length === 0) return null

  const contextBase = {
    project: { id: props.projectId, slug: props.projectSlug, name: props.projectName },
    user: { id: props.userId, role: 'member' as const },
    userPermissions: new Set(props.userPermissions),
  }

  return (
    <SidebarGroup>
      <SidebarGroupLabel>Plugins</SidebarGroupLabel>
      <SidebarGroupContent>
        <SidebarMenu className="gap-0.5">
          {/* Full-page entries get auto-generated nav links (so plugins don't
              need to both declare sidebar.item AND project.page). */}
          {pageEntries.map(entry => {
            const href = `${props.base}/plugin-pages/${entry.pluginId}/${(entry.meta as { path?: string }).path ?? ''}`
            const active = pathname?.startsWith(`${props.base}/plugin-pages/${entry.pluginId}`)
            const title = (entry.meta as { title?: string }).title ?? entry.pluginId
            return (
              <SidebarMenuItem key={`page-${entry.pluginId}:${entry.id}`}>
                <SidebarMenuButton asChild isActive={active ?? false}>
                  <Link href={href}>
                    <Puzzle className="h-4 w-4" />
                    {title}
                  </Link>
                </SidebarMenuButton>
              </SidebarMenuItem>
            )
          })}

          {/* Custom sidebar.item renderers declared by plugins. */}
          <Slot
            name="sidebar.item"
            contextBase={contextBase}
            renderEntry={(entry, node) => (
              <SidebarMenuItem key={`custom-${entry.pluginId}:${entry.id}`}>
                {node}
              </SidebarMenuItem>
            )}
          />
        </SidebarMenu>
      </SidebarGroupContent>
    </SidebarGroup>
  )
}
