import { parse as parseYaml } from 'yaml'
import type { CommandManifest, CommandArgSpec } from '@jiku/types'

/**
 * Plan 24 — Parse COMMAND.md (YAML frontmatter + markdown body).
 *
 * Example:
 * ---
 * name: "Marketing Channel Execute"
 * description: "Run scheduled marketing post"
 * tags: [marketing]
 * args:
 *   - name: raw
 *     description: "Natural language instruction"
 * metadata:
 *   jiku:
 *     emoji: "📣"
 *     entrypoint: COMMAND.md
 * ---
 *
 * # Body instructions for the agent...
 */
export interface ParsedCommandDoc {
  manifest: CommandManifest
  body: string
}

const FRONTMATTER_RE = /^---\s*\r?\n([\s\S]*?)\r?\n---\s*\r?\n?([\s\S]*)$/

export function parseCommandDoc(content: string): ParsedCommandDoc {
  const match = content.match(FRONTMATTER_RE)
  if (!match) {
    throw new Error('Command manifest missing: expected YAML frontmatter delimited by "---"')
  }
  const rawYaml = match[1] ?? ''
  const body = match[2] ?? ''

  let parsed: unknown
  try {
    parsed = parseYaml(rawYaml)
  } catch (err) {
    throw new Error(`Command frontmatter is invalid YAML: ${err instanceof Error ? err.message : String(err)}`)
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Command frontmatter must be a YAML object')
  }

  const obj = parsed as Record<string, unknown>
  const name = obj['name']
  const description = obj['description']
  if (typeof name !== 'string' || !name.trim()) {
    throw new Error('Command frontmatter: `name` is required and must be a non-empty string')
  }
  if (typeof description !== 'string' || !description.trim()) {
    throw new Error('Command frontmatter: `description` is required and must be a non-empty string')
  }

  const tags = Array.isArray(obj['tags'])
    ? (obj['tags'] as unknown[]).filter((t): t is string => typeof t === 'string')
    : undefined

  const args = parseArgs(obj['args'])
  const metadata = isPlainObject(obj['metadata']) ? (obj['metadata'] as CommandManifest['metadata']) : undefined

  const manifest: CommandManifest = {
    name: name.trim(),
    description: description.trim(),
    ...(tags && tags.length > 0 ? { tags } : {}),
    ...(args && args.length > 0 ? { args } : {}),
    ...(metadata ? { metadata } : {}),
  }
  return { manifest, body }
}

function parseArgs(raw: unknown): CommandArgSpec[] | undefined {
  if (!Array.isArray(raw)) return undefined
  const out: CommandArgSpec[] = []
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue
    const o = entry as Record<string, unknown>
    if (typeof o['name'] !== 'string' || !o['name'].trim()) continue
    const spec: CommandArgSpec = { name: o['name'].trim() }
    if (typeof o['description'] === 'string') spec.description = o['description']
    if (o['type'] === 'string' || o['type'] === 'number' || o['type'] === 'boolean') spec.type = o['type']
    if (typeof o['required'] === 'boolean') spec.required = o['required']
    out.push(spec)
  }
  return out
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v)
}

/** Resolve entrypoint: explicit metadata override, else COMMAND.md, else index.md. */
export function resolveCommandEntrypoint(manifest: CommandManifest, fallbackExists: (path: string) => boolean): string {
  const explicit = manifest.metadata?.jiku?.entrypoint
  if (explicit) return explicit
  if (fallbackExists('COMMAND.md')) return 'COMMAND.md'
  if (fallbackExists('index.md')) return 'index.md'
  return 'COMMAND.md'
}
