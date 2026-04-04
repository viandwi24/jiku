import { getAgentCredential } from '@jiku-studio/db'
import { decryptFields, maskFields } from './encryption.ts'
import type { Credential } from '@jiku-studio/db'
import type { CredentialAdapter } from './adapters.ts'
import { getAdapter } from './adapters.ts'
import { createOpenAI } from '@ai-sdk/openai'
import { createAnthropic } from '@ai-sdk/anthropic'
import { createOpenRouter } from '@openrouter/ai-sdk-provider'
import type { LanguageModel } from 'ai'

export interface CredentialResponse {
  id: string
  name: string
  description: string | null
  group_id: string
  adapter_id: string
  scope: string
  scope_id: string
  metadata: Record<string, string>
  fields_masked: Record<string, string>
  adapter: CredentialAdapter | undefined
  created_at: string | null
}

export function formatCredential(cred: Credential): CredentialResponse {
  let fields_masked: Record<string, string> = {}
  if (cred.fields_encrypted) {
    try {
      const fields = decryptFields(cred.fields_encrypted)
      fields_masked = maskFields(fields)
    } catch {
      fields_masked = {}
    }
  }

  return {
    id: cred.id,
    name: cred.name,
    description: cred.description ?? null,
    group_id: cred.group_id,
    adapter_id: cred.adapter_id,
    scope: cred.scope,
    scope_id: cred.scope_id,
    metadata: (cred.metadata ?? {}) as Record<string, string>,
    fields_masked,
    adapter: getAdapter(cred.adapter_id),
    created_at: cred.created_at ? cred.created_at.toISOString() : null,
  }
}

/** Test connectivity for a credential (basic validation only) */
export async function testCredential(cred: Credential): Promise<{ ok: boolean; message: string }> {
  if (!cred.fields_encrypted && cred.adapter_id !== 'ollama') {
    return { ok: false, message: 'No credentials stored' }
  }

  try {
    const fields = cred.fields_encrypted ? decryptFields(cred.fields_encrypted) : {}
    const metadata = (cred.metadata ?? {}) as Record<string, string>

    switch (cred.adapter_id) {
      case 'openai': {
        const res = await fetch('https://api.openai.com/v1/models', {
          headers: { Authorization: `Bearer ${fields['api_key'] ?? ''}` },
        })
        return res.ok
          ? { ok: true, message: 'Connected' }
          : { ok: false, message: `HTTP ${res.status}` }
      }

      case 'anthropic': {
        const res = await fetch('https://api.anthropic.com/v1/models', {
          headers: {
            'x-api-key': fields['api_key'] ?? '',
            'anthropic-version': '2023-06-01',
          },
        })
        return res.ok
          ? { ok: true, message: 'Connected' }
          : { ok: false, message: `HTTP ${res.status}` }
      }

      case 'openrouter': {
        const res = await fetch('https://openrouter.ai/api/v1/models', {
          headers: { Authorization: `Bearer ${fields['api_key'] ?? ''}` },
        })
        return res.ok
          ? { ok: true, message: 'Connected' }
          : { ok: false, message: `HTTP ${res.status}` }
      }

      case 'ollama': {
        const baseUrl = metadata['base_url'] ?? 'http://localhost:11434'
        const res = await fetch(`${baseUrl}/api/tags`).catch(() => null)
        return res?.ok
          ? { ok: true, message: 'Connected' }
          : { ok: false, message: 'Cannot reach Ollama instance' }
      }

      case 'telegram': {
        const res = await fetch(`https://api.telegram.org/bot${fields['bot_token'] ?? ''}/getMe`)
        const data = await res.json() as { ok: boolean }
        return data.ok
          ? { ok: true, message: 'Connected' }
          : { ok: false, message: 'Invalid bot token' }
      }

      default:
        return { ok: false, message: `Unknown adapter: ${cred.adapter_id}` }
    }
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : 'Unknown error' }
  }
}

/** Resolve the agent model info (credential + model) for runtime use */
export async function resolveAgentModel(agentId: string): Promise<{
  adapter_id: string
  fields: Record<string, string>
  metadata: Record<string, string>
  model_id: string | null
} | null> {
  const agentCred = await getAgentCredential(agentId)
  if (!agentCred) return null

  const fields = agentCred.credential.fields_encrypted
    ? decryptFields(agentCred.credential.fields_encrypted)
    : {}

  const metadata: Record<string, string> = {
    ...((agentCred.credential.metadata ?? {}) as Record<string, string>),
    ...((agentCred.metadata_override ?? {}) as Record<string, string>),
  }

  return {
    adapter_id: agentCred.credential.adapter_id,
    fields,
    metadata,
    model_id: agentCred.model_id ?? null,
  }
}

/** Build a Vercel AI SDK LanguageModelV2 from resolved agent credential info */
export function buildProvider(info: {
  adapter_id: string
  fields: Record<string, string>
  metadata: Record<string, string>
  model_id: string | null
}): LanguageModel {
  const { adapter_id, fields, metadata, model_id } = info
  const modelId = model_id ?? ''

  switch (adapter_id) {
    case 'openai': {
      const provider = createOpenAI({
        apiKey: fields['api_key'] ?? '',
        ...(metadata['organization_id'] ? { organization: metadata['organization_id'] } : {}),
        ...(metadata['base_url'] ? { baseURL: metadata['base_url'] } : {}),
      })
      return provider(modelId)
    }

    case 'anthropic': {
      const provider = createAnthropic({
        apiKey: fields['api_key'] ?? '',
        ...(metadata['base_url'] ? { baseURL: metadata['base_url'] } : {}),
      })
      return provider(modelId)
    }

    case 'openrouter': {
      const provider = createOpenRouter({
        apiKey: fields['api_key'] ?? '',
        ...(metadata['site_url'] ? { siteUrl: metadata['site_url'] } : {}),
        ...(metadata['site_name'] ? { siteName: metadata['site_name'] } : {}),
      })
      return provider(modelId)
    }

    case 'ollama': {
      // Ollama is OpenAI-compatible
      const baseURL = (metadata['base_url'] ?? 'http://localhost:11434') + '/v1'
      const provider = createOpenAI({ apiKey: 'ollama', baseURL })
      return provider(modelId)
    }

    default:
      throw new Error(`buildProvider: unsupported adapter "${adapter_id}"`)
  }
}
