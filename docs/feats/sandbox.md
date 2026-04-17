# Sandbox (`jiku.code-runtime`)

System-scoped plugin that exposes a single tool `run_js` for sandboxed JavaScript / TypeScript execution. Agents call it when they need to compute, transform, or analyse data without burning the main conversation's context window.

## What it does

Runs a snippet of JS/TS inside a QuickJS isolate with hard memory/CPU limits. Three ways to deliver the code:

| Mode | Input | Behaviour |
|---|---|---|
| `code` | Raw source string | Transpile (if TS) → eval |
| `path` | Absolute disk path | Read file → transpile if `.ts*` → eval |
| `prompt` | Natural-language goal | LLM (inherited from the calling agent) generates the code → eval. Generated code is returned in the result so the agent can debug what ran. |

The prompt mode is the context-saving play: code generation happens inside the tool via `RuntimeContext.llm`, so only the goal and the result live in the agent's own history, not the full source.

## Architecture

- **Plugin entry** (`plugins/jiku.code-runtime/src/index.ts`): `definePlugin` with `project_scope: false`, registers `run_js` in `setup`. Config parsed from schema at setup time and captured via closure.
- **Tool factory** (`src/tools/run_js.ts`): `createRunJsTool(getConfig)` returns the `ToolDefinition`. Module-level `Semaphore` captured in closure so every invocation in-process shares the concurrency cap.
- **Source resolver** (`src/source/resolve.ts`): dispatches the discriminated `source` input to one of `from-path.ts` (disk read with optional `allowed_path_roots` guard) or `from-prompt.ts` (LLM-backed codegen with cache).
- **Prompt cache** (`src/source/from-prompt.ts`): keyed by `sha256(system_version + model + prompt)`, stored in `toolCtx.storage` with TTL. Hits skip the LLM call entirely.
- **Queue** (`src/queue/semaphore.ts`): bounded semaphore + FIFO waiting list. Acquire returns typed errors (`queue_full`, `queue_timeout`) that the tool surfaces to the agent as distinct error codes.
- **Sandbox runner** (`src/sandbox/runner.ts`): one `QuickJSRuntime` per invocation (isolated GC, clean dispose). Bridges exposed inside the VM:
  - `console.log / warn / error` → captured into `logs[]`
  - `__jiku_result(value)` → captures the output
  - `__jiku_error(msg)` → captures recoverable errors
- **Wrapper** (`src/sandbox/wrap.ts`): wraps user code in an async IIFE with try/catch. Auto-returns the last expression unless it's a statement-starter (`return`, `const`, `if`, ...).
- **Transpile** (`src/sandbox/transpile.ts`): `Bun.Transpiler` with `loader: 'ts'` when TS is declared or heuristically detected. JS passes through unchanged.

## Error codes

Returned in `result.error`:

| Code | Meaning | Agent hint |
|---|---|---|
| `queue_full` | Too many runs queued | Retry later, system is overloaded |
| `queue_timeout` | Waited too long for a slot | Retry later |
| `exec_timeout` | Hit `exec_timeout_ms` | Your code is too slow / has an infinite loop |
| `transpile_error` | TS couldn't be parsed | Fix the syntax |
| `eval_error` | QuickJS threw during eval | Runtime bug in the code |
| `read_error` | `path` mode: fs failure | Path invalid, outside roots, or file unreadable |
| `llm_error` | `prompt` mode: LLM call failed | Model/provider issue — try simpler prompt |

## Config

All configurable via Studio UI (auto-rendered from `configSchema` in plugin entry):

- `max_concurrent` (default 5) — hard cap on in-flight runs
- `max_queue_depth` (default 20) — waiting queue size before `queue_full`
- `queue_timeout_ms` (default 30_000) — how long to wait for a slot
- `exec_timeout_ms` (default 120_000) — per-run deadline
- `memory_limit_mb` / `stack_limit_kb` — QuickJS runtime limits
- `allowed_path_roots` — if set, `path` mode restricted to these prefixes; empty = allow all absolute paths
- `llm_override` — override provider/model for prompt codegen; default inherit from agent
- `prompt_cache_ttl_ms` (default 1h) — 0 disables cache

## LLM inheritance

`RuntimeContext.llm` is populated by the core runner (`packages/core/src/runner.ts`) with an `LLMBridge` bound to the agent's active provider/model. The sandbox plugin calls `ctx.runtime.llm.generate(prompt, opts)` in prompt mode. Plugins may override `provider` / `model` per call via the plugin's `llm_override` config — useful when the agent runs a reasoning model but code-gen should use Haiku.

See ADR-104 (`docs/builder/decisions.md`) for why this sits on `RuntimeContext` rather than being a plugin dependency.

## Known limitations

- **No Node APIs inside the sandbox** — no `fs`, `net`, `process`, `require`, `import`. Use `path` mode if you need file-based setup before hand-off.
- **No package installer** — `import`/`require` won't resolve. Inline whatever you need.
- **Bun-only** — transpile uses `Bun.Transpiler`. The plugin won't run under Node without a polyfill.
- **Config changes need restart** — system-scoped plugin config doesn't hot-reload yet (plugin stores defaults in closure). Studio UI wiring for system-plugin config is future work.
- **Single-process queue** — the semaphore is per-process. Multi-instance deployments each get their own `max_concurrent`.

## Related files

- `plugins/jiku.code-runtime/src/**` — plugin implementation
- `packages/types/src/index.ts` — `LLMBridge`, `RuntimeContext.llm`
- `packages/core/src/runner.ts` — LLM bridge construction (around line 260)
- `refs-bak/js-sandbox.ts` — legacy senken-specific sandbox, kept as reference only
- `docs/plans/26-sandbox.md` — design plan
