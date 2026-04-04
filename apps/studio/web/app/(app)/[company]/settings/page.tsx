'use client'

import { use, useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { api } from '@/lib/api'
import { Button, Input, Label, Separator } from '@jiku/ui'
import { ArrowLeft, KeyRound } from 'lucide-react'
import { toast } from 'sonner'

interface PageProps {
  params: Promise<{ company: string }>
}

export default function CompanySettingsPage({ params }: PageProps) {
  const { company: companySlug } = use(params)
  const qc = useQueryClient()
  const router = useRouter()

  const { data: companyData } = useQuery({
    queryKey: ['company', companySlug],
    queryFn: async () => {
      const { companies } = await api.companies.list()
      return companies.find(c => c.slug === companySlug) ?? null
    },
  })

  const [name, setName] = useState('')
  const [slug, setSlug] = useState('')

  // Sync form when data loads
  const company = companyData
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
      qc.invalidateQueries({ queryKey: ['company', companySlug] })
      toast.success('Company updated')
      // If slug changed, redirect to new slug
      if (data.company.slug !== companySlug) {
        router.replace(`/${data.company.slug}/settings`)
      }
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : 'Failed to update'),
  })

  const deleteMutation = useMutation({
    mutationFn: () => api.companies.delete(companySlug),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['companies'] })
      toast.success('Company deleted')
      router.replace('/home')
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : 'Failed to delete'),
  })

  return (
    <div className="p-6 max-w-2xl mx-auto">
      <div className="flex items-center gap-3 mb-6">
        <Link href={`/${companySlug}`}>
          <Button variant="ghost" size="icon" className="h-8 w-8">
            <ArrowLeft className="w-4 h-4" />
          </Button>
        </Link>
        <div>
          <p className="text-xs text-muted-foreground">Company</p>
          <h1 className="text-xl font-bold">{company?.name ?? companySlug} — Settings</h1>
        </div>
      </div>

      {/* General */}
      <section className="space-y-4">
        <h2 className="text-sm font-semibold">General</h2>
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

      <Separator className="my-6" />

      {/* Sub-sections */}
      <section className="space-y-2">
        <h2 className="text-sm font-semibold mb-3">Settings</h2>
        <Link href={`/${companySlug}/settings/credentials`} className="flex items-center gap-3 p-4 rounded-lg border hover:bg-muted/50 transition-colors">
          <KeyRound className="w-5 h-5 text-muted-foreground" />
          <div>
            <p className="font-medium text-sm">Credentials</p>
            <p className="text-xs text-muted-foreground">Manage API keys and provider credentials shared across projects</p>
          </div>
        </Link>
      </section>

      <Separator className="my-6" />

      {/* Danger zone */}
      <section className="space-y-3">
        <h2 className="text-sm font-semibold text-destructive">Danger Zone</h2>
        <div className="rounded-lg border border-destructive/40 p-4 flex items-center justify-between gap-4">
          <div>
            <p className="text-sm font-medium">Delete this company</p>
            <p className="text-xs text-muted-foreground">Permanently delete this company and all its projects and agents. This cannot be undone.</p>
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
