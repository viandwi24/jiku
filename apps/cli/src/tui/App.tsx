import { Box, Text, useApp, useInput } from 'ink'
import Spinner from 'ink-spinner'
import { useEffect, useState } from 'react'
import { listPlugins, type PluginRow } from '../lib/discover.ts'
import { buildPlugin, watchPlugin, type WatchHandle } from '../lib/builder.ts'

interface WatchState { [id: string]: WatchHandle }
interface BuildLog { id: string; ok: boolean; duration_ms: number; stderr: string }

export function App() {
  const { exit } = useApp()
  const [rows, setRows] = useState<PluginRow[] | null>(null)
  const [cursor, setCursor] = useState(0)
  const [building, setBuilding] = useState<string | null>(null)
  const [watchState, setWatchState] = useState<WatchState>({})
  const [logs, setLogs] = useState<BuildLog[]>([])
  const [notice, setNotice] = useState<string>('')

  async function refresh() {
    const r = await listPlugins()
    setRows(r)
    if (cursor >= r.length) setCursor(Math.max(0, r.length - 1))
  }

  useEffect(() => {
    refresh().catch((err: unknown) => setNotice(err instanceof Error ? err.message : String(err)))
    return () => { for (const h of Object.values(watchState)) h.stop() }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useInput((input, key) => {
    if (!rows || rows.length === 0) {
      if (input === 'q' || key.escape) exit()
      return
    }
    const current = rows[cursor]
    if (key.upArrow) setCursor(c => Math.max(0, c - 1))
    else if (key.downArrow) setCursor(c => Math.min(rows.length - 1, c + 1))
    else if (input === 'q' || key.escape) {
      for (const h of Object.values(watchState)) h.stop()
      exit()
    }
    else if (input === 'r') { setNotice('refreshing…'); refresh().then(() => setNotice('')) }
    else if (input === 'b' && current) {
      setBuilding(current.def.meta.id)
      buildPlugin(current.def.meta.id, current.dir).then(res => {
        setBuilding(null)
        setLogs(prev => [{ id: res.id, ok: res.ok, duration_ms: res.duration_ms, stderr: res.stderr }, ...prev].slice(0, 6))
        refresh()
      })
    }
    else if (input === 'w' && current) {
      const id = current.def.meta.id
      if (watchState[id]) {
        watchState[id].stop()
        setWatchState(s => { const n = { ...s }; delete n[id]; return n })
        setNotice(`stopped watching ${id}`)
      } else {
        watchPlugin(id, current.dir, line => {
          setLogs(prev => [{ id, ok: true, duration_ms: 0, stderr: line }, ...prev].slice(0, 6))
        }).then(h => {
          if (h) {
            setWatchState(s => ({ ...s, [id]: h }))
            setNotice(`watching ${id}`)
          } else {
            setNotice(`${id} has no tsup.config.*`)
          }
        })
      }
    }
  })

  return (
    <Box flexDirection="column" padding={1}>
      <Box marginBottom={1}>
        <Text bold color="cyan">jiku plugin manager</Text>
        <Text dimColor>  ↑↓ select · b build · w watch · r refresh · q quit</Text>
      </Box>
      {rows === null ? (
        <Text><Spinner type="dots" /> discovering plugins…</Text>
      ) : rows.length === 0 ? (
        <Text dimColor>No plugins found in workspace.</Text>
      ) : (
        <Box flexDirection="column">
          {rows.map((r, i) => {
            const selected = i === cursor
            const watching = !!watchState[r.def.meta.id]
            const isBuilding = building === r.def.meta.id
            return (
              <Box key={r.def.meta.id}>
                <Text color={selected ? 'cyan' : undefined}>
                  {selected ? '▸ ' : '  '}
                  {r.def.meta.id.padEnd(22)}
                  {' '}
                  <Text dimColor>v{r.def.meta.version.padEnd(8)}</Text>
                  {' '}
                  {r.uiEntries > 0 ? <Text color="green">ui:{r.uiEntries}</Text> : <Text dimColor>ui:-</Text>}
                  {'  '}
                  {r.built ? <Text color="green">built</Text> : <Text color="yellow">unbuilt</Text>}
                  {isBuilding && <Text color="yellow">  …building</Text>}
                  {watching && <Text color="magenta">  watching</Text>}
                </Text>
              </Box>
            )
          })}
        </Box>
      )}
      {notice && (
        <Box marginTop={1}><Text color="yellow">{notice}</Text></Box>
      )}
      {logs.length > 0 && (
        <Box marginTop={1} flexDirection="column">
          <Text dimColor>recent:</Text>
          {logs.map((l, i) => (
            <Text key={i} color={l.ok ? 'green' : 'red'}>
              {l.ok ? '✓' : '✗'} {l.id.padEnd(22)} {l.duration_ms ? `${l.duration_ms}ms` : ''} {l.stderr.slice(0, 80)}
            </Text>
          ))}
        </Box>
      )}
    </Box>
  )
}
