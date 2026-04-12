import { promises as fsp } from 'node:fs'
import { join, relative } from 'node:path'
import {
  SkillRegistry,
  parseSkillDoc,
  hashManifestSource,
  resolveEntrypoint,
} from '@jiku/core'
import type {
  PluginSkillSpec,
  SkillEntry,
  SkillFileCategory,
  SkillFileTree,
  SkillManifest,
  SkillSource,
} from '@jiku/types'
import {
  deactivateSkillsBySource,
  upsertSkillCache,
} from '@jiku-studio/db'
import { getFilesystemService } from '../filesystem/service.ts'

/**
 * Plan 19 Workstream B — Project-scoped skill loader.
 *
 * Source of truth: FS (under `/skills/<slug>/`) + plugin contributions.
 * DB `project_skills` rows are a CACHE keyed by (project_id, slug, source).
 *
 * Responsibilities:
 *  - scan FS → parse SKILL.md → upsert cache + registry
 *  - track plugin-registered skills (folder / inline) per plugin id
 *  - serve file reads for either source in `loadFile`/`buildFileTree`
 */

interface PluginFolderBinding {
  source: SkillSource
  plugin_id: string
  slug: string
  root: string            // absolute path on disk
  manifest: SkillManifest
  manifest_hash: string
}

interface PluginInlineBinding {
  source: SkillSource
  plugin_id: string
  slug: string
  manifest: SkillManifest
  manifest_hash: string
  files: Map<string, string>  // path -> content
}

type PluginBinding = PluginFolderBinding | PluginInlineBinding

const SKILLS_ROOT = '/skills'

export class SkillLoader {
  readonly registry = new SkillRegistry()
  private plugins = new Map<string, PluginBinding>() // key = `${source}::${slug}`

  constructor(public readonly projectId: string) {}

  // ── FS source ────────────────────────────────────────────────────────────

  /**
   * Scan `/skills/<slug>/SKILL.md` for each folder, parse manifests, upsert cache rows,
   * and rebuild the FS portion of the registry.
   * Returns the current registry snapshot (FS + plugin entries).
   */
  async syncFilesystem(): Promise<SkillEntry[]> {
    const fs = await getFilesystemService(this.projectId)
    if (!fs) {
      // No filesystem configured yet — clear FS entries and return what we have (plugin only)
      this.removeBySource('fs')
      return this.registry.list()
    }

    let roots: Array<{ path: string; type: string }>
    try {
      roots = await fs.list(SKILLS_ROOT)
    } catch {
      roots = []
    }

    const slugsSeen = new Set<string>()

    for (const entry of roots) {
      if (entry.type !== 'folder') continue
      const slug = entry.path.split('/').pop()
      if (!slug) continue

      const content = await this.readSkillManifestFile(fs, slug)
      if (!content) continue

      try {
        const { manifest } = parseSkillDoc(content)
        const manifest_hash = hashManifestSource(content)
        const entrypoint = resolveEntrypoint(manifest, _ => true)

        await upsertSkillCache({
          project_id: this.projectId,
          slug,
          source: 'fs',
          name: manifest.name,
          description: manifest.description,
          tags: manifest.tags ?? [],
          entrypoint,
          manifest: manifest as unknown,
          manifest_hash,
          active: true,
        })

        this.registry.upsert({
          slug,
          source: 'fs',
          plugin_id: null,
          manifest,
          manifest_hash,
          active: true,
          last_synced_at: new Date(),
        })
        slugsSeen.add(slug)
      } catch (err) {
        console.warn(`[skills] Invalid SKILL.md for "${slug}" in project ${this.projectId}:`, err instanceof Error ? err.message : err)
      }
    }

    // Remove FS registry entries for slugs that vanished from disk.
    for (const e of this.registry.list()) {
      if (e.source === 'fs' && !slugsSeen.has(e.slug)) {
        this.registry.remove('fs', e.slug)
      }
    }

    return this.registry.list()
  }

  private async readSkillManifestFile(
    fs: NonNullable<Awaited<ReturnType<typeof getFilesystemService>>>,
    slug: string,
  ): Promise<string | null> {
    for (const name of ['SKILL.md', 'index.md']) {
      try {
        const res = await fs.read(`${SKILLS_ROOT}/${slug}/${name}`)
        const text = typeof res === 'string' ? res : res?.content
        if (text) return text
      } catch { /* try next */ }
    }
    return null
  }

  // ── Plugin source ────────────────────────────────────────────────────────

  /**
   * Register a plugin-contributed skill. Idempotent per (plugin_id, slug, variant).
   * Call on plugin activate; call `unregisterPluginSkills(pluginId)` on deactivate.
   */
  async registerPluginSkill(pluginId: string, spec: PluginSkillSpec, pluginRoot?: string): Promise<void> {
    const source: SkillSource = `plugin:${pluginId}`

    if (spec.source === 'folder') {
      if (!pluginRoot) throw new Error('registerPluginSkill: pluginRoot is required for "folder" specs')
      const abs = join(pluginRoot, spec.path)
      const skillMd = await readFileIfExists(join(abs, 'SKILL.md'))
        ?? await readFileIfExists(join(abs, 'index.md'))
      if (!skillMd) throw new Error(`registerPluginSkill: no SKILL.md under ${abs}`)

      const { manifest } = parseSkillDoc(skillMd)
      const manifest_hash = hashManifestSource(skillMd)
      const binding: PluginFolderBinding = {
        source, plugin_id: pluginId, slug: spec.slug, root: abs, manifest, manifest_hash,
      }
      this.plugins.set(this.key(source, spec.slug), binding)
      await this.upsertPluginCache(binding)
      this.registry.upsert(this.entryFromBinding(binding))
      return
    }

    // inline
    const inlineMd = spec.files['SKILL.md'] ?? spec.files['index.md']
    if (!inlineMd) throw new Error('registerPluginSkill: inline files must include SKILL.md or index.md')
    const manifest_hash = hashManifestSource(inlineMd)
    const binding: PluginInlineBinding = {
      source,
      plugin_id: pluginId,
      slug: spec.slug,
      manifest: spec.manifest,
      manifest_hash,
      files: new Map(Object.entries(spec.files)),
    }
    this.plugins.set(this.key(source, spec.slug), binding)
    await this.upsertPluginCache(binding)
    this.registry.upsert(this.entryFromBinding(binding))
  }

  /** Mark every skill contributed by this plugin inactive (preserves agent_skills assignments). */
  async unregisterPluginSkills(pluginId: string): Promise<void> {
    const source: SkillSource = `plugin:${pluginId}`
    // Remove from in-memory registry + plugin map
    for (const [k, v] of this.plugins) {
      if (v.plugin_id === pluginId) {
        this.registry.remove(source, v.slug)
        this.plugins.delete(k)
      }
    }
    await deactivateSkillsBySource(this.projectId, source)
  }

  // ── Generic file access ──────────────────────────────────────────────────

  /** Load a file from either FS or a plugin source. */
  async loadFile(slug: string, source: SkillSource, path: string): Promise<string | null> {
    if (source === 'fs') {
      const fs = await getFilesystemService(this.projectId)
      if (!fs) return null
      try {
        const res = await fs.read(`${SKILLS_ROOT}/${slug}/${path}`)
        return typeof res === 'string' ? res : (res?.content ?? null)
      } catch { return null }
    }
    const binding = this.plugins.get(this.key(source, slug))
    if (!binding) return null
    if ('files' in binding) {
      return binding.files.get(path) ?? null
    }
    // folder binding
    return readFileIfExists(join(binding.root, path))
  }

  /**
   * Enumerate all files in a skill folder (for skill_list_files / skill_activate follow-ups).
   * Returns an SkillFileTree with the entrypoint pre-loaded.
   */
  async buildFileTree(slug: string, source: SkillSource): Promise<SkillFileTree | null> {
    const manifest = this.registry.get(source, slug)?.manifest
    const entrypointName = manifest ? resolveEntrypoint(manifest, _ => true) : 'SKILL.md'

    let files: Array<{ path: string; size_bytes: number }> = []
    let entrypointContent: string | null = null

    if (source === 'fs') {
      const fs = await getFilesystemService(this.projectId)
      if (!fs) return null
      try {
        const entries = await fs.list(`${SKILLS_ROOT}/${slug}`)
        const prefix = `${SKILLS_ROOT}/${slug}/`
        files = entries
          .filter(e => e.type === 'file')
          .map(e => ({
            path: e.path.startsWith(prefix) ? e.path.slice(prefix.length) : e.path,
            size_bytes: e.type === 'file' ? e.size_bytes : 0,
          }))
        const unwrap = (v: unknown): string | null =>
          typeof v === 'string' ? v : (v as { content?: string } | null)?.content ?? null
        entrypointContent = unwrap(await fs.read(`${SKILLS_ROOT}/${slug}/${entrypointName}`).catch(() => null))
        if (!entrypointContent) {
          // legacy fallback
          const md = files.find(f => f.path.endsWith('.md'))
          if (md) entrypointContent = unwrap(await fs.read(`${SKILLS_ROOT}/${slug}/${md.path}`).catch(() => null))
        }
      } catch {
        return null
      }
    } else {
      const binding = this.plugins.get(this.key(source, slug))
      if (!binding) return null
      if ('files' in binding) {
        files = [...binding.files.entries()].map(([path, content]) => ({
          path,
          size_bytes: Buffer.byteLength(content, 'utf8'),
        }))
        entrypointContent = binding.files.get(entrypointName) ?? binding.files.get('index.md') ?? null
      } else {
        const all = await walkDir(binding.root)
        files = all.map(p => ({
          path: relative(binding.root, p).replace(/\\/g, '/'),
          size_bytes: 0,
        }))
        // populate sizes
        for (const f of files) {
          try {
            const st = await fsp.stat(join(binding.root, f.path))
            f.size_bytes = st.size
          } catch { /* leave 0 */ }
        }
        entrypointContent = await readFileIfExists(join(binding.root, entrypointName))
          ?? await readFileIfExists(join(binding.root, 'index.md'))
      }
    }

    if (!entrypointContent) return null

    return {
      entrypoint: { path: entrypointName, content: entrypointContent },
      files: files.map(f => ({
        path: f.path,
        category: classify(f.path),
        size_bytes: f.size_bytes,
      })),
    }
  }

  // ── Internals ────────────────────────────────────────────────────────────

  private key(source: SkillSource, slug: string): string {
    return `${source}::${slug}`
  }

  private entryFromBinding(b: PluginBinding): SkillEntry {
    return {
      slug: b.slug,
      source: b.source,
      plugin_id: b.plugin_id,
      manifest: b.manifest,
      manifest_hash: b.manifest_hash,
      active: true,
      last_synced_at: new Date(),
    }
  }

  private async upsertPluginCache(b: PluginBinding): Promise<void> {
    const entrypoint = resolveEntrypoint(b.manifest, _ => true)
    await upsertSkillCache({
      project_id: this.projectId,
      slug: b.slug,
      source: b.source,
      plugin_id: b.plugin_id,
      name: b.manifest.name,
      description: b.manifest.description,
      tags: b.manifest.tags ?? [],
      entrypoint,
      manifest: b.manifest as unknown,
      manifest_hash: b.manifest_hash,
      active: true,
    })
  }

  private removeBySource(source: SkillSource): void {
    for (const e of this.registry.list()) {
      if (e.source === source) this.registry.remove(source, e.slug)
    }
  }
}

// ── module-level cache (one loader per project) ──────────────────────────────

const loaders = new Map<string, SkillLoader>()

export function getSkillLoader(projectId: string): SkillLoader {
  let l = loaders.get(projectId)
  if (!l) {
    l = new SkillLoader(projectId)
    loaders.set(projectId, l)
  }
  return l
}

// ── helpers ──────────────────────────────────────────────────────────────────

async function readFileIfExists(path: string): Promise<string | null> {
  try {
    return await fsp.readFile(path, 'utf8')
  } catch {
    return null
  }
}

async function walkDir(root: string): Promise<string[]> {
  const out: string[] = []
  async function rec(dir: string) {
    let entries: Array<{ name: string; isDirectory(): boolean; isFile(): boolean }> = []
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true }) as unknown as typeof entries
    } catch { return }
    for (const e of entries) {
      const p = join(dir, e.name)
      if (e.isDirectory()) await rec(p)
      else if (e.isFile()) out.push(p)
    }
  }
  await rec(root)
  return out
}

function classify(path: string): SkillFileCategory {
  const ext = path.toLowerCase().split('.').pop() ?? ''
  if (['md', 'markdown', 'txt', 'mdx'].includes(ext)) return 'markdown'
  if (['py', 'js', 'ts', 'sh', 'rb', 'go', 'rs', 'java', 'cpp', 'c', 'mjs', 'cjs'].includes(ext)) return 'code'
  if (['json', 'yaml', 'yml', 'toml', 'csv', 'xml', 'html', 'css'].includes(ext)) return 'asset'
  return 'binary'
}
