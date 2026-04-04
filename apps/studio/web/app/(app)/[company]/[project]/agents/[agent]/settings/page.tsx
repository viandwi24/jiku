'use client'

import { use, useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import Link from 'next/link'
import { api } from '@/lib/api'
import type { CredentialAdapter } from '@/lib/api'
import { AgentConfigForm } from '@/components/agent/agent-config-form'
import {
  Tabs, TabsContent, TabsList, TabsTrigger,
  Button, Separator,
  CredentialSelector, ModelSelector, MetadataOverrideForm,
} from '@jiku/ui'
import { ArrowLeft, ShieldCheck, Cpu } from 'lucide-react'
import { toast } from 'sonner'

interface PageProps {
  params: Promise<{ company: string; project: string; agent: string }>
}

export default function AgentSettingsPage({ params }: PageProps) {
  const { company: companySlug, project: projectSlug, agent: agentSlug } = use(params)
  const qc = useQueryClient()

  const { data: companyData } = useQuery({
    queryKey: ['company', companySlug],
    queryFn: async () => {
      const { companies } = await api.companies.list()
      return companies.find(c => c.slug === companySlug) ?? null
    },
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
  const agentId = agent?.id ?? ''

  const { data: adaptersData } = useQuery({
    queryKey: ['credentials-adapters', 'provider-model'],
    queryFn: () => api.credentials.adapters('provider-model'),
  })

  const { data: availableCredsData } = useQuery({
    queryKey: ['available-credentials', project?.id],
    queryFn: () => api.credentials.available(project!.id, 'provider-model'),
    enabled: !!project?.id,
  })

  const { data: agentCredData, isLoading: isLoadingAgentCred } = useQuery({
    queryKey: ['agent-credential', agentId],
    queryFn: () => api.credentials.getAgent(agentId),
  })

  // Local state for Model & Provider tab
  const currentCred = agentCredData?.agent_credential
  const [selectedCredId, setSelectedCredId] = useState<string | null>(null)
  const [selectedModelId, setSelectedModelId] = useState<string>('')
  const [metadataOverride, setMetadataOverride] = useState<Record<string, string>>({})

  // Initialize from loaded data
  const credId = selectedCredId ?? currentCred?.credential.id ?? null
  const adapter = adaptersData?.adapters.find((a: CredentialAdapter) => {
    const cred = availableCredsData?.credentials.find(c => c.id === credId)
    return cred && a.adapter_id === cred.adapter_id
  })

  const modelId = selectedModelId || currentCred?.model_id || ''

  const saveMutation = useMutation({
    mutationFn: async () => {
      if (!credId) throw new Error('Select a credential first')
      if (currentCred) {
        return api.credentials.updateAgent(agentId, {
          credential_id: credId,
          model_id: modelId || undefined,
          metadata_override: metadataOverride,
        })
      } else {
        return api.credentials.assignAgent(agentId, {
          credential_id: credId,
          model_id: modelId || undefined,
          metadata_override: metadataOverride,
        })
      }
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['agent-credential', agentId] })
      toast.success('Model & Provider saved')
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : 'Failed to save'),
  })

  const unassignMutation = useMutation({
    mutationFn: () => api.credentials.unassignAgent(agentId),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['agent-credential', agentId] })
      setSelectedCredId(null)
      setSelectedModelId('')
      setMetadataOverride({})
      toast.success('Credential unassigned')
    },
  })

  const chatPath = `/${companySlug}/${projectSlug}/agents/${agentSlug}`
  const permissionsPath = `/${companySlug}/${projectSlug}/agents/${agentSlug}/settings/permissions`

  return (
    <div className="p-6 max-w-3xl mx-auto">
      <div className="flex items-center gap-3 mb-6">
        <Link href={chatPath}>
          <Button variant="ghost" size="icon" className="h-8 w-8">
            <ArrowLeft className="w-4 h-4" />
          </Button>
        </Link>
        <div>
          <p className="text-xs text-muted-foreground">{companyData?.name} / {project?.name}</p>
          <h1 className="text-xl font-bold">{agent?.name ?? 'Agent'} — Settings</h1>
        </div>
      </div>

      <Tabs defaultValue="config">
        <TabsList className="mb-6">
          <TabsTrigger value="config">Configuration</TabsTrigger>
          <TabsTrigger value="model" className="flex items-center gap-1">
            <Cpu className="w-3.5 h-3.5" /> Model & Provider
          </TabsTrigger>
          <TabsTrigger value="permissions" asChild>
            <Link href={permissionsPath} className="flex items-center gap-1">
              <ShieldCheck className="w-3.5 h-3.5" />
              Permissions
            </Link>
          </TabsTrigger>
        </TabsList>

        <TabsContent value="config">
          {agent && project ? (
            <AgentConfigForm agent={agent} projectId={project.id} />
          ) : (
            <p className="text-muted-foreground text-sm">Loading...</p>
          )}
        </TabsContent>

        <TabsContent value="model" className="space-y-6">
          {isLoadingAgentCred ? (
            <p className="text-sm text-muted-foreground">Loading...</p>
          ) : (
            <>
              <div className="space-y-2">
                <p className="text-sm font-medium">Provider Credential</p>
                <p className="text-xs text-muted-foreground">Select the API credential to use for this agent.</p>
                <CredentialSelector
                  credentials={availableCredsData?.credentials ?? []}
                  value={credId}
                  onChange={(id) => {
                    setSelectedCredId(id)
                    setSelectedModelId('')
                  }}
                  groupFilter="provider-model"
                />
              </div>

              {credId && adapter && (
                <>
                  <Separator />
                  <div className="space-y-2">
                    <p className="text-sm font-medium">Model</p>
                    <p className="text-xs text-muted-foreground">Choose the model to use with this credential.</p>
                    <ModelSelector
                      models={adapter.models}
                      value={modelId}
                      onChange={setSelectedModelId}
                    />
                  </div>

                  <Separator />
                  <div className="space-y-2">
                    <p className="text-sm font-medium">Metadata Override <span className="text-muted-foreground font-normal text-xs">(optional)</span></p>
                    <p className="text-xs text-muted-foreground">Override credential metadata for this agent only.</p>
                    <MetadataOverrideForm
                      value={metadataOverride}
                      onChange={setMetadataOverride}
                    />
                  </div>
                </>
              )}

              <div className="flex items-center gap-2 pt-2">
                <Button
                  onClick={() => saveMutation.mutate()}
                  disabled={!credId || saveMutation.isPending}
                >
                  {saveMutation.isPending ? 'Saving...' : 'Save Changes'}
                </Button>
                {currentCred && (
                  <Button
                    variant="outline"
                    onClick={() => unassignMutation.mutate()}
                    disabled={unassignMutation.isPending}
                  >
                    Unassign
                  </Button>
                )}
              </div>
            </>
          )}
        </TabsContent>
      </Tabs>
    </div>
  )
}
