'use client'

import { use } from 'react'
import { useQuery } from '@tanstack/react-query'
import Link from 'next/link'
import { useRouter, useSearchParams } from 'next/navigation'
import { api } from '@/lib/api'
import { Button, Tabs, TabsContent, TabsList, TabsTrigger } from '@jiku/ui'
import { Webhook, Plus } from 'lucide-react'
import { ConnectorsTab } from '@/components/channels/connectors-tab'
import { MessagesTab } from '@/components/channels/messages-tab'
import { EventsTab } from '@/components/channels/events-tab'
import { withPermissionGuard } from '@/components/permissions/permission-guard'

interface PageProps {
  params: Promise<{ company: string; project: string }>
}

type TabValue = 'connectors' | 'messages' | 'events'

function parseTab(v: string | null): TabValue {
  return v === 'messages' || v === 'events' ? v : 'connectors'
}

function ChannelsPage({ params }: PageProps) {
  const { company: companySlug, project: projectSlug } = use(params)
  const router = useRouter()
  const searchParams = useSearchParams()

  const tab = parseTab(searchParams.get('tab'))
  const initialConnectorId = searchParams.get('connector_id') ?? undefined

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
  const base = `/studio/companies/${companySlug}/projects/${projectSlug}`

  function setTab(next: TabValue) {
    const sp = new URLSearchParams(searchParams.toString())
    if (next === 'connectors') sp.delete('tab')
    else sp.set('tab', next)
    if (next === 'connectors') sp.delete('connector_id')
    const qs = sp.toString()
    router.replace(`${base}/channels${qs ? `?${qs}` : ''}`, { scroll: false })
  }

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold flex items-center gap-2">
            <Webhook className="h-5 w-5" />
            Channels
          </h1>
          <p className="text-sm text-muted-foreground mt-0.5">
            Connect agents to external platforms — inspect events &amp; message traffic
          </p>
        </div>
        <Button size="sm" asChild>
          <Link href={`${base}/channels/new`}>
            <Plus className="h-4 w-4" />
            Add Connector
          </Link>
        </Button>
      </div>

      <Tabs value={tab} onValueChange={(v) => setTab(v as TabValue)}>
        <TabsList>
          <TabsTrigger value="connectors">Connectors</TabsTrigger>
          <TabsTrigger value="messages">Messages</TabsTrigger>
          <TabsTrigger value="events">Events</TabsTrigger>
        </TabsList>

        <TabsContent value="connectors" className="mt-4">
          {project && <ConnectorsTab projectId={project.id} baseUrl={base} />}
        </TabsContent>
        <TabsContent value="messages" className="mt-4">
          {project && <MessagesTab projectId={project.id} initialConnectorId={initialConnectorId} />}
        </TabsContent>
        <TabsContent value="events" className="mt-4">
          {project && <EventsTab projectId={project.id} initialConnectorId={initialConnectorId} />}
        </TabsContent>
      </Tabs>
    </div>
  )
}

export default withPermissionGuard(ChannelsPage, 'channels:read')
