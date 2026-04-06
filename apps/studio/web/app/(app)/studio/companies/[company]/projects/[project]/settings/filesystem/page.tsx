'use client'

import { use, useState, useEffect } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { api } from '@/lib/api'
import { Button, Switch, Label, Select, SelectContent, SelectItem, SelectTrigger, SelectValue, Separator } from '@jiku/ui'
import { toast } from 'sonner'
import { CheckCircle2, XCircle, Loader2, HardDrive } from 'lucide-react'

interface PageProps {
  params: Promise<{ company: string; project: string }>
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`
}

export default function FilesystemSettingsPage({ params }: PageProps) {
  const { company: companySlug, project: projectSlug } = use(params)
  const qc = useQueryClient()

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
  const projectId = project?.id ?? ''

  const { data: configData, isLoading } = useQuery({
    queryKey: ['filesystem-config', projectId],
    queryFn: () => api.filesystem.getConfig(projectId),
    enabled: !!projectId,
  })

  const { data: credentialsData } = useQuery({
    queryKey: ['credentials-storage', projectId],
    queryFn: () => api.credentials.available(projectId, 'storage'),
    enabled: !!projectId,
  })

  const [enabled, setEnabled] = useState(false)
  const [credentialId, setCredentialId] = useState<string>('')
  const [initialized, setInitialized] = useState(false)
  const [testResult, setTestResult] = useState<{ ok: boolean; message: string } | null>(null)

  useEffect(() => {
    if (configData && !initialized) {
      const cfg = configData.config
      setEnabled(cfg?.enabled ?? false)
      setCredentialId(cfg?.credential_id ?? '')
      setInitialized(true)
    }
  }, [configData, initialized])

  const saveMutation = useMutation({
    mutationFn: () => api.filesystem.updateConfig(projectId, {
      enabled,
      credential_id: credentialId || null,
    }),
    onSuccess: () => {
      setInitialized(false)
      setTestResult(null)
      qc.invalidateQueries({ queryKey: ['filesystem-config', projectId] })
      toast.success('Filesystem config saved')
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : 'Save failed'),
  })

  const testMutation = useMutation({
    mutationFn: () => api.filesystem.testConnection(projectId),
    onSuccess: (res) => setTestResult(res),
    onError: (err) => setTestResult({ ok: false, message: err instanceof Error ? err.message : 'Test failed' }),
  })

  const storageCredentials = credentialsData?.credentials.filter(c => c.group_id === 'storage') ?? []
  const config = configData?.config

  if (isLoading) {
    return <div className="text-sm text-muted-foreground py-4">Loading...</div>
  }

  return (
    <div className="space-y-8">
      <div>
        <h2 className="text-base font-semibold">Filesystem</h2>
        <p className="text-sm text-muted-foreground mt-1">
          Virtual filesystem for this project. All agents share the same file tree. Files are stored in your S3/RustFS storage.
        </p>
      </div>

      {/* Enable toggle */}
      <section className="space-y-4">
        <div className="flex items-center justify-between gap-4">
          <div>
            <Label className="text-sm font-medium">Enable filesystem</Label>
            <p className="text-xs text-muted-foreground mt-0.5">
              Makes <code className="text-xs bg-muted px-1 rounded">fs_read</code>,{' '}
              <code className="text-xs bg-muted px-1 rounded">fs_write</code>,{' '}
              and other file tools available to agents.
            </p>
          </div>
          <Switch checked={enabled} onCheckedChange={setEnabled} />
        </div>
      </section>

      <Separator />

      {/* Credential picker */}
      <section className="space-y-4">
        <div>
          <h3 className="text-sm font-semibold">Storage Credential</h3>
          <p className="text-xs text-muted-foreground mt-0.5">
            Select an S3/RustFS credential. Create one in{' '}
            <strong>Credentials</strong> using the <strong>S3 / RustFS / MinIO</strong> adapter.
          </p>
        </div>

        <div className="space-y-2">
          <Select value={credentialId} onValueChange={setCredentialId}>
            <SelectTrigger className="w-full max-w-sm">
              <SelectValue placeholder="Select credential..." />
            </SelectTrigger>
            <SelectContent>
              {storageCredentials.length === 0 ? (
                <div className="px-3 py-2 text-xs text-muted-foreground">
                  No storage credentials found. Create one first.
                </div>
              ) : (
                storageCredentials.map(c => (
                  <SelectItem key={c.id} value={c.id}>
                    {c.name}
                  </SelectItem>
                ))
              )}
            </SelectContent>
          </Select>
        </div>

        {/* Test connection */}
        <div className="flex items-center gap-3">
          <Button
            variant="outline"
            size="sm"
            onClick={() => testMutation.mutate()}
            disabled={testMutation.isPending || !credentialId}
            className="gap-1.5"
          >
            {testMutation.isPending ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : null}
            Test Connection
          </Button>

          {testResult && (
            <div className={`flex items-center gap-2 text-sm ${testResult.ok ? 'text-emerald-600' : 'text-red-500'}`}>
              {testResult.ok
                ? <CheckCircle2 className="w-4 h-4" />
                : <XCircle className="w-4 h-4" />}
              <span>{testResult.message}</span>
            </div>
          )}
        </div>
      </section>

      {/* Storage stats */}
      {config?.enabled && (
        <>
          <Separator />
          <section className="space-y-3">
            <h3 className="text-sm font-semibold">Storage Info</h3>
            <div className="flex items-start gap-3 p-4 rounded-lg border bg-muted/30">
              <HardDrive className="w-5 h-5 text-muted-foreground shrink-0 mt-0.5" />
              <div className="grid grid-cols-2 gap-x-8 gap-y-1 text-sm">
                <span className="text-muted-foreground">Total files</span>
                <span className="font-medium tabular-nums">{config.total_files.toLocaleString()}</span>
                <span className="text-muted-foreground">Total size</span>
                <span className="font-medium tabular-nums">{formatSize(config.total_size_bytes)}</span>
              </div>
            </div>
          </section>
        </>
      )}

      <div className="pt-2">
        <Button
          onClick={() => saveMutation.mutate()}
          disabled={saveMutation.isPending || !projectId}
        >
          {saveMutation.isPending ? 'Saving...' : 'Save'}
        </Button>
      </div>
    </div>
  )
}
