'use client'

import { useForm } from 'react-hook-form'
import { Button, Input, Label, Switch } from '@jiku/ui'

interface JsonSchemaProperty {
  type?: string
  description?: string
  default?: unknown
  minimum?: number
  maximum?: number
  enum?: string[]
}

interface JsonSchema {
  type?: string
  properties?: Record<string, JsonSchemaProperty>
  required?: string[]
}

interface PluginConfigFormProps {
  schema: JsonSchema
  defaultValues?: Record<string, unknown>
  onSubmit: (config: Record<string, unknown>) => void | Promise<void>
  submitLabel?: string
  isSubmitting?: boolean
}

export function PluginConfigForm({
  schema,
  defaultValues = {},
  onSubmit,
  submitLabel = 'Save Configuration',
  isSubmitting = false,
}: PluginConfigFormProps) {
  const properties = schema.properties ?? {}
  const hasFields = Object.keys(properties).length > 0

  const { register, handleSubmit, setValue, watch } = useForm<Record<string, unknown>>({
    defaultValues: Object.fromEntries(
      Object.entries(properties).map(([key, field]) => [
        key,
        defaultValues[key] ?? field.default ?? (field.type === 'boolean' ? false : ''),
      ])
    ),
  })

  if (!hasFields) {
    return (
      <div className="space-y-4">
        <p className="text-sm text-muted-foreground">No configuration required for this plugin.</p>
        <Button onClick={() => onSubmit({})} disabled={isSubmitting} size="sm">
          {isSubmitting ? 'Activating...' : submitLabel}
        </Button>
      </div>
    )
  }

  return (
    <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
      {Object.entries(properties).map(([key, field]) => (
        <DynamicField
          key={key}
          fieldKey={key}
          schema={field}
          value={watch(key)}
          register={register}
          setValue={setValue}
        />
      ))}
      <Button type="submit" size="sm" disabled={isSubmitting}>
        {isSubmitting ? 'Saving...' : submitLabel}
      </Button>
    </form>
  )
}

interface DynamicFieldProps {
  fieldKey: string
  schema: JsonSchemaProperty
  value: unknown
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  register: (key: string, opts?: any) => any
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  setValue: (key: string, value: any) => void
}

function DynamicField({ fieldKey, schema, value, register, setValue }: DynamicFieldProps) {
  const label = fieldKey.replace(/_/g, ' ').replace(/\b\w/g, l => l.toUpperCase())

  if (schema.type === 'boolean') {
    return (
      <div className="flex items-center justify-between">
        <div>
          <Label className="text-sm font-medium">{label}</Label>
          {schema.description && (
            <p className="text-xs text-muted-foreground mt-0.5">{schema.description}</p>
          )}
        </div>
        <Switch
          checked={!!value}
          onCheckedChange={(checked) => setValue(fieldKey, checked)}
        />
      </div>
    )
  }

  if (schema.type === 'number') {
    return (
      <div className="space-y-1.5">
        <Label className="text-sm font-medium">{label}</Label>
        {schema.description && (
          <p className="text-xs text-muted-foreground">{schema.description}</p>
        )}
        <Input
          type="number"
          min={schema.minimum}
          max={schema.maximum}
          {...register(fieldKey, { valueAsNumber: true })}
        />
        {(schema.minimum !== undefined || schema.maximum !== undefined) && (
          <p className="text-xs text-muted-foreground">
            Range: {schema.minimum ?? '—'} – {schema.maximum ?? '—'}
          </p>
        )}
      </div>
    )
  }

  // Default: string
  return (
    <div className="space-y-1.5">
      <Label className="text-sm font-medium">{label}</Label>
      {schema.description && (
        <p className="text-xs text-muted-foreground">{schema.description}</p>
      )}
      <Input placeholder={String(schema.default ?? '')} {...register(fieldKey)} />
    </div>
  )
}
