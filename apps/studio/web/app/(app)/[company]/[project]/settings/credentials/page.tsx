'use client'

import { use, useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import Link from 'next/link'
import { api } from '@/lib/api'
import type { CredentialAdapter } from '@/lib/api'
import { Button, Dialog, DialogContent, DialogHeader, DialogTitle, CredentialList, CredentialForm } from '@jiku/ui'
import type { CredentialCardItem } from '@jiku/ui'
import { ArrowLeft, Plus } from 'lucide-react'
import { toast } from 'sonner'

interface PageProps {
  params: Promise<{ company: string; project: string }>
}

export default function ProjectCredentialsPage({ params }: PageProps) {
  const { company: companySlug, project: projectSlug } = use(params)
  const qc = useQueryClient()
  const [showAdd, setShowAdd] = useState(false)
  const [editTarget, setEditTarget] = useState<CredentialCardItem | null>(null)

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
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['project-credentials', project?.id] })
      setShowAdd(false)
      toast.success('Credential added')
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
  const base = `/${companySlug}/${projectSlug}`

  return (
    <div className="p-6 max-w-3xl mx-auto">
      <div className="flex items-center gap-3 mb-6">
        <Link href={`${base}/settings`}>
          <Button variant="ghost" size="icon" className="h-8 w-8">
            <ArrowLeft className="w-4 h-4" />
          </Button>
        </Link>
        <div>
          <p className="text-xs text-muted-foreground">{companyData?.name} / {project?.name} / Settings</p>
          <h1 className="text-xl font-bold">Project Credentials</h1>
        </div>
      </div>

      {/* Inherited company credentials (read-only) */}
      {(companyCredsData?.credentials.length ?? 0) > 0 && (
        <div className="mb-6">
          <p className="text-sm font-medium mb-2">Inherited from Company <span className="text-muted-foreground font-normal">(read-only)</span></p>
          <CredentialList
            credentials={companyCredsData?.credentials ?? []}
            readonly
            emptyText="No company credentials."
          />
        </div>
      )}

      {/* Project credentials */}
      <div className="flex items-center justify-between mb-3">
        <p className="text-sm font-medium">Project Credentials</p>
        <Button size="sm" onClick={() => setShowAdd(true)} disabled={!project}>
          <Plus className="w-4 h-4 mr-1" /> Add Credential
        </Button>
      </div>
      <CredentialList
        credentials={projectCredsData?.credentials ?? []}
        onEdit={setEditTarget}
        onDelete={(id) => deleteMutation.mutate(id)}
        onTest={(id) => testMutation.mutate(id)}
        emptyText="No project credentials yet."
      />

      {/* Add dialog */}
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

      {/* Edit dialog */}
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
    </div>
  )
}
