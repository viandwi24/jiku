'use client'

import { useMemo, useState, useEffect } from 'react'
import { Input } from '@jiku/ui'
import { Search, AlertCircle, Loader2 } from 'lucide-react'
import { getAuthHeaders } from '@/lib/auth'
import type { FileViewAdapterProps } from '@/lib/file-view-adapters'

const BASE_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001'

interface SheetData {
  sheetNames: string[]
  sheets: Record<string, { headers: string[]; rows: string[][] }>
  truncated: boolean
}

/** Minimal RFC 4180-compliant CSV parser — used for client-side CSV parsing. */
function parseCsv(raw: string): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let inQuotes = false
  let i = 0

  while (i < raw.length) {
    const ch = raw[i]!
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

function getExt(filename: string): string {
  return filename.includes('.') ? '.' + filename.split('.').pop()!.toLowerCase() : ''
}

function SheetTable({ headers, rows, filename }: { headers: string[]; rows: string[][]; filename: string }) {
  const [search, setSearch] = useState('')

  const filteredRows = useMemo(() => {
    if (!search) return rows
    const q = search.toLowerCase()
    return rows.filter(row => row.some(cell => cell.toLowerCase().includes(q)))
  }, [rows, search])

  return (
    <div className="flex flex-col flex-1 overflow-hidden">
      <div className="flex items-center gap-2 px-3 py-2 border-b shrink-0">
        <div className="relative">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3 w-3 text-muted-foreground" />
          <Input
            className="pl-7 h-7 text-xs w-48"
            placeholder="Filter rows..."
            value={search}
            onChange={e => setSearch(e.target.value)}
          />
        </div>
        <span className="text-xs text-muted-foreground">
          {filteredRows.length.toLocaleString()} / {rows.length.toLocaleString()} rows · {headers.length} cols
        </span>
        <span className="text-xs text-muted-foreground ml-auto">{filename}</span>
      </div>

      <div className="flex-1 overflow-auto">
        <table className="w-full text-xs border-collapse">
          <thead className="sticky top-0 z-10 bg-muted/90 backdrop-blur">
            <tr>
              <th className="w-10 px-2 py-1.5 text-right text-muted-foreground font-normal border-r border-b bg-muted/90 select-none">
                #
              </th>
              {headers.map((h, i) => (
                <th key={i} className="px-3 py-1.5 text-left font-semibold border-r border-b last:border-r-0 whitespace-nowrap">
                  {h || <span className="text-muted-foreground italic">col {i + 1}</span>}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {filteredRows.map((row, ri) => {
              const originalIndex = search ? rows.indexOf(row) : ri
              return (
                <tr key={ri} className="hover:bg-muted/30 even:bg-muted/10 transition-colors">
                  <td className="px-2 py-1 text-right text-muted-foreground border-r select-none">
                    {originalIndex + 2}
                  </td>
                  {headers.map((_, ci) => (
                    <td key={ci} className="px-3 py-1 border-r last:border-r-0 max-w-xs truncate" title={row[ci] ?? ''}>
                      {row[ci] ?? ''}
                    </td>
                  ))}
                </tr>
              )
            })}
            {filteredRows.length === 0 && (
              <tr>
                <td colSpan={headers.length + 1} className="px-3 py-8 text-center text-muted-foreground">
                  No rows match the filter.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  )
}

export function SheetViewAdapter({ projectId, content, filename, path }: FileViewAdapterProps) {
  const ext = getExt(filename)
  const isCsv = ext === '.csv'

  // For CSV: parse client-side from content prop
  const csvData = useMemo<SheetData | null>(() => {
    if (!isCsv) return null
    const rows = parseCsv(content)
    if (rows.length === 0) return { sheetNames: ['Sheet1'], sheets: { Sheet1: { headers: [], rows: [] } }, truncated: false }
    const headers = rows[0]!
    const dataRows = rows.slice(1)
    return {
      sheetNames: ['Sheet1'],
      sheets: { Sheet1: { headers, rows: dataRows } },
      truncated: false,
    }
  }, [isCsv, content])

  // For binary spreadsheets: fetch via plugin API
  const [apiData, setApiData] = useState<SheetData | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (isCsv || !path || !projectId) return
    setLoading(true)
    setError(null)
    setApiData(null)

    const url = `${BASE_URL}/api/plugins/jiku.sheet/api/sheet?path=${encodeURIComponent(path)}&project=${encodeURIComponent(projectId)}`
    fetch(url, { headers: { ...getAuthHeaders() } })
      .then(async r => {
        if (!r.ok) {
          const body = await r.json().catch(() => ({ error: r.statusText }))
          throw new Error((body as { error?: string }).error ?? 'Request failed')
        }
        return r.json() as Promise<SheetData>
      })
      .then(data => setApiData(data))
      .catch(err => setError(err instanceof Error ? err.message : String(err)))
      .finally(() => setLoading(false))
  }, [isCsv, path, projectId])

  const data = isCsv ? csvData : apiData
  const [activeSheet, setActiveSheet] = useState('')

  // Reset active sheet when data changes
  useEffect(() => {
    if (data?.sheetNames.length) {
      setActiveSheet(prev => data.sheetNames.includes(prev) ? prev : data.sheetNames[0]!)
    }
  }, [data])

  if (loading) {
    return (
      <div className="flex-1 flex items-center justify-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" />
        Parsing spreadsheet...
      </div>
    )
  }

  if (error) {
    return (
      <div className="flex-1 flex items-center justify-center gap-2 text-sm text-destructive">
        <AlertCircle className="h-4 w-4" />
        {error}
      </div>
    )
  }

  if (!data) {
    return (
      <div className="flex-1 flex items-center justify-center text-xs text-muted-foreground">
        Empty file
      </div>
    )
  }

  const sheetData = data.sheets[activeSheet]

  return (
    <div className="flex flex-col flex-1 overflow-hidden">
      {/* Sheet tabs — only shown when more than one sheet */}
      {data.sheetNames.length > 1 && (
        <div className="flex items-center gap-0.5 px-2 pt-1.5 border-b shrink-0 overflow-x-auto">
          {data.sheetNames.map(name => (
            <button
              key={name}
              onClick={() => setActiveSheet(name)}
              className={`px-3 py-1 text-xs rounded-t border-b-2 transition-colors whitespace-nowrap ${
                activeSheet === name
                  ? 'border-primary text-foreground font-medium'
                  : 'border-transparent text-muted-foreground hover:text-foreground'
              }`}
            >
              {name}
            </button>
          ))}
          {data.truncated && (
            <span className="ml-2 text-xs text-amber-500 shrink-0">Truncated at 5 000 rows/sheet</span>
          )}
        </div>
      )}

      {/* Table for the active sheet */}
      {sheetData ? (
        <SheetTable headers={sheetData.headers} rows={sheetData.rows} filename={filename} />
      ) : (
        <div className="flex-1 flex items-center justify-center text-xs text-muted-foreground">
          Empty sheet
        </div>
      )}
    </div>
  )
}
