'use client'

import { use, useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { api } from '@/lib/api'
import type { AgentSkillAssignment, SkillItem } from '@/lib/api'
import { Button, Badge, cn } from '@jiku/ui'
import { BookOpen, Plus, Trash2, ToggleLeft, ToggleRight, Zap, Clock } from 'lucide-react'

interface PageProps {
  params: Promise<{ company: string; project: string; agent: string }>
}

export default function AgentSkillsPage({ params }: PageProps) {
  const { company: companySlug, project: projectSlug, agent: agentSlug } = use(params)
  const queryClient = useQueryClient()
  const [addingSkillId, setAddingSkillId] = useState<string | null>(null)

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
    queryKey: ['agent-skills', agent?.id],
    queryFn: () => api.skills.listAgentSkills(agent!.id),
    enabled: !!agent?.id,
  })

  const { data: projectSkillsData } = useQuery({
    queryKey: ['project-skills', project?.id],
    queryFn: () => api.skills.list(project!.id),
    enabled: !!project?.id,
  })

  const assignedSkillIds = new Set(assignmentsData?.assignments.map(a => a.skill_id) ?? [])
  const availableSkills = projectSkillsData?.skills.filter(s => !assignedSkillIds.has(s.id)) ?? []

  const assignMutation = useMutation({
    mutationFn: ({ skillId, mode }: { skillId: string; mode: 'always' | 'on_demand' }) =>
      api.skills.assignSkill(agent!.id, { skill_id: skillId, mode }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['agent-skills', agent?.id] })
      setAddingSkillId(null)
    },
  })

  const toggleModeMutation = useMutation({
    mutationFn: ({ skillId, currentMode }: { skillId: string; currentMode: 'always' | 'on_demand' }) =>
      api.skills.updateAssignment(agent!.id, skillId, currentMode === 'always' ? 'on_demand' : 'always'),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['agent-skills', agent?.id] }),
  })

  const removeMutation = useMutation({
    mutationFn: (skillId: string) => api.skills.removeSkill(agent!.id, skillId),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['agent-skills', agent?.id] }),
  })

  if (!agent) return null

  const assignments = assignmentsData?.assignments ?? []

  return (
    <div className="p-6 max-w-2xl space-y-6">
      <div>
        <h2 className="text-base font-semibold flex items-center gap-2">
          <BookOpen className="h-4 w-4" />
          Agent Skills
        </h2>
        <p className="text-xs text-muted-foreground mt-1">
          Skills inject specialized knowledge or instructions into this agent. Use <strong>always</strong> to inject on every run, or <strong>on-demand</strong> so the agent loads them when needed.
        </p>
      </div>

      {/* Assigned skills */}
      <div className="space-y-2">
        {assignmentsLoading && (
          <p className="text-xs text-muted-foreground py-4 text-center">Loading...</p>
        )}

        {!assignmentsLoading && assignments.length === 0 && (
          <div className="border border-dashed border-border/60 rounded-lg py-8 text-center">
            <BookOpen className="h-6 w-6 mx-auto text-muted-foreground/50 mb-2" />
            <p className="text-xs text-muted-foreground">No skills assigned yet.</p>
          </div>
        )}

        {assignments.map((assignment) => (
          <AssignmentRow
            key={assignment.id}
            assignment={assignment}
            onToggleMode={() => toggleModeMutation.mutate({ skillId: assignment.skill_id, currentMode: assignment.mode })}
            onRemove={() => removeMutation.mutate(assignment.skill_id)}
            isToggling={toggleModeMutation.isPending}
            isRemoving={removeMutation.isPending}
          />
        ))}
      </div>

      {/* Add skill section */}
      {availableSkills.length > 0 && (
        <div className="space-y-2">
          <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Add Skill</p>
          <div className="grid gap-2">
            {availableSkills.map(skill => (
              <div
                key={skill.id}
                className="flex items-center gap-3 px-3 py-2.5 border border-border/40 rounded-lg hover:bg-muted/30 transition-colors"
              >
                <div className="flex-1 min-w-0">
                  <div className="font-medium text-sm">{skill.name}</div>
                  {skill.description && (
                    <div className="text-xs text-muted-foreground truncate">{skill.description}</div>
                  )}
                </div>
                <div className="flex items-center gap-1.5 shrink-0">
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-7 text-xs gap-1"
                    onClick={() => assignMutation.mutate({ skillId: skill.id, mode: 'on_demand' })}
                    disabled={assignMutation.isPending}
                  >
                    <Clock className="h-3 w-3" />
                    On-demand
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-7 text-xs gap-1"
                    onClick={() => assignMutation.mutate({ skillId: skill.id, mode: 'always' })}
                    disabled={assignMutation.isPending}
                  >
                    <Zap className="h-3 w-3" />
                    Always
                  </Button>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {availableSkills.length === 0 && assignments.length > 0 && (
        <p className="text-xs text-muted-foreground">
          All project skills are assigned. Create more skills in the project skills settings.
        </p>
      )}

      {projectSkillsData?.skills.length === 0 && (
        <p className="text-xs text-muted-foreground">
          No skills in this project yet. Create skills from the project settings.
        </p>
      )}
    </div>
  )
}

function AssignmentRow({
  assignment,
  onToggleMode,
  onRemove,
  isToggling,
  isRemoving,
}: {
  assignment: AgentSkillAssignment
  onToggleMode: () => void
  onRemove: () => void
  isToggling: boolean
  isRemoving: boolean
}) {
  const { skill, mode } = assignment

  return (
    <div className="flex items-center gap-3 px-3 py-2.5 border border-border/40 rounded-lg">
      <BookOpen className="h-4 w-4 shrink-0 text-muted-foreground" />
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <span className="font-medium text-sm">{skill.name}</span>
          <Badge
            variant="secondary"
            className={cn(
              'text-[10px] px-1.5 py-0 h-4',
              mode === 'always'
                ? 'bg-amber-500/10 text-amber-600 dark:text-amber-400'
                : 'bg-blue-500/10 text-blue-600 dark:text-blue-400',
            )}
          >
            {mode === 'always' ? 'always' : 'on-demand'}
          </Badge>
        </div>
        {skill.description && (
          <p className="text-xs text-muted-foreground truncate">{skill.description}</p>
        )}
      </div>
      <div className="flex items-center gap-1 shrink-0">
        <Button
          size="icon"
          variant="ghost"
          className="h-7 w-7"
          title={mode === 'always' ? 'Switch to on-demand' : 'Switch to always'}
          onClick={onToggleMode}
          disabled={isToggling}
        >
          {mode === 'always' ? (
            <ToggleRight className="h-4 w-4 text-amber-500" />
          ) : (
            <ToggleLeft className="h-4 w-4 text-muted-foreground" />
          )}
        </Button>
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
