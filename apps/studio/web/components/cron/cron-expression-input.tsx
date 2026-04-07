'use client'

import { useMemo } from 'react'
import cronstrue from 'cronstrue'
import { Badge, Input, Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@jiku/ui'
import { CheckCircle2, XCircle } from 'lucide-react'

const CRON_PRESETS = [
  { label: 'Every minute', value: '* * * * *' },
  { label: 'Every 5 minutes', value: '*/5 * * * *' },
  { label: 'Every 15 minutes', value: '*/15 * * * *' },
  { label: 'Every 30 minutes', value: '*/30 * * * *' },
  { label: 'Every hour', value: '0 * * * *' },
  { label: 'Every 6 hours', value: '0 */6 * * *' },
  { label: 'Every 12 hours', value: '0 */12 * * *' },
  { label: 'Every day at midnight', value: '0 0 * * *' },
  { label: 'Every day at 9am', value: '0 9 * * *' },
  { label: 'Every Monday at 9am', value: '0 9 * * 1' },
  { label: 'Every weekday at 9am', value: '0 9 * * 1-5' },
  { label: 'Every Sunday at midnight', value: '0 0 * * 0' },
  { label: 'Every 1st of month', value: '0 0 1 * *' },
]

function parseCron(expr: string): { valid: boolean; description: string } {
  const trimmed = expr.trim()
  if (!trimmed) return { valid: false, description: '' }
  try {
    const description = cronstrue.toString(trimmed, { use24HourTimeFormat: true, verbose: false })
    return { valid: true, description }
  } catch {
    return { valid: false, description: 'Invalid cron expression' }
  }
}

interface CronExpressionInputProps {
  value: string
  onChange: (value: string) => void
  disabled?: boolean
}

export function CronExpressionInput({ value, onChange, disabled }: CronExpressionInputProps) {
  const parsed = useMemo(() => parseCron(value), [value])

  return (
    <div className="space-y-2">
      <div className="flex gap-2">
        <Input
          value={value}
          onChange={e => onChange(e.target.value)}
          placeholder="0 * * * *"
          className="font-mono text-sm flex-1"
          disabled={disabled}
        />
        <Select onValueChange={onChange} disabled={disabled}>
          <SelectTrigger className="w-[150px] text-xs shrink-0">
            <SelectValue placeholder="Presets..." />
          </SelectTrigger>
          <SelectContent>
            {CRON_PRESETS.map(p => (
              <SelectItem key={p.value} value={p.value} className="text-xs">
                <span>{p.label}</span>
                <Badge variant="outline" className="ml-2 font-mono text-[10px]">{p.value}</Badge>
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {/* Human-readable preview */}
      {value.trim() && (
        <div className={`flex items-start gap-1.5 text-xs rounded-md px-2.5 py-1.5 ${
          parsed.valid
            ? 'bg-green-50 text-green-700 dark:bg-green-950/30 dark:text-green-400'
            : 'bg-destructive/10 text-destructive'
        }`}>
          {parsed.valid
            ? <CheckCircle2 className="h-3.5 w-3.5 mt-0.5 shrink-0" />
            : <XCircle className="h-3.5 w-3.5 mt-0.5 shrink-0" />
          }
          <span>{parsed.description}</span>
        </div>
      )}

      <p className="text-xs text-muted-foreground">
        5-field cron: <code className="font-mono">minute hour day month weekday</code> (UTC)
      </p>
    </div>
  )
}
