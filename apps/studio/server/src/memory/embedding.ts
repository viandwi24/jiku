import type { ResolvedMemoryConfig } from '@jiku/types'
import { recordLLMUsage } from '../usage/tracker.ts'

export interface EmbeddingService {
  embed(texts: string[]): Promise<number[][]>
  dimensions: number
}

/** Provider → base URL mapping for OpenAI-compatible embedding endpoints. */
const PROVIDER_ENDPOINTS: Record<string, string> = {
  openai: 'https://api.openai.com/v1/embeddings',
  openrouter: 'https://openrouter.ai/api/v1/embeddings',
}

/** Well-known embedding models with their dimensions. */
const MODEL_DIMENSIONS: Record<string, number> = {
  'text-embedding-3-small': 1536,
  'text-embedding-3-large': 3072,
  'text-embedding-ada-002': 1536,
  'openai/text-embedding-3-small': 1536,
  'openai/text-embedding-3-large': 3072,
}

// Cache per project to avoid re-resolving credentials on every call
const serviceCache = new Map<string, { service: EmbeddingService | null; cachedAt: number }>()
const CACHE_TTL_MS = 5 * 60 * 1000 // 5 minutes

/**
 * Create an embedding service from the project's memory config.
 * Reads embedding.provider, embedding.model, embedding.credential_id from the config.
 * Returns null if embedding is not enabled or not configured.
 */
export async function createEmbeddingService(projectId: string): Promise<EmbeddingService | null> {
  const cached = serviceCache.get(projectId)
  if (cached && Date.now() - cached.cachedAt < CACHE_TTL_MS) {
    return cached.service
  }

  let service: EmbeddingService | null = null

  try {
    // Load project memory config from DB
    const { getProjectById } = await import('@jiku-studio/db')
    const { DEFAULT_PROJECT_MEMORY_CONFIG } = await import('@jiku/core')
    const project = await getProjectById(projectId)
    const memoryConfig = (project?.memory_config as ResolvedMemoryConfig | null) ?? DEFAULT_PROJECT_MEMORY_CONFIG

    const embeddingConfig = memoryConfig.embedding
    if (!embeddingConfig?.enabled || !embeddingConfig.provider || !embeddingConfig.model) {
      serviceCache.set(projectId, { service: null, cachedAt: Date.now() })
      return null
    }

    // Resolve API key from credential
    const apiKey = await resolveApiKey(projectId, embeddingConfig.credential_id, embeddingConfig.provider)
    if (!apiKey) {
      console.warn(`[embedding] No API key found for provider "${embeddingConfig.provider}" in project ${projectId}`)
      serviceCache.set(projectId, { service: null, cachedAt: Date.now() })
      return null
    }

    const baseUrl = PROVIDER_ENDPOINTS[embeddingConfig.provider]
    if (!baseUrl) {
      console.warn(`[embedding] Unknown provider "${embeddingConfig.provider}" — no endpoint mapping`)
      serviceCache.set(projectId, { service: null, cachedAt: Date.now() })
      return null
    }

    const dimensions = embeddingConfig.dimensions
      || MODEL_DIMENSIONS[embeddingConfig.model]
      || 1536

    service = createOpenAICompatibleEmbedding(apiKey, baseUrl, embeddingConfig.model, dimensions, {
      projectId,
      provider: embeddingConfig.provider,
    })
  } catch (err) {
    console.warn('[embedding] Failed to create embedding service:', err instanceof Error ? err.message : err)
  }

  serviceCache.set(projectId, { service, cachedAt: Date.now() })
  return service
}

/** Clear cached embedding service for a project (call after config change). */
export function clearEmbeddingCache(projectId: string): void {
  serviceCache.delete(projectId)
}

/**
 * Resolve API key: try specific credential_id first, then find any credential matching the provider.
 */
async function resolveApiKey(
  projectId: string,
  credentialId: string | null,
  provider: string,
): Promise<string | null> {
  const { decryptFields } = await import('../credentials/encryption.ts')

  if (credentialId) {
    const { getCredentialById } = await import('@jiku-studio/db')
    const cred = await getCredentialById(credentialId)
    if (cred?.fields_encrypted) {
      const fields = decryptFields(cred.fields_encrypted)
      return fields.api_key ?? null
    }
  }

  // Fallback: find any credential for this provider (project + company level)
  const { getProjectById, getAvailableCredentials } = await import('@jiku-studio/db')
  const project = await getProjectById(projectId)
  const creds = await getAvailableCredentials(project?.company_id ?? '', projectId)
  const match = creds.find(c => c.adapter_id === provider)
  if (match?.fields_encrypted) {
    const fields = decryptFields(match.fields_encrypted)
    return fields.api_key ?? null
  }

  return null
}

function createOpenAICompatibleEmbedding(
  apiKey: string,
  baseUrl: string,
  model: string,
  dimensions: number,
  usageCtx: { projectId: string; provider: string },
): EmbeddingService {
  return {
    dimensions,
    async embed(texts: string[]): Promise<number[][]> {
      const t0 = Date.now()
      const response = await fetch(baseUrl, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ model, input: texts }),
      })

      if (!response.ok) {
        const body = await response.text().catch(() => '')
        throw new Error(`Embedding API error: ${response.status} ${response.statusText} — ${body.slice(0, 200)}`)
      }

      const data = await response.json() as {
        data: Array<{ embedding: number[] }>
        usage?: { prompt_tokens?: number; total_tokens?: number }
      }

      const inputTokens = data.usage?.prompt_tokens ?? data.usage?.total_tokens ?? 0
      recordLLMUsage({
        source: 'embedding',
        mode: 'embedding',
        project_id: usageCtx.projectId,
        provider: usageCtx.provider,
        model,
        input_tokens: inputTokens,
        output_tokens: 0,
        duration_ms: Date.now() - t0,
        raw_system_prompt: null,
        raw_messages: texts.map(t => ({ role: 'user', content: t })),
        raw_response: `vectors=${data.data.length}, dimensions=${dimensions}`,
      })

      return data.data.map(d => d.embedding)
    },
  }
}
