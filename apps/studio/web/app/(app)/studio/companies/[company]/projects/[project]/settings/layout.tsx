'use client'

import { use } from 'react'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { Tabs, TabsList, TabsTrigger } from '@jiku/ui'

interface LayoutProps {
  children: React.ReactNode
  params: Promise<{ company: string; project: string }>
}

export default function ProjectSettingsLayout({ children, params }: LayoutProps) {
  const { company: companySlug, project: projectSlug } = use(params)
  const pathname = usePathname()

  const base = `/studio/companies/${companySlug}/projects/${projectSlug}/settings`
  const tabs = [
    { value: 'general', label: 'General', href: `${base}/general` },
    { value: 'credentials', label: 'Credentials', href: `${base}/credentials` },
    { value: 'permissions', label: 'Permissions', href: `${base}/permissions` },
  ]

  const activeTab = tabs.find(t => pathname.startsWith(t.href))?.value ?? 'general'

  return (
    <div className="max-w-3xl mx-auto px-6 py-6">
      <div className="mb-6">
        <h1 className="text-xl font-semibold">Settings</h1>
      </div>
      <Tabs value={activeTab}>
        <TabsList className="mb-6">
          {tabs.map(tab => (
            <TabsTrigger key={tab.value} value={tab.value} asChild>
              <Link href={tab.href}>{tab.label}</Link>
            </TabsTrigger>
          ))}
        </TabsList>
      </Tabs>
      {children}
    </div>
  )
}
