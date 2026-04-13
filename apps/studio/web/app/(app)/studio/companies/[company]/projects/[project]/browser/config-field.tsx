'use client'

import { Input, Label, Switch, Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@jiku/ui'
import type { BrowserAdapterConfigField } from '@/lib/api'

interface Props {
  name: string
  field: BrowserAdapterConfigField
  value: unknown
  onChange: (next: unknown) => void
}

/** Convert snake_case/camelCase key into a human-readable label. */
export function humanizeKey(key: string): string {
  return key
    .replace(/_/g, ' ')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/\b\w/g, (c) => c.toUpperCase())
    // Common unit suffixes — uppercase them.
    .replace(/\bMs\b/, '(ms)')
    .replace(/\bUrl\b/, 'URL')
    .replace(/\bCdp\b/, 'CDP')
    .replace(/\bId\b/, 'ID')
}

/** Build a placeholder string from the field's default value. */
function placeholderFor(field: BrowserAdapterConfigField): string | undefined {
  if (field.placeholder) return field.placeholder
  if (field.default === undefined || field.default === null) return undefined
  if (typeof field.default === 'string') return field.default
  if (typeof field.default === 'number') return `default: ${field.default}`
  return undefined
}

/**
 * Produce the initial form state for an adapter's config: prefill with each
 * field's declared default so users see meaningful values, not empty boxes.
 */
export function initialConfigFor(fields: Record<string, BrowserAdapterConfigField>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [key, f] of Object.entries(fields)) {
    if (f.default !== undefined) out[key] = f.default
  }
  return out
}

export function ConfigField({ name, field, value, onChange }: Props) {
  const label = humanizeKey(name)
  const placeholder = placeholderFor(field)
  const hint =
    field.type === 'integer' || field.type === 'number'
      ? [
          field.min !== undefined && `min ${field.min}`,
          field.max !== undefined && `max ${field.max}`,
        ].filter(Boolean).join(' · ')
      : ''

  // ── boolean → Switch ─────────────────────────────────────────────────────
  if (field.type === 'boolean') {
    return (
      <div className="flex items-start justify-between gap-4 rounded-md border px-3 py-2.5">
        <div className="min-w-0 flex-1">
          <Label htmlFor={`cf-${name}`} className="text-sm font-medium cursor-pointer">{label}</Label>
          {field.description && (
            <p className="text-xs text-muted-foreground mt-0.5">{field.description}</p>
          )}
          <p className="text-[10px] font-mono text-muted-foreground mt-1">{name}</p>
        </div>
        <Switch
          id={`cf-${name}`}
          checked={Boolean(value ?? field.default ?? false)}
          onCheckedChange={(v) => onChange(v)}
        />
      </div>
    )
  }

  // ── enum → Select ────────────────────────────────────────────────────────
  if (field.type === 'enum' && field.options && field.options.length > 0) {
    return (
      <div className="space-y-1.5">
        <div className="flex items-baseline justify-between gap-2">
          <Label htmlFor={`cf-${name}`} className="text-sm font-medium">
            {label}{!field.optional && <span className="text-red-500"> *</span>}
          </Label>
          <span className="text-[10px] font-mono text-muted-foreground">{name}</span>
        </div>
        {field.description && (
          <p className="text-xs text-muted-foreground">{field.description}</p>
        )}
        <Select
          value={value === undefined || value === null ? '' : String(value)}
          onValueChange={(v) => onChange(v)}
        >
          <SelectTrigger id={`cf-${name}`}>
            <SelectValue placeholder={placeholder ?? 'Select...'} />
          </SelectTrigger>
          <SelectContent>
            {field.options.map((opt) => (
              <SelectItem key={opt} value={opt}>{opt}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
    )
  }

  // ── number / integer → numeric Input with min/max ────────────────────────
  if (field.type === 'number' || field.type === 'integer') {
    const num = typeof value === 'number' ? value : ''
    return (
      <div className="space-y-1.5">
        <div className="flex items-baseline justify-between gap-2">
          <Label htmlFor={`cf-${name}`} className="text-sm font-medium">
            {label}{!field.optional && <span className="text-red-500"> *</span>}
          </Label>
          <span className="text-[10px] font-mono text-muted-foreground">{name}</span>
        </div>
        {field.description && (
          <p className="text-xs text-muted-foreground">{field.description}</p>
        )}
        <Input
          id={`cf-${name}`}
          type="number"
          inputMode="numeric"
          value={num}
          placeholder={placeholder}
          min={field.min}
          max={field.max}
          step={field.type === 'integer' ? 1 : 'any'}
          onChange={(e) => {
            const raw = e.target.value
            if (raw === '') { onChange(undefined); return }
            const parsed = field.type === 'integer' ? parseInt(raw, 10) : parseFloat(raw)
            if (Number.isNaN(parsed)) return  // ignore non-numeric input
            onChange(parsed)
          }}
        />
        {hint && (
          <p className="text-[11px] text-muted-foreground tabular-nums">{hint}</p>
        )}
      </div>
    )
  }

  // ── string / fallback → text Input ───────────────────────────────────────
  return (
    <div className="space-y-1.5">
      <div className="flex items-baseline justify-between gap-2">
        <Label htmlFor={`cf-${name}`} className="text-sm font-medium">
          {label}{!field.optional && <span className="text-red-500"> *</span>}
        </Label>
        <span className="text-[10px] font-mono text-muted-foreground">{name}</span>
      </div>
      {field.description && (
        <p className="text-xs text-muted-foreground">{field.description}</p>
      )}
      <Input
        id={`cf-${name}`}
        value={typeof value === 'string' ? value : ''}
        placeholder={placeholder}
        onChange={(e) => {
          const v = e.target.value
          onChange(v === '' ? undefined : v)
        }}
      />
    </div>
  )
}
