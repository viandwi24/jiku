'use client'

import { use, useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { api } from '@/lib/api'
import type { SkillItem } from '@/lib/api'
import { Button, Badge, cn } from '@jiku/ui'
import { BookOpen, Plus, Trash2, Check, X, AlertCircle, Settings2 } from 'lucide-react'
import { FileExplorer } from '@/components/filesystem/file-explorer'
import { toast } from 'sonner'

interface PageProps {
  params: Promise<{ company: string; project: string }>
}

export default function ProjectSkillsPage({ params }: PageProps) {
  const { company: companySlug, project: projectSlug } = use(params)
  const queryClient = useQueryClient()
  const [selectedSkillId, setSelectedSkillId] = useState<string | null>(null)
  const [creatingSkill, setCreatingSkill] = useState(false)
  const [newSkillName, setNewSkillName] = useState('')

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

  const { data: skillsData, isLoading } = useQuery({
    queryKey: ['project-skills', project?.id],
    queryFn: () => api.skills.list(project!.id),
    enabled: !!project?.id,
  })

  const { data: configData } = useQuery({
    queryKey: ['filesystem-config', project?.id],
    queryFn: () => api.filesystem.getConfig(project!.id),
    enabled: !!project?.id,
  })

  const createSkillMutation = useMutation({
    mutationFn: (name: string) => api.skills.create(project!.id, { name }),
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ['project-skills', project?.id] })
      queryClient.invalidateQueries({ queryKey: ['files', project?.id] })
      setSelectedSkillId(data.skill.id)
      setCreatingSkill(false)
      setNewSkillName('')
      toast.success(`Skill "${data.skill.name}" created`)
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : 'Failed to create skill'),
  })

  const deleteSkillMutation = useMutation({
    mutationFn: (skillId: string) => api.skills.delete(skillId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['project-skills', project?.id] })
      queryClient.invalidateQueries({ queryKey: ['files', project?.id] })
      setSelectedSkillId(null)
      toast.success('Skill deleted')
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : 'Failed to delete skill'),
  })

  const skills = skillsData?.skills ?? []
  const selectedSkill = skills.find(s => s.id === selectedSkillId) ?? null
  const isFilesystemConfigured = configData?.config?.enabled

  return (
    <div className="flex h-full overflow-hidden">
      {/* ── Skill list panel ── */}
      <div className="w-56 shrink-0 border-r flex flex-col">
        <div className="px-3 py-3 border-b flex items-center justify-between">
          <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Skills</span>
          <Button
            size="icon"
            variant="ghost"
            className="h-6 w-6"
            onClick={() => setCreatingSkill(true)}
          >
            <Plus className="h-3.5 w-3.5" />
          </Button>
        </div>

        <div className="flex-1 overflow-auto py-1.5">
          {isLoading && (
            <p className="text-xs text-muted-foreground px-3 py-2">Loading...</p>
          )}

          {!isLoading && skills.length === 0 && !creatingSkill && (
            <div className="px-3 py-4 text-center">
              <BookOpen className="h-5 w-5 mx-auto text-muted-foreground/50 mb-1.5" />
              <p className="text-xs text-muted-foreground">No skills yet</p>
            </div>
          )}

          {skills.map(skill => (
            <button
              key={skill.id}
              onClick={() => setSelectedSkillId(skill.id)}
              className={cn(
                'w-full text-left px-3 py-2 flex items-center gap-2 text-sm transition-colors',
                selectedSkillId === skill.id
                  ? 'bg-accent text-accent-foreground'
                  : 'hover:bg-muted/40 text-muted-foreground hover:text-foreground',
              )}
            >
              <BookOpen className="h-3.5 w-3.5 shrink-0" />
              <span className="truncate flex-1">{skill.name}</span>
              {!skill.enabled && (
                <Badge variant="outline" className="text-[9px] h-4 px-1 shrink-0">off</Badge>
              )}
            </button>
          ))}

          {creatingSkill && (
            <div className="px-2 py-1.5 flex items-center gap-1">
              <input
                autoFocus
                value={newSkillName}
                onChange={e => setNewSkillName(e.target.value)}
                placeholder="Skill name"
                className="flex-1 h-7 text-xs px-2 rounded border bg-background outline-none focus:ring-1 ring-ring"
                onKeyDown={e => {
                  if (e.key === 'Enter' && newSkillName.trim()) {
                    createSkillMutation.mutate(newSkillName.trim())
                  } else if (e.key === 'Escape') {
                    setCreatingSkill(false)
                    setNewSkillName('')
                  }
                }}
              />
              <Button
                size="icon"
                variant="ghost"
                className="h-7 w-7 shrink-0"
                disabled={!newSkillName.trim() || createSkillMutation.isPending}
                onClick={() => createSkillMutation.mutate(newSkillName.trim())}
              >
                <Check className="h-3.5 w-3.5" />
              </Button>
              <Button
                size="icon"
                variant="ghost"
                className="h-7 w-7 shrink-0"
                onClick={() => { setCreatingSkill(false); setNewSkillName('') }}
              >
                <X className="h-3.5 w-3.5" />
              </Button>
            </div>
          )}
        </div>
      </div>

      {/* ── Main panel ── */}
      <div className="flex-1 flex flex-col overflow-hidden">
        {!selectedSkill && (
          <div className="flex items-center justify-center h-full text-center">
            <div>
              <BookOpen className="h-8 w-8 mx-auto text-muted-foreground/40 mb-3" />
              <p className="text-sm text-muted-foreground">Select a skill to edit its files</p>
              <p className="text-xs text-muted-foreground/70 mt-1">or click + to create one</p>
            </div>
          </div>
        )}

        {selectedSkill && !isFilesystemConfigured && (
          <div className="flex items-center justify-center h-full p-8">
            <div className="max-w-sm text-center space-y-3">
              <AlertCircle className="w-8 h-8 text-muted-foreground mx-auto" />
              <h2 className="font-semibold text-sm">Virtual Disk not configured</h2>
              <p className="text-sm text-muted-foreground">
                Skills are stored on the project filesystem. Configure S3-compatible storage in
                the <strong>Disk</strong> page to create and edit skill files.
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

        {selectedSkill && isFilesystemConfigured && project?.id && (
          <SkillFileEditor
            skill={selectedSkill}
            projectId={project.id}
            onDelete={() => {
              if (!confirm(`Delete skill "${selectedSkill.name}" and all its files?`)) return
              deleteSkillMutation.mutate(selectedSkill.id)
            }}
          />
        )}
      </div>
    </div>
  )
}

function SkillFileEditor({
  skill,
  projectId,
  onDelete,
}: {
  skill: SkillItem
  projectId: string
  onDelete: () => void
}) {
  return (
    <div className="flex flex-col flex-1 overflow-hidden">
      {/* Header */}
      <div className="flex items-center gap-3 px-4 py-2.5 border-b shrink-0">
        <BookOpen className="w-4 h-4 text-muted-foreground" />
        <div className="flex-1 min-w-0">
          <p className="text-sm font-medium truncate">{skill.name}</p>
          {skill.description && (
            <p className="text-xs text-muted-foreground truncate">{skill.description}</p>
          )}
        </div>
        <div className="flex items-center gap-2 shrink-0 text-xs text-muted-foreground">
          <span className="font-mono bg-muted px-1.5 py-0.5 rounded">{skill.slug}</span>
          <span>·</span>
          <span>entry: <span className="font-mono">{skill.entrypoint}</span></span>
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

      {/* FileExplorer scoped to /skills/{slug}/ — key resets all state when skill changes */}
      <FileExplorer
        key={skill.id}
        projectId={projectId}
        rootPath={`/skills/${skill.slug}`}
        hideUpload
      />
    </div>
  )
}
