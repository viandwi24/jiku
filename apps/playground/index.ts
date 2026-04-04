/**
 * Jiku Playground
 *
 * Single chat scenario demonstrating Plugin System V2:
 *   - contributes (async init)
 *   - depends instance → typed ctx
 *   - depends string → sort only
 *   - circular dep detection
 *   - missing dep detection
 *   - override / bridge pattern
 *   - full runtime chat with stream
 *
 * Usage:
 *   OPENAI_API_KEY=sk-... bun run index.ts
 */

import {
  JikuRuntime,
  PluginLoader,
  MemoryStorageAdapter,
  createProviderDef,
} from '@jiku/core'
import { defineAgent } from '@jiku/kit'
import { createOpenAI } from '@ai-sdk/openai'
import type { CallerContext, JikuStreamChunk, PolicyRule } from '@jiku/types'
import {
  DatabasePlugin,
  SocialPlugin,
  AnalyticsPlugin,
  MockServerPlugin,
  WebhookPlugin,
} from './plugins.ts'
import { runChecks } from './checks.ts'

// ============================================================
// 1. Run V2 checks (circular dep, missing dep)
// ============================================================

await runChecks()

// ============================================================
// 2. Setup plugins with override bridge
// ============================================================

console.log('\n=== Runtime Setup ===\n')

const openai = createOpenAI({ apiKey: process.env.OPENAI_API_KEY })
const registeredRoutes: { method: string; path: string }[] = []

const plugins = new PluginLoader()
plugins.register(DatabasePlugin, SocialPlugin, AnalyticsPlugin, MockServerPlugin, WebhookPlugin)

// Override bridge — replace noop server with actual recording
plugins.override('@jiku/plugin-server', {
  contributes: () => ({
    server: {
      get: (path: string, _handler: unknown) => {
        registeredRoutes.push({ method: 'GET', path })
      },
    },
  }),
})

// ============================================================
// 3. Rules — delete_post admin only
// ============================================================

const rules: PolicyRule[] = [
  {
    resource_type: 'tool',
    resource_id: 'jiku.social:delete_post',
    subject_type: 'role',
    subject: 'admin',
    effect: 'allow',
  },
]

// ============================================================
// 4. Boot runtime
// ============================================================

const runtime = new JikuRuntime({
  plugins,
  storage: new MemoryStorageAdapter(),
  rules,
  providers: { openai: createProviderDef('openai', openai) },
  default_provider: 'openai',
})

runtime.addAgent(
  defineAgent({
    meta: { id: 'social_manager', name: 'Social Media Manager' },
    base_prompt: 'You are a social media manager. Help users manage their posts across platforms.',
    allowed_modes: ['chat', 'task'],
    provider_id: 'openai',
    model_id: 'gpt-4o-mini',
  })
)

await runtime.boot()

console.log('Load order:', plugins.getLoadOrder())
console.log('Registered routes:', registeredRoutes)
console.log('Tools:', plugins.getResolvedTools().map(t => t.resolved_id))

// ============================================================
// 5. Chat run — admin with all permissions
// ============================================================

const caller: CallerContext = {
  user_id: 'user-admin',
  roles: ['admin'],
  permissions: ['jiku.social:post:write', 'jiku.social:post:delete'],
  user_data: { name: 'Admin User', company_id: 'comp-123' },
}

console.log('\n=== Chat Run ===\n')
console.log('> List all posts\n')

const { stream, run_id, conversation_id } = await runtime.run({
  agent_id: 'social_manager',
  caller,
  mode: 'chat',
  input: 'List all posts',
})

for await (const chunk of stream as AsyncIterable<JikuStreamChunk>) {
  if (chunk.type === 'text-delta') {
    process.stdout.write(chunk.delta)
  } else if (chunk.type === 'data-jiku-usage') {
    console.log(`\n[usage] in=${chunk.data.input_tokens} out=${chunk.data.output_tokens}`)
  } else if (chunk.type === 'finish' && chunk.finishReason === 'error') {
    console.error('\n[error] stream finished with error')
  }
}

console.log(`\n[run_id=${run_id} conv=${conversation_id}]`)

await runtime.stop()
console.log('\n[done]')
