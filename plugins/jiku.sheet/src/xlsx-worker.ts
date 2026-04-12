// Worker thread for xlsx parsing — runs synchronous XLSX.read() in isolation
// so the main event loop is never blocked.
// Receives: { bufArray: ArrayBuffer, ext: string, maxRows: number }
// Sends:    { sheetNames, sheets, truncated } | { error: string }

import { parentPort, workerData } from 'node:worker_threads'
import { createRequire } from 'node:module'

// SheetJS Bun docs: "It is strongly recommended to use CommonJS in Bun."
// ESM import() does not auto-load encoding/stream support; require() does.
const require_ = createRequire(import.meta.url)

/**
 * Validate ZIP local file header to detect corruption before feeding to xlsx.
 *
 * A well-formed XLSX/ODS is a ZIP archive. The local file header starts at
 * offset 0 with the PK\x03\x04 signature. Bytes 22–25 (little-endian uint32)
 * hold the *uncompressed* size of the first entry. SheetJS reads this field
 * and allocates a buffer of that size *without validation* — a corrupted ZIP64
 * field (e.g. 0x200000000 = 8 GB) causes immediate OOM / system freeze.
 *
 * We reject the file if any entry's declared uncompressed size exceeds a sane
 * multiple of the total archive size (corrupt) or an absolute cap of 256 MB.
 */
function validateZipSizes(buf: Buffer): string | null {
  const MAX_UNCOMPRESSED = 256 * 1024 * 1024 // 256 MB absolute cap
  const MAX_RATIO = 200 // uncompressed can't be >200x the archive itself

  let offset = 0
  let entries = 0
  const maxEntries = 500

  while (offset + 30 <= buf.length && entries < maxEntries) {
    // Local file header signature: PK\x03\x04
    if (
      buf[offset] !== 0x50 ||
      buf[offset + 1] !== 0x4b ||
      buf[offset + 2] !== 0x03 ||
      buf[offset + 3] !== 0x04
    ) {
      break // no more local file headers
    }

    const compressedSize   = buf.readUInt32LE(offset + 18)
    const uncompressedSize = buf.readUInt32LE(offset + 22)
    const fileNameLen      = buf.readUInt16LE(offset + 26)
    const extraFieldLen    = buf.readUInt16LE(offset + 28)

    // Detect ZIP64 sentinel (0xFFFFFFFF) — means real size is in extra field.
    // We don't parse ZIP64 extra fields here; just cap based on file size.
    const sizeToCheck = uncompressedSize === 0xffffffff
      ? buf.length * MAX_RATIO + 1  // force fail: we can't safely determine real size
      : uncompressedSize

    if (sizeToCheck > MAX_UNCOMPRESSED || sizeToCheck > buf.length * MAX_RATIO) {
      return `ZIP entry declares uncompressed size ${uncompressedSize} bytes which exceeds safe limits. The file appears corrupted — please delete and re-upload it.`
    }

    // Advance past this local file header + data
    const dataOffset = offset + 30 + fileNameLen + extraFieldLen
    const nextOffset = dataOffset + compressedSize
    if (nextOffset <= offset || nextOffset > buf.length + 30) break // guard infinite loop
    offset = nextOffset
    entries++
  }

  return null // OK
}

async function main() {
  const { bufArray, ext, maxRows } = workerData as {
    bufArray: ArrayBuffer
    ext: string
    maxRows: number
  }

  const buf = Buffer.from(bufArray)

  // Validate ZIP structure for binary spreadsheet formats before xlsx touches it.
  if (ext !== '.csv') {
    const err = validateZipSizes(buf)
    if (err) {
      parentPort?.postMessage({ error: err })
      return
    }
  }

  // Use CommonJS require (Bun strongly recommends this over ESM import for xlsx).
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const XLSX = require_('xlsx') as typeof import('xlsx')

  let workbook: import('xlsx').WorkBook
  if (ext === '.csv') {
    workbook = XLSX.read(buf.toString('utf-8'), { type: 'string', raw: false })
  } else {
    workbook = XLSX.read(buf, { type: 'buffer', raw: false, cellDates: true })
  }

  const sheets: Record<string, { headers: string[]; rows: string[][] }> = {}
  for (const name of workbook.SheetNames) {
    const ws = workbook.Sheets[name]!
    const aoa = XLSX.utils.sheet_to_json<unknown[]>(ws, { header: 1, defval: '' })
    const headers = ((aoa[0] ?? []) as unknown[]).map(c => String(c ?? ''))
    const rows = aoa.slice(1, maxRows + 1).map(row =>
      headers.map((_, i) => String((row as unknown[])[i] ?? ''))
    )
    sheets[name] = { headers, rows }
  }

  parentPort?.postMessage({
    sheetNames: workbook.SheetNames,
    sheets,
    truncated: workbook.SheetNames.some(n => (sheets[n]?.rows.length ?? 0) >= maxRows),
  })
}

main().catch(err => {
  parentPort?.postMessage({ error: err instanceof Error ? err.message : String(err) })
})
