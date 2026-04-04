'use client'

import { useState } from 'react'
import { Button } from '../ui/button.tsx'
import { Input } from '../ui/input.tsx'
import { Label } from '../ui/label.tsx'
import { X, Plus } from 'lucide-react'

interface MetadataOverrideFormProps {
  value: Record<string, string>
  onChange: (value: Record<string, string>) => void
}

export function MetadataOverrideForm({ value, onChange }: MetadataOverrideFormProps) {
  const [newKey, setNewKey] = useState('')
  const [newVal, setNewVal] = useState('')

  const entries = Object.entries(value)

  const addEntry = () => {
    if (!newKey.trim()) return
    onChange({ ...value, [newKey.trim()]: newVal })
    setNewKey('')
    setNewVal('')
  }

  const removeEntry = (key: string) => {
    const next = { ...value }
    delete next[key]
    onChange(next)
  }

  const updateValue = (key: string, val: string) => {
    onChange({ ...value, [key]: val })
  }

  return (
    <div className="space-y-2">
      {entries.length > 0 && (
        <div className="space-y-2">
          {entries.map(([k, v]) => (
            <div key={k} className="flex items-center gap-2">
              <span className="text-sm font-mono text-muted-foreground w-32 shrink-0 truncate">{k}</span>
              <Input
                value={v}
                onChange={e => updateValue(k, e.target.value)}
                className="flex-1"
              />
              <Button type="button" variant="ghost" size="icon" className="h-8 w-8 shrink-0" onClick={() => removeEntry(k)}>
                <X className="w-3.5 h-3.5" />
              </Button>
            </div>
          ))}
        </div>
      )}

      <div className="flex items-center gap-2">
        <Input
          placeholder="key"
          value={newKey}
          onChange={e => setNewKey(e.target.value)}
          className="w-32 shrink-0 font-mono text-sm"
          onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); addEntry() } }}
        />
        <Input
          placeholder="value"
          value={newVal}
          onChange={e => setNewVal(e.target.value)}
          className="flex-1"
          onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); addEntry() } }}
        />
        <Button type="button" variant="outline" size="icon" className="h-8 w-8 shrink-0" onClick={addEntry}>
          <Plus className="w-3.5 h-3.5" />
        </Button>
      </div>

      {entries.length === 0 && !newKey && (
        <p className="text-xs text-muted-foreground">No overrides set. Click + to add a key-value override.</p>
      )}
    </div>
  )
}
