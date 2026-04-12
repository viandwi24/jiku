# Plugin UI — Overview (Plan 17)

Jiku plugins ship **isolated** React UI that mounts into Studio slots. Each plugin is a self-contained ESM bundle — it carries its own React, can crash freely, and can be hot-reloaded without touching Studio.

## Gateway

Plugins live in `/plugins/<id>/`. At server boot, the gateway:

1. Scans the `plugins/` folder.
2. Dynamic-imports each `src/index.ts` (default export = `PluginDefinition`).
3. Registers with the shared loader.

Every surface — tool runtime, UI manifest, HTTP, asset serving — reads from this loader. No hardcoded plugin list in server code.

## Directory layout

```
plugins/my-plugin/
├─ package.json              module = src/index.ts, build script via tsup
├─ tsup.config.ts            bundles src/ui/*.tsx → dist/ui/*.js
├─ tsconfig.json
└─ src/
   ├─ index.ts               definePlugin({ ui: defineUI(...), setup(ctx){...} })
   └─ ui/
      ├─ Dashboard.tsx       defineMountable(Dashboard)
      └─ Settings.tsx        defineMountable(Settings)
```

## Host anchor: `@jiku-plugin/studio`

Studio-host-specific ctx surfaces (`ctx.http`, `ctx.events`, `ctx.connector`, `ctx.studio.api`, and future additions like `ctx.db`) are **not** in `@jiku/types`. They live in the `@jiku-plugin/studio` anchor package, which other plugins opt in to via:

1. `depends: [StudioPlugin]` in `definePlugin()` — dependency signal. TypeScript's `MergeContributes` gives the dependent's `setup(ctx)` typed access to `ctx.http` / `ctx.events` / `ctx.connector`.
2. For UI components, use `StudioComponentProps` (also exported from `@jiku-plugin/studio`) as the prop type — that's how `ctx.studio.api` becomes typed on the browser side.

This keeps `@jiku/types` host-agnostic: a non-Studio host would never pollute generic types, and a plugin that runs in multiple hosts only depends on the anchor for the host it's using right now. No module augmentation is used — the plugin system's existing `contributes`/`depends` is the only mechanism.

## Minimal plugin

```ts
// plugins/my-plugin/src/index.ts
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { definePlugin } from '@jiku/kit'
import { defineUI } from '@jiku/kit/ui'
import { StudioPlugin } from '@jiku-plugin/studio'

const UI_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist', 'ui')

export default definePlugin({
  meta: { id: 'my.plugin', name: 'My Plugin', version: '1.0.0', project_scope: true },
  depends: [StudioPlugin],    // ctx.http / ctx.events / ctx.studio types + dependency signal
  ui: defineUI({
    assetsDir: UI_DIR,
    entries: [
      {
        slot: 'project.page',
        id: 'dashboard',
        module: './Dashboard.js',
        meta: { path: '', title: 'My Dashboard' },
      },
    ],
  }),
  setup(ctx) {
    ctx.http?.get('/hello', async ({ projectId }) => ({ projectId, msg: 'hi' }))
  },
})
```

```tsx
// plugins/my-plugin/src/ui/Dashboard.tsx
import { defineMountable, PluginPage, usePluginQuery } from '@jiku/kit/ui'
import type { StudioComponentProps } from '@jiku-plugin/studio'

function Dashboard({ ctx }: StudioComponentProps) {
  const q = usePluginQuery<{ msg: string }>(ctx, 'hello')
  // ctx.studio.api.* is typed thanks to StudioComponentProps.
  return (
    <PluginPage title="My Plugin">
      <p>{q.data?.msg ?? 'loading…'}</p>
    </PluginPage>
  )
}

export default defineMountable(Dashboard)
```

## Build + run

All plugin dev-tooling goes through the `jiku` CLI (`apps/cli/`):

```bash
bun install

# first time
bun run jiku plugin build              # builds every plugins/*/dist/ui
bun run jiku plugin build jiku.analytics   # or one at a time

# watch while developing
bun run jiku plugin watch

# scaffold a new plugin
bun run jiku plugin create jiku.myplugin

# interactive TUI (arrow keys + b/w/r/q)
bun run jiku
```

See [CLI reference](./cli.md) for the full command list.

Server discovers plugin at boot. After an edit:

- Code change in `src/ui/*`: tsup rebuilds → in Studio open **Plugins → Inspector → Reload plugin**, the next island render pulls a fresh bundle.
- Change in `src/index.ts` (server side): restart `apps/studio/server` to re-discover.

## Isolation guarantees

- **Build isolation**: Studio's Next.js never imports plugin source — your TS errors only break your plugin.
- **Runtime isolation**: your plugin renders into its own React root; crashes are caught at the island boundary.
- **Hot reload**: Inspector's reload button invalidates the mount cache without touching Studio.

## Reference

- [Security notes](./security.md) — signed URLs, rate limits, secret-handling rules
- [Context API](./context-api.md)
- [Slots](./slots.md)
- Implementation report: `docs/plans/impl-reports/17-plugin-ui-implementation-report.md`
