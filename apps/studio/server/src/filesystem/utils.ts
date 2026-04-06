import nodePath from 'node:path'

export const ALLOWED_EXTENSIONS = new Set([
  // Text
  '.txt', '.md', '.mdx', '.rst',
  // Web
  '.html', '.css', '.js', '.jsx', '.ts', '.tsx',
  // Programming
  '.py', '.rs', '.go', '.java', '.c', '.cpp', '.h',
  '.rb', '.php', '.swift', '.kt', '.cs', '.sh',
  // Config / Data
  '.json', '.yaml', '.yml', '.toml', '.env', '.ini',
  '.xml', '.csv', '.sql',
])

export const MAX_FILE_SIZE_BYTES = 5 * 1024 * 1024 // 5 MB

export function isAllowedFile(filename: string, sizeBytes: number): { allowed: boolean; reason?: string } {
  const ext = nodePath.extname(filename).toLowerCase()
  if (!ALLOWED_EXTENSIONS.has(ext)) {
    return { allowed: false, reason: `File type "${ext}" is not allowed` }
  }
  if (sizeBytes > MAX_FILE_SIZE_BYTES) {
    return { allowed: false, reason: `File size ${sizeBytes} exceeds the 5 MB limit` }
  }
  return { allowed: true }
}

export function normalizePath(input: string): string {
  let p = input.trim()
  if (!p.startsWith('/')) p = '/' + p
  p = p.replace(/\/+/g, '/')
  // strip path traversal components
  p = p.split('/').filter(seg => seg !== '..').join('/')
  if (!p.startsWith('/')) p = '/' + p
  return p
}

export function extractImmediateSubfolders(paths: string[], folderPath: string): string[] {
  const normalizedFolder = folderPath === '/' ? '' : folderPath
  const subfolders = new Set<string>()

  for (const p of paths) {
    if (!p.startsWith(normalizedFolder + '/')) continue
    const rest = p.slice(normalizedFolder.length + 1) // remove leading folder + slash
    const nextSlash = rest.indexOf('/')
    if (nextSlash === -1) continue // file directly in this folder — not a subfolder
    const subfolder = normalizedFolder + '/' + rest.slice(0, nextSlash)
    subfolders.add(subfolder)
  }

  return Array.from(subfolders).sort()
}

const MIME_MAP: Record<string, string> = {
  '.txt': 'text/plain',
  '.md': 'text/markdown',
  '.mdx': 'text/markdown',
  '.rst': 'text/plain',
  '.html': 'text/html',
  '.css': 'text/css',
  '.js': 'application/javascript',
  '.jsx': 'application/javascript',
  '.ts': 'application/typescript',
  '.tsx': 'application/typescript',
  '.json': 'application/json',
  '.yaml': 'application/yaml',
  '.yml': 'application/yaml',
  '.toml': 'application/toml',
  '.xml': 'application/xml',
  '.csv': 'text/csv',
  '.sql': 'application/sql',
  '.sh': 'application/x-sh',
  '.py': 'text/x-python',
  '.go': 'text/x-go',
  '.rs': 'text/x-rust',
  '.java': 'text/x-java-source',
  '.c': 'text/x-csrc',
  '.cpp': 'text/x-c++src',
  '.h': 'text/x-chdr',
  '.rb': 'text/x-ruby',
  '.php': 'application/x-httpd-php',
  '.swift': 'text/x-swift',
  '.kt': 'text/x-kotlin',
  '.cs': 'text/x-csharp',
  '.env': 'text/plain',
  '.ini': 'text/plain',
}

export function getMimeType(ext: string): string {
  return MIME_MAP[ext.toLowerCase()] ?? 'text/plain'
}
