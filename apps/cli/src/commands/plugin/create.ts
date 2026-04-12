import { scaffoldPlugin } from '../../lib/scaffold.ts'

export async function pluginCreateCmd(id: string, opts: { name?: string }): Promise<void> {
  try {
    const r = await scaffoldPlugin(id, opts.name)
    console.log(`✓ Scaffolded "${r.id}" at ${r.dir}`)
    console.log('  Files:')
    for (const f of r.files) console.log(`    ${f}`)
    console.log()
    console.log('Next steps:')
    console.log('  1. bun install                 # link the new workspace package')
    console.log(`  2. jiku plugin build ${r.id}   # produce dist/ui`)
    console.log('  3. Restart apps/studio/server  # picks up the new plugin via auto-discovery')
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err))
    process.exit(1)
  }
}
