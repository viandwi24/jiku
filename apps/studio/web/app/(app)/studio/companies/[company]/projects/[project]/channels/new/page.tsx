'use client'

import { use, useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useRouter } from 'next/navigation'
import { api } from '@/lib/api'
import type { ConnectorPlugin, CredentialItem } from '@/lib/api'
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Input,
  Label,
} from '@jiku/ui'
import { Webhook, ArrowLeft, CheckCircle2, KeyRound, Plus } from 'lucide-react'
import Link from 'next/link'

interface PageProps {
  params: Promise<{ company: string; project: string }>
}

export default function NewConnectorPage({ params }: PageProps) {
  const { company: companySlug, project: projectSlug } = use(params)
  const router = useRouter()
  const qc = useQueryClient()

  const [selectedPlugin, setSelectedPlugin] = useState<ConnectorPlugin | null>(null)
  const [selectedCredential, setSelectedCredential] = useState<CredentialItem | null>(null)
  const [displayName, setDisplayName] = useState('')

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

  const { data: pluginsData, isLoading: pluginsLoading } = useQuery({
    queryKey: ['connector-plugins'],
    queryFn: () => api.connectors.plugins(),
  })

  // Load available credentials filtered by the selected plugin's credentialAdapterId
  const { data: credentialsData, isLoading: credentialsLoading } = useQuery({
    queryKey: ['credentials-available', project?.id, selectedPlugin?.credential_adapter_id],
    queryFn: () => api.credentials.available(project!.id, 'channel'),
    enabled: !!project?.id && !!selectedPlugin,
    select: (d) => d.credentials.filter(c => c.adapter_id === selectedPlugin?.credential_adapter_id),
  })

  const createMutation = useMutation({
    mutationFn: () => api.connectors.create(project!.id, {
      plugin_id: selectedPlugin!.id,
      display_name: displayName || selectedPlugin!.display_name,
      credential_id: selectedCredential?.id ?? null,
    }),
    onSuccess: (data) => {
      qc.invalidateQueries({ queryKey: ['connectors', project?.id] })
      router.push(`/studio/companies/${companySlug}/projects/${projectSlug}/channels/${data.connector.id}`)
    },
  })

  const base = `/studio/companies/${companySlug}/projects/${projectSlug}`
  const plugins = pluginsData?.plugins ?? []
  const credentials = credentialsData ?? []

  const canCreate = !!selectedPlugin && (credentials.length === 0 || !!selectedCredential)

  return (
    <div className="p-6 max-w-2xl space-y-6">
      <div className="flex items-center gap-3">
        <Button size="sm" variant="ghost" asChild>
          <Link href={`${base}/channels`}>
            <ArrowLeft className="h-4 w-4" />
          </Link>
        </Button>
        <div>
          <h1 className="text-xl font-semibold">Add Connector</h1>
          <p className="text-sm text-muted-foreground">Connect your project to an external platform</p>
        </div>
      </div>

      {/* Step 1: Select plugin */}
      <div className="space-y-3">
        <h2 className="text-sm font-medium">1. Select connector type</h2>
        {pluginsLoading && <p className="text-xs text-muted-foreground">Loading available connectors...</p>}
        {!pluginsLoading && plugins.length === 0 && (
          <div className="rounded-lg border border-dashed p-6 text-center">
            <Webhook className="h-8 w-8 mx-auto text-muted-foreground/40 mb-2" />
            <p className="text-sm text-muted-foreground">No connector plugins installed.</p>
          </div>
        )}
        <div className="grid gap-3 sm:grid-cols-2">
          {plugins.map(plugin => (
            <Card
              key={plugin.id}
              className={`cursor-pointer transition-colors ${selectedPlugin?.id === plugin.id ? 'ring-2 ring-primary' : 'hover:border-border'}`}
              onClick={() => {
                setSelectedPlugin(plugin)
                setDisplayName(plugin.display_name)
                setSelectedCredential(null)
              }}
            >
              <CardHeader className="pb-2 pt-4 px-4">
                <div className="flex items-center justify-between">
                  <CardTitle className="text-sm">{plugin.display_name}</CardTitle>
                  {selectedPlugin?.id === plugin.id && <CheckCircle2 className="h-4 w-4 text-primary" />}
                </div>
                <CardDescription className="text-xs">{plugin.id}</CardDescription>
              </CardHeader>
              <CardContent className="px-4 pb-4">
                <p className="text-xs text-muted-foreground">
                  Events: {plugin.supported_events.join(', ')}
                </p>
              </CardContent>
            </Card>
          ))}
        </div>
      </div>

      {/* Step 2: Select credential */}
      {selectedPlugin && (
        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-medium">2. Select credential</h2>
            <Button size="sm" variant="outline" className="h-7 text-xs gap-1" asChild>
              <Link href={`${base}/settings/credentials`}>
                <Plus className="h-3 w-3" />
                New credential
              </Link>
            </Button>
          </div>

          {credentialsLoading && <p className="text-xs text-muted-foreground">Loading credentials...</p>}

          {!credentialsLoading && credentials.length === 0 && (
            <div className="rounded-lg border border-dashed p-5 text-center space-y-2">
              <KeyRound className="h-7 w-7 mx-auto text-muted-foreground/40" />
              <p className="text-sm text-muted-foreground">No credentials for this connector type.</p>
              <p className="text-xs text-muted-foreground">
                Create a <strong>{selectedPlugin.display_name}</strong> credential in Settings first.
              </p>
              <Button size="sm" variant="outline" asChild>
                <Link href={`${base}/settings/credentials`}>Go to Credentials</Link>
              </Button>
            </div>
          )}

          {credentials.length > 0 && (
            <div className="space-y-2">
              {credentials.map(cred => (
                <button
                  key={cred.id}
                  className={`w-full flex items-center justify-between px-4 py-3 rounded-lg border text-left transition-colors ${
                    selectedCredential?.id === cred.id
                      ? 'ring-2 ring-primary bg-primary/5'
                      : 'hover:bg-muted/30'
                  }`}
                  onClick={() => setSelectedCredential(cred)}
                >
                  <div className="space-y-0.5">
                    <p className="text-sm font-medium">{cred.name}</p>
                    <p className="text-xs text-muted-foreground">{cred.adapter_id}</p>
                  </div>
                  <div className="flex items-center gap-2">
                    <Badge variant="outline" className="text-[10px]">{cred.scope}</Badge>
                    {selectedCredential?.id === cred.id && <CheckCircle2 className="h-4 w-4 text-primary" />}
                  </div>
                </button>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Step 3: Display name + create */}
      {selectedPlugin && (credentials.length === 0 || selectedCredential) && (
        <div className="space-y-4">
          <h2 className="text-sm font-medium">{credentials.length === 0 ? '2' : '3'}. Name your connector</h2>
          <div className="space-y-1.5">
            <Label htmlFor="display-name" className="text-xs">Display name</Label>
            <Input
              id="display-name"
              value={displayName}
              onChange={e => setDisplayName(e.target.value)}
              placeholder={selectedPlugin.display_name}
              className="h-8 text-sm"
            />
          </div>

          <Button
            size="sm"
            onClick={() => createMutation.mutate()}
            disabled={createMutation.isPending || !canCreate}
          >
            {createMutation.isPending ? 'Creating...' : 'Create Connector'}
          </Button>

          {createMutation.isError && (
            <p className="text-xs text-destructive">{String(createMutation.error)}</p>
          )}
        </div>
      )}
    </div>
  )
}
