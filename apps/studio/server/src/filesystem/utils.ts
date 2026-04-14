import nodePath from 'node:path'

// ─── Extension whitelist, grouped ─────────────────────────────────────────────

const TEXT_EXTS = new Set([
  // Prose / docs
  '.txt', '.md', '.mdx', '.rst',
  // Web
  '.html', '.css', '.scss', '.sass', '.less',
  // Scripts / programming
  '.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs',
  '.py', '.rs', '.go', '.java', '.c', '.cpp', '.cc', '.h', '.hpp',
  '.rb', '.php', '.swift', '.kt', '.kts', '.cs', '.sh', '.bash', '.zsh',
  '.ps1', '.lua', '.r', '.pl', '.dart', '.scala',
  // Config / Data
  '.json', '.yaml', '.yml', '.toml', '.env', '.ini', '.cfg', '.conf',
  '.xml', '.csv', '.tsv', '.sql', '.graphql', '.gql',
])

const DOCUMENT_EXTS = new Set([
  '.pdf',
  '.xlsx', '.xls', '.ods',
  '.docx', '.doc', '.odt',
  '.pptx', '.ppt', '.odp',
  '.zip',
])

const IMAGE_EXTS = new Set([
  '.jpg', '.jpeg', '.png', '.webp', '.gif', '.svg',
  '.bmp', '.tiff', '.tif', '.heic', '.heif', '.avif', '.apng', '.ico',
])

const VIDEO_EXTS = new Set([
  '.mp4', '.mov', '.mkv', '.webm', '.avi', '.m4v', '.3gp', '.wmv', '.flv',
])

const AUDIO_EXTS = new Set([
  '.mp3', '.wav', '.ogg', '.m4a', '.aac', '.opus', '.flac', '.wma',
])

export const ALLOWED_EXTENSIONS = new Set<string>([
  ...TEXT_EXTS,
  ...DOCUMENT_EXTS,
  ...IMAGE_EXTS,
  ...VIDEO_EXTS,
  ...AUDIO_EXTS,
])

// Binary extensions must be stored as Buffer (not UTF-8 text). These are
// preserved byte-for-byte; text-format extensions are stored as UTF-8 strings.
export const BINARY_EXTENSIONS = new Set<string>([
  ...DOCUMENT_EXTS,
  ...IMAGE_EXTS,
  ...VIDEO_EXTS,
  ...AUDIO_EXTS,
])

// ─── Size caps per category ───────────────────────────────────────────────────

const ONE_MB = 1024 * 1024

const SIZE_CAP_TEXT = 5 * ONE_MB
const SIZE_CAP_IMAGE = 50 * ONE_MB
const SIZE_CAP_DOCUMENT = 50 * ONE_MB
const SIZE_CAP_AUDIO = 100 * ONE_MB
const SIZE_CAP_VIDEO = 500 * ONE_MB

/** Upper bound for any single upload — used by the multipart parser. */
export const MAX_UPLOAD_BYTES = SIZE_CAP_VIDEO

/** Legacy export retained for backwards compatibility. New code should call `getMaxSizeForExtension()`. */
export const MAX_FILE_SIZE_BYTES = SIZE_CAP_TEXT

export function getMaxSizeForExtension(ext: string): number {
  const e = ext.toLowerCase()
  if (IMAGE_EXTS.has(e)) return SIZE_CAP_IMAGE
  if (VIDEO_EXTS.has(e)) return SIZE_CAP_VIDEO
  if (AUDIO_EXTS.has(e)) return SIZE_CAP_AUDIO
  if (DOCUMENT_EXTS.has(e)) return SIZE_CAP_DOCUMENT
  return SIZE_CAP_TEXT
}

export function isBinaryExtension(ext: string): boolean {
  return BINARY_EXTENSIONS.has(ext.toLowerCase())
}

// ─── Validation ───────────────────────────────────────────────────────────────

export function isAllowedFile(filename: string, sizeBytes: number): { allowed: boolean; reason?: string } {
  const ext = nodePath.extname(filename).toLowerCase()
  if (!ALLOWED_EXTENSIONS.has(ext)) {
    return { allowed: false, reason: `File type "${ext}" is not allowed` }
  }
  const cap = getMaxSizeForExtension(ext)
  if (sizeBytes > cap) {
    const capMb = Math.round(cap / ONE_MB)
    const sizeMb = (sizeBytes / ONE_MB).toFixed(1)
    return { allowed: false, reason: `File size ${sizeMb} MB exceeds the ${capMb} MB limit for "${ext}" files` }
  }
  return { allowed: true }
}

// ─── Path helpers ─────────────────────────────────────────────────────────────

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

// ─── MIME mapping ─────────────────────────────────────────────────────────────

const MIME_MAP: Record<string, string> = {
  // Text / prose
  '.txt': 'text/plain',
  '.md': 'text/markdown',
  '.mdx': 'text/markdown',
  '.rst': 'text/plain',
  // Web
  '.html': 'text/html',
  '.css': 'text/css',
  '.scss': 'text/x-scss',
  '.sass': 'text/x-sass',
  '.less': 'text/x-less',
  // Scripts / programming
  '.js': 'application/javascript',
  '.jsx': 'application/javascript',
  '.mjs': 'application/javascript',
  '.cjs': 'application/javascript',
  '.ts': 'application/typescript',
  '.tsx': 'application/typescript',
  '.py': 'text/x-python',
  '.go': 'text/x-go',
  '.rs': 'text/x-rust',
  '.java': 'text/x-java-source',
  '.c': 'text/x-csrc',
  '.cpp': 'text/x-c++src',
  '.cc': 'text/x-c++src',
  '.h': 'text/x-chdr',
  '.hpp': 'text/x-c++hdr',
  '.rb': 'text/x-ruby',
  '.php': 'application/x-httpd-php',
  '.swift': 'text/x-swift',
  '.kt': 'text/x-kotlin',
  '.kts': 'text/x-kotlin',
  '.cs': 'text/x-csharp',
  '.sh': 'application/x-sh',
  '.bash': 'application/x-sh',
  '.zsh': 'application/x-sh',
  '.ps1': 'application/x-powershell',
  '.lua': 'text/x-lua',
  '.r': 'text/x-r',
  '.pl': 'text/x-perl',
  '.dart': 'application/dart',
  '.scala': 'text/x-scala',
  // Config / data
  '.json': 'application/json',
  '.yaml': 'application/yaml',
  '.yml': 'application/yaml',
  '.toml': 'application/toml',
  '.xml': 'application/xml',
  '.csv': 'text/csv',
  '.tsv': 'text/tab-separated-values',
  '.sql': 'application/sql',
  '.graphql': 'application/graphql',
  '.gql': 'application/graphql',
  '.env': 'text/plain',
  '.ini': 'text/plain',
  '.cfg': 'text/plain',
  '.conf': 'text/plain',
  // Documents
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.xls': 'application/vnd.ms-excel',
  '.ods': 'application/vnd.oasis.opendocument.spreadsheet',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.doc': 'application/msword',
  '.odt': 'application/vnd.oasis.opendocument.text',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.ppt': 'application/vnd.ms-powerpoint',
  '.odp': 'application/vnd.oasis.opendocument.presentation',
  '.pdf': 'application/pdf',
  '.zip': 'application/zip',
  // Images
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.bmp': 'image/bmp',
  '.tiff': 'image/tiff',
  '.tif': 'image/tiff',
  '.heic': 'image/heic',
  '.heif': 'image/heif',
  '.avif': 'image/avif',
  '.apng': 'image/apng',
  '.ico': 'image/x-icon',
  // Video
  '.mp4': 'video/mp4',
  '.mov': 'video/quicktime',
  '.mkv': 'video/x-matroska',
  '.webm': 'video/webm',
  '.avi': 'video/x-msvideo',
  '.m4v': 'video/x-m4v',
  '.3gp': 'video/3gpp',
  '.wmv': 'video/x-ms-wmv',
  '.flv': 'video/x-flv',
  // Audio
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.m4a': 'audio/mp4',
  '.aac': 'audio/aac',
  '.opus': 'audio/opus',
  '.flac': 'audio/flac',
  '.wma': 'audio/x-ms-wma',
}

export function getMimeType(ext: string): string {
  return MIME_MAP[ext.toLowerCase()] ?? 'application/octet-stream'
}

// ─── Plan 16: folder path helpers ─────────────────────────────────────────

/**
 * Returns all ancestor folder paths for a file path, from shallowest to
 * deepest. The file's own name is excluded.
 *
 * Example: '/a/b/c/d.ts' → ['/a', '/a/b', '/a/b/c']
 */
export function getAncestorPaths(filePath: string): string[] {
  const parts = filePath.split('/').filter(Boolean)
  const ancestors: string[] = []
  for (let i = 1; i < parts.length; i++) {
    ancestors.push('/' + parts.slice(0, i).join('/'))
  }
  return ancestors
}
