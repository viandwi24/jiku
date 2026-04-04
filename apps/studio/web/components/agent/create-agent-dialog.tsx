'use client'

import { useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { api } from '@/lib/api'
import { Button } from '@jiku/ui'
import { Input } from '@jiku/ui'
import { Label } from '@jiku/ui'
import { Textarea } from '@jiku/ui'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from '@jiku/ui'
import { Plus } from 'lucide-react'

export function CreateAgentDialog({ projectId }: { projectId: string }) {
  const qc = useQueryClient()
  const [open, setOpen] = useState(false)
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [basePrompt, setBasePrompt] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setError('')
    setLoading(true)
    try {
      await api.agents.create(projectId, {
        name,
        description: description || null,
        base_prompt: basePrompt,
        allowed_modes: ['chat'],
        provider_id: 'anthropic',
        model_id: 'claude-sonnet-4-5',
      })
      await qc.invalidateQueries({ queryKey: ['agents', projectId] })
      setOpen(false)
      setName('')
      setDescription('')
      setBasePrompt('')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create agent')
    } finally {
      setLoading(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button>
          <Plus className="w-4 h-4 mr-1" />
          New Agent
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Create Agent</DialogTitle>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-2">
            <Label>Name</Label>
            <Input value={name} onChange={e => setName(e.target.value)} placeholder="Social Media Manager" required />
          </div>
          <div className="space-y-2">
            <Label>Description</Label>
            <Input value={description} onChange={e => setDescription(e.target.value)} placeholder="What does this agent do?" />
          </div>
          <div className="space-y-2">
            <Label>System Prompt</Label>
            <Textarea
              value={basePrompt}
              onChange={e => setBasePrompt(e.target.value)}
              placeholder="You are a helpful AI agent..."
              rows={4}
              required
            />
          </div>
          {error && <p className="text-sm text-destructive">{error}</p>}
          <div className="flex justify-end gap-2">
            <Button type="button" variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
            <Button type="submit" disabled={loading}>{loading ? 'Creating...' : 'Create'}</Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  )
}
