'use client'

import { useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { api } from '@/lib/api'
import type { Agent } from '@/lib/api'
import { Button } from '@jiku/ui'
import { Input } from '@jiku/ui'
import { Label } from '@jiku/ui'
import { Textarea } from '@jiku/ui'
import { toast } from 'sonner'

interface AgentConfigFormProps {
  agent: Agent
  projectId: string
}

export function AgentConfigForm({ agent, projectId }: AgentConfigFormProps) {
  const qc = useQueryClient()
  const [name, setName] = useState(agent.name)
  const [description, setDescription] = useState(agent.description ?? '')
  const [basePrompt, setBasePrompt] = useState(agent.base_prompt)
  const [modelId, setModelId] = useState(agent.model_id)

  const mutation = useMutation({
    mutationFn: () => api.agents.update(agent.id, { name, description: description || null, base_prompt: basePrompt, model_id: modelId }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['agents', projectId] })
      toast.success('Agent updated')
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : 'Failed to update'),
  })

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
        <Label>Model</Label>
        <Input value={modelId} onChange={e => setModelId(e.target.value)} />
      </div>
      <div className="space-y-2">
        <Label>System Prompt</Label>
        <Textarea value={basePrompt} onChange={e => setBasePrompt(e.target.value)} rows={8} required />
      </div>
      <Button type="submit" disabled={mutation.isPending}>
        {mutation.isPending ? 'Saving...' : 'Save Changes'}
      </Button>
    </form>
  )
}
