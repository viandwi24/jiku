'use client'

import { use, useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { api } from '@/lib/api'
import type { CommandItem } from '@/lib/api'
import { Button, Badge, cn } from '@jiku/ui'
import { Terminal, Plus, Trash2, Check, X, AlertCircle, Settings2, RefreshCw } from 'lucide-react'
import { FileExplorer } from '@/components/filesystem/file-explorer'
import { toast } from 'sonner'

interface PageProps {
  params: Promise<{ company: string; project: string }>
}

function commandEmoji(cmd: CommandItem): string {
  const m = cmd.manifest as { metadata?: { jiku?: { emoji?: string } } } | undefined
  return m?.metadata?.jiku?.emoji ?? '/'
}

export default function ProjectCommandsPage({ params }: PageProps) {
  const { company: companySlug, project: projectSlug } = use(params)
  const queryClient = useQueryClient()
  const [selectedCommandId, setSelectedCommandId] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)
  const [newName, setNewName] = useState('')

  const { data: companiesData } = useQuery({
    queryKey: ['companies'],
    queryFn: () => api.companies.list(),
  })
  const company = companiesData?.companies.find(c => c.slug === companySlug)

  const { data: projectsData } = useQuery({
    queryKey: ['projects', company?.id],
    queryFn: () => api.projects.list(company!.id),
    enabled: !!company?.id,
  })
  const project = projectsData?.projects.find(p => p.slug === projectSlug)

  const { data: commandsData, isLoading } = useQuery({
    queryKey: ['project-commands', project?.id],
    queryFn: () => api.commands.list(project!.id),
    enabled: !!project?.id,
  })

  const { data: configData } = useQuery({
    queryKey: ['filesystem-config', project?.id],
    queryFn: () => api.filesystem.getConfig(project!.id),
    enabled: !!project?.id,
  })

  const createMutation = useMutation({
    mutationFn: (name: string) => api.commands.create(project!.id, { name }),
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ['project-commands', project?.id] })
      queryClient.invalidateQueries({ queryKey: ['files', project?.id] })
      setSelectedCommandId(data.command.id)
      setCreating(false)
      setNewName('')
      toast.success(`Command "${data.command.name}" created`)
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : 'Failed to create command'),
  })

  const deleteMutation = useMutation({
    mutationFn: (commandId: string) => api.commands.delete(commandId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['project-commands', project?.id] })
      queryClient.invalidateQueries({ queryKey: ['files', project?.id] })
      setSelectedCommandId(null)
      toast.success('Command deleted')
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : 'Failed to delete command'),
  })

  const commands = commandsData?.commands ?? []
  const selectedCommand = commands.find(c => c.id === selectedCommandId) ?? null
  const isFilesystemConfigured = configData?.config?.enabled

  return (
    <div className="flex h-full overflow-hidden">
      {/* Command list panel */}
      <div className="w-64 shrink-0 border-r flex flex-col">
        <div className="px-3 py-3 border-b flex items-center justify-between">
          <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Commands</span>
          <div className="flex items-center gap-0.5">
            <Button
              size="icon"
              variant="ghost"
              className="h-6 w-6"
              title="Rescan /commands folder"
              onClick={async () => {
                if (!project?.id) return
                try {
                  const r = await api.commands.refresh(project.id)
                  toast.success(`Synced ${r.count} command(s)`)
                  queryClient.invalidateQueries({ queryKey: ['project-commands', project.id] })
                } catch (err) {
                  toast.error(err instanceof Error ? err.message : 'Refresh failed')
                }
              }}
            >
              <RefreshCw className="h-3.5 w-3.5" />
            </Button>
            <Button
              size="icon"
              variant="ghost"
              className="h-6 w-6"
              title="New command"
              onClick={() => setCreating(true)}
            >
              <Plus className="h-3.5 w-3.5" />
            </Button>
          </div>
        </div>

        <div className="flex-1 overflow-auto py-1.5">
          {isLoading && (
            <p className="text-xs text-muted-foreground px-3 py-2">Loading...</p>
          )}

          {!isLoading && commands.length === 0 && !creating && (
            <div className="px-3 py-4 text-center">
              <Terminal className="h-5 w-5 mx-auto text-muted-foreground/50 mb-1.5" />
              <p className="text-xs text-muted-foreground">No commands yet</p>
            </div>
          )}

          {commands.map(command => (
            <button
              key={command.id}
              onClick={() => setSelectedCommandId(command.id)}
              className={cn(
                'w-full text-left px-3 py-2 flex items-center gap-2 text-sm transition-colors',
                selectedCommandId === command.id
                  ? 'bg-accent text-accent-foreground'
                  : 'hover:bg-muted/40 text-muted-foreground hover:text-foreground',
              )}
            >
              <span className="text-sm w-4 text-center shrink-0">{commandEmoji(command)}</span>
              <span className="truncate flex-1 font-mono text-xs">{command.slug}</span>
              {command.source && command.source !== 'fs' && (
                <Badge variant="outline" className="text-[9px] h-4 px-1 shrink-0" title={command.source}>plugin</Badge>
              )}
              {!command.enabled && (
                <Badge variant="outline" className="text-[9px] h-4 px-1 shrink-0">off</Badge>
              )}
              {command.active === false && (
                <Badge variant="outline" className="text-[9px] h-4 px-1 shrink-0" title="Inactive source">inactive</Badge>
              )}
            </button>
          ))}

          {creating && (
            <div className="px-2 py-1.5 flex items-center gap-1">
              <input
                autoFocus
                value={newName}
                onChange={e => setNewName(e.target.value)}
                placeholder="Command name"
                className="flex-1 h-7 text-xs px-2 rounded border bg-background outline-none focus:ring-1 ring-ring"
                onKeyDown={e => {
                  if (e.key === 'Enter' && newName.trim()) {
                    createMutation.mutate(newName.trim())
                  } else if (e.key === 'Escape') {
                    setCreating(false)
                    setNewName('')
                  }
                }}
              />
              <Button
                size="icon"
                variant="ghost"
                className="h-7 w-7 shrink-0"
                disabled={!newName.trim() || createMutation.isPending}
                onClick={() => createMutation.mutate(newName.trim())}
              >
                <Check className="h-3.5 w-3.5" />
              </Button>
              <Button
                size="icon"
                variant="ghost"
                className="h-7 w-7 shrink-0"
                onClick={() => { setCreating(false); setNewName('') }}
              >
                <X className="h-3.5 w-3.5" />
              </Button>
            </div>
          )}
        </div>
      </div>

      {/* Main panel */}
      <div className="flex-1 flex flex-col overflow-hidden">
        {!selectedCommand && (
          <div className="flex items-center justify-center h-full text-center">
            <div>
              <Terminal className="h-8 w-8 mx-auto text-muted-foreground/40 mb-3" />
              <p className="text-sm text-muted-foreground">Select a command to edit its files</p>
              <p className="text-xs text-muted-foreground/70 mt-1">or click + to create one</p>
            </div>
          </div>
        )}

        {selectedCommand && !isFilesystemConfigured && (
          <div className="flex items-center justify-center h-full p-8">
            <div className="max-w-sm text-center space-y-3">
              <AlertCircle className="w-8 h-8 text-muted-foreground mx-auto" />
              <h2 className="font-semibold text-sm">Virtual Disk not configured</h2>
              <p className="text-sm text-muted-foreground">
                Commands are stored on the project filesystem. Configure S3-compatible storage in
                the <strong>Disk</strong> page to create and edit command files.
              </p>
              <Button variant="outline" size="sm" asChild>
                <a href="./disk">
                  <Settings2 className="w-3.5 h-3.5 mr-1.5" />
                  Configure Storage
                </a>
              </Button>
            </div>
          </div>
        )}

        {selectedCommand && isFilesystemConfigured && project?.id && (
          <CommandFileEditor
            command={selectedCommand}
            projectId={project.id}
            onDelete={() => {
              if (!confirm(`Delete command "${selectedCommand.name}" and all its files?`)) return
              deleteMutation.mutate(selectedCommand.id)
            }}
          />
        )}
      </div>
    </div>
  )
}

function CommandFileEditor({
  command,
  projectId,
  onDelete,
}: {
  command: CommandItem
  projectId: string
  onDelete: () => void
}) {
  return (
    <div className="flex flex-col flex-1 overflow-hidden">
      <div className="flex items-center gap-3 px-4 py-2.5 border-b shrink-0">
        <Terminal className="w-4 h-4 text-muted-foreground" />
        <div className="flex-1 min-w-0">
          <p className="text-sm font-medium truncate">{command.name}</p>
          {command.description && (
            <p className="text-xs text-muted-foreground truncate">{command.description}</p>
          )}
        </div>
        <div className="flex items-center gap-2 shrink-0 text-xs text-muted-foreground">
          <span className="font-mono bg-muted px-1.5 py-0.5 rounded">/{command.slug}</span>
          <span>·</span>
          <span>entry: <span className="font-mono">{command.entrypoint}</span></span>
        </div>
        <Button
          variant="ghost"
          size="sm"
          className="h-7 text-xs text-destructive hover:text-destructive gap-1"
          onClick={onDelete}
        >
          <Trash2 className="h-3 w-3" />
          Delete
        </Button>
      </div>

      <FileExplorer
        key={command.id}
        projectId={projectId}
        rootPath={`/commands/${command.slug}`}
        hideUpload
      />
    </div>
  )
}
