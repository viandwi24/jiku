import type { SkillEntry, SkillSource } from '@jiku/types'

/**
 * Plan 19 — In-memory union registry of skills across FS + plugin sources.
 *
 * The registry is pure state: population (FS scan, plugin registrations) lives
 * in the studio server layer. This class is the authoritative read surface for
 * "what skills are currently registered for this project?".
 */
export class SkillRegistry {
  // key = `${source}::${slug}` — avoids collisions across sources
  private entries = new Map<string, SkillEntry>()

  upsert(entry: SkillEntry): void {
    this.entries.set(this.key(entry.source, entry.slug), entry)
  }

  remove(source: SkillSource, slug: string): void {
    this.entries.delete(this.key(source, slug))
  }

  /** Remove every entry whose source matches exactly. Used on plugin deactivate. */
  removeBySource(source: SkillSource): number {
    let removed = 0
    for (const [k, v] of this.entries) {
      if (v.source === source) {
        this.entries.delete(k)
        removed++
      }
    }
    return removed
  }

  get(source: SkillSource, slug: string): SkillEntry | undefined {
    return this.entries.get(this.key(source, slug))
  }

  /** All active entries, irrespective of source. */
  list(filter?: { active?: boolean }): SkillEntry[] {
    const arr: SkillEntry[] = []
    for (const e of this.entries.values()) {
      if (filter?.active !== undefined && e.active !== filter.active) continue
      arr.push(e)
    }
    return arr
  }

  /** Look up by slug — returns all matches (FS + plugin sources could collide). */
  findBySlug(slug: string): SkillEntry[] {
    return [...this.entries.values()].filter(e => e.slug === slug)
  }

  clear(): void {
    this.entries.clear()
  }

  private key(source: SkillSource, slug: string): string {
    return `${source}::${slug}`
  }
}
