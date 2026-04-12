// Locate workspace root + conventional paths. Walks up from cwd until a
// package.json with a `workspaces` field is found.

import { readFile, stat } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'

export interface WorkspaceInfo {
  root: string
  pluginsDir: string
}

async function exists(p: string): Promise<boolean> {
  try { await stat(p); return true } catch { return false }
}

async function readJson(p: string): Promise<Record<string, unknown> | null> {
  try { return JSON.parse(await readFile(p, 'utf-8')) } catch { return null }
}

export async function findWorkspaceRoot(startDir: string = process.cwd()): Promise<WorkspaceInfo> {
  let dir = resolve(startDir)
  while (true) {
    const pkg = await readJson(join(dir, 'package.json'))
    if (pkg && Array.isArray(pkg['workspaces'])) {
      const pluginsDir = join(dir, 'plugins')
      if (!(await exists(pluginsDir))) {
        throw new Error(`Workspace root found at ${dir} but no plugins/ directory exists`)
      }
      return { root: dir, pluginsDir }
    }
    const parent = dirname(dir)
    if (parent === dir) {
      throw new Error(`Not inside a jiku workspace (no package.json with "workspaces" found above ${startDir})`)
    }
    dir = parent
  }
}
