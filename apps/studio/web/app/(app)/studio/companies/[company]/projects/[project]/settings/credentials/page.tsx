'use client'

import { use, useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { api } from '@/lib/api'
import type { CredentialAdapter } from '@/lib/api'
import {
  Alert,
  AlertDescription,
  AlertTitle,
  Button,
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  CredentialList,
  CredentialForm,
} from '@jiku/ui'
import type { CredentialCardItem } from '@jiku/ui'
import { AlertTriangle, Plus, Wand2 } from 'lucide-react'
import { toast } from 'sonner'
import { ConnectorSetupWizard } from '@/components/connectors/setup-wizard'

interface PageProps {
  params: Promise<{ company: string; project: string }>
}

export default function ProjectCredentialsPage({ params }: PageProps) {
  const { company: companySlug, project: projectSlug } = use(params)
  const qc = useQueryClient()
  const [showAdd, setShowAdd] = useState(false)
  const [editTarget, setEditTarget] = useState<CredentialCardItem | null>(null)
  const [setupTarget, setSetupTarget] = useState<{ id: string; adapter_id: string } | null>(null)

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

  const { data: adaptersData } = useQuery({
    queryKey: ['credentials-adapters'],
    queryFn: () => api.credentials.adapters(),
  })

  const { data: companyCredsData } = useQuery({
    queryKey: ['company-credentials', companySlug],
    queryFn: () => api.credentials.listCompany(companySlug),
  })

  const { data: projectCredsData } = useQuery({
    queryKey: ['project-credentials', project?.id],
    queryFn: () => api.credentials.listProject(project!.id),
    enabled: !!project?.id,
  })

  const createMutation = useMutation({
    mutationFn: (body: Parameters<typeof api.credentials.createProject>[1]) =>
      api.credentials.createProject(project!.id, body),
    onSuccess: (res, vars) => {
      qc.invalidateQueries({ queryKey: ['project-credentials', project?.id] })
      setShowAdd(false)
      toast.success('Credential added')
      const ad = adaptersById.get(vars.adapter_id)
      if (ad?.requires_interactive_setup) {
        setSetupTarget({ id: res.credential.id, adapter_id: vars.adapter_id })
      }
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : 'Failed to add credential'),
  })

  const updateMutation = useMutation({
    mutationFn: ({ id, body }: { id: string; body: Parameters<typeof api.credentials.update>[1] }) =>
      api.credentials.update(id, body),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['project-credentials', project?.id] })
      setEditTarget(null)
      toast.success('Credential updated')
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : 'Failed to update'),
  })

  const deleteMutation = useMutation({
    mutationFn: (id: string) => api.credentials.delete(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['project-credentials', project?.id] })
      toast.success('Credential deleted')
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : 'Failed to delete'),
  })

  const testMutation = useMutation({
    mutationFn: (id: string) => api.credentials.test(id),
    onSuccess: (result) => {
      if (result.ok) toast.success(`Connected: ${result.message}`)
      else toast.error(`Failed: ${result.message}`)
    },
  })

  const adapters: CredentialAdapter[] = adaptersData?.adapters ?? []

  const adaptersById = new Map(adapters.map(a => [a.adapter_id, a]))
  const projectCreds = projectCredsData?.credentials ?? []
  const credsNeedingSetup = projectCreds.filter(c => {
    const ad = adaptersById.get(c.adapter_id)
    if (!ad?.requires_interactive_setup) return false
    // Setup wizard required when the credential's "auto-filled" markers are
    // missing — the wizard's job is to fill them. For Telegram User adapter
    // that marker is `session_string` (in masked fields) OR `user_id` (in
    // metadata); without either, no wizard has ever completed against this
    // credential. We check both so any auto-filled key from the spec is OK.
    const fields = c.fields_masked ?? {}
    const meta = (c.metadata as Record<string, unknown> | undefined) ?? {}
    const hasSession = !!fields['session_string'] || !!meta['session_string']
    const hasUserId = !!meta['user_id'] || !!fields['user_id']
    // If neither marker exists, setup is incomplete → show the alert.
    return !hasSession && !hasUserId
  })

  return (
    <div className="space-y-6">
      {(companyCredsData?.credentials.length ?? 0) > 0 && (
        <div>
          <p className="text-sm font-medium mb-2">Inherited from Company <span className="text-muted-foreground font-normal">(read-only)</span></p>
          <CredentialList
            credentials={companyCredsData?.credentials ?? []}
            readonly
            emptyText="No company credentials."
          />
        </div>
      )}

      <div className="flex items-center justify-between">
        <p className="text-sm font-medium">Project Credentials</p>
        <Button size="sm" onClick={() => setShowAdd(true)} disabled={!project}>
          <Plus className="w-4 h-4 mr-1" /> Add Credential
        </Button>
      </div>
      {credsNeedingSetup.length > 0 && (
        <div className="space-y-2">
          {credsNeedingSetup.map(c => (
            <Alert key={c.id}>
              <AlertTriangle className="h-4 w-4" />
              <AlertTitle className="flex items-center justify-between gap-2">
                <span>Setup required — {c.name}</span>
                <Button
                  size="sm"
                  onClick={() => setSetupTarget({ id: c.id, adapter_id: c.adapter_id })}
                >
                  <Wand2 className="w-3.5 h-3.5 mr-1" /> Run Setup
                </Button>
              </AlertTitle>
              <AlertDescription>
                This connector requires an interactive setup before it can be used. Click
                Run Setup to complete configuration.
              </AlertDescription>
            </Alert>
          ))}
        </div>
      )}

      <CredentialList
        credentials={projectCreds}
        onEdit={setEditTarget}
        onDelete={(id) => deleteMutation.mutate(id)}
        onTest={(id) => testMutation.mutate(id)}
        onSetup={(c) => setSetupTarget({ id: c.id, adapter_id: c.adapter_id })}
        isSetupEligible={(c) => !!adaptersById.get(c.adapter_id)?.requires_interactive_setup}
        isSetupCompleted={(c) => {
          const meta = (c.metadata as Record<string, unknown> | undefined) ?? {}
          const fields = c.fields_masked ?? {}
          return !!fields['session_string'] || !!meta['session_string'] || !!meta['user_id'] || !!fields['user_id']
        }}
        emptyText="No project credentials yet."
      />

      <Dialog open={showAdd} onOpenChange={setShowAdd}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>Add Project Credential</DialogTitle>
          </DialogHeader>
          <CredentialForm
            adapters={adapters}
            onSubmit={(values) => createMutation.mutate(values)}
            onCancel={() => setShowAdd(false)}
            isLoading={createMutation.isPending}
          />
        </DialogContent>
      </Dialog>

      <Dialog open={!!editTarget} onOpenChange={(open) => { if (!open) setEditTarget(null) }}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>Edit Credential</DialogTitle>
          </DialogHeader>
          {editTarget && (
            <CredentialForm
              adapters={adapters}
              editMode
              initialValues={{
                name: editTarget.name,
                description: editTarget.description ?? '',
                adapter_id: editTarget.adapter_id,
                metadata: editTarget.metadata,
              }}
              onSubmit={(values) => {
                const body: Parameters<typeof api.credentials.update>[1] = {
                  name: values.name,
                  description: values.description,
                  metadata: values.metadata,
                }
                if (Object.values(values.fields).some(v => v !== '')) {
                  body.fields = values.fields
                }
                updateMutation.mutate({ id: editTarget.id, body })
              }}
              onCancel={() => setEditTarget(null)}
              submitLabel="Update"
              isLoading={updateMutation.isPending}
            />
          )}
        </DialogContent>
      </Dialog>

      {setupTarget && project && (
        <ConnectorSetupWizard
          projectId={project.id}
          credentialId={setupTarget.id}
          adapterId={setupTarget.adapter_id}
          open={!!setupTarget}
          onOpenChange={(open) => { if (!open) setSetupTarget(null) }}
          onComplete={() => {
            qc.invalidateQueries({ queryKey: ['project-credentials', project?.id] })
            toast.success('Connector setup complete')
            setSetupTarget(null)
          }}
        />
      )}
    </div>
  )
}
