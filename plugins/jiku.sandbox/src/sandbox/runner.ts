// QuickJS-based sandbox runner. One QuickJSRuntime per invocation (isolated
// GC, clean dispose). Ported & trimmed from refs-bak/js-sandbox.ts — bridges
// to external Node services removed so the MVP sandbox is pure-compute.
//
// Bridges exposed inside the VM:
//   • console.log / warn / error → captured into logs[]
//   • __jiku_result(value)        → captures the eventual output
//   • __jiku_error(message)       → captures a recoverable error string
//
// The wrapper injected by `wrapCode` calls __jiku_result with the last
// expression's value by default; explicit calls in user code still work.

import { getQuickJS, shouldInterruptAfterDeadline } from 'quickjs-emscripten'
import type { SandboxLimits, SandboxResult } from '../types.ts'
import { wrapCode } from './wrap.ts'
import { transpile, looksLikeTs } from './transpile.ts'

export interface RunInSandboxArgs {
  code: string
  language?: 'js' | 'ts'
  limits: SandboxLimits
}

export async function runInSandbox(
  args: RunInSandboxArgs,
): Promise<Omit<SandboxResult, 'mode' | 'queueWaitMs'>> {
  const start = Date.now()
  const logs: string[] = []
  let output: unknown = undefined
  let sandboxError: string | undefined

  // Transpile TS if declared, or auto-detect
  let source: string
  try {
    const lang = args.language ?? (looksLikeTs(args.code) ? 'ts' : 'js')
    source = transpile(args.code, lang)
  } catch (e) {
    return {
      output: null,
      logs,
      error: 'transpile_error',
      errorDetail: e instanceof Error ? e.message : String(e),
      executionMs: Date.now() - start,
    }
  }

  const QuickJS = await getQuickJS()
  const runtime = QuickJS.newRuntime()
  runtime.setMemoryLimit(args.limits.memoryLimitMb * 1024 * 1024)
  runtime.setMaxStackSize(args.limits.stackLimitKb * 1024)
  runtime.setInterruptHandler(
    shouldInterruptAfterDeadline(Date.now() + args.limits.execTimeoutMs),
  )
  const vm = runtime.newContext()

  try {
    // ── console.{log,warn,error} bridge ───────────────────
    const logFn = vm.newFunction('log', (...argHandles) => {
      const parts = argHandles.map((h) => {
        const v = vm.dump(h)
        return typeof v === 'object' ? JSON.stringify(v) : String(v)
      })
      logs.push(parts.join(' '))
    })
    const consoleObj = vm.newObject()
    vm.setProp(consoleObj, 'log', logFn)
    vm.setProp(consoleObj, 'warn', logFn)
    vm.setProp(consoleObj, 'error', logFn)
    vm.setProp(vm.global, 'console', consoleObj)
    logFn.dispose()
    consoleObj.dispose()

    // ── __jiku_result / __jiku_error ──────────────────────
    const resultFn = vm.newFunction('__jiku_result', (val) => {
      output = vm.dump(val)
    })
    vm.setProp(vm.global, '__jiku_result', resultFn)
    resultFn.dispose()

    const errorFn = vm.newFunction('__jiku_error', (val) => {
      sandboxError = String(vm.dump(val))
    })
    vm.setProp(vm.global, '__jiku_error', errorFn)
    errorFn.dispose()

    // ── Evaluate wrapped user code ────────────────────────
    const wrapped = wrapCode(source)
    const evalResult = vm.evalCode(wrapped)
    if (evalResult.error) {
      const err = vm.dump(evalResult.error)
      evalResult.error.dispose()
      return {
        output: null,
        logs,
        error: 'eval_error',
        errorDetail: typeof err === 'object' && err !== null ? JSON.stringify(err) : String(err),
        executionMs: Date.now() - start,
      }
    }
    evalResult.value.dispose()

    // ── Drain microjob queue until quiescent or deadline ──
    const deadline = Date.now() + args.limits.execTimeoutMs
    while (Date.now() < deadline) {
      if (output !== undefined || sandboxError !== undefined) break
      const jobResult = runtime.executePendingJobs(-1)
      if (typeof jobResult === 'object' && 'error' in jobResult && jobResult.error) {
        const err = vm.dump(jobResult.error)
        jobResult.error.dispose()
        sandboxError = String(err)
        break
      }
      if (typeof jobResult === 'number' && jobResult === 0) {
        // no jobs pending — yield then re-check (in case async bridge queued more)
        await new Promise((r) => setTimeout(r, 5))
        if (runtime.executePendingJobs(-1) === 0) break
      }
    }

    const timedOut = Date.now() >= deadline && output === undefined && sandboxError === undefined

    if (timedOut) {
      return {
        output: output ?? null,
        logs,
        error: 'exec_timeout',
        errorDetail: `Execution exceeded ${args.limits.execTimeoutMs}ms`,
        executionMs: args.limits.execTimeoutMs,
      }
    }
    if (sandboxError) {
      return {
        output: null,
        logs,
        error: 'eval_error',
        errorDetail: sandboxError,
        executionMs: Date.now() - start,
      }
    }
    return {
      output: output ?? null,
      logs,
      executionMs: Date.now() - start,
    }
  } finally {
    try { vm.dispose() } catch { /* ignore residual handles */ }
    try { runtime.dispose() } catch { /* ignore */ }
  }
}
