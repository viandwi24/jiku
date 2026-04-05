'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { useQueryClient } from '@tanstack/react-query'
import { api } from '@/lib/api'
import { Button, Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger, Input, Label } from '@jiku/ui'
import { Plus } from 'lucide-react'

interface CreateAgentDialogProps {
  projectId: string
  companySlug: string
  projectSlug: string
}

export function CreateAgentDialog({ projectId, companySlug, projectSlug }: CreateAgentDialogProps) {
  const qc = useQueryClient()
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [name, setName] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setError('')
    setLoading(true)
    try {
      const res = await api.agents.create(projectId, {
        name,
        description: null,
        base_prompt: '',
        allowed_modes: ['chat'],
      })
      await qc.invalidateQueries({ queryKey: ['agents', projectId] })
      setOpen(false)
      setName('')
      router.push(`/studio/companies/${companySlug}/projects/${projectSlug}/agents/${res.agent.slug}`)
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
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>New Agent</DialogTitle>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-2">
            <Label>Name</Label>
            <Input
              value={name}
              onChange={e => setName(e.target.value)}
              placeholder="e.g. Social Media Manager"
              autoFocus
              required
            />
          </div>
          {error && <p className="text-sm text-destructive">{error}</p>}
          <div className="flex justify-end gap-2">
            <Button type="button" variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
            <Button type="submit" disabled={loading || !name.trim()}>
              {loading ? 'Creating...' : 'Create'}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  )
}
