'use client'

import { useState } from 'react'
import { Button } from '../ui/button.tsx'
import { Input } from '../ui/input.tsx'
import { Label } from '../ui/label.tsx'
import { Textarea } from '../ui/textarea.tsx'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../ui/select.tsx'
import { Separator } from '../ui/separator.tsx'
import { Eye, EyeOff } from 'lucide-react'

export interface AdapterField {
  key: string
  label: string
  type: 'secret' | 'string' | 'number' | 'boolean'
  required: boolean
  default?: string
  placeholder?: string
}

export interface CredentialAdapter {
  group_id: string
  adapter_id: string
  name: string
  icon: string
  fields: AdapterField[]
  metadata: AdapterField[]
  models: { id: string; name: string }[]
}

interface CredentialFormProps {
  adapters: CredentialAdapter[]
  /** Edit mode: pre-fill name/description/adapter and lock adapter picker */
  initialValues?: {
    name?: string
    description?: string
    adapter_id?: string
    metadata?: Record<string, string>
  }
  /** In edit mode, secret fields show a "keep current / replace" pattern */
  editMode?: boolean
  onSubmit: (values: {
    name: string
    description: string
    adapter_id: string
    group_id: string
    fields: Record<string, string>
    metadata: Record<string, string>
  }) => void | Promise<void>
  onCancel?: () => void
  submitLabel?: string
  isLoading?: boolean
}

export function CredentialForm({ adapters, initialValues, editMode, onSubmit, onCancel, submitLabel = 'Save', isLoading }: CredentialFormProps) {
  const [name, setName] = useState(initialValues?.name ?? '')
  const [description, setDescription] = useState(initialValues?.description ?? '')
  const [adapterId, setAdapterId] = useState(initialValues?.adapter_id ?? '')
  const [fields, setFields] = useState<Record<string, string>>({})
  const [metadata, setMetadata] = useState<Record<string, string>>(initialValues?.metadata ?? {})
  const [showSecrets, setShowSecrets] = useState<Record<string, boolean>>({})

  const adapter = adapters.find(a => a.adapter_id === adapterId)

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!adapter) return

    await onSubmit({
      name,
      description,
      adapter_id: adapterId,
      group_id: adapter.group_id,
      fields,
      metadata,
    })
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <div className="space-y-2">
        <Label htmlFor="cred-name">Name <span className="text-destructive">*</span></Label>
        <Input
          id="cred-name"
          value={name}
          onChange={e => setName(e.target.value)}
          placeholder="OpenAI Production"
          required
        />
      </div>

      <div className="space-y-2">
        <Label htmlFor="cred-desc">Description</Label>
        <Textarea
          id="cred-desc"
          value={description}
          onChange={e => setDescription(e.target.value)}
          placeholder="Optional description"
          rows={2}
        />
      </div>

      <div className="space-y-2">
        <Label>Adapter <span className="text-destructive">*</span></Label>
        {editMode ? (
          <div className="px-3 py-2 rounded-md border bg-muted/50 text-sm text-muted-foreground">
            {adapter?.name ?? adapterId} <span className="text-xs">(cannot change)</span>
          </div>
        ) : (
          <Select value={adapterId} onValueChange={setAdapterId} required>
            <SelectTrigger>
              <SelectValue placeholder="Select adapter..." />
            </SelectTrigger>
            <SelectContent>
              {adapters.map(a => (
                <SelectItem key={a.adapter_id} value={a.adapter_id}>
                  {a.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
      </div>

      {adapter && adapter.fields.length > 0 && (
        <>
          <Separator />
          <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
            Secret Fields
            {editMode && <span className="normal-case font-normal ml-1">— leave blank to keep current values</span>}
          </p>
          {adapter.fields.map(field => (
            <div key={field.key} className="space-y-2">
              <Label htmlFor={`field-${field.key}`}>
                {field.label}
                {field.required && !editMode && <span className="text-destructive ml-1">*</span>}
              </Label>
              <div className="relative">
                <Input
                  id={`field-${field.key}`}
                  type={showSecrets[field.key] ? 'text' : 'password'}
                  value={fields[field.key] ?? ''}
                  onChange={e => setFields(prev => ({ ...prev, [field.key]: e.target.value }))}
                  placeholder={editMode ? '(unchanged)' : (field.placeholder ?? '')}
                  required={field.required && !editMode}
                  className="pr-9"
                />
                <button
                  type="button"
                  className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                  onClick={() => setShowSecrets(prev => ({ ...prev, [field.key]: !prev[field.key] }))}
                >
                  {showSecrets[field.key] ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                </button>
              </div>
            </div>
          ))}
        </>
      )}

      {adapter && adapter.metadata.length > 0 && (
        <>
          <Separator />
          <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Metadata (Optional)</p>
          {adapter.metadata.map(field => (
            <div key={field.key} className="space-y-2">
              <Label htmlFor={`meta-${field.key}`}>
                {field.label}
                {field.required && <span className="text-destructive ml-1">*</span>}
              </Label>
              <Input
                id={`meta-${field.key}`}
                value={metadata[field.key] ?? field.default ?? ''}
                onChange={e => setMetadata(prev => ({ ...prev, [field.key]: e.target.value }))}
                placeholder={field.placeholder ?? field.default ?? ''}
                required={field.required && !editMode}
              />
            </div>
          ))}
        </>
      )}

      <div className="flex justify-end gap-2 pt-2">
        {onCancel && (
          <Button type="button" variant="outline" onClick={onCancel}>
            Cancel
          </Button>
        )}
        <Button type="submit" disabled={!name || !adapterId || isLoading}>
          {isLoading ? 'Saving...' : submitLabel}
        </Button>
      </div>
    </form>
  )
}
