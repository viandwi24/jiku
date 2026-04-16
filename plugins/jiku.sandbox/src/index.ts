// jiku.sandbox — System-scoped plugin exposing `run_js` tool for sandboxed
// JS/TS execution in QuickJS isolates. Supports three source modes:
//   • code   — raw JS/TS string
//   • path   — absolute disk path to a .js/.ts file
//   • prompt — natural-language goal; LLM (inherited from agent via
//              RuntimeContext.llm) generates the code before eval
//
// Concurrency-capped via FIFO queue (max_concurrent slots, max_queue_depth
// waiters). Two-layer timeouts: queue-wait vs execution deadline.
//
// See docs/plans/26-sandbox.md for architecture.

import { definePlugin } from '@jiku/kit'
import { z } from 'zod'
import { createRunJsTool } from './tools/run_js.ts'
import type { SandboxConfig } from './types.ts'

const configSchema = z.object({
  max_concurrent: z.number().int().positive().default(5)
    .describe('Max sandbox runs in flight at once'),
  max_queue_depth: z.number().int().nonnegative().default(20)
    .describe('Max requests waiting for a slot before rejecting with queue_full'),
  queue_timeout_ms: z.number().int().positive().default(30_000)
    .describe('How long a request may wait in queue before timing out (ms)'),
  exec_timeout_ms: z.number().int().positive().default(120_000)
    .describe('Default per-run execution deadline (ms)'),
  memory_limit_mb: z.number().int().positive().default(50)
    .describe('Per-run QuickJS heap limit (MB)'),
  stack_limit_kb: z.number().int().positive().default(1024)
    .describe('Per-run QuickJS stack limit (KB)'),
  allowed_path_roots: z.array(z.string()).default([])
    .describe('If non-empty, mode=path only allowed under these absolute prefixes. Empty = allow all absolute paths'),
  llm_override: z.object({
    provider: z.string(),
    model: z.string(),
  }).optional()
    .describe('Override model for prompt-mode code-gen. Default: inherit from calling agent'),
  prompt_cache_ttl_ms: z.number().int().nonnegative().default(3_600_000)
    .describe('Cache generated code by prompt hash for this many ms. 0 = disable cache'),
})

export default definePlugin({
  meta: {
    id: 'jiku.sandbox',
    name: 'Sandbox',
    version: '1.0.0',
    description: 'Sandboxed JS/TS execution for agents. Exposes `run_js` tool with three source modes (code / path / prompt). Isolated via QuickJS, concurrency-capped with queue, two-layer timeouts.',
    author: 'Jiku',
    icon: 'Terminal',
    category: 'developer',
    project_scope: false,
    
  },

  configSchema,

  setup(ctx) {
    // System-scoped plugin: no per-project config piping yet. Parse defaults
    // from the schema once at setup and capture via closure. When Studio UI
    // wires up system-plugin config storage, swap this getter to read from
    // plugin storage so changes take effect without restart.
    const defaults = configSchema.parse({}) as SandboxConfig
    const getConfig = (): SandboxConfig => defaults
    ctx.tools.register(createRunJsTool(getConfig))
  },
})
