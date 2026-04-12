import { listPlugins, findPlugin, detectCwdPlugin, type PluginRow } from '../../lib/discover.ts'
import { watchPlugin, type WatchHandle } from '../../lib/builder.ts'

async function resolveTargets(id: string | undefined): Promise<{ rows: PluginRow[]; scope: string }> {
  if (id) {
    const r = await findPlugin(id)
    return { rows: r ? [r] : [], scope: `plugin "${id}"` }
  }
  const cwd = await detectCwdPlugin()
  if (cwd) return { rows: [cwd], scope: `cwd plugin "${cwd.def.meta.id}"` }
  const all = (await listPlugins()).filter(r => r.uiEntries > 0)
  return { rows: all, scope: 'all plugins' }
}

export async function pluginWatchCmd(id: string | undefined): Promise<void> {
  const { rows, scope } = await resolveTargets(id)
  if (rows.length === 0) {
    console.error(id ? `Plugin "${id}" not found.` : 'No plugins with UI entries found.')
    process.exit(1)
  }

  const handles: WatchHandle[] = []
  for (const r of rows) {
    const h = await watchPlugin(r.def.meta.id, r.dir, (line) => {
      console.log(`[${r.def.meta.id}] ${line}`)
    })
    if (h) handles.push(h)
  }
  if (handles.length === 0) {
    console.error('No buildable plugin found (missing tsup.config).')
    process.exit(1)
  }
  console.log(`Watching ${scope} (${handles.length} plugin${handles.length === 1 ? '' : 's'}). Ctrl+C to stop.`)

  const cleanup = () => {
    console.log('\nStopping watchers…')
    for (const h of handles) h.stop()
    process.exit(0)
  }
  process.on('SIGINT', cleanup)
  process.on('SIGTERM', cleanup)
  await new Promise(() => {})
}
