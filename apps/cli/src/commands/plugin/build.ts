import { listPlugins, findPlugin, detectCwdPlugin, type PluginRow } from '../../lib/discover.ts'
import { buildPlugin } from '../../lib/builder.ts'

async function resolveTargets(id: string | undefined): Promise<{ rows: PluginRow[]; scope: string }> {
  if (id) {
    const r = await findPlugin(id)
    return { rows: r ? [r] : [], scope: `plugin "${id}"` }
  }
  // No id: if cwd is inside a plugin, build just that one. Otherwise all.
  const cwd = await detectCwdPlugin()
  if (cwd) return { rows: [cwd], scope: `cwd plugin "${cwd.def.meta.id}"` }
  const all = (await listPlugins()).filter(r => r.uiEntries > 0)
  return { rows: all, scope: 'all plugins' }
}

export async function pluginBuildCmd(id: string | undefined): Promise<void> {
  const { rows, scope } = await resolveTargets(id)
  if (rows.length === 0) {
    console.error(id ? `Plugin "${id}" not found.` : 'No plugins with UI entries found.')
    process.exit(1)
  }

  console.log(`Building ${scope} (${rows.length} plugin${rows.length === 1 ? '' : 's'})…`)
  let failed = 0
  for (const r of rows) {
    process.stdout.write(`  ${r.def.meta.id.padEnd(30)} `)
    const res = await buildPlugin(r.def.meta.id, r.dir)
    if (res.ok) {
      console.log(`✓ (${res.duration_ms}ms)`)
    } else {
      failed++
      console.log(`✗ (code ${res.code})`)
      if (res.stderr) console.log(res.stderr.split('\n').map(l => '    ' + l).join('\n'))
    }
  }
  if (failed > 0) process.exit(1)
}
