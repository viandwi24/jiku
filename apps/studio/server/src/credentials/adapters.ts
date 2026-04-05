// eslint-disable-next-line @typescript-eslint/no-explicit-any
type CredentialSchemaLike = any

export interface AdapterField {
  key: string
  label: string
  type: 'secret' | 'string' | 'number' | 'boolean'
  required: boolean
  default?: string
  placeholder?: string
  description?: string
}

export interface AdapterModel {
  id: string
  name: string
  description?: string
}

export interface CredentialAdapter {
  group_id: string
  adapter_id: string
  name: string
  icon: string
  fields: AdapterField[]     // secret → encrypted
  metadata: AdapterField[]   // non-secret → plain JSON
  models: AdapterModel[]     // empty = dynamic fetch
}

/**
 * Derive AdapterField[] from a Zod object schema.
 * Convention: `.describe('secret|...')` marks a field as a secret (encrypted).
 * Fields without 'secret' in description go to `metadata` (plain JSON).
 *
 * Returns `{ fields, metadata }` split.
 */
export function zodSchemaToAdapterFields(schema: CredentialSchemaLike): { fields: AdapterField[]; metadata: AdapterField[] } {
  const fields: AdapterField[] = []
  const metadata: AdapterField[] = []

  for (const [key, zodField] of Object.entries(schema.shape) as [string, any][]) {
    const desc: string = zodField.description ?? ''
    const isSecret = desc.includes('secret')
    const label = desc.replace('secret|', '').replace('secret', '').trim() || key
      .replace(/_/g, ' ')
      .replace(/\b\w/g, c => c.toUpperCase())

    const typeName: string = zodField._def?.typeName ?? 'ZodString'
    let type: AdapterField['type'] = 'string'
    if (typeName === 'ZodNumber') type = 'number'
    else if (typeName === 'ZodBoolean') type = 'boolean'
    else if (isSecret) type = 'secret'

    const required = !zodField.isOptional()
    const checks: Array<{ kind: string; value?: unknown }> = zodField._def?.checks ?? []
    const defaultCheck = checks.find(c => c.kind === 'default') as { value?: string } | undefined
    const adapterField: AdapterField = { key, label, type, required, default: String(defaultCheck?.value ?? ''), description: desc.replace('secret|', '').replace('secret', '').trim() || undefined }

    if (isSecret) {
      fields.push(adapterField)
    } else {
      metadata.push(adapterField)
    }
  }

  return { fields, metadata }
}

export const CREDENTIAL_ADAPTERS: CredentialAdapter[] = [
  {
    group_id: 'provider-model',
    adapter_id: 'openai',
    name: 'OpenAI',
    icon: 'openai',
    fields: [
      { key: 'api_key', label: 'API Key', type: 'secret', required: true, placeholder: 'sk-...' },
    ],
    metadata: [
      { key: 'organization_id', label: 'Organization ID', type: 'string', required: false },
      { key: 'base_url', label: 'Base URL (override)', type: 'string', required: false },
    ],
    models: [
      { id: 'gpt-4o', name: 'GPT-4o' },
      { id: 'gpt-4o-mini', name: 'GPT-4o Mini' },
      { id: 'gpt-4-turbo', name: 'GPT-4 Turbo' },
      { id: 'gpt-4.1', name: 'GPT-4.1' },
      { id: 'gpt-4.1-mini', name: 'GPT-4.1 Mini' },
      { id: 'gpt-4.1-nano', name: 'GPT-4.1 Nano' },
      { id: 'gpt-5-nano', name: 'GPT-5 Nano' },
      { id: 'o1', name: 'o1' },
      { id: 'o1-mini', name: 'o1 Mini' },
    ],
  },
  {
    group_id: 'provider-model',
    adapter_id: 'anthropic',
    name: 'Anthropic',
    icon: 'anthropic',
    fields: [
      { key: 'api_key', label: 'API Key', type: 'secret', required: true, placeholder: 'sk-ant-...' },
    ],
    metadata: [
      { key: 'base_url', label: 'Base URL (override)', type: 'string', required: false },
    ],
    models: [
      { id: 'claude-opus-4-6', name: 'Claude Opus 4.6' },
      { id: 'claude-sonnet-4-6', name: 'Claude Sonnet 4.6' },
      { id: 'claude-haiku-4-5-20251001', name: 'Claude Haiku 4.5' },
    ],
  },
  {
    group_id: 'provider-model',
    adapter_id: 'openrouter',
    name: 'OpenRouter',
    icon: 'openrouter',
    fields: [
      { key: 'api_key', label: 'API Key', type: 'secret', required: true },
    ],
    metadata: [
      { key: 'site_url', label: 'Site URL', type: 'string', required: false },
      { key: 'site_name', label: 'Site Name', type: 'string', required: false },
    ],
    models: [], // dynamic from OpenRouter API
  },
  {
    group_id: 'provider-model',
    adapter_id: 'ollama',
    name: 'Ollama (Local)',
    icon: 'ollama',
    fields: [],  // no secrets
    metadata: [
      { key: 'base_url', label: 'Base URL', type: 'string', required: true, default: 'http://localhost:11434' },
    ],
    models: [], // dynamic from Ollama instance
  },
]

export function getAdapter(adapter_id: string): CredentialAdapter | undefined {
  return CREDENTIAL_ADAPTERS.find(a => a.adapter_id === adapter_id)
}

export function getAdaptersByGroup(group_id?: string): CredentialAdapter[] {
  if (!group_id) return CREDENTIAL_ADAPTERS
  return CREDENTIAL_ADAPTERS.filter(a => a.group_id === group_id)
}

/**
 * Derive CredentialAdapter entries from registered ConnectorAdapters that have a credentialSchema.
 * These are merged into the credential adapter list at request time so plugins
 * define their own credential fields via Zod — no hardcoded entries needed.
 */
export function getConnectorDerivedAdapters(): CredentialAdapter[] {
  // Lazy import to avoid circular dep at module load time
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { connectorRegistry } = require('../connectors/registry.ts') as typeof import('../connectors/registry.ts')
  const adapters: CredentialAdapter[] = []

  for (const connectorAdapter of connectorRegistry.list()) {
    if (!connectorAdapter.credentialSchema) continue
    const { fields, metadata } = zodSchemaToAdapterFields(connectorAdapter.credentialSchema)
    adapters.push({
      group_id: 'channel',
      adapter_id: connectorAdapter.credentialAdapterId,
      name: connectorAdapter.credentialDisplayName ?? connectorAdapter.displayName,
      icon: connectorAdapter.credentialAdapterId,
      fields,
      metadata,
      models: [],
    })
  }

  return adapters
}

/**
 * Get all adapters — static list merged with connector-derived ones.
 */
export function getAllAdapters(group_id?: string): CredentialAdapter[] {
  const connectorDerived = getConnectorDerivedAdapters()
  // Deduplicate by adapter_id (static list takes precedence if both define the same id)
  const staticIds = new Set(CREDENTIAL_ADAPTERS.map(a => a.adapter_id))
  const merged = [
    ...CREDENTIAL_ADAPTERS,
    ...connectorDerived.filter(a => !staticIds.has(a.adapter_id)),
  ]
  if (!group_id) return merged
  return merged.filter(a => a.group_id === group_id)
}
