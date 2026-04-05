'use client'

import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Check, Puzzle, Search } from 'lucide-react'
import { toast } from 'sonner'
import { api, type PluginItem } from '@/lib/api'
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardFooter,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  Input,
} from '@jiku/ui'
import { PluginConfigForm } from './plugin-config-form'

interface MarketplaceProps {
  projectId: string
}

const CATEGORIES = [
  { id: 'all', label: 'All' },
  { id: 'productivity', label: 'Productivity' },
  { id: 'communication', label: 'Communication' },
  { id: 'finance', label: 'Finance' },
  { id: 'tools', label: 'Tools' },
]

export function Marketplace({ projectId }: MarketplaceProps) {
  const [search, setSearch] = useState('')
  const [category, setCategory] = useState('all')

  const { data: allPluginsData } = useQuery({
    queryKey: ['plugins'],
    queryFn: () => api.plugins.list(),
  })

  const { data: projectData } = useQuery({
    queryKey: ['project-plugins', projectId],
    queryFn: () => api.plugins.listProject(projectId),
  })

  const activeIds = new Set((projectData?.plugins ?? []).filter(p => p.enabled).map(p => p.id))

  const filtered = (allPluginsData?.plugins ?? []).filter(p =>
    p.project_scope &&
    (category === 'all' || p.category === category) &&
    (
      p.name.toLowerCase().includes(search.toLowerCase()) ||
      (p.description ?? '').toLowerCase().includes(search.toLowerCase())
    )
  )

  return (
    <div className="p-6 space-y-4">
      {/* Search */}
      <div className="relative">
        <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
        <Input
          placeholder="Search plugins..."
          className="pl-9"
          value={search}
          onChange={e => setSearch(e.target.value)}
        />
      </div>

      {/* Category filter */}
      <div className="flex gap-2 flex-wrap">
        {CATEGORIES.map(cat => (
          <Button
            key={cat.id}
            variant={category === cat.id ? 'default' : 'outline'}
            size="sm"
            onClick={() => setCategory(cat.id)}
          >
            {cat.label}
          </Button>
        ))}
      </div>

      {/* Plugin grid */}
      {filtered.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-16 gap-3 text-center">
          <Puzzle className="h-10 w-10 text-muted-foreground/40" />
          <p className="text-sm text-muted-foreground">No plugins found</p>
        </div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {filtered.map(plugin => (
            <MarketplaceCard
              key={plugin.id}
              plugin={plugin}
              isActive={activeIds.has(plugin.id)}
              projectId={projectId}
            />
          ))}
        </div>
      )}
    </div>
  )
}

interface MarketplaceCardProps {
  plugin: PluginItem
  isActive: boolean
  projectId: string
}

function MarketplaceCard({ plugin, isActive, projectId }: MarketplaceCardProps) {
  const qc = useQueryClient()
  const [dialogOpen, setDialogOpen] = useState(false)

  const schema = plugin.config_schema as { properties?: Record<string, unknown>; required?: string[] } | null
  const hasRequiredConfig = !!(schema?.required && schema.required.length > 0)

  const enableMutation = useMutation({
    mutationFn: (config: Record<string, unknown>) => api.plugins.enable(projectId, plugin.id, config),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['project-plugins', projectId] })
      toast.success(`${plugin.name} activated`)
      setDialogOpen(false)
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : 'Failed to activate'),
  })

  function handleActivate() {
    if (hasRequiredConfig) {
      setDialogOpen(true)
    } else {
      enableMutation.mutate({})
    }
  }

  return (
    <>
      <Card className="flex flex-col">
        <CardContent className="pt-5 flex-1">
          <div className="flex items-start gap-3 mb-3">
            <div className="h-9 w-9 rounded-lg bg-muted flex items-center justify-center shrink-0">
              <Puzzle className="h-4 w-4 text-muted-foreground" />
            </div>
            <div className="min-w-0">
              <h3 className="font-medium text-sm truncate">{plugin.name}</h3>
              <p className="text-xs text-muted-foreground">
                {[plugin.author && `by ${plugin.author}`, `v${plugin.version}`].filter(Boolean).join(' · ')}
              </p>
            </div>
          </div>
          <p className="text-xs text-muted-foreground line-clamp-3">{plugin.description}</p>
          {plugin.category && (
            <Badge variant="secondary" className="mt-3 text-xs">{plugin.category}</Badge>
          )}
        </CardContent>
        <CardFooter className="pt-0">
          {isActive ? (
            <div className="flex items-center gap-1.5 text-xs text-green-600 w-full">
              <Check className="h-3.5 w-3.5" />
              Active
            </div>
          ) : (
            <Button
              size="sm"
              className="w-full"
              onClick={handleActivate}
              disabled={enableMutation.isPending}
            >
              {enableMutation.isPending ? 'Activating...' : 'Activate'}
            </Button>
          )}
        </CardFooter>
      </Card>

      {/* Config dialog for plugins with required fields */}
      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Activate {plugin.name}</DialogTitle>
            <DialogDescription>
              Configure this plugin for your project before activating.
            </DialogDescription>
          </DialogHeader>
          <PluginConfigForm
            schema={plugin.config_schema as Parameters<typeof PluginConfigForm>[0]['schema']}
            defaultValues={{}}
            onSubmit={(config) => enableMutation.mutate(config)}
            submitLabel="Activate Plugin"
            isSubmitting={enableMutation.isPending}
          />
        </DialogContent>
      </Dialog>
    </>
  )
}
