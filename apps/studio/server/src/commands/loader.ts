import { promises as fsp } from 'node:fs'
import { join, relative } from 'node:path'
import {
  CommandRegistry,
  parseCommandDoc,
  hashManifestSource,
  resolveCommandEntrypoint,
} from '@jiku/core'
import type {
  CommandEntry,
  CommandFileTree,
  CommandManifest,
  CommandSource,
  PluginCommandSpec,
  SkillFileCategory,
} from '@jiku/types'
import {
  deactivateCommandsBySource,
  deactivateCommandBySlug,
  upsertCommandCache,
} from '@jiku-studio/db'
import { getFilesystemService } from '../filesystem/service.ts'

/**
 * Plan 24 — Project-scoped command loader.
 * FS layout: `/commands/<slug>/COMMAND.md` (folder) or `/commands/<slug>.md` (single file).
 * Mirrors SkillLoader. Cache keyed by (project_id, slug, source).
 */

interface PluginFolderBinding {
  source: CommandSource
  plugin_id: string
  slug: string
  root: string
  manifest: CommandManifest
  manifest_hash: string
}

interface PluginInlineBinding {
  source: CommandSource
  plugin_id: string
  slug: string
  manifest: CommandManifest
  manifest_hash: string
  files: Map<string, string>
}

type PluginBinding = PluginFolderBinding | PluginInlineBinding

const COMMANDS_ROOT = '/commands'

export class CommandLoader {
  readonly registry = new CommandRegistry()
  private plugins = new Map<string, PluginBinding>()
  // Cache body by (source, slug) so dispatcher can skip re-reading on hot path.
  private bodyCache = new Map<string, { hash: string; body: string }>()

  constructor(public readonly projectId: string) {}

  async syncFilesystem(): Promise<CommandEntry[]> {
    const fs = await getFilesystemService(this.projectId)
    if (!fs) {
      this.removeBySource('fs')
      return this.registry.list()
    }

    let roots: Array<{ path: string; type: string }>
    try {
      roots = await fs.list(COMMANDS_ROOT)
    } catch {
      roots = []
    }

    const slugsSeen = new Set<string>()

    for (const entry of roots) {
      let slug: string | undefined
      let content: string | null = null

      if (entry.type === 'folder') {
        slug = entry.path.split('/').pop()
        if (!slug) continue
        content = await this.readFolderManifest(fs, slug)
      } else if (entry.type === 'file' && entry.path.endsWith('.md')) {
        const base = entry.path.split('/').pop() ?? ''
        slug = base.replace(/\.md$/, '')
        if (!slug) continue
        try {
          const res = await fs.read(entry.path)
          content = typeof res === 'string' ? res : (res?.content ?? null)
        } catch {}
      }

      if (!slug || !content) continue

      try {
        const { manifest, body } = parseCommandDoc(content)
        const manifest_hash = hashManifestSource(content)
        const entrypoint = resolveCommandEntrypoint(manifest, _ => true)

        await upsertCommandCache({
          project_id: this.projectId,
          slug,
          source: 'fs',
          name: manifest.name,
          description: manifest.description,
          tags: manifest.tags ?? [],
          entrypoint,
          args_schema: manifest.args ?? [],
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
        this.bodyCache.set(this.key('fs', slug), { hash: manifest_hash, body })
        slugsSeen.add(slug)
      } catch (err) {
        console.warn(`[commands] Invalid command manifest for "${slug}" in project ${this.projectId}:`, err instanceof Error ? err.message : err)
      }
    }

    for (const e of this.registry.list()) {
      if (e.source === 'fs' && !slugsSeen.has(e.slug)) {
        this.registry.remove('fs', e.slug)
        this.bodyCache.delete(this.key('fs', e.slug))
        deactivateCommandBySlug(this.projectId, e.slug).catch(err =>
          console.warn(`[commands] failed to deactivate stale command "${e.slug}":`, err),
        )
      }
    }

    return this.registry.list()
  }

  private async readFolderManifest(
    fs: NonNullable<Awaited<ReturnType<typeof getFilesystemService>>>,
    slug: string,
  ): Promise<string | null> {
    for (const name of ['COMMAND.md', 'index.md']) {
      try {
        const res = await fs.read(`${COMMANDS_ROOT}/${slug}/${name}`)
        const text = typeof res === 'string' ? res : res?.content
        if (text) return text
      } catch { /* try next */ }
    }
    return null
  }

  async registerPluginCommand(pluginId: string, spec: PluginCommandSpec, pluginRoot?: string): Promise<void> {
    const source: CommandSource = `plugin:${pluginId}`

    if (spec.source === 'folder') {
      if (!pluginRoot) throw new Error('registerPluginCommand: pluginRoot required for folder specs')
      const abs = join(pluginRoot, spec.path)
      const content = await readFileIfExists(join(abs, 'COMMAND.md'))
        ?? await readFileIfExists(join(abs, 'index.md'))
      if (!content) throw new Error(`registerPluginCommand: no COMMAND.md under ${abs}`)

      const { manifest, body } = parseCommandDoc(content)
      const manifest_hash = hashManifestSource(content)
      const binding: PluginFolderBinding = {
        source, plugin_id: pluginId, slug: spec.slug, root: abs, manifest, manifest_hash,
      }
      this.plugins.set(this.key(source, spec.slug), binding)
      await this.upsertPluginCache(binding)
      this.registry.upsert(this.entryFromBinding(binding))
      this.bodyCache.set(this.key(source, spec.slug), { hash: manifest_hash, body })
      return
    }

    const inline = spec.files['COMMAND.md'] ?? spec.files['index.md']
    if (!inline) throw new Error('registerPluginCommand: inline files must include COMMAND.md or index.md')
    const { manifest: parsedManifest, body } = parseCommandDoc(inline)
    const manifest_hash = hashManifestSource(inline)
    const binding: PluginInlineBinding = {
      source,
      plugin_id: pluginId,
      slug: spec.slug,
      manifest: spec.manifest ?? parsedManifest,
      manifest_hash,
      files: new Map(Object.entries(spec.files)),
    }
    this.plugins.set(this.key(source, spec.slug), binding)
    await this.upsertPluginCache(binding)
    this.registry.upsert(this.entryFromBinding(binding))
    this.bodyCache.set(this.key(source, spec.slug), { hash: manifest_hash, body })
  }

  async unregisterPluginCommands(pluginId: string): Promise<void> {
    const source: CommandSource = `plugin:${pluginId}`
    for (const [k, v] of this.plugins) {
      if (v.plugin_id === pluginId) {
        this.registry.remove(source, v.slug)
        this.plugins.delete(k)
        this.bodyCache.delete(this.key(source, v.slug))
      }
    }
    await deactivateCommandsBySource(this.projectId, source)
  }

  /** Return the entrypoint body for a command (markdown after frontmatter). */
  async loadBody(slug: string, source: CommandSource): Promise<string | null> {
    const cached = this.bodyCache.get(this.key(source, slug))
    if (cached) return cached.body

    if (source === 'fs') {
      const fs = await getFilesystemService(this.projectId)
      if (!fs) return null
      // Try folder first, then single-file.
      const folder = await this.readFolderManifest(fs, slug)
      if (folder) {
        try {
          const { body, manifest } = parseCommandDoc(folder)
          this.bodyCache.set(this.key('fs', slug), { hash: hashManifestSource(folder), body })
          void manifest
          return body
        } catch { /* fallthrough */ }
      }
      try {
        const res = await fs.read(`${COMMANDS_ROOT}/${slug}.md`)
        const text = typeof res === 'string' ? res : (res?.content ?? null)
        if (text) {
          const { body } = parseCommandDoc(text)
          return body
        }
      } catch {}
      return null
    }

    const binding = this.plugins.get(this.key(source, slug))
    if (!binding) return null
    if ('files' in binding) {
      const content = binding.files.get('COMMAND.md') ?? binding.files.get('index.md')
      return content ? parseCommandDoc(content).body : null
    }
    const content = await readFileIfExists(join(binding.root, 'COMMAND.md'))
      ?? await readFileIfExists(join(binding.root, 'index.md'))
    return content ? parseCommandDoc(content).body : null
  }

  async loadFile(slug: string, source: CommandSource, path: string): Promise<string | null> {
    if (source === 'fs') {
      const fs = await getFilesystemService(this.projectId)
      if (!fs) return null
      try {
        const res = await fs.read(`${COMMANDS_ROOT}/${slug}/${path}`)
        return typeof res === 'string' ? res : (res?.content ?? null)
      } catch { return null }
    }
    const binding = this.plugins.get(this.key(source, slug))
    if (!binding) return null
    if ('files' in binding) return binding.files.get(path) ?? null
    return readFileIfExists(join(binding.root, path))
  }

  async buildFileTree(slug: string, source: CommandSource): Promise<CommandFileTree | null> {
    const manifest = this.registry.get(source, slug)?.manifest
    const entrypointName = manifest ? resolveCommandEntrypoint(manifest, _ => true) : 'COMMAND.md'

    let files: Array<{ path: string; size_bytes: number }> = []
    let entrypointContent: string | null = null

    if (source === 'fs') {
      const fs = await getFilesystemService(this.projectId)
      if (!fs) return null
      try {
        const entries = await fs.list(`${COMMANDS_ROOT}/${slug}`)
        const prefix = `${COMMANDS_ROOT}/${slug}/`
        files = entries
          .filter(e => e.type === 'file')
          .map(e => ({
            path: e.path.startsWith(prefix) ? e.path.slice(prefix.length) : e.path,
            size_bytes: e.type === 'file' ? e.size_bytes : 0,
          }))
        const unwrap = (v: unknown): string | null =>
          typeof v === 'string' ? v : (v as { content?: string } | null)?.content ?? null
        entrypointContent = unwrap(await fs.read(`${COMMANDS_ROOT}/${slug}/${entrypointName}`).catch(() => null))
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
        files = all.map(p => ({ path: relative(binding.root, p).replace(/\\/g, '/'), size_bytes: 0 }))
        for (const f of files) {
          try {
            const st = await fsp.stat(join(binding.root, f.path))
            f.size_bytes = st.size
          } catch {}
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

  private key(source: CommandSource, slug: string): string {
    return `${source}::${slug}`
  }

  private entryFromBinding(b: PluginBinding): CommandEntry {
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
    const entrypoint = resolveCommandEntrypoint(b.manifest, _ => true)
    await upsertCommandCache({
      project_id: this.projectId,
      slug: b.slug,
      source: b.source,
      plugin_id: b.plugin_id,
      name: b.manifest.name,
      description: b.manifest.description,
      tags: b.manifest.tags ?? [],
      entrypoint,
      args_schema: b.manifest.args ?? [],
      manifest: b.manifest as unknown,
      manifest_hash: b.manifest_hash,
      active: true,
    })
  }

  private removeBySource(source: CommandSource): void {
    for (const e of this.registry.list()) {
      if (e.source === source) this.registry.remove(source, e.slug)
    }
  }
}

const loaders = new Map<string, CommandLoader>()

export function getCommandLoader(projectId: string): CommandLoader {
  let l = loaders.get(projectId)
  if (!l) {
    l = new CommandLoader(projectId)
    loaders.set(projectId, l)
  }
  return l
}

async function readFileIfExists(path: string): Promise<string | null> {
  try { return await fsp.readFile(path, 'utf8') } catch { return null }
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
