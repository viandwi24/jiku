'use client'

import { use } from 'react'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { useQuery } from '@tanstack/react-query'
import {
  Activity,
  BarChart2,
  Bot,
  Brain,
  Cpu,
  FileText,
  MessageSquare,
  Paperclip,
  Shield,
  Sparkles,
  Wrench,
} from 'lucide-react'
import { api } from '@/lib/api'
import { Button, cn } from '@jiku/ui'

interface LayoutProps {
  children: React.ReactNode
  params: Promise<{ company: string; project: string; agent: string }>
}

export default function AgentLayout({ children, params }: LayoutProps) {
  const { company: companySlug, project: projectSlug, agent: agentSlug } = use(params)
  const pathname = usePathname()

  const base = `/studio/companies/${companySlug}/projects/${projectSlug}/agents/${agentSlug}`

  const navItems = [
    { value: 'info', label: 'info', icon: Bot, href: base },
    { value: 'llm', label: 'llm', icon: Cpu, href: `${base}/llm` },
    { value: 'prompt', label: 'prompt', icon: FileText, href: `${base}/prompt` },
    { value: 'persona', label: 'persona', icon: Sparkles, href: `${base}/persona` },
    { value: 'tools', label: 'tools', icon: Wrench, href: `${base}/tools` },
    { value: 'memory', label: 'memory', icon: Brain, href: `${base}/memory` },
    { value: 'files', label: 'files', icon: Paperclip, href: `${base}/files` },
    { value: 'heartbeat', label: 'heartbeat', icon: Activity, href: `${base}/heartbeat` },
    { value: 'usage', label: 'usage', icon: BarChart2, href: `${base}/usage` },
    { value: 'permissions', label: 'permissions', icon: Shield, href: `${base}/permissions` },
  ]

  const activeValue = (() => {
    for (const item of [...navItems].reverse()) {
      if (item.value === 'info') continue
      if (pathname.startsWith(item.href)) return item.value
    }
    return 'info'
  })()

  const { data: companyData } = useQuery({
    queryKey: ['companies'],
    queryFn: () => api.companies.list(),
    select: (d) => d.companies.find(c => c.slug === companySlug) ?? null,
  })

  const { data: projectsData } = useQuery({
    queryKey: ['projects', companyData?.id],
    queryFn: () => api.projects.list(companyData!.id),
    enabled: !!companyData?.id,
  })
  const project = projectsData?.projects.find(p => p.slug === projectSlug)

  const { data: agentsData } = useQuery({
    queryKey: ['agents', project?.id],
    queryFn: () => api.agents.list(project!.id),
    enabled: !!project?.id,
  })
  const agent = agentsData?.agents.find(a => a.slug === agentSlug)

  return (
    <div className="flex flex-col h-full">
      {/* Agent header */}
      <div className="flex items-center gap-3 px-6 py-3 border-b shrink-0">
        <Link
          href={`${base.split('/agents/')[0]}/agents`}
          className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors"
        >
          <Bot className="h-3.5 w-3.5" />
          agents
        </Link>
        <span className="text-muted-foreground text-xs">/</span>
        <span className="text-sm font-semibold">{agent?.name ?? agentSlug}</span>
        <div className="ml-auto">
          <Button asChild size="sm" variant="outline">
            <Link href={`/studio/companies/${companySlug}/projects/${projectSlug}/chats?agent=${agentSlug}`}>
              <MessageSquare className="h-3.5 w-3.5 mr-1.5" />
              Chat
            </Link>
          </Button>
        </div>
      </div>

      {/* Content: left nav + main */}
      <div className="flex flex-1 overflow-hidden">
        {/* Left nav */}
        <nav className="w-40 shrink-0 border-r flex flex-col gap-0.5 py-3 px-2">
          {navItems.map(item => (
            <Link
              key={item.value}
              href={item.href}
              className={cn(
                'flex items-center gap-2.5 px-2.5 py-1.5 rounded-md text-sm transition-colors',
                activeValue === item.value
                  ? 'bg-accent text-accent-foreground font-medium'
                  : 'text-muted-foreground hover:text-foreground hover:bg-accent/50',
              )}
            >
              <item.icon className="h-4 w-4 shrink-0" />
              {item.label}
            </Link>
          ))}
        </nav>

        {/* Page content */}
        <div className="flex-1 overflow-auto">
          {children}
        </div>
      </div>
    </div>
  )
}
