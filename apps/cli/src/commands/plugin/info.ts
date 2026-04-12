import { findPlugin } from '../../lib/discover.ts'

export async function pluginInfoCmd(id: string): Promise<void> {
  const row = await findPlugin(id)
  if (!row) {
    console.error(`Plugin "${id}" not found.`)
    process.exit(1)
  }
  const def = row.def
  console.log(`${def.meta.name} (${def.meta.id}) v${def.meta.version}`)
  console.log(`  package     ${row.packageName}`)
  console.log(`  dir         ${row.dir}`)
  console.log(`  scope       ${def.meta.project_scope ? 'project' : 'system'}`)
  console.log(`  built       ${row.built ? 'yes' : 'no'}`)
  console.log(`  description ${def.meta.description ?? '—'}`)
  console.log(`  author      ${def.meta.author ?? '—'}`)
  console.log()

  const entries = def.ui?.entries ?? []
  if (entries.length === 0) {
    console.log('UI entries: (none)')
  } else {
    console.log(`UI entries (${entries.length}, apiVersion ${def.ui?.apiVersion ?? '1'}):`)
    for (const e of entries) {
      console.log(`  • ${e.slot.padEnd(28)} ${e.id.padEnd(16)} module=${e.module}`)
    }
    console.log(`  assetsDir: ${def.ui?.assetsDir ?? '(not set)'}`)
  }
  console.log()
  console.log('Depends:', Array.isArray(def.depends) ? def.depends.map(d => typeof d === 'string' ? d : d.meta.id).join(', ') : '(none)')
}
