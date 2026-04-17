// Resolve a discriminated `source` input to the actual code string + language
// that the sandbox runner will evaluate. Centralises the three-mode dispatch
// so the tool handler stays small.

import type { LLMBridge, PluginStorageAPI } from '@jiku/types'
import { loadFromPath } from './from-path.ts'
import { generateFromPrompt } from './from-prompt.ts'
import type { SandboxMode } from '../types.ts'

export type SourceInput =
  | { type: 'code'; code: string; language?: 'js' | 'ts' }
  | { type: 'path'; path: string }
  | { type: 'prompt'; prompt: string; context?: Record<string, unknown> }

export interface ResolveArgs {
  source: SourceInput
  llm?: LLMBridge
  llmOverride?: { provider: string; model: string }
  storage: PluginStorageAPI
  allowedPathRoots: string[]
  promptCacheTtlMs: number
}

export interface ResolvedSource {
  mode: SandboxMode
  code: string
  language: 'js' | 'ts'
  /** Only populated for path/prompt — the exact text that will be evaluated */
  executedCodePreview: string
  /** Extra metadata to surface back to the caller */
  cached?: boolean
  resolvedPath?: string
}

export async function resolveSource(args: ResolveArgs): Promise<ResolvedSource> {
  const { source } = args

  if (source.type === 'code') {
    return {
      mode: 'code',
      code: source.code,
      language: source.language ?? 'js',
      executedCodePreview: source.code,
    }
  }

  if (source.type === 'path') {
    const loaded = await loadFromPath(source.path, args.allowedPathRoots)
    return {
      mode: 'path',
      code: loaded.code,
      language: loaded.language,
      executedCodePreview: loaded.code,
      resolvedPath: loaded.resolvedPath,
    }
  }

  // prompt mode
  if (!args.llm) {
    throw new Error('prompt mode requires ctx.llm — ensure RuntimeContext.llm is populated')
  }
  const gen = await generateFromPrompt({
    prompt: source.prompt,
    llm: args.llm,
    llmOverride: args.llmOverride,
    context: source.context,
    storage: args.storage,
    cacheTtlMs: args.promptCacheTtlMs,
  })
  // If context was supplied, inject it as a global `ctx` binding before the
  // generated code runs. The generator's system prompt documents this global.
  const preamble = source.context
    ? `const ctx = ${JSON.stringify(source.context)};\n`
    : ''
  return {
    mode: 'prompt',
    code: preamble + gen.code,
    language: 'js',
    executedCodePreview: gen.code,
    cached: gen.cached,
  }
}
