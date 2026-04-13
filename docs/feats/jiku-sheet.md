# Feature: jiku.sheet Plugin

## What it does

Adds spreadsheet/CSV support to Jiku Studio:
- **UI viewer** — Sheet view tab in the file explorer (two-phase loading: metadata → active sheet data)
- **Agent tools** — `csv_read` and `sheet_read` for structured data access
- **Binary file hint** — registers `.xlsx`/`.xls`/`.ods`/`.csv` → `sheet_read` so `fs_read` redirects agents to the right tool instead of dumping raw base64

## Architecture

```
Plugin setup (ctx.setup):
  ├─ ctx.fileViewAdapters.register({ id: 'jiku.sheet.spreadsheet', extensions: ['.csv', '.xlsx', ...] })
  ├─ ctx.http.get('/sheet') — metadata + per-sheet data route (shared with UI)
  └─ ctx.project.tools.register(csv_read, sheet_read)

UI (SheetAdapter.tsx):
  ├─ Phase 1: GET /sheet?path=&project= → { sheetNames, truncated }
  └─ Phase 2: GET /sheet?path=&project=&sheet=<name> → { headers, rows, truncated }

Workbook cache (in-memory):
  ├─ Map<`${projectId}:${filePath}`, CachedWorkbook> — 1hr TTL, max 30 entries
  └─ inFlight Map — deduplicates concurrent parses for same file

Worker thread (xlsx-worker.ts):
  ├─ CommonJS require('xlsx') via createRequire (NOT ESM import — Bun compat)
  ├─ ZIP structure validation (uncompressed size, 256MB cap, 200× ratio cap, ZIP64 sentinel)
  └─ 30-second hard timeout via setTimeout + worker.terminate()
```

## Agent Tools

### `csv_read`
- Input: `content` (raw CSV text from `fs_read`), optional `limit`, `filter_column`, `filter_value`
- Use for: plain text CSV files after reading with `fs_read`
- Permission: `*`

### `sheet_read`
- Input: `path` (preferred — reads from disk directly) OR `content` (base64/text for small files)
- Optional: `sheet` (defaults to first sheet), `row_start`, `max_rows` (default 100, max 500)
- Returns: `{ sheet, all_sheets, dimensions, headers, rows, returned, truncated }`
- Each row includes `_row` (1-based spreadsheet row number) for targeted follow-up reads
- Permission: `*`

**Path-based read:** Uses `toolCtx.runtime['project_id']` (injected by runner) + dynamic import of `getFilesystemService` to read binary directly — avoids context overflow. Hits the shared workbook cache (UI and tool share the same cache).

## UI Layout

Root uses `position: absolute; inset: 0` — critical for pixel-precise dimensions. Without this, `overflow-x: auto` on the tabs bar fails with 20+ sheets because flex sizing can't pin width without a defined containing block.

Host div in `file-detail-panel.tsx` must have class `relative` for the absolute positioning to work.

Sticky header: `position: sticky; top: 0` on `<th>` elements (NOT `<tr>`).

Styles pre-computed before JSX return (esbuild 0.27.x TSX parser bug: can't handle `style={fn({...})}` with nested `{}` inside JSX attribute `{}`).

## Known Gotchas

- **`??` vs `||` for optional `sheet` param**: Agent may pass `"sheet": ""`. Use `args.sheet || wb.sheetNames[0]`, NOT `args.sheet ?? wb.sheetNames[0]`. Empty string is falsy to `||` but not `??`.
- **CommonJS require for xlsx**: Must use `createRequire(import.meta.url)` + `require_('xlsx')` in the worker. ESM `import('xlsx')` in Bun doesn't auto-load encoding/stream support and may hang.
- **ZIP validation before parse**: Corrupted xlsxfiles can declare 8GB uncompressed sizes (0x200000000) in the ZIP local file header. Validate before calling `XLSX.read()` or xlsx will try to allocate that memory.
- **Worker timeout**: 30s hard limit — corrupt files that pass ZIP validation but hang during parsing still get killed.

## Related Files

- `plugins/jiku.sheet/src/index.ts` — main plugin (tools, HTTP route, cache, worker spawning)
- `plugins/jiku.sheet/src/xlsx-worker.ts` — worker thread (CommonJS xlsx, ZIP validation)
- `plugins/jiku.sheet/src/ui/SheetAdapter.tsx` — React UI component
- `apps/studio/server/src/plugins/ui/fileViewAdapterRegistry.ts` — `buildBinaryFileHints()`
- `apps/studio/server/src/filesystem/tools.ts` — `BinaryFileHints` type + `fs_read` binary intercept
- `apps/studio/server/src/runtime/manager.ts` — wires `buildBinaryFileHints()` into `buildFilesystemTools()`
