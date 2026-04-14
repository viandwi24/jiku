import { getFileByPath } from '@jiku-studio/db'
import { audit } from '../audit/logger.ts'

/**
 * Plan 25 — Reference hint provider (@file).
 *
 * Scan input text for `@path/to/file` mentions. For each match, verify the file
 * exists in the project's virtual disk and inject a concise `<user_references>`
 * notice listing matches + missing paths. Does NOT read file contents — agent
 * uses `fs_read` on-demand, keeping token cost low.
 *
 * Rules:
 *  - `@x/y`       → workspace-root absolute "/x/y"
 *  - `@/x`        → workspace-root absolute "/x"
 *  - `@./x`       → not-supported in this minimal impl; treated as literal skip
 *  - `@../x`      → rejected (escape)
 *  - `\@foo`      → literal, not scanned
 *  - Non-path-like `@alice` → resolver fails, silently dropped
 *  - Cap at 20 matches per invocation
 */

const MAX_REFS = 20
const LARGE_FILE_BYTES = 1_048_576 // 1 MB — tag hint note

// @<path> where path is at least one slash or dot segment. Exclude purely
// alphanumeric usernames (@alice) from the manifest by requiring a `/` or `.`.
const REFERENCE_RE = /(^|[^\w\\])@([A-Za-z0-9_.\-/][A-Za-z0-9_.\-/]*)/g

export interface ReferenceMatch {
  raw: string         // e.g. "plans/marketing-channel.md"
  path: string        // normalized absolute workspace path "/plans/marketing-channel.md"
  status: 'ok' | 'not_found' | 'rejected'
  size_bytes?: number
  is_large?: boolean
  updated_at?: Date | null
}

export interface ReferenceScanResult {
  matches: ReferenceMatch[]
  hintBlock: string | null
}

function normalizeReferencePath(raw: string): string | null {
  if (raw.startsWith('./')) return null // relative-to-caller not supported in MVP
  if (raw.startsWith('../')) return null // escape
  const clean = raw.startsWith('/') ? raw : `/${raw}`
  // Reject `..` segments anywhere.
  const parts = clean.split('/').filter(Boolean)
  if (parts.some(p => p === '..' || p === '.')) return null
  if (parts.length === 0) return null
  // Must look like a file or nested path (contain `.` extension OR at least one slash).
  const last = parts[parts.length - 1] ?? ''
  const hasDot = last.includes('.')
  if (parts.length === 1 && !hasDot) return null
  return '/' + parts.join('/')
}

export async function scanReferences(opts: {
  projectId: string
  text: string
  userId?: string | null
  surface: 'chat' | 'cron' | 'task' | 'heartbeat' | 'connector' | 'command_body'
}): Promise<ReferenceScanResult> {
  const { projectId, text, userId, surface } = opts
  if (!text || !text.includes('@')) return { matches: [], hintBlock: null }

  const matches: ReferenceMatch[] = []
  const seen = new Set<string>()

  REFERENCE_RE.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = REFERENCE_RE.exec(text))) {
    if (matches.length >= MAX_REFS) break
    const raw = m[2] ?? ''
    if (!raw) continue
    // Strip trailing punctuation commonly attached in prose.
    const trimmed = raw.replace(/[.,;:!?)\]]+$/, '')
    if (!trimmed) continue
    const norm = normalizeReferencePath(trimmed)
    if (!norm) continue
    if (seen.has(norm)) continue
    seen.add(norm)
    matches.push({ raw: trimmed, path: norm, status: 'not_found' })
  }

  // Validate each match against the project filesystem (stat only).
  for (const ref of matches) {
    try {
      const file = await getFileByPath(projectId, ref.path)
      if (file) {
        ref.status = 'ok'
        ref.size_bytes = file.size_bytes
        ref.updated_at = file.updated_at
        ref.is_large = file.size_bytes > LARGE_FILE_BYTES
      }
    } catch {
      // remain not_found
    }
  }

  const ok = matches.filter(r => r.status === 'ok')
  const missing = matches.filter(r => r.status === 'not_found')

  audit.referenceScan(
    { actor_id: userId ?? null, actor_type: userId ? 'user' : 'system', project_id: projectId },
    { surface, total: matches.length, ok: ok.length, missing: missing.length },
  )

  if (matches.length === 0) return { matches: [], hintBlock: null }

  const lines: string[] = ['<user_references>']
  lines.push('User / context is referencing the following files from the project workspace disk.')
  lines.push('These files are available — use the `fs_read` tool to read their contents as needed. Do NOT ask the user to paste them.')
  lines.push('')
  if (ok.length > 0) {
    for (const r of ok) {
      const size = r.size_bytes !== undefined ? `${formatBytes(r.size_bytes)}` : ''
      const large = r.is_large ? ' LARGE — use offset/limit when fs_read-ing' : ''
      const mtime = r.updated_at ? `, updated ${r.updated_at.toISOString?.().slice(0, 10) ?? ''}` : ''
      lines.push(`- ${r.path}${size ? ` (${size}${mtime})` : ''}${large}`)
    }
  }
  if (missing.length > 0) {
    lines.push('')
    lines.push('The following were mentioned but are NOT present on the disk:')
    for (const r of missing) lines.push(`- ${r.path} — not found`)
  }
  lines.push('</user_references>')

  return { matches, hintBlock: lines.join('\n') }
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n}B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}KB`
  return `${(n / 1024 / 1024).toFixed(1)}MB`
}
