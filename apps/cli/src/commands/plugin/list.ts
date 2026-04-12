import { listPlugins } from '../../lib/discover.ts'

export async function pluginListCmd(opts: { json?: boolean }): Promise<void> {
  const rows = await listPlugins()
  if (opts.json) {
    console.log(JSON.stringify(rows.map(r => ({
      id: r.def.meta.id,
      name: r.def.meta.name,
      version: r.def.meta.version,
      packageName: r.packageName,
      dir: r.dir,
      built: r.built,
      ui_entries: r.uiEntries,
      project_scope: !!r.def.meta.project_scope,
    })), null, 2))
    return
  }
  if (rows.length === 0) {
    console.log('No plugins found.')
    return
  }
  const pad = (s: string, n: number) => s.length >= n ? s : s + ' '.repeat(n - s.length)
  const idW = Math.max(...rows.map(r => r.def.meta.id.length), 2)
  const nameW = Math.max(...rows.map(r => r.def.meta.name.length), 4)
  const verW = Math.max(...rows.map(r => r.def.meta.version.length), 7)

  console.log(`${pad('ID', idW)}  ${pad('NAME', nameW)}  ${pad('VERSION', verW)}  UI  BUILT  SCOPE`)
  for (const r of rows) {
    const scope = r.def.meta.project_scope ? 'project' : 'system '
    const built = r.built ? 'yes' : 'no '
    const ui = r.uiEntries > 0 ? `${r.uiEntries}` : '—'
    console.log(
      `${pad(r.def.meta.id, idW)}  ${pad(r.def.meta.name, nameW)}  ${pad(r.def.meta.version, verW)}  ${pad(ui, 2)}  ${built}    ${scope}`,
    )
  }
}
