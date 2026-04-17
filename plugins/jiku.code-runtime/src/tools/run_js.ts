// run_js — sandboxed JS/TS execution tool.
//
// Three source modes via discriminated union:
//   • code   — raw JS/TS string, optional `language` hint
//   • path   — absolute disk path to .js/.ts file (loaded server-side)
//   • prompt — natural-language goal, code generated via inherited LLM
//
// Flow:
//   acquire queue slot → resolve source → transpile → QuickJS eval → return
//
// Response always includes `mode` + `queueWaitMs` + `executionMs`. For path
// and prompt modes, `executedCode` is populated so the agent can debug what
// actually ran. On error, `error` is one of the typed codes from SandboxErrorCode.

import { defineTool } from '@jiku/kit'
import { z } from 'zod'
import { Semaphore, type SemaphoreError } from '../queue/semaphore.ts'
import { resolveSource, type SourceInput } from '../source/resolve.ts'
import { runInSandbox } from '../sandbox/runner.ts'
import type { SandboxConfig, SandboxResult } from '../types.ts'

const inputSchema = z.object({
  source: z.discriminatedUnion('type', [
    z.object({
      type: z.literal('code'),
      code: z.string().describe('Raw JS/TS source to execute. The last expression is returned as output; or call __jiku_result(value) explicitly.'),
      language: z.enum(['js', 'ts']).optional().describe('Language hint. Auto-detected if omitted.'),
    }),
    z.object({
      type: z.literal('path'),
      path: z.string().describe('Absolute disk path to a .js/.ts file. Contents are loaded and executed in the sandbox.'),
    }),
    z.object({
      type: z.literal('prompt'),
      prompt: z.string().describe('Natural-language goal. An LLM (inherited from the calling agent) generates code to fulfill it, which is then executed in the sandbox.'),
      context: z.record(z.unknown()).optional().describe('Extra JSON-serialisable context. Made available to generated code as a global `ctx` variable.'),
    }),
  ]).describe('Source of the code to run: provide raw code, a disk path, or a prompt to be translated to code.'),
  timeout_ms: z.number().int().positive().optional().describe('Override default execution timeout for this run.'),
})

type RunJsInput = z.infer<typeof inputSchema>

// One semaphore per plugin instance — captured in closure so all tool
// invocations in the same process share the cap.
function buildSemaphore(config: SandboxConfig): Semaphore {
  return new Semaphore({
    maxConcurrent: config.max_concurrent,
    maxQueueDepth: config.max_queue_depth,
    queueTimeoutMs: config.queue_timeout_ms,
  })
}

export function createRunJsTool(getConfig: () => SandboxConfig) {
  const semaphore = buildSemaphore(getConfig())
  return defineTool({
    meta: {
      id: 'run_js',
      name: 'Run JavaScript',
      group: 'code_runtime',
      description: 'Execute JS/TS code in a sandboxed QuickJS isolate. Choose the source mode: `code` for raw snippets, `path` to load a file from disk, or `prompt` to have an LLM generate the code from a natural-language goal (saves context tokens on the agent side). Returns `{ output, logs, error?, executedCode?, executionMs, queueWaitMs, mode }`. Sandbox has no Node/network/fs APIs inside — last expression or __jiku_result(value) is the output.',
    },
    permission: 'run',
    modes: ['chat', 'task'],
    input: inputSchema,
    execute: async (argsRaw, toolCtx): Promise<SandboxResult> => {
      const args = argsRaw as RunJsInput
      const config = getConfig()
      semaphore.configure({
        maxConcurrent: config.max_concurrent,
        maxQueueDepth: config.max_queue_depth,
        queueTimeoutMs: config.queue_timeout_ms,
      })
  
      // ── Acquire queue slot ─────────────────────────────────
      let slot: { release: () => void; waitedMs: number }
      try {
        slot = await semaphore.acquire()
      } catch (err) {
        const code = err as SemaphoreError
        return {
          mode: (args.source as SourceInput).type,
          output: null,
          logs: [],
          error: code === 'queue_full' ? 'queue_full' : 'queue_timeout',
          errorDetail:
            code === 'queue_full'
              ? `Queue depth exceeded (max ${config.max_queue_depth}). Retry later.`
              : `Timed out waiting ${config.queue_timeout_ms}ms for a slot.`,
          executionMs: 0,
          queueWaitMs: 0,
        }
      }
  
      try {
        // ── Resolve source ───────────────────────────────────
        let resolved
        try {
          resolved = await resolveSource({
            source: args.source as SourceInput,
            llm: toolCtx.runtime.llm,
            llmOverride: config.llm_override,
            storage: toolCtx.storage,
            allowedPathRoots: config.allowed_path_roots,
            promptCacheTtlMs: config.prompt_cache_ttl_ms,
          })
        } catch (err) {
          const type = (args.source as SourceInput).type
          const isPath = type === 'path'
          return {
            mode: type,
            output: null,
            logs: [],
            error: isPath ? 'read_error' : 'llm_error',
            errorDetail: err instanceof Error ? err.message : String(err),
            executionMs: 0,
            queueWaitMs: slot.waitedMs,
          }
        }
  
        // ── Run in QuickJS ───────────────────────────────────
        const result = await runInSandbox({
          code: resolved.code,
          language: resolved.language,
          limits: {
            execTimeoutMs: args.timeout_ms ?? config.exec_timeout_ms,
            memoryLimitMb: config.memory_limit_mb,
            stackLimitKb: config.stack_limit_kb,
          },
        })
  
        return {
          mode: resolved.mode,
          output: result.output,
          logs: result.logs,
          error: result.error,
          errorDetail: result.errorDetail,
          executedCode: resolved.mode === 'code' ? undefined : resolved.executedCodePreview,
          executionMs: result.executionMs,
          queueWaitMs: slot.waitedMs,
        }
      } finally {
        slot.release()
      }
    },
  })
}
