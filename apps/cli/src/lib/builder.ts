// Thin wrapper around tsup's programmatic API. Each plugin must have its own
// tsup.config.ts; we just spawn `bunx tsup` inside its folder to honor it.
// Doing it via child_process avoids coupling the CLI to every plugin's
// specific config shape.

import { spawn, type ChildProcess } from 'node:child_process'
import { stat } from 'node:fs/promises'
import { join } from 'node:path'

export interface BuildResult {
  id: string
  dir: string
  ok: boolean
  code: number | null
  duration_ms: number
  stderr: string
}

async function hasTsupConfig(dir: string): Promise<boolean> {
  for (const name of ['tsup.config.ts', 'tsup.config.js', 'tsup.config.mjs']) {
    try { await stat(join(dir, name)); return true } catch { /* try next */ }
  }
  return false
}

export async function buildPlugin(id: string, dir: string): Promise<BuildResult> {
  if (!(await hasTsupConfig(dir))) {
    return { id, dir, ok: false, code: null, duration_ms: 0, stderr: `No tsup.config.* found in ${dir}` }
  }
  const start = Date.now()
  return new Promise(resolve => {
    const child = spawn('bunx', ['tsup'], { cwd: dir, stdio: ['ignore', 'pipe', 'pipe'] })
    let stderr = ''
    child.stderr?.on('data', chunk => { stderr += chunk.toString() })
    child.stdout?.on('data', () => { /* swallow per-plugin noise; surface only on fail */ })
    child.on('exit', code => {
      resolve({ id, dir, ok: code === 0, code, duration_ms: Date.now() - start, stderr })
    })
    child.on('error', err => {
      resolve({ id, dir, ok: false, code: null, duration_ms: Date.now() - start, stderr: err.message })
    })
  })
}

export interface WatchHandle {
  id: string
  dir: string
  proc: ChildProcess
  stop(): void
}

/** Spawn `bunx tsup --watch` — returns a handle so callers can kill on demand. */
export async function watchPlugin(
  id: string,
  dir: string,
  onLine: (line: string) => void,
): Promise<WatchHandle | null> {
  if (!(await hasTsupConfig(dir))) return null
  const proc = spawn('bunx', ['tsup', '--watch'], { cwd: dir, stdio: ['ignore', 'pipe', 'pipe'] })
  const forward = (buf: Buffer) => {
    for (const l of buf.toString().split('\n')) { if (l.trim()) onLine(l) }
  }
  proc.stdout?.on('data', forward)
  proc.stderr?.on('data', forward)
  return {
    id,
    dir,
    proc,
    stop: () => { if (!proc.killed) proc.kill('SIGTERM') },
  }
}
