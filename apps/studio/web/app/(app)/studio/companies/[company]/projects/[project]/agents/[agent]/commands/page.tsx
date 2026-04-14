'use client'

import { use, useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { api } from '@/lib/api'
import type { AgentCommandAssignment, CommandItem } from '@/lib/api'
import { Button, Badge, cn } from '@jiku/ui'
import { Terminal, Plus, Trash2, Pin } from 'lucide-react'
import { toast } from 'sonner'

interface PageProps {
  params: Promise<{ company: string; project: string; agent: string }>
}

function commandEmoji(cmd: CommandItem): string {
  const m = cmd.manifest as { metadata?: { jiku?: { emoji?: string } } } | undefined
  return m?.metadata?.jiku?.emoji ?? '/'
}

export default function AgentCommandsPage({ params }: PageProps) {
  const { company: companySlug, project: projectSlug, agent: agentSlug } = use(params)
  const queryClient = useQueryClient()

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

  const { data: agentsData } = useQuery({
    queryKey: ['agents', project?.id],
    queryFn: () => api.agents.list(project!.id),
    enabled: !!project?.id,
  })
  const agent = agentsData?.agents.find(a => a.slug === agentSlug)

  const { data: assignmentsData, isLoading: assignmentsLoading } = useQuery({
    queryKey: ['agent-commands', agent?.id],
    queryFn: () => api.commands.listAgentCommands(agent!.id),
    enabled: !!agent?.id,
  })

  const { data: projectCommandsData } = useQuery({
    queryKey: ['project-commands', project?.id],
    queryFn: () => api.commands.list(project!.id),
    enabled: !!project?.id,
  })

  const assignedIds = new Set(assignmentsData?.assignments.map(a => a.command_id) ?? [])
  const availableCommands = projectCommandsData?.commands.filter(c => !assignedIds.has(c.id) && c.active !== false && c.enabled) ?? []

  const assignMutation = useMutation({
    mutationFn: ({ commandId, pinned }: { commandId: string; pinned?: boolean }) =>
      api.commands.assignCommand(agent!.id, { command_id: commandId, pinned }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['agent-commands', agent?.id] }),
  })

  const removeMutation = useMutation({
    mutationFn: (commandId: string) => api.commands.removeCommand(agent!.id, commandId),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['agent-commands', agent?.id] }),
  })

  if (!agent) return null

  const assignments = assignmentsData?.assignments ?? []
  const mode: 'manual' | 'all' = agent.command_access_mode ?? 'manual'
  const activeProjectCommands = projectCommandsData?.commands.filter(c => c.active !== false && c.enabled) ?? []

  return (
    <div className="p-6 max-w-2xl space-y-6">
      <div>
        <h2 className="text-base font-semibold flex items-center gap-2">
          <Terminal className="h-4 w-4" />
          Agent Commands
        </h2>
        <p className="text-xs text-muted-foreground mt-1">
          Commands are slash-invokable prompts/actions the agent can run. Use <strong>manual</strong> to pick specific commands, or <strong>all</strong> to expose every active project command.
        </p>
      </div>

      <AccessModeControl
        agentId={agent.id}
        currentMode={mode}
        onChanged={() => queryClient.invalidateQueries({ queryKey: ['agents', project?.id] })}
      />

      {mode === 'all' && (
        <div className="space-y-2">
          <p className="text-xs text-muted-foreground">
            All active project commands are available to this agent.
          </p>
          <div className="space-y-2">
            {activeProjectCommands.length === 0 && (
              <div className="border border-dashed border-border/60 rounded-lg py-8 text-center">
                <Terminal className="h-6 w-6 mx-auto text-muted-foreground/50 mb-2" />
                <p className="text-xs text-muted-foreground">No active project commands.</p>
              </div>
            )}
            {activeProjectCommands.map(command => (
              <div
                key={command.id}
                className="flex items-center gap-3 px-3 py-2.5 border border-border/40 rounded-lg"
              >
                <span className="text-sm w-4 text-center shrink-0">{commandEmoji(command)}</span>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="font-mono text-xs bg-muted px-1.5 py-0.5 rounded">/{command.slug}</span>
                    <span className="font-medium text-sm truncate">{command.name}</span>
                  </div>
                  {command.description && (
                    <p className="text-xs text-muted-foreground truncate">{command.description}</p>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {mode === 'manual' && (
        <>
          <div className="space-y-2">
            {assignmentsLoading && (
              <p className="text-xs text-muted-foreground py-4 text-center">Loading...</p>
            )}

            {!assignmentsLoading && assignments.length === 0 && (
              <div className="border border-dashed border-border/60 rounded-lg py-8 text-center">
                <Terminal className="h-6 w-6 mx-auto text-muted-foreground/50 mb-2" />
                <p className="text-xs text-muted-foreground">No commands assigned yet.</p>
              </div>
            )}

            {assignments.map((assignment) => (
              <AssignmentRow
                key={assignment.id}
                assignment={assignment}
                onRemove={() => removeMutation.mutate(assignment.command_id)}
                isRemoving={removeMutation.isPending}
              />
            ))}
          </div>

          {availableCommands.length > 0 && (
            <div className="space-y-2">
              <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Add Command</p>
              <div className="grid gap-2">
                {availableCommands.map(command => (
                  <div
                    key={command.id}
                    className="flex items-center gap-3 px-3 py-2.5 border border-border/40 rounded-lg hover:bg-muted/30 transition-colors"
                  >
                    <span className="text-sm w-4 text-center shrink-0">{commandEmoji(command)}</span>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="font-mono text-xs bg-muted px-1.5 py-0.5 rounded">/{command.slug}</span>
                        <span className="font-medium text-sm truncate">{command.name}</span>
                      </div>
                      {command.description && (
                        <div className="text-xs text-muted-foreground break-words">{command.description}</div>
                      )}
                    </div>
                    <div className="flex items-center gap-1.5 shrink-0">
                      <Button
                        size="sm"
                        variant="outline"
                        className="h-7 text-xs gap-1"
                        onClick={() => assignMutation.mutate({ commandId: command.id })}
                        disabled={assignMutation.isPending}
                      >
                        <Plus className="h-3 w-3" />
                        Add
                      </Button>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {availableCommands.length === 0 && assignments.length > 0 && (
            <p className="text-xs text-muted-foreground">
              All project commands are assigned. Create more commands in the project commands settings.
            </p>
          )}

          {projectCommandsData?.commands.length === 0 && (
            <p className="text-xs text-muted-foreground">
              No commands in this project yet. Create commands from the project settings.
            </p>
          )}
        </>
      )}
    </div>
  )
}

function AssignmentRow({
  assignment,
  onRemove,
  isRemoving,
}: {
  assignment: AgentCommandAssignment
  onRemove: () => void
  isRemoving: boolean
}) {
  const { command, pinned } = assignment

  return (
    <div className="flex items-center gap-3 px-3 py-2.5 border border-border/40 rounded-lg">
      <span className="text-sm w-4 text-center shrink-0">{commandEmoji(command)}</span>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <span className="font-mono text-xs bg-muted px-1.5 py-0.5 rounded">/{command.slug}</span>
          <span className="font-medium text-sm truncate">{command.name}</span>
          {pinned && (
            <Badge
              variant="secondary"
              className={cn(
                'text-[10px] px-1.5 py-0 h-4 gap-1',
                'bg-amber-500/10 text-amber-600 dark:text-amber-400',
              )}
            >
              <Pin className="h-2.5 w-2.5" />
              pinned
            </Badge>
          )}
        </div>
        {command.description && (
          <p className="text-xs text-muted-foreground truncate">{command.description}</p>
        )}
      </div>
      <div className="flex items-center gap-1 shrink-0">
        <Button
          size="icon"
          variant="ghost"
          className="h-7 w-7 text-destructive hover:text-destructive"
          onClick={onRemove}
          disabled={isRemoving}
        >
          <Trash2 className="h-3.5 w-3.5" />
        </Button>
      </div>
    </div>
  )
}

function AccessModeControl({
  agentId,
  currentMode,
  onChanged,
}: {
  agentId: string
  currentMode: 'manual' | 'all'
  onChanged: () => void
}) {
  const [mode, setMode] = useState<'manual' | 'all'>(currentMode)
  const [busy, setBusy] = useState(false)

  const change = async (next: 'manual' | 'all') => {
    if (next === mode) return
    setBusy(true)
    try {
      await api.commands.setCommandAccessMode(agentId, next)
      setMode(next)
      toast.success(`Access mode: ${next === 'manual' ? 'Manual' : 'All'}`)
      onChanged()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to update')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="rounded-md border p-3 space-y-2">
      <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Access Mode</div>
      <div className="flex gap-2">
        <Button
          size="sm"
          variant={mode === 'manual' ? 'default' : 'outline'}
          onClick={() => change('manual')}
          disabled={busy}
        >
          Manual
        </Button>
        <Button
          size="sm"
          variant={mode === 'all' ? 'default' : 'outline'}
          onClick={() => change('all')}
          disabled={busy}
        >
          All
        </Button>
      </div>
      <p className="text-[10px] text-muted-foreground">
        {mode === 'manual'
          ? 'Agent sees only the commands explicitly assigned below.'
          : 'Agent sees every active command in the project.'}
      </p>
    </div>
  )
}
