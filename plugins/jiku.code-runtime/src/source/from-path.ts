// Load source code from an absolute disk path. Guards against:
//   • Non-absolute paths
//   • Paths containing `..` traversal segments
//   • (Optional) paths outside allowed_path_roots when whitelist is configured
//
// File size is not capped at the loader level — the sandbox's memory limit
// handles oversized sources. The caller decides language by file extension.

import { readFile } from 'node:fs/promises'
import { isAbsolute, normalize, resolve as resolvePath } from 'node:path'

export interface LoadFromPathResult {
  code: string
  language: 'js' | 'ts'
  resolvedPath: string
}

export async function loadFromPath(
  path: string,
  allowedRoots: string[],
): Promise<LoadFromPathResult> {
  if (!isAbsolute(path)) {
    throw new Error(`path must be absolute, got: ${path}`)
  }
  const normalized = normalize(path)
  if (normalized.split(/[/\\]/).includes('..')) {
    throw new Error(`path must not contain '..' segments: ${path}`)
  }
  if (allowedRoots.length > 0) {
    const ok = allowedRoots.some((root) => {
      const absRoot = resolvePath(root)
      return normalized === absRoot || normalized.startsWith(absRoot + '/')
    })
    if (!ok) {
      throw new Error(`path not under any allowed_path_roots: ${path}`)
    }
  }

  const raw = await readFile(normalized, 'utf8')
  const language: 'js' | 'ts' = /\.(ts|mts|cts|tsx)$/i.test(normalized) ? 'ts' : 'js'
  return { code: raw, language, resolvedPath: normalized }
}
