# Plan 26 — JS/TS Sandbox Plugin (`jiku.sandbox`)

> **Goal:** System-scoped plugin yang register tool `run_js` untuk eksekusi kode JS/TS secara aman di QuickJS isolate. Tool mendukung tiga mode input (code / path / prompt), concurrency-capped dengan queue, dan mewarisi model LLM dari agent untuk prompt-to-code generation.
>
> **Why:** Agent sering butuh compute/analysis yang gak layak ditulis langsung di conversation (makan context token, no persistence). Sandbox memberi agent compute primitive yang isolated, bounded, dan reusable. Mode `prompt` memindahkan code-gen ke dalam tool call sehingga code blob tidak membebani context agent utama.
>
> **Non-goals:**
> - Bukan full Node.js runtime — tidak ada `fs`, `net`, `process`, `child_process` di dalam sandbox.
> - Bukan package installer — tidak support `npm install` / dynamic imports. Kalau butuh lib, harus inline.
> - Bukan Python/bash sandbox (scope plan ini JS/TS saja). Python sandbox = plan terpisah.
> - Bukan skill runtime pengganti — walaupun related dengan `skill_exec_file` backlog, plan ini fokus ke tool primitive, bukan skill loader.

---

## 1. Konsep Inti

### Tool `run_js`

Satu tool dengan **discriminated union input** untuk tiga mode:

| Mode | Input | Flow |
|---|---|---|
| `code` | Raw JS/TS string | Transpile TS (kalau ada) → QuickJS eval |
| `path` | Absolute disk path | Load file → transpile jika `.ts` → eval |
| `prompt` | Natural language goal | LLM call (inherit dari agent) generate code → eval, code yang di-generate dikembalikan di result |

**Kenapa tiga mode di satu tool, bukan tiga tool terpisah:** schema discriminated — validator ketat, tapi dari sisi agent ada satu "compute primitive" yang intentnya sama (jalankan komputasi). Memisahkan jadi tiga tool bikin agent bingung kapan pakai yang mana.

### Queue & Concurrency

- **Module-level semaphore** cap `max_concurrent` slot (default 5).
- **FIFO waiting queue**, depth cap `max_queue_depth` (default 20). Request ke-21 direject dengan `queue_full`.
- **Two-layer timeout:**
  - `queue_timeout_ms` (default 30_000) — berapa lama boleh nunggu slot. Lewat → `queue_timeout`.
  - `exec_timeout_ms` (default 120_000) — per-run QuickJS deadline via `shouldInterruptAfterDeadline`. Lewat → `exec_timeout`.
- Error code dibedakan supaya agent tahu apakah sistem overloaded (retry later) atau code-nya infinite loop (fix logic).

### LLM Inheritance

Mode `prompt` generate code via LLM call. Model **inherit dari agent yang memanggil tool**, bukan konfigurasi terpisah.

- Butuh prerequisite: extend `RuntimeContext` dengan `llm: LLMBridge` yang di-bind ke provider/model agent aktif.
- Plugin config boleh expose `llm_override` optional — kalau agent pakai reasoning model mahal, code-gen bisa di-route ke Haiku.
- Code yang di-generate **selalu dikembalikan di hasil tool** (`executedCode` field) supaya agent bisa debug kalau error.
- Cache code by `hash(prompt + agent_model)` → hindari re-LLM untuk prompt identik. Storage via `toolCtx.storage`.

---

## 2. Data Flow

```
agent → tool_call run_js { source: { type, ... } }
         │
         ├─ acquire slot from queue ──┐
         │                             │ (queue_timeout_ms)
         ↓                             ↓
    resolve source → code string       │
    (path: read fs, prompt: LLM call)  │
         │                             │
         ↓                             │
    TS transpile (if needed) ──────────┘
         │
         ↓
    QuickJS eval with exec_timeout_ms
         │
         ↓
    return { output, logs, error?, executionMs, executedCode?, mode, queueWaitMs }
```

---

## 3. Input / Output Schema

### Input (Zod)

```ts
z.object({
  source: z.discriminatedUnion('type', [
    z.object({
      type: z.literal('code'),
      code: z.string().describe('Raw JS/TS source to execute'),
      language: z.enum(['js', 'ts']).default('js').optional(),
    }),
    z.object({
      type: z.literal('path'),
      path: z.string().describe('Absolute disk path to .js or .ts file'),
    }),
    z.object({
      type: z.literal('prompt'),
      prompt: z.string().describe('Natural-language goal; LLM will generate code to fulfill it'),
      context: z.record(z.unknown()).optional().describe('Extra context passed as `ctx` variable to generated code'),
    }),
  ]),
  timeout_ms: z.number().int().positive().optional().describe('Override exec_timeout_ms for this run'),
})
```

### Output

```ts
{
  mode: 'code' | 'path' | 'prompt',
  output: unknown,              // last-expression value atau __jiku_result() arg
  logs: string[],               // dari console.log/warn/error di dalam sandbox
  error?: string,               // error code: 'queue_full' | 'queue_timeout' | 'exec_timeout' | 'eval_error' | 'transpile_error' | 'read_error' | 'llm_error'
  errorDetail?: string,         // human-readable
  executedCode?: string,        // selalu untuk path/prompt, opsional untuk code
  executionMs: number,
  queueWaitMs: number,
}
```

---

## 4. Config Schema (UI auto-render)

```ts
configSchema: z.object({
  max_concurrent:       z.number().int().positive().default(5)
    .describe('Max sandbox runs in flight at once'),
  max_queue_depth:      z.number().int().nonnegative().default(20)
    .describe('Max requests waiting for a slot before rejecting'),
  queue_timeout_ms:     z.number().int().positive().default(30_000)
    .describe('How long a request may wait in queue before timing out'),
  exec_timeout_ms:      z.number().int().positive().default(120_000)
    .describe('Default per-run execution deadline'),
  memory_limit_mb:      z.number().int().positive().default(50)
    .describe('Per-run QuickJS heap limit'),
  stack_limit_kb:       z.number().int().positive().default(1024)
    .describe('Per-run QuickJS stack limit'),
  allowed_path_roots:   z.array(z.string()).default([])
    .describe('If set, mode=path only allowed under these prefixes. Empty = allow all absolute paths'),
  llm_override: z.object({
    provider: z.string(),
    model: z.string(),
  }).optional().describe('Override model for prompt-mode code-gen. Default: inherit from calling agent'),
  prompt_cache_ttl_ms:  z.number().int().nonnegative().default(3_600_000)
    .describe('Cache generated code by prompt hash. 0 = disable'),
})
```

Per CLAUDE.md "config over hardcode" — semua limit di atas dirender jadi form di Studio UI.

---

## 5. Architecture & Files

### New files

```
plugins/jiku.sandbox/
├── package.json
├── tsconfig.json
├── src/
│   ├── index.ts                  # definePlugin, system-scoped, register run_js
│   ├── tools/
│   │   └── run_js.ts             # tool definition, schema, handler
│   ├── sandbox/
│   │   ├── runner.ts             # runInSandbox — port & fix dari refs-bak
│   │   ├── transpile.ts          # TS→JS via oxc-transform atau bun.Transpiler
│   │   └── wrap.ts               # wrapCode impl (auto-return last expr)
│   ├── queue/
│   │   └── semaphore.ts          # concurrency + FIFO queue + depth cap
│   ├── source/
│   │   ├── resolve.ts            # resolves { type, ... } → code string
│   │   ├── from-path.ts          # disk fs reader with allowed_path_roots guard
│   │   └── from-prompt.ts        # LLM call via ctx.llm + cache lookup
│   └── types.ts                  # SandboxResult, SandboxConfig, error codes
```

### Core changes (prerequisite)

Perubahan ini **bukan** bagian plugin — ini extend core agar plugin bisa inherit LLM:

| File | Change |
|---|---|
| `packages/types/src/index.ts` | Tambah interface `LLMBridge { generate(prompt: string, opts?: { model?: string, max_tokens?: number }): Promise<string> }`. Tambah field `llm?: LLMBridge` di `RuntimeContext`. |
| `packages/core/src/runner.ts` (~line 616-625) | Saat build `runtimeCtx`, populate `llm` dengan adapter yang call agent's active provider/model. |

### Ported / stripped dari `refs-bak/js-sandbox.ts`

**Keep:**
- QuickJS runtime setup (memory/stack/interrupt limits)
- `console.log/warn/error` bridge
- `__jiku_result` / `__jiku_error` result-capture pattern (renamed dari `__senken_*`)
- Drain loop pattern (alternating Node yield + QuickJS microjob drain)
- Dispose lifecycle (`disposingRef`, `pendingNodePromises`)

**Strip (senken-specific):**
- `getProvider("binance").getKlines(...)` dan `senken.getCandles` / `getSymbolInfo`
- `senken.finance.*` (getPrice, getGas, getLendingAccount, getLendingPositions, getWalletBalances)
- `senken.vfs.*` (read, write, list)
- `ANALYSIS_HELPERS` (sma, ema, rsi, macd, bollingerBands, macd) — domain finance, bukan general

**Fix bugs di refs-bak:**
- `wrapCode(code)` body **kosong** (line 26). Implement: wrap di async IIFE + try/catch, auto-return last expression kalau bukan statement-starter (gunakan `STMT_KEYWORDS` regex yang sudah ada).
- Legacy alias `inFlightCount` / `disposing` (line 201-203) duplikat dari `inFlightRef` / `disposingRef`. Buang, pakai `*Ref` saja.

### Docs touchpoints (per CLAUDE.md automated docs protocol)

- `docs/feats/sandbox.md` — new feature doc (API, limitations, related files)
- `docs/builder/current.md` — update phase, active tasks, relevant files
- `docs/builder/tasks.md` — move backlog entry "Sandboxed skill_exec_file runtime" jadi in-progress (ini parent-nya)
- `docs/builder/decisions.md` — ADR: LLM bridge via RuntimeContext (kenapa inherit by default)
- `docs/builder/changelog.md` — entry per phase merge

---

## 6. Implementation Phases

Urutan dependency-aware. Tiap phase landable & verifiable.

### Phase 0 — Core LLM bridge (prerequisite)
**Scope:** extend `RuntimeContext.llm`, wire di runner.
**Files:** `packages/types/src/index.ts`, `packages/core/src/runner.ts`.
**Exit:** plugin arbitrary bisa call `ctx.llm.generate("hello")` dan dapat completion dari agent's active provider.
**Verify:** temp smoke test in existing plugin → remove.

### Phase 1 — Plugin scaffold
**Scope:** create `plugins/jiku.sandbox/` dengan `package.json`, `src/index.ts` minimal (system-scoped `definePlugin`, no tools yet).
**Exit:** plugin terdaftar di loader, muncul di plugin list.

### Phase 2 — Sandbox core
**Scope:** port `runInSandbox` dari refs-bak dengan semua strip + bug fixes. Mode `code` only, tanpa queue. TS transpile via bun.Transpiler.
**Exit:** bisa eval `{ type: 'code', code: '1+1' }` dan return `{ output: 2 }`. `wrapCode` bekerja untuk last-expression.

### Phase 3 — Queue & concurrency
**Scope:** `semaphore.ts` — slot acquire/release, FIFO waiting list, depth cap, queue_timeout. Integrate ke tool handler.
**Exit:** spawn 10 concurrent calls → 5 jalan, 5 antri; request ke-21 direject `queue_full`.

### Phase 4 — Tool wiring & source modes
**Scope:** tool `run_js` dengan discriminated union input. `from-path.ts` + `from-prompt.ts` + `resolve.ts`. Prompt caching pakai `toolCtx.storage`.
**Exit:** ketiga mode jalan end-to-end. `executedCode` dikembalikan untuk path & prompt.

### Phase 5 — Config schema & UI
**Scope:** `configSchema` di plugin definition, verify auto-render di Studio. Wire config ke runtime (semaphore sizes, timeouts, memory limits).
**Exit:** ubah `max_concurrent` dari UI → runtime behavior berubah tanpa restart.

### Phase 6 — Docs & backlog update
**Scope:** feature doc, decision log, current/tasks update, changelog.
**Exit:** CLAUDE.md docs protocol terpenuhi.

---

## 7. Resolved Decisions (2026-04-16)

1. **Core change: YES.** Phase 0 modif `packages/core/src/runner.ts` + `packages/types/src/index.ts` disetujui. Mode `prompt` bagian dari MVP.
2. **Mode `path` scope: default allow-all.** `allowed_path_roots` tetap ada di config schema sebagai opt-in guard, tapi default kosong = unrestricted. Trust model: system-scoped plugin = elevated trust.
3. **TS transpile: `bun.Transpiler`.** Zero-dep, sudah ada di runtime.
4. **`ANALYSIS_HELPERS`: DROP.** Finance helpers itu legacy dari project senken, gak relevan untuk jiku. Plugin ini general-purpose. Kalau ada kebutuhan domain-specific helpers nanti, bikin plugin terpisah yang inject bridge via `contributes`.

---

## 8. Risks & Mitigations

| Risk | Mitigation |
|---|---|
| QuickJS memory leak kalau dispose order salah | Test dengan 1000-iteration soak; monitor heap. Pattern `finally { vm.dispose(); runtime.dispose() }` sudah benar di refs-bak. |
| LLM code-gen produces code yang harmful (infinite loop, memory bomb) | Exec timeout + memory limit menutupi. Code isolated di QuickJS — gak bisa escape. |
| Path mode eksekusi arbitrary user file | `allowed_path_roots` guard + log every path load. Default empty → trust agent discretion (system-scoped plugin = elevated trust). |
| Prompt cache stale kalau model upgrade | Hash key include `agent_model` + `model_version`. TTL default 1 jam. |
| Queue deadlock kalau handler throws tanpa release slot | `finally { semaphore.release() }` wajib di tool handler. Unit test untuk jalur error. |

---

## 9. Success Criteria

- Agent bisa call `run_js` dengan tiga mode, hasil balik dalam <2.5 menit untuk run wajar.
- 10 concurrent calls → tidak ada crash, tidak ada cross-contamination state antar run.
- LLM mode: `executedCode` selalu ada di response, cache hit rate >70% untuk prompt repetitif.
- Config via UI Studio — semua limit bisa diubah tanpa redeploy.
- Docs (`feats/sandbox.md`, ADR, current.md, tasks.md) ter-update.
- `refs-bak/js-sandbox.ts` bisa dihapus setelah Phase 2 selesai (atau tetap sebagai arsip, tidak di-import).
