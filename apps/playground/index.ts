/**
 * Jiku Playground — stream-aware demo
 *
 * Usage:
 *   OPENAI_API_KEY=sk-... bun run index.ts
 */

import { JikuRuntime, PluginLoader, MemoryStorageAdapter, createProviderDef } from '@jiku/core'
import { defineAgent } from '@jiku/kit'
import type { JikuStreamChunk, PolicyRule, CallerContext } from '@jiku/types'
import { createOpenAI } from '@ai-sdk/openai'
import socialPlugin from '@jiku/plugin-social'

// ============================================================
// Model provider setup
// ============================================================
const openai = createOpenAI({ apiKey: process.env.OPENAI_API_KEY })

// ============================================================
// Step 1 — Init plugin loader
// ============================================================
const plugins = new PluginLoader()
plugins.register(socialPlugin)

// ============================================================
// Step 2 — Define agents
// ============================================================
const socialAgent = defineAgent({
  meta: { id: 'social_manager', name: 'Social Media Manager' },
  base_prompt: 'You are a social media manager. Help users manage their posts across platforms.',
  allowed_modes: ['chat', 'task'],
  provider_id: 'openai',
  model_id: 'gpt-4o-mini',
})

// ============================================================
// Step 3 — Define rules
// ============================================================
const rules: PolicyRule[] = [
  {
    resource_type: 'tool',
    resource_id: 'jiku.social:delete_post',
    subject_type: 'role',
    subject: 'admin',
    effect: 'allow',
  },
  {
    resource_type: 'agent',
    resource_id: 'social_manager:task',
    subject_type: 'permission',
    subject: 'social_manager:task',
    effect: 'allow',
  },
]

// ============================================================
// Step 4 — Init runtime
// ============================================================
const runtime = new JikuRuntime({
  plugins,
  storage: new MemoryStorageAdapter(),
  rules,
  providers: {
    openai: createProviderDef('openai', openai),
  },
  default_provider: 'openai',
})

runtime.addAgent(socialAgent)
await runtime.boot()

// ============================================================
// Helper: consume stream and print output
// ============================================================
async function runAndPrint(
  label: string,
  caller: CallerContext,
  input: string,
  mode: 'chat' | 'task' = 'chat',
) {
  console.log(`\n========== ${label} ==========`)
  console.log(`> ${input}\n`)

  const { stream, run_id, conversation_id } = await runtime.run({
    agent_id: 'social_manager',
    caller,
    mode,
    input,
  })

  for await (const c of stream) {
    if (c.type === 'text-delta') {
      process.stdout.write(c.delta)
    } else if (c.type === 'data-jiku-usage') {
      console.log(`\n[usage] in=${c.data.input_tokens} out=${c.data.output_tokens}`)
    } else if (c.type === 'data-jiku-tool-data') {
      console.log(`\n[tool-data] ${c.data.tool_id}:`, JSON.stringify(c.data.data))
    } else if (c.type === 'finish') {
      if (c.finishReason === 'error') console.error('\n[error] stream finished with error')
    }
  }

  console.log()
  console.log(`[run_id=${run_id} conv=${conversation_id}]`)
}

// ============================================================
// Step 5 — Admin: list posts (chat)
// ============================================================
const adminCaller: CallerContext = {
  user_id: 'user-admin',
  roles: ['admin'],
  permissions: ['social_manager:task', 'jiku.social:post:write', 'jiku.social:post:delete'],
  user_data: { name: 'Admin User', company_id: 'comp-123' },
}

await runAndPrint('Chat (Admin)', adminCaller, 'List all posts')

// ============================================================
// Step 6 — Member: limited tools
// ============================================================
const memberCaller: CallerContext = {
  user_id: 'user-member',
  roles: ['member'],
  permissions: [],
  user_data: { name: 'Regular Member', company_id: 'comp-123' },
}

await runAndPrint('Chat (Member)', memberCaller, 'List all posts')

// ============================================================
// Step 7 — Abort demo
// ============================================================
console.log('\n========== Abort Demo ==========')
const abortController = new AbortController()
const { stream: abortStream } = await runtime.run({
  agent_id: 'social_manager',
  caller: adminCaller,
  mode: 'chat',
  input: 'List all posts and then create a new one about the weather',
  abort_signal: abortController.signal,
})

let gotFirstDelta = false
const abortReader = abortStream.getReader()
while (true) {
  const { done, value } = await abortReader.read()
  if (done) break

  const c = value as JikuStreamChunk
  if (c.type === 'text-delta') {
    process.stdout.write(c.delta)
    if (!gotFirstDelta) {
      gotFirstDelta = true
      abortController.abort()
    }
  }
  if (c.type === 'finish') {
    console.log(`\n[finish reason=${c.finishReason ?? 'unknown'}]`)
    break
  }
}

// ============================================================
// Step 8 — Task mode
// ============================================================
await runAndPrint('Task (Admin)', adminCaller, 'List all existing posts and summarize them', 'task')

// ============================================================
// Step 9 — Tool custom data demo (tool pushes via writer)
// ============================================================
console.log('\n========== Tool Custom Data Demo ==========')
console.log('(Plugin tools can push custom data chunks via ctx.writer.write())')

await runtime.stop()
console.log('\n[done]')
