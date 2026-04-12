// Thin wrapper around tsup. Each plugin must have its own tsup.config.ts.
// We run `bun run build` (which resolves tsup from the plugin's own
// node_modules) rather than `bunx tsup` — bunx downloads tsup to a temp dir
// that cannot find the plugin's peer deps (e.g. typescript).

import { spawn, type ChildProcess } from 'node:child_process'
import { join } from 'node:path'

export interface BuildResult {
  id: string
  dir: string
  ok: boolean
  code: number | null
  duration_ms: number
  stderr: string
}

async function hasBuildScript(dir: string): Promise<boolean> {
  try {
    const pkgPath = join(dir, 'package.json')
    const { readFile } = await import('node:fs/promises')
    const pkg = JSON.parse(await readFile(pkgPath, 'utf-8')) as { scripts?: Record<string, string> }
    return typeof pkg.scripts?.build === 'string'
  } catch { return false }
}

export async function buildPlugin(id: string, dir: string): Promise<BuildResult> {
  if (!(await hasBuildScript(dir))) {
    return { id, dir, ok: false, code: null, duration_ms: 0, stderr: `No "build" script in ${dir}/package.json` }
  }
  const start = Date.now()
  return new Promise(resolve => {
    const child = spawn('bun', ['run', 'build'], { cwd: dir, stdio: ['ignore', 'pipe', 'pipe'] })
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

/** Spawn `bun run build:watch` — returns a handle so callers can kill on demand. */
export async function watchPlugin(
  id: string,
  dir: string,
  onLine: (line: string) => void,
): Promise<WatchHandle | null> {
  if (!(await hasBuildScript(dir))) return null
  const proc = spawn('bun', ['run', 'build:watch'], { cwd: dir, stdio: ['ignore', 'pipe', 'pipe'] })
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
