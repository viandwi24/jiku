'use client'

import { use, useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { api } from '@/lib/api'
import { Button } from '@jiku/ui'
import { toast } from 'sonner'
import { Loader2, Save, Info } from 'lucide-react'

interface PageProps {
  params: Promise<{ company: string; project: string; agent: string }>
}

function useAgentId(companySlug: string, projectSlug: string, agentSlug: string) {
  const { data: companyData } = useQuery({
    queryKey: ['companies'],
    queryFn: () => api.companies.list(),
    select: d => d.companies.find(c => c.slug === companySlug) ?? null,
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
  return agentsData?.agents.find(a => a.slug === agentSlug) ?? null
}

export default function AgentFilesPage({ params }: PageProps) {
  const { company: companySlug, project: projectSlug, agent: agentSlug } = use(params)
  const qc = useQueryClient()

  const agent = useAgentId(companySlug, projectSlug, agentSlug)

  const [fileDelivery, setFileDelivery] = useState<'base64' | 'proxy_url'>('base64')
  const [attachmentScope, setAttachmentScope] = useState<'per_user' | 'shared'>('per_user')
  const [synced, setSynced] = useState(false)

  if (agent && !synced) {
    setFileDelivery((agent.file_delivery ?? 'base64') as 'base64' | 'proxy_url')
    setAttachmentScope((agent.attachment_scope ?? 'per_user') as 'per_user' | 'shared')
    setSynced(true)
  }

  const saveMutation = useMutation({
    mutationFn: () => api.agents.update(agent!.id, { file_delivery: fileDelivery, attachment_scope: attachmentScope }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['agents'] })
      toast.success('Saved')
    },
    onError: err => toast.error(err instanceof Error ? err.message : 'Save failed'),
  })

  if (!agent) {
    return <div className="flex items-center justify-center h-40"><Loader2 className="w-5 h-5 animate-spin text-muted-foreground" /></div>
  }

  return (
    <div className="p-6 max-w-xl space-y-6">
      <div>
        <h2 className="text-base font-semibold">Attachment Config</h2>
        <p className="text-sm text-muted-foreground mt-1">
          Control how chat attachments (images, files) are delivered to the model and who can access them.
        </p>
      </div>

      {/* File delivery mode */}
      <div className="space-y-3">
        <div>
          <p className="text-sm font-medium">File delivery</p>
          <p className="text-xs text-muted-foreground mt-0.5">How attachments are sent to the AI model.</p>
        </div>
        <div className="grid grid-cols-2 gap-2">
          <button
            onClick={() => setFileDelivery('base64')}
            className={`flex flex-col gap-1 text-left p-3 rounded-lg border text-sm transition-colors ${
              fileDelivery === 'base64'
                ? 'border-primary bg-primary/5'
                : 'border-border hover:border-muted-foreground/40'
            }`}
          >
            <span className="font-medium">Inline base64</span>
            <span className="text-xs text-muted-foreground">File data embedded directly in the message. No public URL needed. Best for development.</span>
          </button>
          <button
            onClick={() => setFileDelivery('proxy_url')}
            className={`flex flex-col gap-1 text-left p-3 rounded-lg border text-sm transition-colors ${
              fileDelivery === 'proxy_url'
                ? 'border-primary bg-primary/5'
                : 'border-border hover:border-muted-foreground/40'
            }`}
          >
            <span className="font-medium">Proxy URL</span>
            <span className="text-xs text-muted-foreground">Server generates a short-lived signed URL. Smaller payload, requires PUBLIC_URL env to be set.</span>
          </button>
        </div>

        {fileDelivery === 'proxy_url' && (
          <div className="flex items-start gap-2 p-3 rounded-md bg-amber-50 dark:bg-amber-950/20 text-amber-700 dark:text-amber-400 text-xs">
            <Info className="w-3.5 h-3.5 shrink-0 mt-0.5" />
            <span>Proxy URL requires <code className="font-mono">PUBLIC_URL</code> to be set in server env so the model provider can reach the file endpoint.</span>
          </div>
        )}
      </div>

      {/* Attachment scope */}
      <div className="space-y-3 pt-2 border-t">
        <div>
          <p className="text-sm font-medium">Attachment scope</p>
          <p className="text-xs text-muted-foreground mt-0.5">Who can access uploaded attachments.</p>
        </div>
        <div className="grid grid-cols-2 gap-2">
          <button
            onClick={() => setAttachmentScope('per_user')}
            className={`flex flex-col gap-1 text-left p-3 rounded-lg border text-sm transition-colors ${
              attachmentScope === 'per_user'
                ? 'border-primary bg-primary/5'
                : 'border-border hover:border-muted-foreground/40'
            }`}
          >
            <span className="font-medium">Per user</span>
            <span className="text-xs text-muted-foreground">Each user's uploads are private to their own conversations.</span>
          </button>
          <button
            onClick={() => setAttachmentScope('shared')}
            className={`flex flex-col gap-1 text-left p-3 rounded-lg border text-sm transition-colors ${
              attachmentScope === 'shared'
                ? 'border-primary bg-primary/5'
                : 'border-border hover:border-muted-foreground/40'
            }`}
          >
            <span className="font-medium">Shared</span>
            <span className="text-xs text-muted-foreground">All uploads visible to everyone in the project. Good for shared knowledge bases.</span>
          </button>
        </div>
      </div>

      <Button
        size="sm"
        onClick={() => saveMutation.mutate()}
        disabled={saveMutation.isPending}
      >
        {saveMutation.isPending ? <Loader2 className="w-3.5 h-3.5 animate-spin mr-1.5" /> : <Save className="w-3.5 h-3.5 mr-1.5" />}
        Save
      </Button>
    </div>
  )
}
