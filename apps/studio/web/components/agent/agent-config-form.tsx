'use client'

import { useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { api } from '@/lib/api'
import type { Agent } from '@/lib/api'
import { Button, Checkbox, Input, Label, Textarea } from '@jiku/ui'
import { toast } from 'sonner'

const AVAILABLE_MODES = [
  { value: 'chat', label: 'Chat', description: 'Standard conversational mode' },
  { value: 'task', label: 'Task', description: 'Autonomous task execution (required for heartbeat)' },
] as const

interface AgentConfigFormProps {
  agent: Agent
  projectId: string
}

export function AgentConfigForm({ agent, projectId }: AgentConfigFormProps) {
  const qc = useQueryClient()
  const [name, setName] = useState(agent.name)
  const [description, setDescription] = useState(agent.description ?? '')
  const [basePrompt, setBasePrompt] = useState(agent.base_prompt)
  const [allowedModes, setAllowedModes] = useState<string[]>(agent.allowed_modes ?? ['chat'])

  const mutation = useMutation({
    mutationFn: () => api.agents.update(agent.id, {
      name,
      description: description || null,
      base_prompt: basePrompt,
      allowed_modes: allowedModes,
    }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['agents', projectId] })
      toast.success('Agent updated')
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : 'Failed to update'),
  })

  function toggleMode(mode: string) {
    setAllowedModes(prev =>
      prev.includes(mode) ? prev.filter(m => m !== mode) : [...prev, mode]
    )
  }

  return (
    <form
      onSubmit={e => { e.preventDefault(); mutation.mutate() }}
      className="space-y-4 max-w-xl"
    >
      <div className="space-y-2">
        <Label>Name</Label>
        <Input value={name} onChange={e => setName(e.target.value)} required />
      </div>
      <div className="space-y-2">
        <Label>Description</Label>
        <Input value={description} onChange={e => setDescription(e.target.value)} />
      </div>
      <div className="space-y-2">
        <Label>System Prompt</Label>
        <Textarea value={basePrompt} onChange={e => setBasePrompt(e.target.value)} rows={8} required />
      </div>
      <div className="space-y-2">
        <Label>Allowed Modes</Label>
        <div className="space-y-2">
          {AVAILABLE_MODES.map(mode => (
            <div key={mode.value} className="flex items-start gap-2">
              <Checkbox
                id={`mode-${mode.value}`}
                checked={allowedModes.includes(mode.value)}
                onCheckedChange={() => toggleMode(mode.value)}
              />
              <div className="grid gap-0.5 leading-none">
                <label htmlFor={`mode-${mode.value}`} className="text-sm font-medium cursor-pointer">
                  {mode.label}
                </label>
                <p className="text-xs text-muted-foreground">{mode.description}</p>
              </div>
            </div>
          ))}
        </div>
      </div>
      <Button type="submit" disabled={mutation.isPending || allowedModes.length === 0}>
        {mutation.isPending ? 'Saving...' : 'Save Changes'}
      </Button>
    </form>
  )
}
