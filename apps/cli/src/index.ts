#!/usr/bin/env bun
import { Command } from 'commander'
import { registerPluginCommands } from './commands/plugin/index.ts'
import { registerPlaceholderCommands } from './commands/placeholders.ts'

const program = new Command()
program
  .name('jiku')
  .description('Jiku developer CLI — manage plugins, agents, database, and dev utilities.')
  .version('0.1.0')

registerPluginCommands(program)
registerPlaceholderCommands(program)

// Default action (no args) → launch interactive Ink TUI.
program.action(async () => {
  const [{ render }, { App }] = await Promise.all([
    import('ink'),
    import('./tui/App.tsx'),
  ])
  const { createElement } = await import('react')
  const { waitUntilExit } = render(createElement(App))
  await waitUntilExit()
})

program.parseAsync(process.argv).catch((err) => {
  console.error(err instanceof Error ? err.message : String(err))
  process.exit(1)
})
