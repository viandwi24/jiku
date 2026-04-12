import { Command } from 'commander'
import { pluginListCmd } from './list.ts'
import { pluginInfoCmd } from './info.ts'
import { pluginBuildCmd } from './build.ts'
import { pluginWatchCmd } from './watch.ts'
import { pluginCreateCmd } from './create.ts'

export function registerPluginCommands(root: Command): void {
  const cmd = root.command('plugin').description('Manage Jiku plugins')

  cmd.command('list')
    .description('List all discovered plugins')
    .option('--json', 'Output JSON')
    .action(async (opts) => { await pluginListCmd(opts) })

  cmd.command('info <id>')
    .description('Show manifest + UI entries for a plugin')
    .action(async (id) => { await pluginInfoCmd(id) })

  cmd.command('build [id]')
    .description('Build plugin UI bundle(s) via tsup. Omit id to build all.')
    .action(async (id) => { await pluginBuildCmd(id) })

  cmd.command('watch [id]')
    .description('Watch plugin UI source and rebuild on change. Omit id to watch all.')
    .action(async (id) => { await pluginWatchCmd(id) })

  cmd.command('create <id>')
    .description('Scaffold a new plugin under plugins/<id>/')
    .option('-n, --name <displayName>', 'Display name shown in Studio')
    .action(async (id, opts) => { await pluginCreateCmd(id, opts) })
}
