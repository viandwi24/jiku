import type { LanguageModel } from 'ai'
import type { ModelProviderDefinition } from '@jiku/types'

export class ModelProviders {
  private readonly _defs: Map<string, ModelProviderDefinition>
  private readonly _defaultId: string | null

  constructor(
    providers: Record<string, ModelProviderDefinition> = {},
    defaultId?: string,
  ) {
    this._defs = new Map(Object.entries(providers))
    this._defaultId = defaultId ?? (Object.keys(providers)[0] ?? null)
  }

  resolve(provider_id?: string, model_id?: string): LanguageModel {
    const pid = provider_id ?? this._defaultId
    if (!pid) throw new Error('[jiku] No model provider configured.')

    const def = this._defs.get(pid)
    if (!def) throw new Error(`[jiku] Unknown provider '${pid}'. Registered: ${[...this._defs.keys()].join(', ')}`)

    if (!model_id) throw new Error(`[jiku] model_id is required when using provider '${pid}'.`)

    return def.getModel(model_id) as LanguageModel
  }

  has(id: string): boolean {
    return this._defs.has(id)
  }

  get defaultId(): string | null {
    return this._defaultId
  }
}

// ============================================================
// Provider factory helpers
// ============================================================

/**
 * Create a provider definition from any @ai-sdk/* provider factory.
 *
 * Usage:
 *   import { createOpenAI } from '@ai-sdk/openai'
 *   const openai = createProviderDef('openai', createOpenAI({ apiKey: '...' }))
 */
export function createProviderDef(
  id: string,
  provider: { languageModel: (modelId: string) => LanguageModel },
): ModelProviderDefinition {
  return {
    id,
    getModel: (model_id) => provider.languageModel(model_id),
  }
}
