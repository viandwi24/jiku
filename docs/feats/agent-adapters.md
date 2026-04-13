# Feature: Agent Adapter System

## What It Does

Lets each agent pick a different execution strategy per mode (chat / task). An "adapter" is the algorithm that drives one run: how it calls the LLM, how it handles tool loops, how it streams to the UI. Previously `AgentRunner` hardcoded a single `streamText` path; now it dispatches to an `AgentAdapter`.

## Built-in Adapters

| Adapter ID | Display | Summary |
|---|---|---|
| `jiku.agent.default` | Default Agent | Single `streamText` with `stepCountIs(max_tool_calls)`. Identical behavior to the pre-adapter runner. |
| `jiku.agent.harness` | Harness Agent | Iterative two-phase loop: phase 1 `tool_choice='none'` (forced narration), phase 2 `tool_choice='auto'` (tool). Makes OpenAI Chat Completions models produce interleaved text → tool → text output that they cannot produce natively. |

## Why Harness Exists

OpenAI Chat Completions responses are EITHER text OR tool_calls — never both. `tool_choice=auto` with GPT generally picks tool-only, producing "batched tools then a single summary". Claude-Code-style UX (narrate → tool → narrate → tool) requires two calls per logical step:

1. **Phase 1 — narration.** `tool_choice: 'none'` forces text. Model narrates next action (or answers directly if no tool needed). Streamed to UI immediately via `sdkWriter.merge(...)` before awaiting steps. System prompt gets `NARRATION_PHASE_INSTRUCTION` appended so the model doesn't hallucinate lack of tool access.
2. **Regex check.** `ACTION_INTENT_RE` (English + Indonesian action-phrase patterns) on phase 1 text. Match → run phase 2. No match → narration WAS the final answer, break loop. Avoids duplicate output on simple questions.
3. **Phase 2 — action.** `tool_choice: 'auto'`, `stepCountIs(max_tool_calls_per_iteration)`. Model emits tool call or final text. If tool → execute, iterate. If text/empty → break.

Critical invariants:
- Phase 1 narration is **never** appended to `messages`. Appending it makes GPT think "already announced, done" → empty phase 2 → stuck loop.
- All phase 2 steps (not just last) are appended to `messages` at iteration end — required when `max_tool_calls_per_iteration > 1` because AI SDK chains internally.
- Never use `tool_choice: 'required'` in phase 2 — forces random tool when task complete → infinite wrong-tool calls.
- Tool outputs normalized via `JSON.parse(JSON.stringify(value))` before re-appending (AI SDK v6 rejects `Date` objects in JSONValue schema).

## Configuration

Per-mode, stored in `agents.mode_configs jsonb`:

```json
{
  "chat": {
    "adapter": "jiku.agent.harness",
    "config": {
      "max_iterations": 40,
      "max_tool_calls_per_iteration": 1,
      "force_narration": true
    }
  },
  "task": {
    "adapter": "jiku.agent.default",
    "config": { "max_tool_calls": 40 }
  }
}
```

`configSchema` on each adapter is JSON Schema draft-07; the UI renders form fields from it dynamically (number → Input[type=number], boolean → Checkbox, string → Input).

### Harness config trade-offs

- `max_tool_calls_per_iteration: 1` (default) — narration before every tool, best UX, 2× LLM cost per tool.
- `max_tool_calls_per_iteration: N > 1` — phase 2 internally chains up to N tools with a single leading narration; faster and cheaper but visually closer to batched output.
- `force_narration: false` — skips phase 1 entirely; use with Claude models that natively interleave (phase 1 is redundant LLM cost there).

## Public API Surface

### `@jiku/core`

```typescript
export interface AgentAdapter {
  id: string
  displayName: string
  description: string
  configSchema: Record<string, unknown>
  execute(ctx: AgentRunContext, params: JikuRunParams & { ... }): Promise<void>
}

export interface AgentRunContext {
  systemPrompt: string
  messages: ModelMessage[]
  modeTools: ResolvedTool[]
  aiTools: ToolSet
  model: LanguageModel
  writer: JikuStreamWriter            // jiku data chunks
  sdkWriter: JikuUIMessageStreamWriter // raw AI SDK stream
  modeConfig?: AgentModeConfig
  emitUsage(usage): void
  persistAssistantMessage(steps): Promise<void>
  // ... run_id, conversation_id, agent_id, storage, runtimeCtx, maxToolCalls, mode
}
```

Export built-ins: `DefaultAgentAdapter`, `HarnessAgentAdapter`. `AgentRunner` takes an optional `AgentAdapterRegistryLike` and falls back to a private default-only registry otherwise.

### Studio server

- `apps/studio/server/src/agent/adapter-registry.ts` — singleton `agentAdapterRegistry`. Methods: `register`, `get`, `resolve` (with fallback to default), `list`, `has`.
- `apps/studio/server/src/agent/index.ts` — side-effect: registers `DefaultAgentAdapter` + `HarnessAgentAdapter` at boot.
- `apps/studio/server/src/runtime/manager.ts` — passes `agentAdapterRegistry` to `JikuRuntime` constructor; forwards `a.mode_configs` via every `defineAgent()` call (wakeUp / syncProjectTools / syncAgent).

### HTTP

| Method | Path | Purpose |
|---|---|---|
| `GET`  | `/api/agents/adapters` | List available adapters with `configSchema` for UI |
| `PATCH` | `/api/agents/:aid` | Accepts `mode_configs` field |
| `POST` | `/api/agents/:aid/preview` | Response extended with `mode` + `adapter_info` |
| `POST` | `/api/conversations/:id/preview` | Same |

### UI

- Agent overview page: per-mode Adapter dropdown + dynamic config form (driven by `configSchema.properties`).
- Chat context bar: shows `<model> · <provider> · [MODE] <adapter name>` under the prompt input.
- Hover popover + ContextPreviewSheet: lists resolved Mode, Adapter display name, and all adapter config key/values.

## Known Limitations

- Phase 2 of the harness adapter uses `tool_choice: 'auto'`; GPT occasionally drops the expected tool call, which causes the harness loop to exit early with incomplete output. This is deliberate — forcing tools via `'required'` causes infinite random tool calls when the task is actually complete, which is worse.
- Action-intent regex is English + Indonesian only. Other languages may not match and fall through to "phase 1 = final answer" or miss valid action intents. Extend `ACTION_INTENT_RE` when needed.
- Plugin-contributed adapters are not yet exposed through the plugin context. Registry already supports it; just needs `ctx.agent.registerAdapter` wired through `context-extender.ts` in Studio.
- `jiku-harness-iteration` data events are emitted from iteration ≥ 2 but nothing in the UI renders them yet.

## Related Files

- `packages/core/src/adapter.ts` — types
- `packages/core/src/adapters/default.ts`, `packages/core/src/adapters/harness.ts` — built-ins
- `packages/core/src/runner.ts` — dispatch to `adapter.execute(ctx, params)`
- `packages/core/src/runtime.ts` — accepts `adapter_registry` option
- `packages/core/src/plugins/loader.ts` — `getPromptSegmentsWithMetaAsync()` for plugin-labeled preview
- `packages/types/src/index.ts` — `AgentModeConfig`, `AgentDefinition.mode_configs`, `PreviewRunResult.mode`, `adapter_info`
- `apps/studio/server/src/agent/adapter-registry.ts`, `apps/studio/server/src/agent/index.ts`
- `apps/studio/server/src/routes/preview.ts`, `apps/studio/server/src/routes/agents.ts`
- `apps/studio/server/src/plugins/narration.ts` — injects "think out loud" rules used by both adapters
- `apps/studio/server/src/runtime/manager.ts` — wires registry + forwards `mode_configs`
- `apps/studio/db/src/migrations/0017_agent_mode_configs.sql`, `apps/studio/db/src/schema/agents.ts`
- `apps/studio/web/components/chat/conversation-viewer.tsx` (streaming indicator, copy-hide, autofocus)
- `apps/studio/web/components/chat/context-bar.tsx`, `apps/studio/web/components/chat/context-preview-sheet.tsx` (mode/adapter surface)
- `apps/studio/web/app/(app)/studio/companies/[company]/projects/[project]/agents/[agent]/page.tsx` (per-mode adapter UI)
