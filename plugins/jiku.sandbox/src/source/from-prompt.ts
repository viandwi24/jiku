// Generate sandbox-runnable code from a natural-language prompt.
//
// Uses the LLM bridge on RuntimeContext (inherited from the calling agent,
// optionally overridden via plugin config). Output is expected to be a
// self-contained JS snippet — the system prompt constrains the model to
// return raw code only (no markdown fences, no commentary).
//
// Generated code is cached in plugin storage keyed by
// sha256(prompt + model + system_version) with TTL. A hit skips the LLM call
// entirely, making repeat "prompt" runs nearly free.

import { createHash } from 'node:crypto'
import type { LLMBridge, PluginStorageAPI } from '@jiku/types'

const SYSTEM_PROMPT_VERSION = 'v1'

const SYSTEM_PROMPT = `You are a code generator for a sandboxed QuickJS environment.

Respond with ONE self-contained JavaScript snippet that fulfills the user's goal. Rules:
- Output raw JavaScript only — NO markdown fences, NO prose, NO \`\`\`js wrappers.
- ES2020+ is fine. The sandbox has NO Node APIs (no fs/net/process/require/import).
- Available globals: \`console.log/warn/error\` (captured into logs), \`Math\`, \`Date\`, \`JSON\`, \`Array\`, \`Object\`, \`String\`, \`Number\`, \`Promise\`.
- The LAST expression is captured as the output. Or call \`__jiku_result(value)\` explicitly.
- Throw on unrecoverable errors — the sandbox catches and reports them.
- If the user supplied \`context\`, it is available as the global \`ctx\`.

Return ONLY the code.`

export interface GenerateFromPromptArgs {
  prompt: string
  llm: LLMBridge
  llmOverride?: { provider: string; model: string }
  context?: Record<string, unknown>
  storage: PluginStorageAPI
  cacheTtlMs: number
}

export interface GenerateFromPromptResult {
  code: string
  cached: boolean
}

interface CacheEntry {
  code: string
  written_at: number
}

function cacheKey(prompt: string, model: string | undefined): string {
  const h = createHash('sha256')
  h.update(SYSTEM_PROMPT_VERSION)
  h.update('\x00')
  h.update(model ?? 'inherit')
  h.update('\x00')
  h.update(prompt)
  return `prompt-cache:${h.digest('hex')}`
}

function stripCodeFences(raw: string): string {
  const trimmed = raw.trim()
  const fence = /^```(?:js|javascript|ts|typescript)?\n([\s\S]*?)\n```$/i.exec(trimmed)
  if (fence) return fence[1]!.trim()
  return trimmed
}

export async function generateFromPrompt(
  args: GenerateFromPromptArgs,
): Promise<GenerateFromPromptResult> {
  const model = args.llmOverride?.model
  const key = cacheKey(args.prompt, model)

  if (args.cacheTtlMs > 0) {
    const hit = (await args.storage.get(key)) as CacheEntry | null
    if (hit && Date.now() - hit.written_at < args.cacheTtlMs) {
      return { code: hit.code, cached: true }
    }
  }

  const userPrompt = args.context
    ? `Goal: ${args.prompt}\n\nAvailable \`ctx\`:\n${JSON.stringify(args.context, null, 2)}`
    : args.prompt

  const raw = await args.llm.generate(userPrompt, {
    system: SYSTEM_PROMPT,
    provider: args.llmOverride?.provider,
    model: args.llmOverride?.model,
    temperature: 0,
    maxTokens: 2048,
  })

  const code = stripCodeFences(raw)

  if (args.cacheTtlMs > 0) {
    const entry: CacheEntry = { code, written_at: Date.now() }
    await args.storage.set(key, entry)
  }

  return { code, cached: false }
}
