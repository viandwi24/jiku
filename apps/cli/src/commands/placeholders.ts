import { Command } from 'commander'

// Namespaces reserved for future jiku CLI growth. They surface in --help so
// the tree is discoverable, but each subcommand exits with a TODO note.

function stub(name: string): (...args: unknown[]) => void {
  return () => {
    console.log(`[jiku ${name}] not implemented yet.`)
    process.exit(2)
  }
}

export function registerPlaceholderCommands(root: Command): void {
  const agent = root.command('agent').description('Agent operations (coming soon)')
  agent.command('list').description('List agents').action(stub('agent list'))
  agent.command('run <id>').description('Run an agent').action(stub('agent run'))

  const db = root.command('db').description('Database operations (coming soon)')
  db.command('push').description('Apply schema changes').action(stub('db push'))
  db.command('studio').description('Open drizzle-kit studio').action(stub('db studio'))
  db.command('seed').description('Seed baseline data').action(stub('db seed'))

  const dev = root.command('dev').description('Development utilities (coming soon)')
  dev.command('doctor').description('Diagnose workspace setup').action(stub('dev doctor'))
}
