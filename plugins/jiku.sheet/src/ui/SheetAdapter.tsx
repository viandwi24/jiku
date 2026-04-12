// Sheet view adapter — plugin UI bundle.
//
// Layout strategy:
//   The plugin root uses `position: absolute; inset: 0` so it fills the host
//   div with *guaranteed* pixel-precise dimensions. This is critical: flex-based
//   sizing fails when there are 20+ tab buttons because the browser can't pin
//   the tabs bar width without a real containing-block size.
//
// Two-phase loading for binary sheets:
//   Phase 1 — GET /sheet (no ?sheet)  → sheet names → render tabs
//   Phase 2 — GET /sheet?sheet=<name> → row data for active sheet only

import { useState, useEffect, useMemo } from 'react'
import type { CSSProperties } from 'react'
import { defineMountable } from '@jiku/kit/ui'
import type { PluginComponentProps } from '@jiku/kit/ui'

// ── Types ─────────────────────────────────────────────────────────────────────

interface SheetMeta extends Record<string, unknown> {
  projectId?: string
  path?: string
  filename?: string
  content?: string
  apiBaseUrl?: string
  authToken?: string | null
}

interface MetaResponse  { sheetNames: string[]; truncated: boolean }
interface SheetResponse { headers: string[]; rows: string[][]; truncated: boolean }

// ── Helpers ───────────────────────────────────────────────────────────────────

function parseCsv(raw: string): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let field = '', inQuotes = false, i = 0
  while (i < raw.length) {
    const ch = raw[i]!, next = raw[i + 1]
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

function sheetUrl(base: string, path: string, projectId: string, sheet?: string) {
  const u = new URL(`${base}/api/plugins/jiku.sheet/api/sheet`)
  u.searchParams.set('path', path)
  u.searchParams.set('project', projectId)
  if (sheet) u.searchParams.set('sheet', sheet)
  return u.toString()
}

function apiFetch<T>(url: string, token: string | null | undefined): Promise<T> {
  const h: Record<string, string> = {}
  if (token) h['Authorization'] = `Bearer ${token}`
  return fetch(url, { headers: h }).then(async r => {
    if (!r.ok) {
      const b = await r.json().catch(() => ({}))
      throw new Error((b as { error?: string }).error ?? `HTTP ${r.status}`)
    }
    return r.json() as Promise<T>
  })
}

// ── Table ─────────────────────────────────────────────────────────────────────

function SheetTable({
  headers,
  rows,
  filename,
  truncated,
}: {
  headers: string[]
  rows: string[][]
  filename: string
  truncated: boolean
}) {
  const [search, setSearch] = useState('')

  const filtered = useMemo(() => {
    if (!search) return rows
    const q = search.toLowerCase()
    return rows.filter(r => r.some(c => c.toLowerCase().includes(q)))
  }, [rows, search])

  // Pre-compute styles outside JSX to avoid esbuild 0.27.x TSX parser bug
  // where `style={fn({...})}` (nested {} inside JSX attribute {}) is rejected.
  const baseThStyle = headerCell({})
  const rowNumThStyle = headerCell({
    width: 40, textAlign: 'right', opacity: 0.4, fontWeight: 400, fontSize: 10,
  })

  return (
    // Wrapper: takes remaining height, clips, does NOT scroll horizontally —
    // that's handled by the inner scroll div.
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
      {/* Toolbar */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 8, padding: '5px 10px',
        borderBottom: '1px solid hsl(var(--border))', flexShrink: 0,
      }}>
        <div style={{ position: 'relative' }}>
          <input
            style={{
              paddingLeft: 26, height: 26, fontSize: 11, width: 160,
              border: '1px solid hsl(var(--border))', borderRadius: 5,
              background: 'transparent', color: 'inherit', outline: 'none',
            }}
            placeholder="Filter rows…"
            value={search}
            onChange={e => setSearch(e.target.value)}
          />
          <span style={{
            position: 'absolute', left: 8, top: '50%', transform: 'translateY(-50%)',
            fontSize: 12, opacity: 0.4, pointerEvents: 'none',
          }}>⌕</span>
        </div>
        <span style={{ fontSize: 11, opacity: 0.55, whiteSpace: 'nowrap' }}>
          {filtered.length.toLocaleString()} / {rows.length.toLocaleString()} rows · {headers.length} cols
          {truncated && (
            <span style={{ marginLeft: 6, color: 'hsl(38 92% 45%)' }}>· 5 000 row limit</span>
          )}
        </span>
        <span style={{
          fontSize: 11, opacity: 0.35, marginLeft: 'auto',
          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0,
        }}>{filename}</span>
      </div>

      {/* Scroll area — both axes; table is naturally as wide as it needs */}
      <div style={{ flex: 1, overflow: 'auto' }}>
        <table style={{ borderCollapse: 'collapse', fontSize: 12, whiteSpace: 'nowrap' }}>
          <thead>
            <tr>
              <th style={rowNumThStyle}>#</th>
              {headers.map((h, i) => (
                <th key={i} style={baseThStyle} title={h}>
                  {h || <em style={{ opacity: 0.35, fontStyle: 'normal' }}>col {i + 1}</em>}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {filtered.length === 0 ? (
              <tr>
                <td
                  colSpan={headers.length + 1}
                  style={{ padding: '24px 12px', textAlign: 'center', opacity: 0.4, fontSize: 12, whiteSpace: 'normal' }}
                >
                  {search ? 'No rows match the filter.' : 'This sheet is empty.'}
                </td>
              </tr>
            ) : filtered.map((row, ri) => {
              const origIdx = search ? rows.indexOf(row) : ri
              return (
                <tr key={ri} style={{ background: ri % 2 === 0 ? undefined : 'hsl(var(--muted) / 0.35)' }}>
                  <td style={{ padding: '3px 8px', textAlign: 'right', opacity: 0.3, fontSize: 10, borderRight: '1px solid hsl(var(--border))', userSelect: 'none' }}>
                    {origIdx + 2}
                  </td>
                  {headers.map((_, ci) => (
                    <td
                      key={ci}
                      style={{ padding: '3px 10px', borderRight: '1px solid hsl(var(--border) / 0.6)', maxWidth: 300, overflow: 'hidden', textOverflow: 'ellipsis' }}
                      title={row[ci] ?? ''}
                    >
                      {row[ci] ?? ''}
                    </td>
                  ))}
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </div>
  )
}

// Named `headerCell` (not `th`) to avoid esbuild TSX parser confusion with <th> elements.
function headerCell(extra: CSSProperties): CSSProperties {
  return {
    padding: '5px 10px',
    textAlign: 'left',
    fontWeight: 600,
    fontSize: 11,
    borderRight: '1px solid hsl(var(--border))',
    borderBottom: '2px solid hsl(var(--border))',
    background: 'hsl(var(--muted))',
    // Sticky: must be on <th>, not <tr>, for reliable cross-browser behaviour
    position: 'sticky',
    top: 0,
    zIndex: 1,
    userSelect: 'none',
    ...extra,
  }
}

// ── Main component ────────────────────────────────────────────────────────────

function SheetAdapterComponent({ meta }: PluginComponentProps) {
  const {
    projectId = '',
    path      = '',
    filename  = '',
    content   = '',
    apiBaseUrl = '',
    authToken  = null,
  } = meta as SheetMeta

  const ext   = (filename as string).includes('.')
    ? '.' + (filename as string).split('.').pop()!.toLowerCase()
    : ''
  const isCsv = ext === '.csv'
  const base  = (apiBaseUrl as string) || ''
  const token = authToken as string | null

  // ── Root style — MUST be absolute to give it defined pixel dimensions.
  // Without this, flex sizing with 20+ tabs causes the layout to blow out
  // beyond the browser viewport.
  const ROOT: CSSProperties = {
    position: 'absolute', inset: 0,
    display: 'flex', flexDirection: 'column',
    overflow: 'hidden',
    fontFamily: 'inherit',
    fontSize: 13,
    color: 'hsl(var(--foreground))',
    background: 'hsl(var(--background))',
  }

  const CENTER: CSSProperties = {
    ...ROOT, alignItems: 'center', justifyContent: 'center',
    gap: 8, fontSize: 12,
  }

  // ── CSV: client-side parse ────────────────────────────────────────────────
  const csvData = useMemo<SheetResponse | null>(() => {
    if (!isCsv) return null
    const raw = parseCsv(content as string)
    if (raw.length === 0) return { headers: [], rows: [], truncated: false }
    return { headers: raw[0]!, rows: raw.slice(1), truncated: false }
  }, [isCsv, content])

  // ── Binary: phase 1 — sheet names ────────────────────────────────────────
  const [metaResult, setMetaResult]   = useState<MetaResponse | null>(null)
  const [metaLoading, setMetaLoading] = useState(false)
  const [metaError, setMetaError]     = useState<string | null>(null)

  // ── Binary: phase 2 — active sheet data ──────────────────────────────────
  const [activeSheet, setActiveSheet] = useState('')
  const [sheetData, setSheetData]     = useState<SheetResponse | null>(null)
  const [dataLoading, setDataLoading] = useState(false)
  const [dataError, setDataError]     = useState<string | null>(null)

  // Reset everything when file path changes
  useEffect(() => {
    setMetaResult(null); setMetaError(null)
    setSheetData(null);  setDataError(null)
    setActiveSheet('')
  }, [path])

  // Phase 1
  useEffect(() => {
    if (isCsv || !path || !projectId) return
    setMetaLoading(true); setMetaError(null)
    apiFetch<MetaResponse>(sheetUrl(base, path as string, projectId as string), token)
      .then(d => { setMetaResult(d); setActiveSheet(d.sheetNames[0] ?? '') })
      .catch(e => setMetaError(e instanceof Error ? e.message : String(e)))
      .finally(() => setMetaLoading(false))
  }, [isCsv, path, projectId, base, token])

  // Phase 2
  useEffect(() => {
    if (isCsv || !activeSheet || !path || !projectId) return
    setDataLoading(true); setDataError(null); setSheetData(null)
    apiFetch<SheetResponse>(sheetUrl(base, path as string, projectId as string, activeSheet), token)
      .then(d => setSheetData(d))
      .catch(e => setDataError(e instanceof Error ? e.message : String(e)))
      .finally(() => setDataLoading(false))
  }, [isCsv, activeSheet, path, projectId, base, token])

  // ── CSV render ────────────────────────────────────────────────────────────
  if (isCsv) {
    if (!csvData || (csvData.headers.length === 0 && csvData.rows.length === 0)) {
      return <div style={{ ...CENTER, opacity: 0.4 }}>Empty file</div>
    }
    return (
      <div style={ROOT}>
        <SheetTable headers={csvData.headers} rows={csvData.rows} filename={filename as string} truncated={false} />
      </div>
    )
  }

  // ── Binary: phase-1 states ────────────────────────────────────────────────
  if (metaLoading) return <div style={{ ...CENTER, opacity: 0.5 }}>Loading spreadsheet…</div>
  if (metaError)   return <div style={{ ...CENTER }}><span style={{ color: 'hsl(var(--destructive))', maxWidth: 360, textAlign: 'center' }}>{metaError}</span></div>
  if (!metaResult) return <div style={{ ...CENTER, opacity: 0.4 }}>No data</div>

  const { sheetNames, truncated: wbTruncated } = metaResult

  return (
    <div style={ROOT}>

      {/* Sheet tabs ─────────────────────────────────────────────────────────
          overflowX:auto here works because ROOT is position:absolute with a
          real pixel width, so the bar has a defined width to scroll within. */}
      {sheetNames.length > 1 && (
        <div style={{
          display: 'flex', alignItems: 'stretch', flexShrink: 0,
          borderBottom: '1px solid hsl(var(--border))',
          overflowX: 'auto',
          // Hide the scrollbar visually — the user drags or uses arrow keys
          scrollbarWidth: 'none',
        }}>
          {sheetNames.map(name => {
            const active = name === activeSheet
            return (
              <button
                key={name}
                onClick={() => setActiveSheet(name)}
                style={{
                  flexShrink: 0,
                  padding: '5px 14px', fontSize: 12,
                  cursor: 'pointer', whiteSpace: 'nowrap', outline: 'none',
                  background: active ? 'hsl(var(--background))' : 'transparent',
                  color: active ? 'hsl(var(--foreground))' : 'hsl(var(--muted-foreground))',
                  fontWeight: active ? 600 : 400,
                  borderBottom: active
                    ? '2px solid hsl(var(--primary))'
                    : '2px solid transparent',
                  borderTop: 'none', borderLeft: 'none',
                  borderRight: '1px solid hsl(var(--border) / 0.4)',
                }}
              >
                {name}
              </button>
            )
          })}
          {wbTruncated && (
            <span style={{
              padding: '4px 10px', fontSize: 11, flexShrink: 0, alignSelf: 'center',
              color: 'hsl(38 92% 45%)',
              borderLeft: '1px solid hsl(var(--border) / 0.4)',
              whiteSpace: 'nowrap',
            }}>
              5 000 row limit
            </span>
          )}
        </div>
      )}

      {/* Phase-2: sheet content */}
      {dataLoading ? (
        <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', opacity: 0.5, fontSize: 12 }}>
          Loading sheet…
        </div>
      ) : dataError ? (
        <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <span style={{ color: 'hsl(var(--destructive))', fontSize: 12 }}>{dataError}</span>
        </div>
      ) : sheetData ? (
        <SheetTable
          headers={sheetData.headers}
          rows={sheetData.rows}
          filename={filename as string}
          truncated={sheetData.truncated}
        />
      ) : (
        <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', opacity: 0.4, fontSize: 12 }}>
          {activeSheet ? 'Loading…' : 'Select a sheet above'}
        </div>
      )}

    </div>
  )
}

export default defineMountable(SheetAdapterComponent)
