# Feature: Plugin System

## What it does

Plugin system memungkinkan developer menambah tools, context providers, dan prompt segments ke AI agent tanpa mengubah core runtime.

## Public API

```ts
import { definePlugin, defineTool } from '@jiku/kit'
import { z } from 'zod'

export default definePlugin({
  meta: { id: 'my.plugin', name: 'My Plugin', version: '1.0.0' },
  dependencies: ['other.plugin'],  // optional
  setup(ctx) {
    ctx.tools.register(
      defineTool({
        meta: { id: 'my_tool', name: 'My Tool', description: '...' },
        permission: '*' | 'some:permission',
        modes: ['chat'] | ['task'] | ['chat', 'task'],
        input: z.object({ ... }),
        execute: async (args, ctx) => { ... },
        prompt: 'Optional hint for system prompt',
      })
    )
    ctx.prompt.inject('Optional static system prompt segment')
    ctx.provide('namespace', (caller) => ({ ... }))  // accessible as ctx.runtime.namespace in tools
    ctx.hooks.hook('event', async (payload) => { ... })
  }
})
```

## Tool ID & Permission Prefixing

PluginLoader otomatis prefix saat boot:
- `tool.meta.id = 'create_post'` → `resolved_id = 'jiku.social:create_post'`
- `tool.permission = 'post:write'` → `resolved_permission = 'jiku.social:post:write'`
- `tool.permission = '*'` → tetap `'*'`

## Boot Phases

1. **Scan** — import semua plugin definition, extract meta + deps
2. **Sort** — topological sort via Kahn's algorithm; skip plugin dengan missing dep
3. **Load** — panggil `setup(ctx)` untuk setiap plugin secara berurutan

## Known Limitations

- Plugin tidak bisa unregister tool setelah boot (restart diperlukan)
- `ctx.prompt.inject()` dengan async function di-resolve tiap call buildSystemPrompt — tidak di-cache
- Tidak ada plugin versioning/semver check antar dependencies

## Related Files

- `packages/core/src/plugins/loader.ts` — PluginLoader class
- `packages/core/src/plugins/registry.ts` — SharedRegistry
- `packages/core/src/plugins/dependency.ts` — topological sort
- `packages/core/src/plugins/hooks.ts` — HookAPI via hookable
- `packages/kit/src/index.ts` — definePlugin, defineTool, defineAgent
