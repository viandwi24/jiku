'use client'

import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Puzzle, X } from 'lucide-react'
import { toast } from 'sonner'
import { api, type PluginItem } from '@/lib/api'
import {
  Badge,
  Button,
  ScrollArea,
  Separator,
  cn,
} from '@jiku/ui'
import { PluginConfigForm } from './plugin-config-form'

interface ActivePluginsProps {
  projectId: string
}

export function ActivePlugins({ projectId }: ActivePluginsProps) {
  const qc = useQueryClient()

  const { data, isLoading } = useQuery({
    queryKey: ['project-plugins', projectId],
    queryFn: () => api.plugins.listProject(projectId),
  })

  const activePlugins = (data?.plugins ?? []).filter(p => p.enabled)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const selected = activePlugins.find(p => p.id === selectedId) ?? activePlugins[0] ?? null

  const disableMutation = useMutation({
    mutationFn: (pluginId: string) => api.plugins.disable(projectId, pluginId),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['project-plugins', projectId] })
      toast.success('Plugin disabled')
      setSelectedId(null)
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : 'Failed to disable'),
  })

  const configMutation = useMutation({
    mutationFn: ({ pluginId, config }: { pluginId: string; config: Record<string, unknown> }) =>
      api.plugins.updateConfig(projectId, pluginId, config),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['project-plugins', projectId] })
      toast.success('Configuration saved')
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : 'Failed to save'),
  })

  if (isLoading) {
    return <div className="flex items-center justify-center h-full text-sm text-muted-foreground">Loading...</div>
  }

  if (activePlugins.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center h-full gap-3 text-center p-8">
        <Puzzle className="h-10 w-10 text-muted-foreground/40" />
        <div>
          <p className="text-sm font-medium">No active plugins</p>
          <p className="text-xs text-muted-foreground mt-1">Go to the Marketplace tab to activate plugins for this project.</p>
        </div>
      </div>
    )
  }

  return (
    <div className="flex h-full">
      {/* Left — plugin list */}
      <div className="w-56 shrink-0 border-r flex flex-col">
        <ScrollArea className="flex-1">
          {activePlugins.map(plugin => (
            <button
              key={plugin.id}
              onClick={() => setSelectedId(plugin.id)}
              className={cn(
                'w-full flex items-center gap-2.5 px-3 py-2.5 text-left border-b border-border/40',
                'hover:bg-muted/50 transition-colors',
                (selected?.id === plugin.id) && 'bg-muted border-l-2 border-l-primary',
              )}
            >
              <div className="h-2 w-2 rounded-full shrink-0 bg-green-500" />
              <div className="min-w-0">
                <p className="text-sm font-medium truncate">{plugin.name}</p>
                <p className="text-xs text-muted-foreground truncate">{plugin.id} v{plugin.version}</p>
              </div>
            </button>
          ))}
        </ScrollArea>
      </div>

      {/* Right — plugin detail */}
      <div className="flex-1 min-w-0 overflow-auto">
        {selected && (
          <PluginDetail
            plugin={selected}
            onDisable={() => disableMutation.mutate(selected.id)}
            isDisabling={disableMutation.isPending}
            onSaveConfig={(config) => configMutation.mutate({ pluginId: selected.id, config })}
            isSavingConfig={configMutation.isPending}
          />
        )}
      </div>
    </div>
  )
}

interface PluginDetailProps {
  plugin: PluginItem
  onDisable: () => void
  isDisabling: boolean
  onSaveConfig: (config: Record<string, unknown>) => void
  isSavingConfig: boolean
}

function PluginDetail({ plugin, onDisable, isDisabling, onSaveConfig, isSavingConfig }: PluginDetailProps) {
  const schema = plugin.config_schema as { properties?: Record<string, unknown> } | null
  const hasConfig = schema && Object.keys(schema.properties ?? {}).length > 0

  return (
    <div className="p-6 space-y-6">
      {/* Header */}
      <div className="flex items-start gap-3">
        <div className="h-10 w-10 rounded-lg bg-muted flex items-center justify-center shrink-0">
          <Puzzle className="h-5 w-5 text-muted-foreground" />
        </div>
        <div className="flex-1 min-w-0">
          <h2 className="font-semibold text-lg">{plugin.name}</h2>
          <p className="text-sm text-muted-foreground">
            {[plugin.author && `by ${plugin.author}`, `v${plugin.version}`, plugin.category].filter(Boolean).join(' · ')}
          </p>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {!plugin.project_scope && (
            <Badge variant="secondary" className="text-xs">System</Badge>
          )}
          <Badge variant="outline" className="text-green-600 border-green-300">Active</Badge>
        </div>
      </div>

      {plugin.description && (
        <p className="text-sm text-muted-foreground">{plugin.description}</p>
      )}

      {hasConfig && (
        <>
          <Separator />
          <div>
            <h3 className="font-medium mb-4 text-sm">Configuration</h3>
            <PluginConfigForm
              schema={plugin.config_schema as Parameters<typeof PluginConfigForm>[0]['schema']}
              defaultValues={(plugin.config ?? {}) as Record<string, unknown>}
              onSubmit={onSaveConfig}
              isSubmitting={isSavingConfig}
            />
          </div>
        </>
      )}

      {plugin.project_scope && (
        <>
          <Separator />
          <div className="flex justify-end">
            <Button
              variant="outline"
              size="sm"
              className="text-destructive border-destructive/30 hover:bg-destructive/5"
              onClick={onDisable}
              disabled={isDisabling}
            >
              <X className="h-4 w-4 mr-2" />
              {isDisabling ? 'Disabling...' : 'Disable Plugin'}
            </Button>
          </div>
        </>
      )}
    </div>
  )
}
