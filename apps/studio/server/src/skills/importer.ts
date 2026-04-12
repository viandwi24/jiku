import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import * as tar from 'tar'
import unzipper from 'unzipper'
import { parseSkillDoc } from '@jiku/core'
import { getFilesystemService } from '../filesystem/service.ts'
import { getSkillLoader } from './loader.ts'
import { findSkillBySlugAnySource } from '@jiku-studio/db'

/**
 * Plan 19 — Skill import (GitHub tarball + ZIP upload).
 *
 * Public-repo GitHub packages only for MVP. Output: writes all files to
 * `/skills/<slug>/` on the project filesystem and triggers a SkillLoader resync.
 */

export interface ImportResult {
  slug: string
  name: string
  files_count: number
  source_package: string
}

const MAX_FILES = 1000
const MAX_FILE_BYTES = 2 * 1024 * 1024 // 2MB per file
const MAX_TOTAL_BYTES = 20 * 1024 * 1024 // 20MB total

export async function importSkillFromGithub(
  projectId: string,
  spec: { owner: string; repo: string; subpath?: string; ref?: string; overwrite?: boolean },
): Promise<ImportResult> {
  const ref = spec.ref ?? 'HEAD'
  const url = `https://api.github.com/repos/${spec.owner}/${spec.repo}/tarball/${ref}`

  const res = await fetch(url, {
    headers: {
      'User-Agent': 'jiku-skill-importer',
      'Accept': 'application/vnd.github+json',
    },
    redirect: 'follow',
  })
  if (!res.ok) {
    throw new Error(`GitHub fetch failed: ${res.status} ${res.statusText}`)
  }
  if (!res.body) throw new Error('GitHub response has no body')

  const files = await extractTarball(res.body as unknown as ReadableStream<Uint8Array>)
  return finalizeImport(projectId, files, {
    overwrite: spec.overwrite,
    skillHint: spec.subpath,
    sourceLabel: `${spec.owner}/${spec.repo}${spec.subpath ? '/' + spec.subpath : ''}`,
  })
}

export async function importSkillFromZipBuffer(
  projectId: string,
  zipBuffer: Buffer,
  opts: { overwrite?: boolean; sourceLabel?: string } = {},
): Promise<ImportResult> {
  const files = await extractZip(zipBuffer)
  return finalizeImport(projectId, files, {
    overwrite: opts.overwrite,
    sourceLabel: opts.sourceLabel ?? 'zip-upload',
  })
}

// ── Extraction ──────────────────────────────────────────────────────────────

type ExtractedFiles = Map<string, Buffer> // path → content

async function extractTarball(webStream: ReadableStream<Uint8Array>): Promise<ExtractedFiles> {
  const files: ExtractedFiles = new Map()
  let totalBytes = 0

  // Node's `tar` lib understands gzipped input via `t()` on a stream.
  // We collect ALL files (minus the wrapping `<owner>-<repo>-<sha>/` prefix) and
  // resolve the skill root afterwards using skills.sh discovery rules.
  const extractor = tar.t({
    onentry: (entry) => {
      if (entry.type !== 'File') { entry.resume(); return }
      const parts = entry.path.split('/')
      parts.shift()  // drop the wrapper folder GitHub adds
      const rel = parts.join('/')
      if (!rel) { entry.resume(); return }
      if (files.size >= MAX_FILES) { entry.resume(); return }
      const chunks: Buffer[] = []
      let bytes = 0
      entry.on('data', (chunk: Buffer) => {
        bytes += chunk.length
        totalBytes += chunk.length
        if (bytes > MAX_FILE_BYTES || totalBytes > MAX_TOTAL_BYTES) {
          entry.resume()
          return
        }
        chunks.push(chunk)
      })
      entry.on('end', () => {
        if (bytes <= MAX_FILE_BYTES) files.set(rel, Buffer.concat(chunks))
      })
    },
  })

  const nodeStream = Readable.fromWeb(webStream as unknown as import('node:stream/web').ReadableStream<Uint8Array>)
  await pipeline(nodeStream, extractor)
  return files
}

async function extractZip(buffer: Buffer): Promise<ExtractedFiles> {
  const files: ExtractedFiles = new Map()
  let totalBytes = 0
  const directory = await unzipper.Open.buffer(buffer)
  for (const f of directory.files) {
    if (f.type !== 'File') continue
    if (files.size >= MAX_FILES) break
    const content = await f.buffer()
    if (content.length > MAX_FILE_BYTES) continue
    totalBytes += content.length
    if (totalBytes > MAX_TOTAL_BYTES) break
    files.set(f.path, content)
  }
  return files
}

// ── Finalize ────────────────────────────────────────────────────────────────

async function finalizeImport(
  projectId: string,
  files: ExtractedFiles,
  opts: { overwrite?: boolean; sourceLabel: string; skillHint?: string },
): Promise<ImportResult> {
  const chosen = resolveSkillRoot(files, opts.skillHint)
  if (!chosen) {
    const available = listAllSkillRoots(files).map(r => r.root.replace(/\/$/, '') || '(root)').slice(0, 10)
    const hint = available.length > 0
      ? `Available skills in this repo: ${available.join(', ')}. Try "owner/repo/<name>" with one of these.`
      : 'No SKILL.md found in standard locations (skills/, skills/.curated/, .claude/skills/, root).'
    throw new Error(hint)
  }

  const manifestContent = files.get(chosen.manifestPath)!.toString('utf8')
  const { manifest } = parseSkillDoc(manifestContent)

  const slug = kebab(manifest.name) || chosen.root.split('/').filter(Boolean).pop() || 'imported-skill'

  // Collision check: if FS-sourced skill exists in this project, require overwrite flag.
  if (!opts.overwrite) {
    const existing = await findSkillBySlugAnySource(projectId, slug)
    if (existing.some(e => e.source === 'fs')) {
      throw new Error(`Skill "${slug}" already exists. Pass overwrite=true to replace it.`)
    }
  }

  const fs = await getFilesystemService(projectId)
  if (!fs) throw new Error('Project filesystem is not configured — cannot import skills')

  let writeCount = 0
  for (const [path, content] of files) {
    // Only include files under the chosen skill root
    if (chosen.root && !path.startsWith(chosen.root)) continue
    const rel = chosen.root ? path.slice(chosen.root.length) : path
    if (!rel) continue
    const target = `/skills/${slug}/${rel}`
    try {
      await fs.write(target, content.toString('utf8'))
      writeCount++
    } catch (err) {
      console.warn(`[skills:import] failed to write ${target}:`, err instanceof Error ? err.message : err)
    }
  }

  // Trigger SkillLoader sync so the DB cache is populated immediately.
  await getSkillLoader(projectId).syncFilesystem()

  return {
    slug,
    name: manifest.name,
    files_count: writeCount,
    source_package: opts.sourceLabel,
  }
}

/**
 * skills.sh / vercel-labs convention: look up a named skill across standard
 * directories. Ordered by preference (see https://github.com/vercel-labs/skills).
 */
const STANDARD_SKILL_DIRS = [
  '',                        // root SKILL.md
  'skills/',
  'skills/.curated/',
  'skills/.experimental/',
  'skills/.system/',
  '.agents/skills/',
  '.claude/skills/',
  '.cursor/skills/',
  '.codex/skills/',
  '.cline/skills/',
]

interface SkillRoot { root: string; manifestPath: string }

function listAllSkillRoots(files: ExtractedFiles): SkillRoot[] {
  const out: SkillRoot[] = []
  for (const p of files.keys()) {
    if (p === 'SKILL.md') out.push({ root: '', manifestPath: p })
    else if (p.endsWith('/SKILL.md')) out.push({ root: p.slice(0, -'SKILL.md'.length), manifestPath: p })
    else if (p === 'index.md') out.push({ root: '', manifestPath: p })
    else if (p.endsWith('/index.md')) out.push({ root: p.slice(0, -'index.md'.length), manifestPath: p })
  }
  return out
}

/**
 * Resolve the skill root given:
 *   - `hint` (user-supplied subpath): may be a literal path like "skills/foo" OR
 *     just a skill name like "foo" (matching `--skill <name>`).
 *   - All files from the tarball.
 *
 * Priority:
 *   1. Exact literal match for `hint/SKILL.md` (or `index.md`).
 *   2. Treat the last segment of `hint` as a skill NAME and try each standard dir.
 *   3. Recursive fallback: any directory whose basename equals the name.
 *   4. No hint: root SKILL.md if present; else error (ambiguous).
 */
function resolveSkillRoot(files: ExtractedFiles, hint?: string): SkillRoot | null {
  const all = listAllSkillRoots(files)
  if (all.length === 0) return null

  const clean = (hint ?? '').replace(/^\/|\/$/g, '')
  if (!clean) {
    // No hint — accept only root or single-skill packages.
    const rootMatch = all.find(r => r.root === '')
    if (rootMatch) return rootMatch
    if (all.length === 1) return all[0]!
    return null
  }

  // (1) Literal path match
  const literal = all.find(r => {
    const rootNoSlash = r.root.replace(/\/$/, '')
    return rootNoSlash === clean
  })
  if (literal) return literal

  // (2) Standard-dir lookup by skill name (the LAST segment of the hint)
  const name = clean.split('/').pop()!
  for (const dir of STANDARD_SKILL_DIRS) {
    const target = dir + name
    const match = all.find(r => r.root.replace(/\/$/, '') === target)
    if (match) return match
  }

  // (3) Recursive fallback — any folder ending in `/name` with a SKILL.md
  const recursive = all.find(r => {
    const rootNoSlash = r.root.replace(/\/$/, '')
    return rootNoSlash === name || rootNoSlash.endsWith('/' + name)
  })
  if (recursive) return recursive

  return null
}

function trimEnd(s: string, suffix: string): string {
  return s.endsWith(suffix) ? s.slice(0, -suffix.length) : s
}

function kebab(s: string): string {
  return s
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-zA-Z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .toLowerCase()
    .slice(0, 64)
}

/**
 * Parse a package spec into its GitHub coordinates. Accepts several shapes:
 *   - `owner/repo`
 *   - `owner/repo/subpath`
 *   - `owner/repo/subpath@ref`
 *   - `https://github.com/owner/repo`
 *   - `https://github.com/owner/repo/tree/<ref>/subpath...`
 *   - `https://skills.sh/owner/repo/subpath` (skills.sh shares the GitHub layout)
 */
export function parseGithubPackageSpec(input: string): {
  owner: string
  repo: string
  subpath?: string
  ref?: string
} {
  let rest = input.trim()

  // Accept full `npx skills add <url> --skill <name>` form (also `skills add …`,
  // `pnpx skills add …`, with optional `-s` shorthand and `--ref <ref>`).
  // We extract the URL + `--skill` value and rebuild a canonical spec.
  const npxMatch = rest.match(/^(?:n?p?npx|pnpx|bunx|yarn\s+dlx)?\s*skills\s+add\s+(.+)$/i)
  if (npxMatch) {
    const argstr = npxMatch[1]!
    const tokens = argstr.match(/"[^"]*"|'[^']*'|\S+/g) ?? []
    let urlTok: string | undefined
    let skillArg: string | undefined
    let refArg: string | undefined
    for (let i = 0; i < tokens.length; i++) {
      const t = tokens[i]!.replace(/^['"]|['"]$/g, '')
      if (t === '--skill' || t === '-s') { skillArg = tokens[++i]?.replace(/^['"]|['"]$/g, ''); continue }
      if (t.startsWith('--skill=')) { skillArg = t.slice('--skill='.length); continue }
      if (t === '--ref' || t === '--branch' || t === '--tag') { refArg = tokens[++i]?.replace(/^['"]|['"]$/g, ''); continue }
      if (t.startsWith('--')) continue  // ignore other flags
      if (!urlTok) urlTok = t
    }
    if (!urlTok) throw new Error('Could not parse `npx skills add` — missing repo URL')
    rest = urlTok
    if (skillArg) rest = rest.replace(/\/$/, '') + '/' + skillArg
    if (refArg) rest = rest + '@' + refArg
  }

  // Strip scheme + known hosts
  rest = rest.replace(/^https?:\/\//, '')
  rest = rest.replace(/^(www\.)?(github\.com|skills\.sh)\//, '')
  // Drop .git suffix if present (GitHub clone URL form)
  rest = rest.replace(/\.git(\/.*)?$/, '$1')

  // Extract `@ref` only when it trails a path component, not an email-like token
  let ref: string | undefined
  const atIdx = rest.lastIndexOf('@')
  if (atIdx > 0 && !rest.slice(atIdx + 1).includes('/')) {
    ref = rest.slice(atIdx + 1)
    rest = rest.slice(0, atIdx)
  }

  const parts = rest.split('/').filter(Boolean)
  if (parts.length < 2) {
    throw new Error('Package spec must be "owner/repo[/subpath]" or a GitHub/skills.sh URL')
  }
  const [owner, repo, ...subparts] = parts as [string, string, ...string[]]

  // Handle GitHub `tree/<ref>/...` in URLs
  if (subparts[0] === 'tree' && subparts.length >= 2) {
    ref = ref ?? subparts[1]
    subparts.splice(0, 2)
  } else if (subparts[0] === 'blob' && subparts.length >= 2) {
    // e.g. /blob/main/path/to/file.md — treat as ref + subpath
    ref = ref ?? subparts[1]
    subparts.splice(0, 2)
  }

  return {
    owner,
    repo,
    ...(subparts.length > 0 ? { subpath: subparts.join('/') } : {}),
    ...(ref ? { ref } : {}),
  }
}
