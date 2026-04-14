import type { CommandEntry, CommandSource } from '@jiku/types'

/**
 * Plan 24 — In-memory union registry of commands across FS + plugin sources.
 * Mirrors SkillRegistry. State-only; population lives in studio server.
 */
export class CommandRegistry {
  private entries = new Map<string, CommandEntry>()

  upsert(entry: CommandEntry): void {
    this.entries.set(this.key(entry.source, entry.slug), entry)
  }

  remove(source: CommandSource, slug: string): void {
    this.entries.delete(this.key(source, slug))
  }

  removeBySource(source: CommandSource): number {
    let removed = 0
    for (const [k, v] of this.entries) {
      if (v.source === source) {
        this.entries.delete(k)
        removed++
      }
    }
    return removed
  }

  get(source: CommandSource, slug: string): CommandEntry | undefined {
    return this.entries.get(this.key(source, slug))
  }

  list(filter?: { active?: boolean }): CommandEntry[] {
    const arr: CommandEntry[] = []
    for (const e of this.entries.values()) {
      if (filter?.active !== undefined && e.active !== filter.active) continue
      arr.push(e)
    }
    return arr
  }

  findBySlug(slug: string): CommandEntry[] {
    return [...this.entries.values()].filter(e => e.slug === slug)
  }

  clear(): void {
    this.entries.clear()
  }

  private key(source: CommandSource, slug: string): string {
    return `${source}::${slug}`
  }
}
