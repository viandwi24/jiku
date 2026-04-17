// jiku.sheet — CSV/spreadsheet support for Jiku Studio.
//
// Server-side:
//   • Registers a `csv_read` tool (CSV text content → structured JSON).
//   • Registers a `sheet_read` tool (xlsx/xls/ods/csv content → structured JSON,
//     supports row ranges for large sheets with complex layouts).
//   • Registers a GET /sheet HTTP route with in-memory cache:
//       – no ?sheet param  → { sheetNames, truncated }   (fast metadata only)
//       – ?sheet=<name>    → { headers, rows, truncated } (single sheet data)
//   • Registers a fileViewAdapters spec so the Studio UI knows this plugin
//     provides a Spreadsheet view for these file types.

import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Worker } from 'node:worker_threads'
import { definePlugin, defineTool } from '@jiku/kit'
import { defineUI } from '@jiku/kit/ui'
import { StudioPlugin } from '@jiku-plugin/studio'
import { z } from 'zod'

const __dirname = dirname(fileURLToPath(import.meta.url))
const UI_DIST_DIR = join(__dirname, '..', 'dist', 'ui')
const WORKER_PATH = join(__dirname, 'xlsx-worker.ts')

// ── In-memory workbook cache ──────────────────────────────────────────────────
// Keyed by `${projectId}:${filePath}`. Stores the fully parsed workbook so that
// per-sheet fetches and repeated opens are served instantly without re-parsing.

interface CachedWorkbook {
  sheetNames: string[]
  sheets: Record<string, { headers: string[]; rows: string[][] }>
  truncated: boolean
  expiresAt: number
}

const workbookCache = new Map<string, CachedWorkbook>()
// In-flight dedup: prevents multiple concurrent requests for the same file from
// each spawning their own worker. The second request waits for the first promise.
const inFlight = new Map<string, Promise<CachedWorkbook>>()

const CACHE_TTL_MS = 60 * 60 * 1_000 // 1 hour
const CACHE_MAX    = 30               // max entries (evict oldest on overflow)

function cacheGet(key: string): CachedWorkbook | null {
  const entry = workbookCache.get(key)
  if (!entry) return null
  if (Date.now() > entry.expiresAt) { workbookCache.delete(key); return null }
  return entry
}

function cachePut(key: string, wb: Omit<CachedWorkbook, 'expiresAt'>) {
  if (workbookCache.size >= CACHE_MAX) {
    let oldestKey = ''
    let oldestTime = Infinity
    for (const [k, v] of workbookCache) {
      if (v.expiresAt < oldestTime) { oldestKey = k; oldestTime = v.expiresAt }
    }
    if (oldestKey) workbookCache.delete(oldestKey)
  }
  workbookCache.set(key, { ...wb, expiresAt: Date.now() + CACHE_TTL_MS })
}

// ── Worker thread ─────────────────────────────────────────────────────────────

const WORKER_TIMEOUT_MS = 30_000 // 30 s hard limit per parse

/** Parse a spreadsheet buffer in a worker thread so the event loop stays free. */
function parseInWorker(
  buf: Buffer,
  ext: string,
  maxRows: number,
): Promise<{
  sheetNames: string[]
  sheets: Record<string, { headers: string[]; rows: string[][] }>
  truncated: boolean
}> {
  return new Promise((resolve, reject) => {
    const bufArray = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)
    const worker = new Worker(WORKER_PATH, {
      workerData: { bufArray, ext, maxRows },
    })

    const timeout = setTimeout(() => {
      worker.terminate()
      reject(new Error('Spreadsheet parsing timed out (30 s). The file may be corrupted — please delete and re-upload it.'))
    }, WORKER_TIMEOUT_MS)

    const cleanup = () => clearTimeout(timeout)

    worker.on('message', (msg: { error?: string }) => {
      cleanup(); worker.terminate()
      if (msg.error) reject(new Error(msg.error))
      else resolve(msg as never)
    })
    worker.on('error', (err) => { cleanup(); worker.terminate(); reject(err) })
    worker.on('exit', (code) => {
      cleanup()
      if (code !== 0) reject(new Error(`xlsx worker exited with code ${code}`))
    })
  })
}

const SHEET_EXTENSIONS  = new Set(['.csv', '.xlsx', '.xls', '.ods'])
const MAX_ROWS_PER_SHEET = 5000
const MAX_BYTES          = 10 * 1024 * 1024 // 10 MB

// ── Shared parse-or-cache helper (HTTP route) ─────────────────────────────────

async function getWorkbook(
  projectId: string,
  filePath: string,
  readProjectFile: ((p: string) => Promise<Buffer | null>) | undefined,
): Promise<CachedWorkbook> {
  const cacheKey = `${projectId}:${filePath}`

  const cached = cacheGet(cacheKey)
  if (cached) return cached

  const existing = inFlight.get(cacheKey)
  if (existing) return existing

  const promise = (async (): Promise<CachedWorkbook> => {
    try {
      const buf = readProjectFile ? await readProjectFile(filePath) : null
      if (!buf) throw Object.assign(new Error('File not found or filesystem not configured'), { status: 404 })

      if (buf.length > MAX_BYTES) {
        throw Object.assign(
          new Error(`File too large to parse (${(buf.length / 1_048_576).toFixed(1)} MB > 10 MB limit)`),
          { status: 413 },
        )
      }

      const ext = ('.' + filePath.split('.').pop()!.toLowerCase()) as string
      if (ext !== '.csv') {
        const b0 = buf[0], b1 = buf[1], b2 = buf[2], b3 = buf[3]
        const isZip = b0 === 0x50 && b1 === 0x4B && b2 === 0x03 && b3 === 0x04
        const isOle = b0 === 0xD0 && b1 === 0xCF && b2 === 0x11 && b3 === 0xE0
        if (!isZip && !isOle) {
          throw Object.assign(
            new Error('File appears corrupted. Please delete and re-upload the file.'),
            { status: 422 },
          )
        }
      }

      const result = await parseInWorker(buf, ext, MAX_ROWS_PER_SHEET)
      const wb: CachedWorkbook = { ...result, expiresAt: Date.now() + CACHE_TTL_MS }
      cachePut(cacheKey, result)
      return wb
    } finally {
      inFlight.delete(cacheKey)
    }
  })()

  inFlight.set(cacheKey, promise)
  return promise
}

// ── Plugin definition ─────────────────────────────────────────────────────────

export default definePlugin({
  meta: {
    id: 'jiku.sheet',
    name: 'Sheet',
    version: '1.0.0',
    description: 'CSV/spreadsheet viewer and parser. Adds a Sheet view tab in the file explorer and gives agents csv_read and sheet_read tools to query tabular data.',
    author: 'Jiku',
    icon: '📋',
    category: 'productivity',
    project_scope: false,
  },

  depends: [StudioPlugin],

  ui: defineUI({
    assetsDir: UI_DIST_DIR,
    entries: [
      {
        slot: 'file.view.adapter',
        id: 'spreadsheet',
        module: './SheetAdapter.js',
        meta: {
          label: 'Sheet',
          extensions: ['.csv', '.xlsx', '.xls', '.ods'],
        },
      },
    ],
  }),

  setup(ctx) {
    // ── Register file view adapter spec ────────────────────────────────────────
    ctx.fileViewAdapters.register({
      id: 'jiku.sheet.spreadsheet',
      label: 'Spreadsheet',
      extensions: ['.csv', '.xlsx', '.xls', '.ods'],
    })

    // ── Sheet HTTP routes ──────────────────────────────────────────────────────
    //
    // GET /sheet?path=<file>&project=<id>
    //   → { sheetNames: string[], truncated: boolean }
    //   Fast metadata-only response used by the UI to render sheet tabs.
    //
    // GET /sheet?path=<file>&project=<id>&sheet=<name>
    //   → { headers: string[], rows: string[][], truncated: boolean }
    //   Single-sheet data. Both routes share the parse-and-cache logic.

    ctx.http.get('/sheet', async ({ projectId, req, res, readProjectFile }) => {
      const filePath  = req.query['path']  as string | undefined
      const sheetName = req.query['sheet'] as string | undefined

      if (!filePath) {
        res.status(400).json({ error: 'path query param required' })
        return
      }

      const ext = ('.' + filePath.split('.').pop()!.toLowerCase()) as string
      if (!SHEET_EXTENSIONS.has(ext)) {
        res.status(400).json({ error: `Unsupported file type: ${ext}` })
        return
      }

      try {
        const wb = await getWorkbook(projectId, filePath, readProjectFile)

        if (!sheetName) {
          // Metadata-only response (UI renders tabs from this)
          res.json({ sheetNames: wb.sheetNames, truncated: wb.truncated })
        } else {
          // Single-sheet data response
          const sheet = wb.sheets[sheetName]
          if (!sheet) {
            res.status(404).json({ error: `Sheet "${sheetName}" not found` })
            return
          }
          res.json({ headers: sheet.headers, rows: sheet.rows, truncated: wb.truncated })
        }
      } catch (err) {
        const status = (err as { status?: number }).status ?? 500
        const msg    = err instanceof Error ? err.message : String(err)
        res.status(status).json({ error: status === 500 ? `Failed to parse file: ${msg}` : msg })
      }
    })

    // ── csv_read tool ──────────────────────────────────────────────────────────
    // Reads plain-text CSV content (passed as a string by the agent after
    // calling fs_read) and returns structured rows.
    ctx.project.tools.register(
      defineTool({
        meta: {
          id: 'csv_read',
          name: 'Read CSV File',
          group: 'sheet',
          description: 'Parse a CSV file that you have already read with fs_read. Returns structured headers and rows. Optionally filter rows by column value.',
        },
        permission: '*',
        modes: ['chat', 'task'],
        input: z.object({
          content: z.string().describe('Raw CSV text content (from fs_read)'),
          limit: z.number().int().min(1).max(1000).optional().default(100).describe('Maximum rows to return (default 100)'),
          filter_column: z.string().optional().describe('Column name to filter on'),
          filter_value: z.string().optional().describe('Value to match in filter_column (case-insensitive substring)'),
        }),
        execute: async (rawArgs) => {
          const args = rawArgs as {
            content: string
            limit: number
            filter_column?: string
            filter_value?: string
          }

          const rows = parseCsv(args.content)
          if (rows.length === 0) return { headers: [], rows: [], total: 0 }

          const headers = rows[0]!
          let dataRows = rows.slice(1).map(row => {
            const obj: Record<string, string> = {}
            headers.forEach((h, i) => { obj[h] = row[i] ?? '' })
            return obj
          })

          if (args.filter_column && args.filter_value !== undefined) {
            const col = args.filter_column.toLowerCase()
            const val = args.filter_value.toLowerCase()
            dataRows = dataRows.filter(row => {
              const key = Object.keys(row).find(k => k.toLowerCase() === col)
              return key ? row[key]!.toLowerCase().includes(val) : false
            })
          }

          const total   = dataRows.length
          const limited = dataRows.slice(0, args.limit)
          return { headers, rows: limited, total, returned: limited.length, truncated: total > args.limit }
        },
      }),
    )

    // ── sheet_read tool ────────────────────────────────────────────────────────
    // Reads xlsx / xls / ods / csv content and returns structured sheet data.
    //
    // Usage for agents:
    //   1. Read the file with fs_read → get its content string.
    //   2. Pass content (and filename) here.
    //   3. For large or complex sheets, use row_start + max_rows to read
    //      specific regions. The _row field on each returned row gives the
    //      1-based spreadsheet row number so you can orient follow-up reads.
    //
    // Binary files (xlsx / xls / ods) are stored as __b64__:... by the
    // filesystem and fs_read returns that prefix intact.
    ctx.project.tools.register(
      defineTool({
        meta: {
          id: 'sheet_read',
          name: 'Read Spreadsheet',
          group: 'sheet',
          description: [
            'Read an XLSX, XLS, ODS, or CSV spreadsheet.',
            'Preferred: pass path="/file.xlsx" to read directly from disk (avoids context overflow).',
            'Alternative: pass content from fs_read (only for small files — large binary files will overflow the context).',
            'For sheets with complex layouts (side-by-side tables, headers not on row 0, footer stats),',
            'use row_start and max_rows to inspect specific regions.',
            'Each row includes a _row field (1-based spreadsheet row number) for targeted follow-up reads.',
          ].join(' '),
        },
        permission: '*',
        modes: ['chat', 'task'],
        input: z.object({
          path: z.string().optional().describe(
            'File path on disk (e.g. "/Rekap Member.xlsx"). Preferred over content for large files — reads directly without loading into context.',
          ),
          content: z.string().optional().describe(
            'Raw file content from fs_read. Use only for small files. CSV: plain text. XLSX/XLS/ODS: __b64__: prefix.',
          ),
          filename: z.string().optional().describe(
            'Filename hint (e.g. "report.xlsx") when using content without path. Used for format detection.',
          ),
          sheet: z.string().optional().describe(
            'Sheet name to read. Defaults to the first sheet.',
          ),
          row_start: z.number().int().min(0).optional().default(0).describe(
            'First data row index to return (0 = first row after headers). Default: 0.',
          ),
          max_rows: z.number().int().min(1).max(500).optional().default(100).describe(
            'Maximum rows to return. Default: 100, max: 500.',
          ),
        }),
        execute: async (rawArgs, toolCtx) => {
          const args = rawArgs as {
            path?: string
            content?: string
            filename?: string
            sheet?: string
            row_start: number
            max_rows: number
          }

          if (!args.path && !args.content) {
            return { error: 'Provide either path (preferred) or content.' }
          }

          let buf: Buffer
          let ext: string

          if (args.path) {
            // ── Path-based: read directly from filesystem ──────────────────
            // projectId is available via toolCtx.runtime.project_id (injected
            // by the runner into every RuntimeContext as of this change).
            const projectId = toolCtx.runtime['project_id'] as string | undefined
            if (!projectId) return { error: 'project_id not available in tool context' }

            const filePath = args.path
            ext = '.' + filePath.split('.').pop()!.toLowerCase()
            if (!SHEET_EXTENSIONS.has(ext)) {
              return { error: `Unsupported file type: ${ext}` }
            }

            // Use the shared cache — if the UI already opened this file, it's
            // served instantly; otherwise parse fresh.
            let wb: CachedWorkbook
            try {
              // Import filesystem service lazily so it doesn't pull server deps
              // into the plugin bundle at build time.
              const { getFilesystemService } = await import(
                '../../../apps/studio/server/src/filesystem/factory.ts'
              ) as { getFilesystemService: (id: string) => Promise<{ readBinary: (p: string) => Promise<Buffer | null> } | null> }

              const readProjectFile = async (p: string): Promise<Buffer | null> => {
                const fs = await getFilesystemService(projectId)
                return fs ? fs.readBinary(p) : null
              }

              wb = await getWorkbook(projectId, filePath, readProjectFile)
            } catch (err) {
              return { error: err instanceof Error ? err.message : String(err) }
            }

            const sheetName = args.sheet || wb.sheetNames[0]
            if (!sheetName) return { error: 'The workbook is empty', all_sheets: wb.sheetNames }
            const sheet = wb.sheets[sheetName]
            if (!sheet) return { error: `Sheet "${args.sheet}" not found`, all_sheets: wb.sheetNames }

            const totalRows  = sheet.rows.length
            const sliced     = sheet.rows.slice(args.row_start, args.row_start + args.max_rows)
            const truncated  = args.row_start + args.max_rows < totalRows
            const rowObjects = sliced.map((row, i) => {
              const rowNum = args.row_start + i + 2
              const obj: Record<string, string> = { _row: String(rowNum) }
              sheet.headers.forEach((h, ci) => { obj[h || `col_${ci + 1}`] = row[ci] ?? '' })
              return obj
            })

            return {
              sheet: sheetName,
              all_sheets: wb.sheetNames,
              dimensions: { total_rows: totalRows, total_cols: sheet.headers.length },
              headers: sheet.headers.length > 0 ? sheet.headers : null,
              rows: rowObjects,
              returned: rowObjects.length,
              truncated,
              ...(truncated ? {
                note: `Sheet has ${totalRows} rows total. Returned rows ${args.row_start + 1}–${args.row_start + rowObjects.length}. Use row_start to read more.`,
              } : {}),
            }
          }

          // ── Content-based (legacy / small files) ──────────────────────────
          const content = args.content!

          if (content.startsWith('__b64__:')) {
            // Binary spreadsheet (xlsx/xls/ods) — decode base64
            const base64 = content.slice('__b64__:'.length)
            const approxBytes = Math.round(base64.length * 0.75)
            if (approxBytes > MAX_BYTES) {
              return {
                error: `File is too large to read via content (${Math.round(approxBytes / 1024)} KB). Use path parameter instead: sheet_read({ path: "${args.filename ?? 'file.xlsx'}" })`,
              }
            }
            buf = Buffer.from(base64, 'base64')
            if (args.filename) {
              ext = '.' + args.filename.split('.').pop()!.toLowerCase()
            } else {
              const b0 = buf[0], b1 = buf[1], b2 = buf[2], b3 = buf[3]
              ext = (b0 === 0xD0 && b1 === 0xCF && b2 === 0x11 && b3 === 0xE0) ? '.xls' : '.xlsx'
            }
          } else {
            buf = Buffer.from(content, 'utf-8')
            ext = '.csv'
          }

          // Parse enough rows to cover the requested range
          const parseMax = Math.min(args.row_start + args.max_rows, MAX_ROWS_PER_SHEET)
          let result: Awaited<ReturnType<typeof parseInWorker>>
          try {
            result = await parseInWorker(buf, ext, parseMax)
          } catch (err) {
            return { error: err instanceof Error ? err.message : String(err) }
          }

          // Resolve sheet
          const sheetName = args.sheet || result.sheetNames[0]
          if (!sheetName) return { error: 'The workbook is empty', all_sheets: result.sheetNames }

          const sheet = result.sheets[sheetName]
          if (!sheet) {
            return {
              error: `Sheet "${args.sheet}" not found`,
              all_sheets: result.sheetNames,
            }
          }

          const totalRows  = sheet.rows.length
          const sliced     = sheet.rows.slice(args.row_start, args.row_start + args.max_rows)
          const truncated  = args.row_start + args.max_rows < totalRows

          // Include _row (1-based spreadsheet row, accounting for header row at row 1)
          const rowObjects = sliced.map((row, i) => {
            const rowNum = args.row_start + i + 2 // +1 for header row, +1 for 1-based
            const obj: Record<string, string> = { _row: String(rowNum) }
            sheet.headers.forEach((h, ci) => {
              obj[h || `col_${ci + 1}`] = row[ci] ?? ''
            })
            return obj
          })

          return {
            sheet: sheetName,
            all_sheets: result.sheetNames,
            dimensions: { total_rows: totalRows, total_cols: sheet.headers.length },
            headers: sheet.headers.length > 0 ? sheet.headers : null,
            rows: rowObjects,
            returned: rowObjects.length,
            truncated,
            ...(truncated ? {
              note: `Sheet has ${totalRows} rows total. Returned rows ${args.row_start + 1}–${args.row_start + rowObjects.length} (spreadsheet rows ${args.row_start + 2}–${args.row_start + rowObjects.length + 1}). Use row_start to read more.`,
            } : {}),
          }
        },
      }),
    )

    ctx.project.prompt.inject(
      [
        'Reading spreadsheet/CSV files:',
        '- XLSX/XLS/ODS/CSV on disk: use sheet_read({ path: "/filename.xlsx" }) — do NOT pass sheet, content, or filename unless needed. Omit sheet to read the first sheet.',
        '- The response always includes all_sheets (list of all sheet names) and sheet (active sheet name).',
        '- To read a specific sheet: sheet_read({ path: "...", sheet: "Sheet2" }).',
        '- For large or complex sheets: use row_start + max_rows to read specific regions.',
        '- The _row field is the 1-based spreadsheet row number for targeted follow-up reads.',
        '- CSV only: alternative is fs_read → csv_read(content).',
      ].join(' '),
    )
  },

  onProjectPluginActivated: async (projectId) => {
    console.log(`[jiku.sheet] activated for project ${projectId}`)
  },

  onProjectPluginDeactivated: async (projectId) => {
    console.log(`[jiku.sheet] deactivated for project ${projectId}`)
  },
})

// ── Minimal CSV parser (server-side, no dependencies) ────────────────────────

function parseCsv(raw: string): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let inQuotes = false
  let i = 0

  while (i < raw.length) {
    const ch   = raw[i]!
    const next = raw[i + 1]

    if (inQuotes) {
      if (ch === '"' && next === '"') { field += '"'; i += 2 }
      else if (ch === '"') { inQuotes = false; i++ }
      else { field += ch; i++ }
    } else {
      if (ch === '"') { inQuotes = true; i++ }
      else if (ch === ',') { row.push(field); field = ''; i++ }
      else if (ch === '\n' || (ch === '\r' && next === '\n')) {
        row.push(field); field = ''
        if (row.some(f => f !== '') || rows.length > 0) rows.push(row)
        row = []; i += ch === '\r' ? 2 : 1
      } else if (ch === '\r') {
        row.push(field); field = ''
        if (row.some(f => f !== '') || rows.length > 0) rows.push(row)
        row = []; i++
      } else { field += ch; i++ }
    }
  }

  if (field !== '' || row.length > 0) { row.push(field); rows.push(row) }
  return rows
}
