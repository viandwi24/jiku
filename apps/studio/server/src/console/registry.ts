import { appendFile, mkdir, rm, readFile, rename, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Response } from 'express'

/**
 * Console feature — per-instance live log streams.
 *
 * Storage model (session-scoped; cleared on server start):
 *   - in-memory ring holds 100–200 latest entries
 *   - when ring reaches 200, oldest 100 are appended to NDJSON file, ring
 *     keeps the newest 100. One file write per 100 entries = batching for free.
 *   - file rotates when it exceeds MAX_FILE_BYTES (single .1 backup kept)
 *
 * On server restart: tmpdir/jiku-console is wiped (logs are ephemeral).
 */

const MEM_LOW = 100
const MEM_HIGH = 200
const MAX_FILE_BYTES = 10 * 1024 * 1024
const DIR = join(tmpdir(), 'jiku-console')

export type ConsoleLevel = 'info' | 'warn' | 'error' | 'debug'

export interface ConsoleEntry {
  ts: number
  level: ConsoleLevel
  msg: string
  meta?: Record<string, unknown>
}

interface ConsoleState {
  id: string
  title: string
  ring: ConsoleEntry[]
  filePath: string
  fileBytes: number
  flushing: Promise<void> | null
  observers: Set<Response>
}

/** Safe id for filesystem — strip anything not [A-Za-z0-9._:-]. */
function safeFilename(id: string): string {
  return id.replace(/[^A-Za-z0-9._:-]/g, '_')
}

class ConsoleRegistry {
  private consoles = new Map<string, ConsoleState>()
  private ready: Promise<void>

  constructor() {
    this.ready = this.bootstrap()
  }

  /** Wipe tmpdir/jiku-console so logs start clean each session. */
  private async bootstrap(): Promise<void> {
    try {
      await rm(DIR, { recursive: true, force: true })
      await mkdir(DIR, { recursive: true })
    } catch (err) {
      console.warn('[console] bootstrap failed:', err)
    }
  }

  /** Idempotent — returns the existing state if already registered. */
  ensure(id: string, title?: string): ConsoleState {
    let s = this.consoles.get(id)
    if (s) {
      if (title && !s.title) s.title = title
      return s
    }
    s = {
      id,
      title: title ?? id,
      ring: [],
      filePath: join(DIR, `${safeFilename(id)}.log`),
      fileBytes: 0,
      flushing: null,
      observers: new Set(),
    }
    this.consoles.set(id, s)
    return s
  }

  list(): Array<{ id: string; title: string; size: number }> {
    return Array.from(this.consoles.values()).map(s => ({
      id: s.id,
      title: s.title,
      size: s.ring.length,
    }))
  }

  log(id: string, entry: Omit<ConsoleEntry, 'ts'> & { ts?: number }): void {
    const s = this.ensure(id)
    const full: ConsoleEntry = { ts: entry.ts ?? Date.now(), level: entry.level, msg: entry.msg, meta: entry.meta }
    s.ring.push(full)

    // Broadcast to SSE observers
    const line = `data: ${JSON.stringify(full)}\n\n`
    for (const res of s.observers) {
      try { res.write(line) } catch { /* will be cleaned on close */ }
    }

    // Flush oldest 100 when ring hits 200
    if (s.ring.length >= MEM_HIGH) {
      const toFlush = s.ring.splice(0, MEM_LOW)
      this.scheduleFlush(s, toFlush)
    }
  }

  info(id: string, msg: string, meta?: Record<string, unknown>) { this.log(id, { level: 'info', msg, meta }) }
  warn(id: string, msg: string, meta?: Record<string, unknown>) { this.log(id, { level: 'warn', msg, meta }) }
  error(id: string, msg: string, meta?: Record<string, unknown>) { this.log(id, { level: 'error', msg, meta }) }
  debug(id: string, msg: string, meta?: Record<string, unknown>) { this.log(id, { level: 'debug', msg, meta }) }

  /** Ensure flushes happen in order per-console by chaining on s.flushing. */
  private scheduleFlush(s: ConsoleState, entries: ConsoleEntry[]): void {
    const prior = s.flushing ?? Promise.resolve()
    s.flushing = prior.then(() => this.doFlush(s, entries)).catch(err => {
      console.warn(`[console:${s.id}] flush error:`, err)
    })
  }

  private async doFlush(s: ConsoleState, entries: ConsoleEntry[]): Promise<void> {
    await this.ready
    const payload = entries.map(e => JSON.stringify(e)).join('\n') + '\n'
    try {
      await appendFile(s.filePath, payload, 'utf-8')
      s.fileBytes += Buffer.byteLength(payload, 'utf-8')
      if (s.fileBytes > MAX_FILE_BYTES) await this.rotate(s)
    } catch (err) {
      console.warn(`[console:${s.id}] append failed:`, err)
    }
  }

  private async rotate(s: ConsoleState): Promise<void> {
    try {
      await rename(s.filePath, s.filePath + '.1').catch(() => {})
      s.fileBytes = 0
    } catch (err) {
      console.warn(`[console:${s.id}] rotate failed:`, err)
    }
  }

  /** Latest up to MEM_HIGH entries from memory — instant, no I/O. */
  snapshot(id: string): { id: string; title: string; entries: ConsoleEntry[] } {
    const s = this.ensure(id)
    return { id: s.id, title: s.title, entries: [...s.ring] }
  }

  /**
   * Reverse-scan the file for entries with ts < before_ts, returning up to
   * `limit` of the newest matching entries (ascending order). Used by the UI
   * when the user scrolls past the in-memory window.
   */
  async history(id: string, beforeTs: number, limit: number): Promise<ConsoleEntry[]> {
    const s = this.consoles.get(id)
    if (!s) return []
    await s.flushing
    const matches: ConsoleEntry[] = []
    for (const path of [s.filePath, s.filePath + '.1']) {
      let raw: string
      try { raw = await readFile(path, 'utf-8') } catch { continue }
      const lines = raw.split('\n')
      for (let i = lines.length - 1; i >= 0; i--) {
        const ln = lines[i]
        if (!ln) continue
        try {
          const e = JSON.parse(ln) as ConsoleEntry
          if (e.ts < beforeTs) {
            matches.unshift(e)
            if (matches.length >= limit) return matches
          }
        } catch { /* malformed line — skip */ }
      }
    }
    return matches
  }

  subscribe(id: string, res: Response): void {
    const s = this.ensure(id)
    s.observers.add(res)
    res.on('close', () => { s.observers.delete(res) })
  }

  /** Drop everything for an id — called when the owner is retired (optional). */
  async drop(id: string): Promise<void> {
    const s = this.consoles.get(id)
    if (!s) return
    for (const res of s.observers) { try { res.end() } catch { /* ignore */ } }
    s.observers.clear()
    this.consoles.delete(id)
    await rm(s.filePath, { force: true }).catch(() => {})
    await rm(s.filePath + '.1', { force: true }).catch(() => {})
  }

  /** Flush all pending writes — called on shutdown. */
  async flushAll(): Promise<void> {
    for (const s of this.consoles.values()) {
      if (s.ring.length > 0) {
        const pending = [...s.ring]
        s.ring.length = 0
        this.scheduleFlush(s, pending)
      }
    }
    for (const s of this.consoles.values()) { await s.flushing }
  }

  /** File stat for diagnostics. */
  async size(id: string): Promise<{ mem: number; file_bytes: number }> {
    const s = this.consoles.get(id)
    if (!s) return { mem: 0, file_bytes: 0 }
    let bytes = 0
    try { bytes = (await stat(s.filePath)).size } catch { /* ignore */ }
    return { mem: s.ring.length, file_bytes: bytes }
  }
}

export const consoleRegistry = new ConsoleRegistry()
