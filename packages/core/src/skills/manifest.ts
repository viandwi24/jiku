import { parse as parseYaml } from 'yaml'
import type { SkillManifest } from '@jiku/types'

/**
 * Plan 19 — Parse a SKILL.md file containing YAML frontmatter + markdown body.
 *
 * Format (compatible with skills.sh / vercel-labs/agent-skills):
 * ---
 * name: "Name"
 * description: "..."
 * tags: [a, b]
 * metadata: { jiku: { ... } }
 * ---
 * # Body markdown...
 */
export interface ParsedSkillDoc {
  manifest: SkillManifest
  body: string
}

const FRONTMATTER_RE = /^---\s*\r?\n([\s\S]*?)\r?\n---\s*\r?\n?([\s\S]*)$/

export function parseSkillDoc(content: string): ParsedSkillDoc {
  const match = content.match(FRONTMATTER_RE)
  if (!match) {
    throw new Error('Skill manifest missing: expected YAML frontmatter delimited by "---"')
  }
  const rawYaml = match[1] ?? ''
  const body = match[2] ?? ''

  let parsed: unknown
  try {
    parsed = parseYaml(rawYaml)
  } catch (err) {
    throw new Error(`Skill frontmatter is invalid YAML: ${err instanceof Error ? err.message : String(err)}`)
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Skill frontmatter must be a YAML object')
  }

  const obj = parsed as Record<string, unknown>
  const name = obj['name']
  const description = obj['description']
  if (typeof name !== 'string' || !name.trim()) {
    throw new Error('Skill frontmatter: `name` is required and must be a non-empty string')
  }
  if (typeof description !== 'string' || !description.trim()) {
    throw new Error('Skill frontmatter: `description` is required and must be a non-empty string')
  }

  const tags = Array.isArray(obj['tags'])
    ? (obj['tags'] as unknown[]).filter((t): t is string => typeof t === 'string')
    : undefined

  const metadata = isPlainObject(obj['metadata']) ? (obj['metadata'] as SkillManifest['metadata']) : undefined

  const manifest: SkillManifest = {
    name: name.trim(),
    description: description.trim(),
    ...(tags && tags.length > 0 ? { tags } : {}),
    ...(metadata ? { metadata } : {}),
  }
  return { manifest, body }
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v)
}

/** Simple stable SHA-ish hash — djb2 32-bit, base36. Good enough for cache invalidation. */
export function hashManifestSource(content: string): string {
  let h = 5381
  for (let i = 0; i < content.length; i++) h = ((h << 5) + h + content.charCodeAt(i)) | 0
  return (h >>> 0).toString(36)
}

/** Resolve which entry file a skill uses. Default "SKILL.md" with legacy "index.md" fallback. */
export function resolveEntrypoint(manifest: SkillManifest, fallbackExists: (path: string) => boolean): string {
  const explicit = manifest.metadata?.jiku?.entrypoint
  if (explicit) return explicit
  if (fallbackExists('SKILL.md')) return 'SKILL.md'
  if (fallbackExists('index.md')) return 'index.md'
  return 'SKILL.md'
}
