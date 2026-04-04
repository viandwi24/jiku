'use client'

import { Input } from '../ui/input.tsx'
import { Label } from '../ui/label.tsx'
import { cn } from '../../lib/utils.ts'
import { CheckCircle2, Circle } from 'lucide-react'

interface ModelOption {
  id: string
  name: string
  description?: string
}

interface ModelSelectorProps {
  models: ModelOption[]
  value: string
  onChange: (modelId: string) => void
}

export function ModelSelector({ models, value, onChange }: ModelSelectorProps) {
  // No static models → free text input
  if (models.length === 0) {
    return (
      <div className="space-y-2">
        <Label>Model ID</Label>
        <Input
          value={value}
          onChange={e => onChange(e.target.value)}
          placeholder="e.g. llama3.2, openai/gpt-4o"
        />
      </div>
    )
  }

  return (
    <div className="rounded-md border divide-y divide-border overflow-hidden">
      {models.map(model => {
        const selected = model.id === value
        return (
          <button
            key={model.id}
            type="button"
            className={cn(
              'w-full flex items-center gap-3 px-4 py-2.5 text-left hover:bg-muted/50 transition-colors',
              selected && 'bg-primary/5'
            )}
            onClick={() => onChange(model.id)}
          >
            {selected
              ? <CheckCircle2 className="w-4 h-4 text-primary shrink-0" />
              : <Circle className="w-4 h-4 text-muted-foreground shrink-0" />
            }
            <div>
              <span className="text-sm font-medium">{model.name}</span>
              {model.description && (
                <p className="text-xs text-muted-foreground">{model.description}</p>
              )}
            </div>
          </button>
        )
      })}
    </div>
  )
}
