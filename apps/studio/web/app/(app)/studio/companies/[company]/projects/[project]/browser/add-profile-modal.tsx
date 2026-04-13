'use client'

import { useState, useEffect } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { api } from '@/lib/api'
import type { BrowserAdapterInfo } from '@/lib/api'
import {
  Button,
  Input,
  Label,
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
  RadioGroup,
  RadioGroupItem,
  Switch,
} from '@jiku/ui'
import { toast } from 'sonner'
import { ConfigField, initialConfigFor } from './config-field'

interface Props {
  projectId: string
  open: boolean
  onOpenChange: (open: boolean) => void
}

export function AddProfileModal({ projectId, open, onOpenChange }: Props) {
  const qc = useQueryClient()
  const { data: adaptersData } = useQuery({
    queryKey: ['browser-adapters', projectId],
    queryFn: () => api.browser.listAdapters(projectId),
    enabled: open && !!projectId,
  })
  const adapters: BrowserAdapterInfo[] = adaptersData?.adapters ?? []

  const [name, setName] = useState('')
  const [adapterId, setAdapterId] = useState<string>('')
  const [cfg, setCfg] = useState<Record<string, unknown>>({})
  const [isDefault, setIsDefault] = useState(false)

  // Default pick to first adapter once loaded.
  useEffect(() => {
    if (open && adapters.length > 0 && !adapterId) {
      setAdapterId(adapters[0]!.id)
    }
  }, [open, adapters, adapterId])

  // Prefill config with the selected adapter's declared defaults, so the
  // user sees meaningful values on open instead of empty inputs.
  useEffect(() => {
    if (!adapterId) return
    const adapter = adapters.find(a => a.id === adapterId)
    if (!adapter) return
    setCfg(initialConfigFor(adapter.config_fields))
  }, [adapterId, adapters])

  // Reset form when modal closes.
  useEffect(() => {
    if (!open) {
      setName('')
      setAdapterId('')
      setCfg({})
      setIsDefault(false)
    }
  }, [open])

  const selected = adapters.find(a => a.id === adapterId)

  const createMutation = useMutation({
    mutationFn: () =>
      api.browser.createProfile(projectId, {
        name: name.trim(),
        adapter_id: adapterId,
        config: cfg,
        is_default: isDefault,
        enabled: true,
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['browser-profiles', projectId] })
      toast.success('Profile created')
      onOpenChange(false)
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : 'Failed to create'),
  })

  const canSubmit = name.trim().length > 0 && adapterId.length > 0 && !createMutation.isPending

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl max-h-[90vh] flex flex-col gap-0 p-0">
        <DialogHeader className="px-6 pt-6 pb-4 border-b shrink-0">
          <DialogTitle>Add Browser Profile</DialogTitle>
        </DialogHeader>
        <div className="space-y-5 overflow-y-auto px-6 py-5 flex-1 min-h-0">
          <div className="space-y-1.5">
            <Label>Profile Name</Label>
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Main, Stealth, Archive"
            />
          </div>

          <div className="space-y-2">
            <Label>Browser Adapter</Label>
            <RadioGroup value={adapterId} onValueChange={setAdapterId}>
              {adapters.map((a) => (
                <label
                  key={a.id}
                  htmlFor={`adapter-${a.id}`}
                  className="flex items-start gap-3 rounded-md border px-3 py-2.5 cursor-pointer hover:bg-muted/30"
                >
                  <RadioGroupItem value={a.id} id={`adapter-${a.id}`} className="mt-1" />
                  <div className="flex-1 min-w-0">
                    <div className="font-medium text-sm">{a.display_name}</div>
                    <div className="text-xs text-muted-foreground mt-0.5">{a.description}</div>
                  </div>
                </label>
              ))}
              {adapters.length === 0 && (
                <div className="text-xs text-muted-foreground italic">
                  No adapters registered. Enable a browser plugin or restart the server.
                </div>
              )}
            </RadioGroup>
          </div>

          {selected && Object.keys(selected.config_fields).length > 0 && (
            <div className="space-y-2">
              <Label>Configuration</Label>
              <div className="space-y-4 rounded-md border p-4 bg-muted/20">
                {Object.entries(selected.config_fields).map(([key, field]) => (
                  <ConfigField
                    key={key}
                    name={key}
                    field={field}
                    value={cfg[key]}
                    onChange={(next) => setCfg(prev => ({ ...prev, [key]: next }))}
                  />
                ))}
              </div>
            </div>
          )}

          <div className="flex items-center justify-between">
            <div>
              <Label className="text-sm">Set as default profile</Label>
              <p className="text-xs text-muted-foreground">The default profile is used when a tool call omits profile_id.</p>
            </div>
            <Switch checked={isDefault} onCheckedChange={setIsDefault} />
          </div>
        </div>

        <DialogFooter className="mx-0 mb-0 px-6 py-4 rounded-b-xl shrink-0">
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button disabled={!canSubmit} onClick={() => createMutation.mutate()}>
            {createMutation.isPending ? 'Creating...' : 'Create Profile'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
