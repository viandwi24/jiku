'use client'

import { use, useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useRouter } from 'next/navigation'
import { api } from '@/lib/api'
import { Button, Input, Label, Separator } from '@jiku/ui'
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger } from '@jiku/ui/components/ui/alert-dialog.tsx'
import { toast } from 'sonner'

interface PageProps {
  params: Promise<{ company: string; project: string }>
}

export default function ProjectSettingsGeneralPage({ params }: PageProps) {
  const { company: companySlug, project: projectSlug } = use(params)
  const qc = useQueryClient()
  const router = useRouter()

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

  const [name, setName] = useState('')
  const [slug, setSlug] = useState('')

  if (project && !name && !slug) {
    setName(project.name)
    setSlug(project.slug)
  }

  const updateMutation = useMutation({
    mutationFn: () => api.projects.update(project!.id, {
      name: name.trim() || undefined,
      slug: slug.trim() || undefined,
    }),
    onSuccess: (data) => {
      qc.invalidateQueries({ queryKey: ['projects', companyData?.id] })
      toast.success('Project updated')
      if (data.project.slug !== projectSlug) {
        router.replace(`/studio/companies/${companySlug}/projects/${data.project.slug}/settings/general`)
      }
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : 'Failed to update'),
  })

  const deleteMutation = useMutation({
    mutationFn: () => api.projects.delete(companyData!.id, project!.id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['projects', companyData?.id] })
      toast.success('Project deleted')
      router.replace(`/studio/companies/${companySlug}`)
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : 'Failed to delete'),
  })

  return (
    <div className="space-y-6">
      <section className="space-y-4">
        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label htmlFor="proj-name">Name</Label>
            <Input
              id="proj-name"
              value={name}
              onChange={e => setName(e.target.value)}
              placeholder="Project name"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="proj-slug">Slug</Label>
            <Input
              id="proj-slug"
              value={slug}
              onChange={e => setSlug(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, '-'))}
              placeholder="project-slug"
              className="font-mono"
            />
            <p className="text-xs text-muted-foreground">Used in URLs. Changing this will break existing links.</p>
          </div>
        </div>
        <Button
          onClick={() => updateMutation.mutate()}
          disabled={updateMutation.isPending || (!name.trim() && !slug.trim())}
          size="sm"
        >
          {updateMutation.isPending ? 'Saving...' : 'Save Changes'}
        </Button>
      </section>

      <Separator />

      <section className="space-y-3">
        <h2 className="text-sm font-semibold text-destructive">Danger Zone</h2>
        <div className="rounded-lg border border-destructive/40 p-4 flex items-center justify-between gap-4">
          <div>
            <p className="text-sm font-medium">Delete this project</p>
            <p className="text-xs text-muted-foreground">Permanently deletes this project and all its agents. Cannot be undone.</p>
          </div>
          <AlertDialog>
            <AlertDialogTrigger asChild>
              <Button
                variant="destructive"
                size="sm"
                disabled={deleteMutation.isPending || !project || !companyData}
              >
                {deleteMutation.isPending ? 'Deleting...' : 'Delete Project'}
              </Button>
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>Delete project &ldquo;{project?.name}&rdquo;?</AlertDialogTitle>
              </AlertDialogHeader>
              <AlertDialogDescription>
                This will permanently delete the project and all its agents. This action cannot be undone.
              </AlertDialogDescription>
              <AlertDialogFooter>
                <AlertDialogCancel>Cancel</AlertDialogCancel>
                <AlertDialogAction
                  onClick={() => deleteMutation.mutate()}
                  className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                >
                  Delete Project
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </div>
      </section>
    </div>
  )
}
