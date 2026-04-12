'use client'

import { use } from 'react'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { cn } from '@jiku/ui'

interface LayoutProps {
  children: React.ReactNode
  params: Promise<{ company: string; project: string }>
}

interface NavItem {
  label: string
  href: string
  description?: string
}

interface NavGroup {
  label: string
  items: NavItem[]
}

export default function ProjectSettingsLayout({ children, params }: LayoutProps) {
  const { company: companySlug, project: projectSlug } = use(params)
  const pathname = usePathname()

  const base = `/studio/companies/${companySlug}/projects/${projectSlug}/settings`

  const groups: NavGroup[] = [
    {
      label: 'Project',
      items: [
        { label: 'General', href: `${base}/general` },
        { label: 'Credentials', href: `${base}/credentials` },
        { label: 'MCP Servers', href: `${base}/mcp` },
      ],
    },
    {
      label: 'Access Control',
      items: [
        { label: 'Members', href: `${base}/permissions` },
        { label: 'Roles', href: `${base}/permissions?tab=roles` },
        { label: 'Agent Access', href: `${base}/permissions?tab=agents` },
        { label: 'Policies', href: `${base}/policies` },
        { label: 'Plugin Permissions', href: `${base}/plugin-permissions` },
      ],
    },
    {
      label: 'Observability',
      items: [
        { label: 'Audit Log', href: `${base}/audit` },
      ],
    },
  ]

  // Strip query string for active comparison, but also match ?tab= for permissions subsections.
  const currentPath = pathname
  const currentQueryTab = typeof window !== 'undefined'
    ? new URLSearchParams(window.location.search).get('tab')
    : null

  function isActive(href: string): boolean {
    const [hrefPath, hrefQuery] = href.split('?')
    if (currentPath !== hrefPath) return false
    if (!hrefQuery) {
      // Only active if there's no ?tab= on permissions (default = Members)
      if (hrefPath.endsWith('/permissions')) return currentQueryTab === null
      return true
    }
    const params = new URLSearchParams(hrefQuery)
    const tab = params.get('tab')
    return currentQueryTab === tab
  }

  return (
    <div className="max-w-6xl mx-auto px-6 py-6">
      <div className="mb-6">
        <h1 className="text-xl font-semibold">Settings</h1>
        <p className="text-sm text-muted-foreground">Configure project, access control, and observability.</p>
      </div>

      <div className="grid grid-cols-[220px_1fr] gap-8">
        <nav className="space-y-6 text-sm">
          {groups.map(group => (
            <div key={group.label}>
              <div className="px-2 mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                {group.label}
              </div>
              <ul className="space-y-0.5">
                {group.items.map(item => {
                  const active = isActive(item.href)
                  return (
                    <li key={item.href}>
                      <Link
                        href={item.href}
                        className={cn(
                          'block px-2 py-1.5 rounded-md transition-colors',
                          active
                            ? 'bg-muted font-medium text-foreground'
                            : 'text-muted-foreground hover:bg-muted/60 hover:text-foreground',
                        )}
                      >
                        {item.label}
                      </Link>
                    </li>
                  )
                })}
              </ul>
            </div>
          ))}
        </nav>

        <div className="min-w-0">{children}</div>
      </div>
    </div>
  )
}
