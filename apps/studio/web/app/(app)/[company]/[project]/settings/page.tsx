'use client'

import { use, useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { api } from '@/lib/api'
import { Button, Input, Label, Separator } from '@jiku/ui'
import { ArrowLeft, KeyRound, ShieldCheck } from 'lucide-react'
import { toast } from 'sonner'

interface PageProps {
  params: Promise<{ company: string; project: string }>
}

export default function ProjectSettingsPage({ params }: PageProps) {
  const { company: companySlug, project: projectSlug } = use(params)
  const qc = useQueryClient()
  const router = useRouter()

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
        router.replace(`/${companySlug}/${data.project.slug}/settings`)
      }
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : 'Failed to update'),
  })

  const deleteMutation = useMutation({
    mutationFn: () => api.projects.delete(companyData!.id, project!.id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['projects', companyData?.id] })
      toast.success('Project deleted')
      router.replace(`/${companySlug}`)
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : 'Failed to delete'),
  })

  const base = `/${companySlug}/${projectSlug}`

  return (
    <div className="p-6 max-w-2xl mx-auto">
      <div className="flex items-center gap-3 mb-6">
        <Link href={base}>
          <Button variant="ghost" size="icon" className="h-8 w-8">
            <ArrowLeft className="w-4 h-4" />
          </Button>
        </Link>
        <div>
          <p className="text-xs text-muted-foreground">{companyData?.name} / {project?.name}</p>
          <h1 className="text-xl font-bold">Project Settings</h1>
        </div>
      </div>

      {/* General */}
      <section className="space-y-4">
        <h2 className="text-sm font-semibold">General</h2>
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
          disabled={updateMutation.isPending || !project}
          size="sm"
        >
          {updateMutation.isPending ? 'Saving...' : 'Save Changes'}
        </Button>
      </section>

      <Separator className="my-6" />

      {/* Sub-sections */}
      <section className="space-y-2">
        <h2 className="text-sm font-semibold mb-3">Settings</h2>
        <Link href={`${base}/settings/credentials`} className="flex items-center gap-3 p-4 rounded-lg border hover:bg-muted/50 transition-colors">
          <KeyRound className="w-5 h-5 text-muted-foreground" />
          <div>
            <p className="font-medium text-sm">Credentials</p>
            <p className="text-xs text-muted-foreground">Project-scoped credentials and inherited company credentials</p>
          </div>
        </Link>
        <Link href={`${base}/settings/permissions`} className="flex items-center gap-3 p-4 rounded-lg border hover:bg-muted/50 transition-colors">
          <ShieldCheck className="w-5 h-5 text-muted-foreground" />
          <div>
            <p className="font-medium text-sm">Permissions</p>
            <p className="text-xs text-muted-foreground">Manage project-level access and member permissions</p>
          </div>
        </Link>
      </section>

      <Separator className="my-6" />

      {/* Danger zone */}
      <section className="space-y-3">
        <h2 className="text-sm font-semibold text-destructive">Danger Zone</h2>
        <div className="rounded-lg border border-destructive/40 p-4 flex items-center justify-between gap-4">
          <div>
            <p className="text-sm font-medium">Delete this project</p>
            <p className="text-xs text-muted-foreground">Permanently delete this project and all its agents. This cannot be undone.</p>
          </div>
          <Button
            variant="destructive"
            size="sm"
            onClick={() => {
              if (confirm(`Delete project "${project?.name}"? This cannot be undone.`)) {
                deleteMutation.mutate()
              }
            }}
            disabled={deleteMutation.isPending || !project || !companyData}
          >
            {deleteMutation.isPending ? 'Deleting...' : 'Delete Project'}
          </Button>
        </div>
      </section>
    </div>
  )
}
