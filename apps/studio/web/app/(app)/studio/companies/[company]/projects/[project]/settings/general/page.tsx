'use client'

import { use, useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useRouter } from 'next/navigation'
import { api } from '@/lib/api'
import { Button, Input, Label, Separator, Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@jiku/ui'
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
  const [timezone, setTimezone] = useState('')

  if (project && !name && !slug) {
    setName(project.name)
    setSlug(project.slug)
    setTimezone((project as { default_timezone?: string }).default_timezone ?? 'Asia/Jakarta')
  }

  // Full IANA list grouped by region for the dropdown.
  const timezoneGroups: Array<{ region: string; zones: string[] }> = (() => {
    type IntlExt = typeof Intl & { supportedValuesOf?: (k: string) => string[] }
    const intl = Intl as IntlExt
    const all = typeof intl.supportedValuesOf === 'function'
      ? intl.supportedValuesOf('timeZone')
      : ['UTC','Asia/Jakarta','Asia/Singapore','Asia/Tokyo','Asia/Kolkata','Europe/London','Europe/Berlin','America/New_York','America/Los_Angeles','America/Sao_Paulo','Australia/Sydney']
    const groups: Record<string, string[]> = {}
    for (const z of all) {
      const region = z.includes('/') ? z.split('/')[0]! : 'Other'
      if (!groups[region]) groups[region] = []
      groups[region].push(z)
    }
    return Object.entries(groups)
      .sort(([a], [b]) => {
        // Asia first (Jakarta-friendly), then alphabetical
        if (a === 'Asia') return -1
        if (b === 'Asia') return 1
        return a.localeCompare(b)
      })
      .map(([region, zones]) => ({ region, zones: zones.sort() }))
  })()

  const updateMutation = useMutation({
    mutationFn: () => api.projects.update(project!.id, {
      name: name.trim() || undefined,
      slug: slug.trim() || undefined,
      default_timezone: timezone || undefined,
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
          <div className="space-y-1.5">
            <Label htmlFor="proj-tz">Timezone</Label>
            <Select value={timezone} onValueChange={setTimezone}>
              <SelectTrigger id="proj-tz" className="font-mono">
                <SelectValue placeholder="Select timezone" />
              </SelectTrigger>
              <SelectContent className="max-h-80">
                {timezoneGroups.map(({ region, zones }) => (
                  <div key={region}>
                    <div className="px-2 py-1.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                      {region}
                    </div>
                    {zones.map(tz => (
                      <SelectItem key={tz} value={tz} className="font-mono text-xs">
                        {tz}
                      </SelectItem>
                    ))}
                  </div>
                ))}
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground">
              IANA timezone used as fallback when users mention local times without a zone.
              DB stays UTC; this only affects how agents interpret times.
            </p>
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
