export interface AdapterField {
  key: string
  label: string
  type: 'secret' | 'string' | 'number' | 'boolean'
  required: boolean
  default?: string
  placeholder?: string
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
  {
    group_id: 'channel',
    adapter_id: 'telegram',
    name: 'Telegram Bot',
    icon: 'telegram',
    fields: [
      { key: 'bot_token', label: 'Bot Token', type: 'secret', required: true },
    ],
    metadata: [],
    models: [],
  },
]

export function getAdapter(adapter_id: string): CredentialAdapter | undefined {
  return CREDENTIAL_ADAPTERS.find(a => a.adapter_id === adapter_id)
}

export function getAdaptersByGroup(group_id?: string): CredentialAdapter[] {
  if (!group_id) return CREDENTIAL_ADAPTERS
  return CREDENTIAL_ADAPTERS.filter(a => a.group_id === group_id)
}
