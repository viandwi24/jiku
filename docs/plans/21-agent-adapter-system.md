# Plan 21 — Agent Adapter System

> Status: Planning Done
> Depends on: Plan 6 (Chat System), Plan 11 (Task/Heartbeat), Plan 19 (Memory/Skills)
> Layer: Core package + App layer
> Goal: Refactor `AgentRunner` dari monolitik streamText menjadi sistem adapter yang bisa dipilih per-mode, dengan registry terpusat yang bisa diextend oleh plugin di masa depan.

---

## 1. Overview

`AgentRunner.run()` sekarang adalah satu metode 500 baris yang hardcode `streamText` sebagai satu-satunya cara eksekusi. Plan 21 memperkenalkan **AgentAdapter** — abstraksi execution strategy yang bisa di-swap per mode.

### Adapters yang dikirim di Plan 21

| Adapter | ID | Keterangan |
|---------|----|-----------
| **Default Agent** | `jiku.agent.default` | Perilaku sekarang. Single-turn `streamText`, langsung pipe ke UIMessageStream. |
| **Harness Agent** | `jiku.agent.harness` | Iterative multi-step loop. LLM → tools → LLM → repeat sampai selesai atau max iterasi tercapai. |

### Apa yang berubah secara arsitektur

```
SEBELUM:
  AgentRunner.run()
    └─ createUIMessageStream
         └─ streamText (hardcoded)

SESUDAH:
  AgentRunner.run()
    └─ buildPreContext()           ← semua setup diekstrak ke sini
         └─ createUIMessageStream  ← tetap di runner
              └─ adapter.execute(ctx)  ← dispatch ke adapter yang sesuai
                   ├─ DefaultAgentAdapter → streamText (perilaku lama)
                   └─ HarnessAgentAdapter → iterative loop (baru)

  AgentAdapterRegistry (singleton di server)
    ├─ register(adapter)   ← plugin bisa daftar adapter custom (future)
    ├─ get(id)
    └─ list()              ← untuk UI dropdown
```

### Heartbeat tidak terpengaruh

Heartbeat bukan mode — dia `ConversationType` yang numpang jalankan `task` mode. Adapter yang dipakai heartbeat = adapter yang dikonfigurasi untuk task mode.

---

## 2. Phase 1 — Types & Interface

### 2.1 Update `packages/types/src/index.ts`

```typescript
// Tambah setelah AgentMode

/** Config per mode di agent definition. */
export interface AgentModeConfig {
  /** ID adapter yang dipakai. Default: 'jiku.agent.default' */
  adapter: string
  /**
   * Adapter-specific config. Shape-nya ditentukan oleh `AgentAdapter.configSchema`.
   * Runner pass ini ke adapter via `ctx.modeConfig.config`.
   * Contoh DefaultAdapter: { max_tool_calls: 40 }
   * Contoh HarnessAdapter: { max_iterations: 20 }
   */
  config?: Record<string, unknown>
}
```

```typescript
// Update AgentDefinition — tambah field mode_configs
export interface AgentDefinition {
  meta: AgentMeta
  base_prompt: string
  allowed_modes: AgentMode[]
  mode_configs?: Partial<Record<AgentMode, AgentModeConfig>>  // ← BARU
  provider_id?: string
  model_id?: string
  compaction_threshold?: number
  max_tool_calls?: number
  built_in_tools?: ToolDefinition[]
}
```

### 2.2 `packages/core/src/adapter.ts` (file baru)

```typescript
import type {
  AgentMode,
  JikuRunParams,
  JikuStorageAdapter,
  RuntimeContext,
  ResolvedTool,
  PolicyRule,
  SubjectMatcher,
} from '@jiku/types'
import type { ModelMessage, ToolSet } from 'ai'
import type { JikuStreamWriter, JikuUIMessageStreamWriter } from './types.ts'

/** Metadata publik adapter — untuk UI dropdown dan logging. */
export interface AgentAdapterMeta {
  /** Stable ID. Format: `jiku.agent.<name>` untuk built-in. */
  id: string
  /** Display name di UI. */
  displayName: string
  /** Deskripsi singkat. */
  description: string
}

/**
 * Shared context yang disiapkan runner sebelum adapter.execute() dipanggil.
 * Adapter pakai ini untuk jalankan LLM — tidak perlu rebuild dari awal.
 */
export interface AgentRunContext {
  // — Prepared data —
  systemPrompt: string
  messages: ModelMessage[]        // history + current user input, siap kirim ke LLM
  modeTools: ResolvedTool[]       // tools setelah filter scope + tool_states
  aiTools: ToolSet                // AI SDK-ready ToolSet
  model: ReturnType<import('./providers.ts').ModelProviders['resolve']>
  maxToolCalls: number
  mode: AgentMode
  run_id: string
  conversation_id: string
  agent_id: string

  // — Infrastructure —
  storage: JikuStorageAdapter
  runtimeCtx: RuntimeContext

  // — Stream handles (tersedia setelah createUIMessageStream execute() dipanggil) —
  writer: JikuStreamWriter
  /** Raw SDK writer — untuk writer.merge() di DefaultAdapter */
  sdkWriter: JikuUIMessageStreamWriter

  // — Mode config (raw, untuk adapter baca field spesifiknya) —
  modeConfig?: import('@jiku/types').AgentModeConfig

  // — Helpers —
  /** Emit jiku-usage chunk */
  emitUsage(usage: { inputTokens?: number; outputTokens?: number }): void
  /** Persist assistant message ke storage dari steps hasil streamText */
  persistAssistantMessage(steps: import('ai').StepResult<import('ai').ToolSet>[]): Promise<void>
}

/** Interface yang harus diimplementasi setiap adapter. */
export interface AgentAdapter extends AgentAdapterMeta {
  /**
   * JSON Schema untuk config adapter ini.
   * Digunakan UI untuk render form konfigurasi secara dinamis saat adapter dipilih.
   * Shape: JSON Schema draft-07 object schema.
   *
   * Contoh:
   * {
   *   type: 'object',
   *   properties: {
   *     max_tool_calls: { type: 'number', default: 40, description: 'Max tool call steps' }
   *   }
   * }
   */
  configSchema: Record<string, unknown>

  /**
   * Jalankan satu turn agent.
   * Dipanggil di dalam createUIMessageStream execute() — writer sudah tersedia.
   * Adapter TIDAK boleh create stream baru, hanya write ke ctx.writer / ctx.sdkWriter.
   */
  execute(ctx: AgentRunContext, params: JikuRunParams & { rules: PolicyRule[]; subject_matcher?: SubjectMatcher }): Promise<void>
}
```

---

## 3. Phase 2 — Built-in Adapters

### 3.1 `packages/core/src/adapters/default.ts` (file baru)

Pindahkan logika streamText dari `runner.ts` ke sini. Tidak ada perubahan perilaku.

```typescript
import { streamText, stepCountIs } from 'ai'
import type { AgentAdapter, AgentRunContext } from '../adapter.ts'
import type { JikuRunParams } from '@jiku/types'

export class DefaultAgentAdapter implements AgentAdapter {
  readonly id = 'jiku.agent.default'
  readonly displayName = 'Default Agent'
  readonly description = 'Standard single-turn streaming agent menggunakan streamText.'

  readonly configSchema = {
    type: 'object',
    properties: {
      max_tool_calls: {
        type: 'number',
        default: 40,
        minimum: 1,
        maximum: 200,
        description: 'Maksimum tool call steps per run.',
      },
    },
  }

  async execute(ctx: AgentRunContext, params: JikuRunParams & { rules: any; subject_matcher?: any }) {
    // Baca max_tool_calls dari mode config, fallback ke ctx.maxToolCalls (AgentDefinition legacy)
    const maxToolCalls: number =
      (ctx.modeConfig?.config?.max_tool_calls as number | undefined) ?? ctx.maxToolCalls

    const result = streamText({
      model: ctx.model,
      system: ctx.systemPrompt,
      messages: ctx.messages,
      tools: Object.keys(ctx.aiTools).length > 0 ? ctx.aiTools : undefined,
      stopWhen: stepCountIs(maxToolCalls),
      abortSignal: params.abort_signal,
      onStepFinish: (event) => {
        ctx.writer.write('jiku-step-usage', {
          step: event.stepNumber,
          input_tokens: event.usage.inputTokens ?? 0,
          output_tokens: event.usage.outputTokens ?? 0,
        })
      },
    })

    ctx.sdkWriter.merge(
      result.toUIMessageStream({ sendFinish: true, sendStart: true, sendReasoning: true, sendSources: true }),
    )

    const [steps, usage] = await Promise.all([result.steps, result.usage])

    // Emit run snapshot untuk usage log debug
    const finalResponseText = steps.map(s => s.text).filter(Boolean).join('\n')
    ctx.writer.write('jiku-run-snapshot', {
      system_prompt: ctx.systemPrompt,
      messages: ctx.messages,
      response: finalResponseText,
    })

    await ctx.persistAssistantMessage(steps)
    ctx.emitUsage(usage)
  }
}
```

### 3.2 `packages/core/src/adapters/harness.ts` (file baru)

Berbeda dari `DefaultAgentAdapter` yang mendelegasikan loop ke AI SDK internal, HarnessAgentAdapter **mengontrol loop sendiri secara eksplisit**. Setiap iterasi adalah satu `streamText` call dengan `stopWhen: stepCountIs(1)`, hasilnya langsung di-merge ke main UI stream. Loop berhenti ketika tidak ada tool calls atau max iterasi tercapai.

```
Iteration 1: streamText → merge → await steps → ada tool calls → lanjut
Iteration 2: streamText → merge → await steps → ada tool calls → lanjut
Iteration N: streamText → merge → await steps → tidak ada tool calls → selesai
```

Client menerima stream kontinyu dari semua iterasi tanpa putus, karena `sdkWriter.merge()` bisa dipanggil berulang kali selama execute callback masih terbuka.

```typescript
import { streamText, stepCountIs } from 'ai'
import type { ModelMessage, StepResult, ToolSet } from 'ai'
import type { AgentAdapter, AgentRunContext } from '../adapter.ts'
import type { JikuRunParams } from '@jiku/types'

/** Default max iterasi harness. Agent bisa override via mode_configs. */
const DEFAULT_HARNESS_MAX_ITERATIONS = 20

export class HarnessAgentAdapter implements AgentAdapter {
  readonly id = 'jiku.agent.harness'
  readonly displayName = 'Harness Agent'
  readonly description = 'Iterative multi-step agent. Setiap turn dikontrol eksplisit — LLM → tools → LLM → repeat sampai selesai atau max iterasi tercapai.'

  readonly configSchema = {
    type: 'object',
    properties: {
      max_iterations: {
        type: 'number',
        default: 20,
        minimum: 1,
        maximum: 100,
        description: 'Maksimum iterasi loop LLM → tools. Setiap iterasi = satu LLM call.',
      },
      max_tool_calls_per_iteration: {
        type: 'number',
        default: 1,
        minimum: 1,
        maximum: 20,
        description: 'Maksimum tool call steps per iterasi. Default 1 agar loop eksplisit.',
      },
    },
  }

  async execute(
    ctx: AgentRunContext,
    params: JikuRunParams & { rules: any; subject_matcher?: any },
  ) {
    const maxIterations: number =
      (ctx.modeConfig?.config?.max_iterations as number | undefined) ?? DEFAULT_HARNESS_MAX_ITERATIONS
    const maxToolCallsPerIteration: number =
      (ctx.modeConfig?.config?.max_tool_calls_per_iteration as number | undefined) ?? 1

    // Working copy messages — diupdate setiap iterasi dengan hasil tool calls
    let messages: ModelMessage[] = [...ctx.messages]

    let iteration = 0
    let totalInputTokens = 0
    let totalOutputTokens = 0
    const allSteps: StepResult<ToolSet>[] = []
    let done = false

    while (!done && iteration < maxIterations) {
      iteration++

      // Emit progress event sebelum setiap iterasi (kecuali pertama)
      if (iteration > 1) {
        ctx.writer.write('jiku-harness-iteration', {
          iteration,
          max_iterations: maxIterations,
        })
      }

      // Satu streamText call per iterasi — satu step saja agar kita yang kontrol loop
      const result = streamText({
        model: ctx.model,
        system: ctx.systemPrompt,
        messages,
        tools: Object.keys(ctx.aiTools).length > 0 ? ctx.aiTools : undefined,
        stopWhen: stepCountIs(maxToolCallsPerIteration),
        abortSignal: params.abort_signal,
        onStepFinish: (event) => {
          ctx.writer.write('jiku-step-usage', {
            step: event.stepNumber,
            input_tokens: event.usage.inputTokens ?? 0,
            output_tokens: event.usage.outputTokens ?? 0,
          })
        },
      })

      // Tunggu iterasi ini selesai dulu agar kita tahu apakah ini iterasi terakhir
      const [steps, usage] = await Promise.all([result.steps, result.usage])

      totalInputTokens += usage.inputTokens ?? 0
      totalOutputTokens += usage.outputTokens ?? 0
      allSteps.push(...steps)

      const lastStep = steps[steps.length - 1]
      // Stop condition: tidak ada tool calls atau tidak ada step → selesai
      const hasToolCalls = (lastStep?.toolCalls?.length ?? 0) > 0
      if (!lastStep || !hasToolCalls) done = true

      // Merge stream iterasi ini ke main UI stream.
      // sendStart hanya di iterasi pertama, sendFinish hanya di iterasi terakhir.
      ctx.sdkWriter.merge(
        result.toUIMessageStream({
          sendStart: iteration === 1,
          sendFinish: done || iteration === maxIterations,
          sendReasoning: true,
          sendSources: true,
        }),
      )

      if (done) break

      // Update messages untuk iterasi berikutnya:
      // append assistant message + tool results ke history
      // Assistant message
      type AssistantPart =
        | { type: 'text'; text: string }
        | { type: 'tool-call'; toolCallId: string; toolName: string; input: unknown }
      const assistantContent: AssistantPart[] = []
      if (lastStep.text) assistantContent.push({ type: 'text', text: lastStep.text })
      for (const tc of lastStep.toolCalls ?? []) {
        assistantContent.push({
          type: 'tool-call',
          toolCallId: tc.toolCallId,
          toolName: tc.toolName,
          input: tc.input,
        })
      }
      messages = [...messages, { role: 'assistant', content: assistantContent }]

      // Tool results
      const toolResults = (lastStep.toolResults ?? []).map((tr) => ({
        type: 'tool-result' as const,
        toolCallId: tr.toolCallId,
        toolName: tr.toolName,
        output: { type: 'json' as const, value: tr.output ?? null },
      }))
      if (toolResults.length > 0) {
        messages = [...messages, { role: 'tool', content: toolResults }]
      }
    }

    // Emit run snapshot untuk usage log debug
    const finalResponseText = allSteps.map(s => s.text).filter(Boolean).join('\n')
    ctx.writer.write('jiku-run-snapshot', {
      system_prompt: ctx.systemPrompt,
      messages: ctx.messages,  // original messages (bukan expanded loop messages)
      response: finalResponseText,
    })

    // Persist semua steps sebagai satu assistant message
    await ctx.persistAssistantMessage(allSteps)

    // Emit total usage semua iterasi
    ctx.emitUsage({ inputTokens: totalInputTokens, outputTokens: totalOutputTokens })
  }
}
```

### Tambahan di `packages/types/src/index.ts` — event baru

```typescript
// Tambah ke JikuDataTypes
'jiku-harness-iteration': {
  iteration: number
  max_iterations: number
}
```

### 3.3 Export dari `packages/core/src/index.ts`

```typescript
export type { AgentAdapter, AgentAdapterMeta, AgentRunContext } from './adapter.ts'
export { DefaultAgentAdapter } from './adapters/default.ts'
export { HarnessAgentAdapter } from './adapters/harness.ts'
```

---

## 4. Phase 3 — AgentAdapterRegistry (Server)

### 4.1 `apps/studio/server/src/agent/adapter-registry.ts` (file baru)

Mirror persis pola `BrowserAdapterRegistry`.

```typescript
// Registry adapter agent. Populated by:
//   - Built-in registration at server start (default + harness).
//   - Plugin setup via `ctx.agent.registerAdapter(adapter)` (future).
//
// Agent mode configs referensi adapter by stable `id` string.

import type { AgentAdapter } from '@jiku/core'

class AgentAdapterRegistry {
  private adapters = new Map<string, AgentAdapter>()

  register(adapter: AgentAdapter): void {
    if (this.adapters.has(adapter.id)) {
      console.warn(`[agent:adapters] Adapter '${adapter.id}' already registered — skipping duplicate`)
      return
    }
    this.adapters.set(adapter.id, adapter)
    console.log(`[agent:adapters] Registered adapter: ${adapter.id} ("${adapter.displayName}")`)
  }

  get(id: string): AgentAdapter | undefined {
    return this.adapters.get(id)
  }

  /** Fallback ke default jika id tidak ditemukan */
  resolve(id: string): AgentAdapter {
    return this.adapters.get(id) ?? this.adapters.get('jiku.agent.default')!
  }

  list(): Pick<AgentAdapter, 'id' | 'displayName' | 'description' | 'configSchema'>[] {
    return Array.from(this.adapters.values()).map(({ id, displayName, description, configSchema }) => ({
      id,
      displayName,
      description,
      configSchema,
    }))
  }

  has(id: string): boolean {
    return this.adapters.has(id)
  }
}

export const agentAdapterRegistry = new AgentAdapterRegistry()
```

### 4.2 `apps/studio/server/src/agent/index.ts` (file baru)

Registrasi built-in adapters saat server start.

```typescript
import { DefaultAgentAdapter, HarnessAgentAdapter } from '@jiku/core'
import { agentAdapterRegistry } from './adapter-registry.ts'

// Register built-in adapters
agentAdapterRegistry.register(new DefaultAgentAdapter())
agentAdapterRegistry.register(new HarnessAgentAdapter())
```

### 4.3 Import di `apps/studio/server/src/index.ts`

```typescript
import './agent/index.ts'  // side-effect: register built-in adapters
```

---

## 5. Phase 4 — Runner Refactor

### 5.1 Ekstrak `buildPreContext()` dari `runner.ts`

Semua logika setup yang sekarang ada di `run()` dipindah ke private method `buildPreContext()`:

```typescript
private async buildPreContext(params: JikuRunParams & { rules: PolicyRule[]; subject_matcher?: SubjectMatcher }): Promise<{
  scope: ScopeResult
  modeTools: ResolvedTool[]
  model: ReturnType<ModelProviders['resolve']>
  model_id: string
  conversation_id: string
  run_id: string
  systemPrompt: string
  messages: ModelMessage[]
  aiTools: ToolSet
  compactSummary: string | null
  compactRemovedCount: number
  compactTokenSaved: number
  runtimeCtx: RuntimeContext
  persistAssistantMessage: (steps: StepResult<ToolSet>[]) => Promise<void>
}>
```

Ini memungkinkan:
- `run()` menjadi thin: `buildPreContext()` → `createUIMessageStream` → `adapter.execute(ctx)`
- `previewRun()` reuse `buildPreContext()` tanpa duplikasi memory/persona/tools loading

### 5.2 Resolve adapter di `run()`

```typescript
async run(params: JikuRunParams & { rules: PolicyRule[]; subject_matcher?: SubjectMatcher }): Promise<JikuRunResult> {
  const preCtx = await this.buildPreContext(params)

  // Resolve adapter: dari mode_configs agent, fallback ke default
  const adapterConfig = this.agent.mode_configs?.[params.mode]
  const adapterId = adapterConfig?.adapter ?? 'jiku.agent.default'
  const adapter = this.adapterRegistry.resolve(adapterId)

  const stream = createUIMessageStream<JikuUIMessage>({
    execute: async ({ writer }) => {
      const jikuWriter = makeWriter(writer)

      // Emit meta + compact event (tetap di runner, bukan tanggung jawab adapter)
      jikuWriter.write('jiku-meta', {
        run_id: preCtx.run_id,
        conversation_id: preCtx.conversation_id,
        agent_id: this.agent.meta.id,
        mode: params.mode,
      })
      if (preCtx.compactSummary !== null) {
        jikuWriter.write('jiku-compact', {
          summary: preCtx.compactSummary,
          removed_count: preCtx.compactRemovedCount,
          token_saved: preCtx.compactTokenSaved,
        })
      }

      // Build ctx lengkap dengan writer
      const ctx: AgentRunContext = {
        ...preCtx,
        writer: jikuWriter,
        sdkWriter: writer,
        mode: params.mode,
        agent_id: this.agent.meta.id,
        maxToolCalls: this.agent.max_tool_calls ?? 40,
        modeConfig: this.agent.mode_configs?.[params.mode],  // ← expose ke adapter
        emitUsage: (usage) => {
          jikuWriter.write('jiku-usage', {
            input_tokens: usage.inputTokens ?? 0,
            output_tokens: usage.outputTokens ?? 0,
          })
        },
      }

      await adapter.execute(ctx, params)

      // Finalize hook (tetap di runner)
      try {
        this.finalizeHook?.({
          conversation_id: preCtx.conversation_id,
          agent_id: this.agent.meta.id,
          mode: params.mode,
          turn_count: 1,
        })
      } catch (err) {
        console.warn('[runner] finalize hook error:', err)
      }
    },
    onError: (err) => { /* existing error handling */ },
  })

  return { run_id: preCtx.run_id, conversation_id: preCtx.conversation_id, stream }
}
```

### 5.3 Inject `adapterRegistry` ke `AgentRunner`

```typescript
// packages/core/src/runner.ts
export class AgentRunner {
  constructor(
    private agent: AgentDefinition,
    private plugins: PluginLoader,
    private storage: JikuStorageAdapter,
    private providers: ModelProviders,
    private memoryConfig?: ResolvedMemoryConfig,
    private runtimeId?: string,
    private personaSeed?: PersonaSeed | null,
    private personaPrompt?: string | null,
    private skillSection?: string | null,
    private skillHint?: string | null,
    private adapterRegistry?: AgentAdapterRegistryLike,  // ← BARU (optional, fallback ke default)
  ) {}
}
```

`AgentAdapterRegistryLike` adalah interface minimal:
```typescript
export interface AgentAdapterRegistryLike {
  resolve(id: string): AgentAdapter
}
```

Di studio, inject `agentAdapterRegistry` saat konstruksi `AgentRunner`.

---

## 6. Phase 5 — DB Migration

### 6.1 `apps/studio/db/src/migrations/0017_agent_mode_configs.sql` (file baru)

```sql
ALTER TABLE agents ADD COLUMN mode_configs jsonb NOT NULL DEFAULT '{}';
```

### 6.2 Update Drizzle schema `apps/studio/db/src/schema/agents.ts`

```typescript
mode_configs: jsonb('mode_configs').$type<Partial<Record<string, { adapter: string }>>>().notNull().default({}),
```

### 6.3 Update queries/types di `@jiku-studio/db`

Pastikan `getAgentById`, `updateAgent`, dan type `Agent` include `mode_configs`.

---

## 7. Phase 6 — API Endpoint (untuk UI dropdown)

### 7.1 `GET /agents/adapters` — List available adapters

Tambahkan ke `apps/studio/server/src/routes/agents.ts`:

```typescript
// GET /agents/adapters — list adapters yang tersedia
router.get('/agents/adapters', authMiddleware, async (req, res) => {
  res.json({ adapters: agentAdapterRegistry.list() })
})
```

Response:
```json
{
  "adapters": [
    {
      "id": "jiku.agent.default",
      "displayName": "Default Agent",
      "description": "...",
      "configSchema": {
        "type": "object",
        "properties": {
          "max_tool_calls": { "type": "number", "default": 40, "description": "..." }
        }
      }
    },
    {
      "id": "jiku.agent.harness",
      "displayName": "Harness Agent",
      "description": "...",
      "configSchema": {
        "type": "object",
        "properties": {
          "max_iterations": { "type": "number", "default": 20, "description": "..." },
          "max_tool_calls_per_iteration": { "type": "number", "default": 1, "description": "..." }
        }
      }
    }
  ]
}
```

### 7.2 Update `PATCH /agents/:id` — Accept `mode_configs`

Pastikan endpoint update agent menerima dan simpan `mode_configs` field.

---

## 8. Phase 7 — UI

### 8.1 Agent Settings — Mode Configuration

Di halaman settings agent, section "Modes" yang sekarang hanya show toggle enabled/disabled, di-extend dengan dropdown adapter + dynamic config form per mode.

```
Modes
──────────────────────────────────────────────────────────
[✓] Chat    Adapter: [Default Agent      ▼]
            ┌─ Adapter Config ───────────────────────────┐
            │  Max Tool Calls   [40    ]                  │
            └────────────────────────────────────────────┘

[✓] Task    Adapter: [Harness Agent      ▼]
            ┌─ Adapter Config ───────────────────────────┐
            │  Max Iterations              [20    ]       │
            │  Max Tool Calls / Iteration  [1     ]       │
            └────────────────────────────────────────────┘
──────────────────────────────────────────────────────────
```

**Flow UI:**
1. On mount: `GET /agents/adapters` → simpan list adapters + configSchema masing-masing
2. Per mode:
   - Toggle enabled/disabled (existing)
   - Dropdown pilih adapter (hanya muncul kalau mode enabled)
   - Saat adapter dipilih → render form dinamis dari `adapter.configSchema`
   - Form render: `number` → number input, `string` → text input, `boolean` → toggle
   - Default values diambil dari `configSchema.properties[field].default`
3. Save ke `PATCH /agents/:id` dengan `mode_configs`:
   ```json
   {
     "mode_configs": {
       "chat": { "adapter": "jiku.agent.default", "config": { "max_tool_calls": 40 } },
       "task": { "adapter": "jiku.agent.harness", "config": { "max_iterations": 20, "max_tool_calls_per_iteration": 1 } }
     }
   }
   ```

**Note:** `max_tool_calls` di top-level `AgentDefinition` tetap sebagai fallback legacy. Adapter config yang lebih spesifik mengoverride-nya.

---

## 9. Future — Plugin Adapter Registration

Disiapkan tapi tidak diimplementasi di Plan 21. Registry sudah siap untuk ini.

```typescript
// plugins/jiku.myplugin/src/index.ts — contoh di masa depan
export default definePlugin({
  setup(ctx) {
    ctx.agent?.registerAdapter({
      id: 'myplugin.agent.custom',
      displayName: 'Custom Agent',
      description: '...',
      async execute(runCtx, params) {
        // custom execution logic
      }
    })
  }
})
```

Plugin API `ctx.agent.registerAdapter()` akan ditambahkan ke `StudioContributes` dan `context-extender.ts` di phase ini (atau plan berikutnya).

---

## 10. Checklist Implementasi

### Phase 1 — Types
- [ ] `AgentModeConfig` di `packages/types/src/index.ts`
- [ ] `mode_configs?: Partial<Record<AgentMode, AgentModeConfig>>` di `AgentDefinition`
- [ ] `packages/core/src/adapter.ts` — `AgentAdapter`, `AgentAdapterMeta`, `AgentRunContext`

### Phase 2 — Built-in Adapters
- [ ] `packages/core/src/adapters/default.ts` — pindahkan logika streamText dari runner
- [ ] `packages/core/src/adapters/harness.ts` — iterative loop full implementation
- [ ] Export dari `packages/core/src/index.ts`

### Phase 3 — Registry
- [ ] `apps/studio/server/src/agent/adapter-registry.ts`
- [ ] `apps/studio/server/src/agent/index.ts` — register built-in di startup
- [ ] Import side-effect di `apps/studio/server/src/index.ts`

### Phase 4 — Runner Refactor
- [ ] Ekstrak `buildPreContext()` dari `run()`
- [ ] `run()` thin: setupCtx → adapter.execute()
- [ ] `previewRun()` reuse `buildPreContext()` — hapus duplikasi
- [ ] Inject `adapterRegistry` ke `AgentRunner` constructor

### Phase 5 — DB
- [ ] Migration `0017_agent_mode_configs.sql`
- [ ] Update Drizzle schema
- [ ] Update DB queries + types

### Phase 6 — API
- [ ] `GET /agents/adapters`
- [ ] `PATCH /agents/:id` terima `mode_configs`

### Phase 7 — UI
- [ ] Fetch adapters list
- [ ] Mode section: toggle + adapter dropdown per mode
- [ ] Save `mode_configs`

---

## 11. File yang Berubah

| File | Status |
|------|--------|
| `packages/types/src/index.ts` | Update — tambah `AgentModeConfig`, update `AgentDefinition` |
| `packages/core/src/adapter.ts` | Baru |
| `packages/core/src/adapters/default.ts` | Baru |
| `packages/core/src/adapters/harness.ts` | Baru |
| `packages/core/src/index.ts` | Update — tambah exports |
| `packages/core/src/runner.ts` | Refactor — ekstrak `buildPreContext()`, inject registry |
| `apps/studio/server/src/agent/adapter-registry.ts` | Baru |
| `apps/studio/server/src/agent/index.ts` | Baru |
| `apps/studio/server/src/index.ts` | Update — import agent/index.ts |
| `apps/studio/server/src/routes/agents.ts` | Update — tambah GET /adapters |
| `apps/studio/db/src/migrations/0017_agent_mode_configs.sql` | Baru |
| `apps/studio/db/src/schema/agents.ts` | Update — tambah mode_configs |
| `apps/studio/db/src/queries/agents.ts` | Update — include mode_configs |
| `apps/studio/web/.../agents/[agent]/settings/page.tsx` | Update — mode + adapter UI |
