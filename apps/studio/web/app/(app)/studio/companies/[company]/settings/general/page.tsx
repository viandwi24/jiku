'use client'

import { use, useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useRouter } from 'next/navigation'
import { api } from '@/lib/api'
import { Button, Input, Label, Separator } from '@jiku/ui'
import { toast } from 'sonner'

interface PageProps {
  params: Promise<{ company: string }>
}

export default function CompanySettingsGeneralPage({ params }: PageProps) {
  const { company: companySlug } = use(params)
  const qc = useQueryClient()
  const router = useRouter()

  const { data: company } = useQuery({
    queryKey: ['companies'],
    queryFn: () => api.companies.list(),
    select: (d) => d.companies.find(c => c.slug === companySlug) ?? null,
  })

  const [name, setName] = useState('')
  const [slug, setSlug] = useState('')

  if (company && !name && !slug) {
    setName(company.name)
    setSlug(company.slug)
  }

  const updateMutation = useMutation({
    mutationFn: () => api.companies.update(companySlug, {
      name: name.trim() || undefined,
      slug: slug.trim() || undefined,
    }),
    onSuccess: (data) => {
      qc.invalidateQueries({ queryKey: ['companies'] })
      toast.success('Company updated')
      if (data.company.slug !== companySlug) {
        router.replace(`/studio/companies/${data.company.slug}/settings/general`)
      }
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : 'Failed to update'),
  })

  const deleteMutation = useMutation({
    mutationFn: () => api.companies.delete(companySlug),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['companies'] })
      toast.success('Company deleted')
      router.replace('/studio')
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : 'Failed to delete'),
  })

  return (
    <div className="space-y-6">
      <section className="space-y-4">
        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label htmlFor="company-name">Name</Label>
            <Input
              id="company-name"
              value={name}
              onChange={e => setName(e.target.value)}
              placeholder="Company name"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="company-slug">Slug</Label>
            <Input
              id="company-slug"
              value={slug}
              onChange={e => setSlug(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, '-'))}
              placeholder="company-slug"
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
            <p className="text-sm font-medium">Delete this company</p>
            <p className="text-xs text-muted-foreground">Permanently deletes this company and all its data. Cannot be undone.</p>
          </div>
          <Button
            variant="destructive"
            size="sm"
            onClick={() => {
              if (confirm(`Delete company "${company?.name}"? This cannot be undone.`)) {
                deleteMutation.mutate()
              }
            }}
            disabled={deleteMutation.isPending}
          >
            {deleteMutation.isPending ? 'Deleting...' : 'Delete Company'}
          </Button>
        </div>
      </section>
    </div>
  )
}
