// Plugin scaffolder — writes a template folder under `plugins/<id>/`.

import { mkdir, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { findWorkspaceRoot } from './workspace.ts'

export interface ScaffoldResult {
  id: string
  dir: string
  files: string[]
}

async function exists(p: string): Promise<boolean> {
  try { await stat(p); return true } catch { return false }
}

function pkg(id: string, displayName: string): string {
  return JSON.stringify(
    {
      name: `@jiku/plugin-${id.replace(/^jiku\./, '')}`,
      version: '0.1.0',
      module: 'src/index.ts',
      types: 'src/index.ts',
      typings: 'src/index.ts',
      type: 'module',
      private: true,
      files: ['src', 'dist'],
      scripts: {
        build: 'tsup',
        'build:watch': 'tsup --watch',
        clean: 'rm -rf dist',
      },
      dependencies: {
        '@jiku-plugin/studio': 'workspace:*',
        '@jiku/kit': 'workspace:*',
        '@jiku/types': 'workspace:*',
        zod: '3.25.76',
      },
      devDependencies: {
        '@types/bun': 'latest',
        '@types/react': '^19',
        '@types/react-dom': '^19',
        react: '^19',
        'react-dom': '^19',
        tsup: '^8.3.0',
        typescript: '^5',
      },
      _scaffolded: { id, displayName, at: new Date().toISOString() },
    },
    null,
    2,
  ) + '\n'
}

const TSUP_CONFIG = `import { defineConfig } from 'tsup'

export default defineConfig({
  entry: { Dashboard: 'src/ui/Dashboard.tsx' },
  outDir: 'dist/ui',
  format: ['esm'],
  target: 'es2022',
  platform: 'browser',
  splitting: false,
  sourcemap: true,
  clean: true,
  // Force bundling of workspace deps + React so the output has no bare
  // specifiers. Plugin runs with its own React instance — fully isolated.
  noExternal: [/^@jiku\\//, /^@jiku-plugin\\//, 'react', 'react-dom', 'react-dom/client'],
  external: [],
  minify: false,
  dts: false,
})
`

const TSCONFIG = `{
  "compilerOptions": {
    "lib": ["ESNext", "DOM", "DOM.Iterable"],
    "target": "ESNext",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "jsx": "react-jsx",
    "allowImportingTsExtensions": true,
    "noEmit": true,
    "strict": true,
    "skipLibCheck": true,
    "esModuleInterop": true
  },
  "include": ["src/**/*"]
}
`

function serverEntry(id: string, displayName: string): string {
  return `import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { definePlugin } from '@jiku/kit'
import { defineUI } from '@jiku/kit/ui'
import { StudioPlugin } from '@jiku-plugin/studio'
import { z } from 'zod'

const UI_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist', 'ui')

export default definePlugin({
  meta: {
    id: ${JSON.stringify(id)},
    name: ${JSON.stringify(displayName)},
    version: '0.1.0',
    project_scope: true,
  },

  // Pulls in ctx.http / ctx.events / ctx.studio types from the Studio host anchor.
  depends: [StudioPlugin],

  configSchema: z.object({}),

  ui: defineUI({
    assetsDir: UI_DIR,
    entries: [
      {
        slot: 'project.page',
        id: 'dashboard',
        module: './Dashboard.js',
        meta: { path: '', title: ${JSON.stringify(displayName)} },
      },
    ],
  }),

  setup(ctx) {
    ctx.http?.get('/hello', async ({ projectId }) => ({ projectId, message: 'hello from ${id}' }))
  },
})
`
}

const DASHBOARD_TSX = `import { defineMountable, PluginPage, usePluginQuery } from '@jiku/kit/ui'
import type { StudioComponentProps } from '@jiku-plugin/studio'

function Dashboard({ ctx }: StudioComponentProps) {
  const q = usePluginQuery<{ message: string }>(ctx, 'hello')
  return (
    <PluginPage title={ctx.plugin.id} description="Scaffolded plugin.">
      <p>{q.isLoading ? 'loading…' : q.data?.message ?? ''}</p>
    </PluginPage>
  )
}

export default defineMountable(Dashboard)
`

export async function scaffoldPlugin(id: string, displayName?: string): Promise<ScaffoldResult> {
  if (!/^[a-z][a-z0-9]*(\.[a-z][a-z0-9]*)*$/.test(id)) {
    throw new Error(`Invalid plugin id "${id}". Use dot-notation, e.g. "jiku.hello" or "myorg.something".`)
  }
  const ws = await findWorkspaceRoot()
  const dir = join(ws.pluginsDir, id)
  if (await exists(dir)) throw new Error(`Plugin folder already exists: ${dir}`)

  const name = displayName ?? id.split('.').pop()!.replace(/^\w/, c => c.toUpperCase())
  await mkdir(join(dir, 'src', 'ui'), { recursive: true })

  const files: Record<string, string> = {
    'package.json': pkg(id, name),
    'tsup.config.ts': TSUP_CONFIG,
    'tsconfig.json': TSCONFIG,
    'src/index.ts': serverEntry(id, name),
    'src/ui/Dashboard.tsx': DASHBOARD_TSX,
  }
  for (const [rel, content] of Object.entries(files)) {
    await writeFile(join(dir, rel), content)
  }

  return { id, dir, files: Object.keys(files) }
}
