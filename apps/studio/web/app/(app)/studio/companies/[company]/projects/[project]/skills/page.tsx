'use client'

import { use, useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { api } from '@/lib/api'
import type { SkillItem } from '@/lib/api'
import { Button, Badge, cn } from '@jiku/ui'
import { BookOpen, Plus, Trash2, Check, X, AlertCircle, Settings2, RefreshCw, Download } from 'lucide-react'
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
  const [importOpen, setImportOpen] = useState(false)

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
      <div className="w-64 shrink-0 border-r flex flex-col">
        <div className="px-3 py-3 border-b flex items-center justify-between">
          <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Skills</span>
          <div className="flex items-center gap-0.5">
            <Button
              size="icon"
              variant="ghost"
              className="h-6 w-6"
              title="Rescan /skills folder"
              onClick={async () => {
                if (!project?.id) return
                try {
                  const r = await api.skills.refresh(project.id)
                  toast.success(`Synced ${r.count} skill(s)`)
                  queryClient.invalidateQueries({ queryKey: ['project-skills', project.id] })
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
              title="Import from GitHub / ZIP"
              onClick={() => setImportOpen(true)}
            >
              <Download className="h-3.5 w-3.5" />
            </Button>
            <Button
              size="icon"
              variant="ghost"
              className="h-6 w-6"
              title="New skill"
              onClick={() => setCreatingSkill(true)}
            >
              <Plus className="h-3.5 w-3.5" />
            </Button>
          </div>
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
              {skill.source && skill.source !== 'fs' && (
                <Badge variant="outline" className="text-[9px] h-4 px-1 shrink-0" title={skill.source}>plugin</Badge>
              )}
              {!skill.enabled && (
                <Badge variant="outline" className="text-[9px] h-4 px-1 shrink-0">off</Badge>
              )}
              {skill.active === false && (
                <Badge variant="outline" className="text-[9px] h-4 px-1 shrink-0" title="Inactive source">inactive</Badge>
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

      {/* Plan 19 — Import dialog */}
      {importOpen && project?.id && (
        <ImportSkillDialog
          projectId={project.id}
          onClose={() => setImportOpen(false)}
          onImported={() => {
            setImportOpen(false)
            queryClient.invalidateQueries({ queryKey: ['project-skills', project.id] })
            queryClient.invalidateQueries({ queryKey: ['files', project.id] })
          }}
        />
      )}
    </div>
  )
}

// ──────────────────────────────────────────────────────────────
// Plan 19 — Import dialog (GitHub / ZIP)
// ──────────────────────────────────────────────────────────────

function ImportSkillDialog({
  projectId,
  onClose,
  onImported,
}: {
  projectId: string
  onClose: () => void
  onImported: () => void
}) {
  const [source, setSource] = useState<'github' | 'zip'>('github')
  const [pkg, setPkg] = useState('')
  const [zipFile, setZipFile] = useState<File | null>(null)
  const [overwrite, setOverwrite] = useState(false)
  const [busy, setBusy] = useState(false)

  const run = async () => {
    try {
      setBusy(true)
      if (source === 'github') {
        if (!pkg.trim()) { toast.error('Package is required'); return }
        const { result } = await api.skills.importFromGithub(projectId, { package: pkg.trim(), overwrite })
        toast.success(`Imported "${result.name}" (${result.files_count} files)`)
      } else {
        if (!zipFile) { toast.error('Choose a ZIP file'); return }
        const { result } = await api.skills.importFromZip(projectId, zipFile, overwrite)
        toast.success(`Imported "${result.name}" (${result.files_count} files)`)
      }
      onImported()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Import failed')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 bg-background/80 backdrop-blur-sm flex items-center justify-center p-4" onClick={onClose}>
      <div className="w-[480px] max-w-full bg-background border rounded-lg shadow-lg p-5 space-y-4" onClick={e => e.stopPropagation()}>
        <div>
          <h2 className="text-sm font-semibold">Import skill</h2>
          <p className="text-xs text-muted-foreground">From a public GitHub repo or a ZIP file</p>
        </div>

        <div className="flex gap-2 text-xs">
          <button
            onClick={() => setSource('github')}
            className={cn('flex-1 py-1.5 rounded border', source === 'github' ? 'bg-accent' : 'hover:bg-muted')}
          >GitHub</button>
          <button
            onClick={() => setSource('zip')}
            className={cn('flex-1 py-1.5 rounded border', source === 'zip' ? 'bg-accent' : 'hover:bg-muted')}
          >ZIP file</button>
        </div>

        {source === 'github' && (
          <div className="space-y-1">
            <label className="text-xs font-medium">Package</label>
            <input
              value={pkg}
              onChange={e => setPkg(e.target.value)}
              placeholder="owner/repo/subpath  or  https://skills.sh/owner/repo/subpath"
              className="w-full h-8 px-2 text-sm font-mono rounded border bg-background"
              autoFocus
            />
            <div className="text-[10px] text-muted-foreground space-y-0.5">
              <p>Format: <code>owner/repo/&lt;skill-name&gt;</code>. The importer looks up the skill
              across skills.sh standard locations (<code>skills/</code>, <code>skills/.curated/</code>,
              <code>.claude/skills/</code>, etc.).</p>
              <p>Examples:</p>
              <ul className="list-disc pl-4 space-y-0.5">
                <li><code>coreyhaines31/marketingskills/marketing-psychology</code></li>
                <li><code>https://skills.sh/coreyhaines31/marketingskills/marketing-psychology</code></li>
                <li><code>owner/repo</code> — for single-skill repos with root <code>SKILL.md</code></li>
                <li>Or paste the full command: <code>npx skills add https://github.com/owner/repo --skill &lt;name&gt;</code></li>
                <li>Append <code>@v1.2</code> or <code>@branch</code> for a specific ref</li>
              </ul>
            </div>
          </div>
        )}

        {source === 'zip' && (
          <div className="space-y-1">
            <label className="text-xs font-medium">ZIP file</label>
            <input
              type="file"
              accept=".zip,application/zip"
              onChange={e => setZipFile(e.target.files?.[0] ?? null)}
              className="w-full text-sm"
            />
            <p className="text-[10px] text-muted-foreground">Must contain SKILL.md at the root (or first subfolder)</p>
          </div>
        )}

        <label className="flex items-center gap-2 text-xs">
          <input type="checkbox" checked={overwrite} onChange={e => setOverwrite(e.target.checked)} />
          Overwrite existing skill with the same slug
        </label>

        <div className="flex justify-end gap-2">
          <Button variant="outline" size="sm" onClick={onClose} disabled={busy}>Cancel</Button>
          <Button size="sm" onClick={run} disabled={busy}>{busy ? 'Importing…' : 'Import'}</Button>
        </div>
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
