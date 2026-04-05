# Plan 6 — Agent Conversation System

> Status: **PLANNING**
> Date: 2026-04-05
> Depends on: Plan 5 (Studio UI/UX)
> Note: Ongoing tasks — tidak semua selesai dalam satu sesi

---

## Daftar Isi

1. [Scope & Goals](#1-scope--goals)
2. [Context Management](#2-context-management)
3. [Context Compaction](#3-context-compaction)
4. [Context Preview & previewRun](#4-context-preview--previewrun)
5. [Tool Calls UI](#5-tool-calls-ui)
6. [Agent Settings — Threshold Config](#6-agent-settings--threshold-config)
7. [Studio Web — UI](#7-studio-web--ui)
8. [Core Changes](#8-core-changes)
9. [Server Changes](#9-server-changes)
10. [File Changes](#10-file-changes)
11. [Implementation Checklist](#11-implementation-checklist)

---

## 1. Scope & Goals

### Features

| Feature | Description | Priority |
|---------|-------------|----------|
| Context management | System prompt, plugin inject, tools prompt — visible dan configurable | P1 |
| Context preview | Simulasi run, lihat semua yang akan di-inject sebelum chat | P1 |
| `previewRun` | Endpoint yang return token count + breakdown context tanpa run LLM | P1 |
| Context compaction | Auto-compact di threshold, LLM-based summarization | P2 |
| Compaction threshold | Setting per-agent di UI | P2 |
| Tool calls UI | Better tool call/result display di chat | P2 |

### Ongoing Task Flag

Plan ini punya **ongoing tasks** — beberapa item dikerjakan bersamaan dan tidak harus selesai semua dalam satu implementation session. AI builder harus catat progress per item.

---

## 2. Context Management

### Apa itu Context di Jiku

Context adalah semua yang di-inject ke LLM sebelum user input. Terdiri dari:

```
1. System Prompt (base)         ← dari agent.base_prompt
2. Mode instruction             ← chat vs task mode description  
3. User context                 ← nama user, role, company
4. Plugin prompt segments       ← dari ctx.prompt.inject() tiap plugin
5. Tool hints                   ← prompt per tool yang aktif
6. Conversation history         ← messages sebelumnya
```

### Sumber Tiap Layer

```typescript
// packages/core/src/resolver/prompt.ts — sudah ada, perlu diperluas

export function buildSystemPrompt(params: {
  base: string                    // agent.base_prompt
  mode: AgentMode                 // 'chat' | 'task'
  active_tools: ResolvedTool[]    // tools yang aktif (setelah policy filter)
  caller: CallerContext           // user info
  plugin_segments: string[]       // dari PluginLoader.getPromptSegments()
}): string {
  const segments = [
    params.base,
    buildModeInstruction(params.mode),
    buildUserContext(params.caller),
    ...params.plugin_segments,
    buildToolHints(params.active_tools),
  ].filter(Boolean)

  return segments.join('\n\n')
}
```

### Context Object — Typed

```typescript
// packages/types/src/index.ts — tambah

export interface ContextSegment {
  source: 'base_prompt' | 'mode' | 'user_context' | 'plugin' | 'tool_hint'
  label: string              // "Base Prompt", "Social Plugin", "list_post hint"
  content: string
  token_estimate: number     // estimasi token untuk segment ini
}

export interface ConversationContext {
  segments: ContextSegment[]
  total_tokens: number       // semua segments dijumlah
  history_tokens: number     // token dari conversation history
  grand_total: number        // total_tokens + history_tokens
  model_context_window: number  // dari model definition
  usage_percent: number      // grand_total / model_context_window * 100
}
```

---

## 3. Context Compaction

### Konsep

Ketika conversation history terlalu panjang (mendekati threshold), conversation di-compact:

```
[msg1, msg2, msg3, msg4, msg5, msg6, msg7, msg8]
                    ↓ compact at threshold (80%)
[checkpoint("Summary of msg1-5"), msg6, msg7, msg8]
```

Checkpoint adalah satu message dengan role `assistant` yang berisi summary dari messages yang dihapus.

### Threshold

```typescript
// Di agent config (DB)
agents {
  // ... existing fields
  compaction_threshold: integer  // default 80 (persen dari context window)
  // 0 = disabled
}
```

### Compaction Algorithm

```typescript
// packages/core/src/compaction.ts — revisi dari SenkenNeo

export async function compactConversation(params: {
  messages: Message[]
  model: LanguageModel
  keep_recent: number           // berapa messages terakhir yang dipertahankan
  caller: CallerContext
}): Promise<{ compacted: Message[]; summary: string; removed_count: number }> {
  const { messages, model, keep_recent } = params

  // Pisah messages lama dan baru
  const toCompact = messages.slice(0, -keep_recent)
  const toKeep = messages.slice(-keep_recent)

  if (toCompact.length === 0) return {
    compacted: messages,
    summary: '',
    removed_count: 0
  }

  // Generate summary pakai LLM
  const summaryResult = await generateText({
    model,
    messages: [
      {
        role: 'user',
        content: `Summarize this conversation history concisely, preserving key facts, decisions, and context:\n\n${
          toCompact.map(m => `${m.role}: ${getTextContent(m)}`).join('\n')
        }`
      }
    ],
    maxTokens: 500,
  })

  const summary = summaryResult.text

  // Buat checkpoint message
  // created_at = toKeep[0].created_at - 1ms (pastikan sort order benar)
  const checkpoint: Message = {
    id: `checkpoint-${Date.now()}`,
    conversation_id: messages[0].conversation_id,
    role: 'assistant',
    parts: [{
      type: 'text',
      text: `[Context Summary]\n${summary}`
    }],
    created_at: new Date(new Date(toKeep[0].created_at).getTime() - 1),
  }

  return {
    compacted: [checkpoint, ...toKeep],
    summary,
    removed_count: toCompact.length,
  }
}
```

### Auto-compact di AgentRunner

```typescript
// packages/core/src/runner.ts — tambah auto-compact check

async run(params: JikuRunParams & { rules: PolicyRule[] }) {
  // ... existing code ...

  // Setelah load messages, cek threshold
  const shouldCompact = await this.checkCompactionThreshold(
    messages,
    agent.compaction_threshold,
    model
  )

  if (shouldCompact) {
    const result = await compactConversation({
      messages,
      model,
      keep_recent: 10,
      caller: params.caller,
    })

    // Persist: hapus messages lama, simpan checkpoint
    await this.storage.replaceMessages(
      conversationId,
      result.compacted
    )

    // Emit compaction event ke stream
    writer.write({
      type: 'data',
      value: [{
        type: 'jiku-compact',
        data: {
          summary: result.summary,
          removed_count: result.removed_count,
        }
      }]
    })

    messages = result.compacted
  }

  // Lanjut dengan messages yang sudah di-compact
  // ...
}

private async checkCompactionThreshold(
  messages: Message[],
  threshold: number,
  model: LanguageModel,
): Promise<boolean> {
  if (threshold === 0) return false  // disabled

  const historyTokens = estimateTokens(messages)
  const contextWindow = getModelContextWindow(model)
  const usagePercent = (historyTokens / contextWindow) * 100

  return usagePercent >= threshold
}
```

### Storage — Tambah `replaceMessages`

```typescript
// packages/types/src/index.ts — tambah ke JikuStorageAdapter

export interface JikuStorageAdapter {
  // ... existing methods ...

  // Untuk compaction — hapus semua messages, simpan yang baru (termasuk checkpoint)
  replaceMessages(conversation_id: string, messages: Message[]): Promise<void>
}
```

---

## 4. Context Preview & previewRun

### Konsep

`previewRun` adalah simulasi run yang **tidak memanggil LLM**. Hanya:
1. Resolve scope (tools apa yang aktif)
2. Build system prompt lengkap
3. Estimasi token per segment
4. Return breakdown context

Mirip "dry run" — user bisa lihat sebelum chat:
- System prompt-nya apa
- Plugin mana yang inject apa
- Tools apa yang akan aktif
- Total token yang akan dikonsumsi

### `previewRun` di Core

```typescript
// packages/core/src/runner.ts — tambah method

export interface PreviewRunResult {
  context: ConversationContext    // breakdown semua segments + token counts
  active_tools: {
    id: string
    name: string
    permission: string
    has_prompt: boolean
    token_estimate: number
  }[]
  active_plugins: {
    id: string
    name: string
    segments: { label: string; token_estimate: number }[]
  }[]
  system_prompt: string           // full system prompt yang akan dikirim
  warnings: string[]             // misal: "approaching context limit"
}

class AgentRunner {
  async previewRun(params: {
    caller: CallerContext
    mode: AgentMode
    conversation_id?: string      // kalau ada, include history token count
    rules: PolicyRule[]
  }): Promise<PreviewRunResult> {

    // 1. Resolve scope — sama seperti run() tapi tidak jalankan LLM
    const scope = resolveScope({
      caller: params.caller,
      agent: this.agent,
      rules: params.rules,
      all_tools: this.plugins.getResolvedTools(),
      mode: params.mode,
    })

    if (!scope.accessible) {
      throw new JikuAccessError(scope.denial_reason)
    }

    // 2. Build system prompt (full)
    const systemPrompt = buildSystemPrompt({
      base: this.agent.base_prompt,
      mode: params.mode,
      active_tools: scope.active_tools,
      caller: params.caller,
      plugin_segments: this.plugins.getPromptSegments(),
    })

    // 3. Build context segments dengan token estimates
    const segments: ContextSegment[] = [
      {
        source: 'base_prompt',
        label: 'Base Prompt',
        content: this.agent.base_prompt,
        token_estimate: estimateTokens(this.agent.base_prompt),
      },
      {
        source: 'mode',
        label: `Mode: ${params.mode}`,
        content: buildModeInstruction(params.mode),
        token_estimate: estimateTokens(buildModeInstruction(params.mode)),
      },
      {
        source: 'user_context',
        label: 'User Context',
        content: buildUserContext(params.caller),
        token_estimate: estimateTokens(buildUserContext(params.caller)),
      },
      // Plugin segments
      ...this.plugins.getPromptSegmentsWithMeta().map(seg => ({
        source: 'plugin' as const,
        label: `Plugin: ${seg.plugin_name}`,
        content: seg.content,
        token_estimate: estimateTokens(seg.content),
      })),
      // Tool hints
      ...scope.active_tools
        .filter(t => t.prompt)
        .map(tool => ({
          source: 'tool_hint' as const,
          label: `Tool: ${tool.meta.name}`,
          content: tool.prompt!,
          token_estimate: estimateTokens(tool.prompt!),
        })),
    ]

    const totalTokens = segments.reduce((acc, s) => acc + s.token_estimate, 0)

    // 4. History tokens (kalau ada conversation)
    let historyTokens = 0
    if (params.conversation_id) {
      const messages = await this.storage.getMessages(params.conversation_id)
      historyTokens = estimateTokens(JSON.stringify(messages))
    }

    const modelContextWindow = getModelContextWindow(this.model)
    const grandTotal = totalTokens + historyTokens
    const usagePercent = (grandTotal / modelContextWindow) * 100

    // 5. Warnings
    const warnings: string[] = []
    if (usagePercent > 80) warnings.push(`Context usage at ${usagePercent.toFixed(0)}% — compaction may trigger soon`)
    if (usagePercent > 95) warnings.push(`Context nearly full — some history may be truncated`)

    return {
      context: {
        segments,
        total_tokens: totalTokens,
        history_tokens: historyTokens,
        grand_total: grandTotal,
        model_context_window: modelContextWindow,
        usage_percent: usagePercent,
      },
      active_tools: scope.active_tools.map(t => ({
        id: t.resolved_id,
        name: t.meta.name,
        permission: t.resolved_permission,
        has_prompt: !!t.prompt,
        token_estimate: t.prompt ? estimateTokens(t.prompt) : 0,
      })),
      active_plugins: this.plugins.getLoadedPlugins().map(p => ({
        id: p.meta.id,
        name: p.meta.name,
        segments: this.plugins.getSegmentsForPlugin(p.meta.id).map(s => ({
          label: s.label,
          token_estimate: estimateTokens(s.content),
        })),
      })),
      system_prompt: systemPrompt,
      warnings,
    }
  }
}
```

### Token Estimation

```typescript
// packages/core/src/utils/tokens.ts

// Rough estimation — 1 token ≈ 4 chars (English)
// Untuk accuracy lebih tinggi bisa pakai tiktoken, tapi ini cukup untuk preview
export function estimateTokens(text: string | object): number {
  const str = typeof text === 'string' ? text : JSON.stringify(text)
  return Math.ceil(str.length / 4)
}

export function getModelContextWindow(model: string): number {
  const windows: Record<string, number> = {
    'claude-opus-4-5':   200000,
    'claude-sonnet-4-5': 200000,
    'claude-haiku-4-5':  200000,
    'gpt-4o':            128000,
    'gpt-4o-mini':       128000,
    'gpt-4.1':           128000,
    'gpt-4.1-mini':      128000,
  }
  return windows[model] ?? 128000  // default 128k
}
```

### API Endpoint

```
POST /api/conversations/:id/preview
POST /api/agents/:aid/preview         ← preview tanpa existing conversation
```

```typescript
// Request body:
{
  mode: 'chat' | 'task'
}

// Response: PreviewRunResult
{
  context: {
    segments: [...],
    total_tokens: 1234,
    history_tokens: 567,
    grand_total: 1801,
    model_context_window: 200000,
    usage_percent: 0.9,
  },
  active_tools: [...],
  active_plugins: [...],
  system_prompt: "You are a social media manager...",
  warnings: [],
}
```

---

## 5. Tool Calls UI

### Current State

Tool calls sudah render pakai `Collapsible` dari shadcn. Perlu ditingkatkan:

### Improved Tool Call View

```typescript
// components/chat/tool-call-view.tsx — revisi

export function ToolCallView({ toolCall, toolResult }) {
  const [open, setOpen] = useState(false)
  const isSuccess = !toolResult?.error
  const duration = toolResult?.duration_ms  // tambah tracking duration

  return (
    <div className="my-1.5">
      <Collapsible open={open} onOpenChange={setOpen}>
        <CollapsibleTrigger asChild>
          <button className={cn(
            "flex items-center gap-2 w-full text-left",
            "px-3 py-2 rounded-lg border text-xs transition-colors",
            "hover:bg-muted/50",
            isSuccess
              ? "bg-muted/30 border-border/50"
              : "bg-destructive/5 border-destructive/30"
          )}>
            {/* Status icon */}
            {!toolResult ? (
              <Loader2 className="h-3 w-3 animate-spin text-muted-foreground" />
            ) : isSuccess ? (
              <Check className="h-3 w-3 text-green-500" />
            ) : (
              <X className="h-3 w-3 text-destructive" />
            )}

            {/* Tool name */}
            <code className="flex-1 font-mono text-xs">
              {toolCall.tool_id.split(':').pop()}()
            </code>

            {/* Duration */}
            {duration && (
              <span className="text-muted-foreground text-xs">
                {duration}ms
              </span>
            )}

            {/* Expand icon */}
            <ChevronDown className={cn(
              "h-3 w-3 text-muted-foreground transition-transform",
              open && "rotate-180"
            )} />
          </button>
        </CollapsibleTrigger>

        <CollapsibleContent>
          <div className="mt-1 rounded-lg border border-border/50 overflow-hidden text-xs">
            {/* Input args */}
            <div className="px-3 py-2 bg-muted/20 border-b border-border/30">
              <p className="text-muted-foreground mb-1 font-medium">Input</p>
              <pre className="font-mono overflow-auto max-h-32 text-foreground">
                {JSON.stringify(toolCall.args, null, 2)}
              </pre>
            </div>

            {/* Output / result */}
            {toolResult && (
              <div className="px-3 py-2">
                <p className={cn(
                  "mb-1 font-medium",
                  isSuccess ? "text-muted-foreground" : "text-destructive"
                )}>
                  {isSuccess ? 'Output' : 'Error'}
                </p>
                <pre className={cn(
                  "font-mono overflow-auto max-h-48",
                  isSuccess ? "text-foreground" : "text-destructive"
                )}>
                  {JSON.stringify(toolResult.result ?? toolResult.error, null, 2)}
                </pre>
              </div>
            )}
          </div>
        </CollapsibleContent>
      </Collapsible>
    </div>
  )
}
```

---

## 6. Agent Settings — Threshold Config

### Tambah Field di Agent Settings (LLM tab)

```typescript
// Di agent LLM settings page:

// Context Compaction
<div className="space-y-3">
  <div className="flex items-center justify-between">
    <div>
      <Label>Context Compaction</Label>
      <p className="text-xs text-muted-foreground mt-0.5">
        Auto-compact conversation history when context usage reaches threshold
      </p>
    </div>
    <Switch
      checked={compactionEnabled}
      onCheckedChange={setCompactionEnabled}
    />
  </div>

  {compactionEnabled && (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <Label className="text-sm">Threshold</Label>
        <span className="text-sm font-medium">{threshold}%</span>
      </div>
      <Slider
        value={[threshold]}
        onValueChange={([v]) => setThreshold(v)}
        min={50}
        max={95}
        step={5}
        className="w-full"
      />
      <div className="flex justify-between text-xs text-muted-foreground">
        <span>50% (aggressive)</span>
        <span>95% (conservative)</span>
      </div>
    </div>
  )}
</div>
```

### DB Schema — Tambah ke agents

```typescript
// apps/studio/db/src/schema/agents.ts

agents {
  // ... existing fields ...
  compaction_threshold: integer('compaction_threshold').default(80),
  // 0 = disabled, 50-95 = threshold percentage
}
```

---

## 7. Studio Web — UI

### Context Preview Panel

Di chat page (`/chats/[conv]`), tambah tombol "Context" di header conversation:

```
┌──────────────────────────────────────────────────────┐
│ Social Manager        gpt-4o    [Context] [···]      │
├──────────────────────────────────────────────────────┤
│                                                      │
│  (messages)                                          │
│                                                      │
└──────────────────────────────────────────────────────┘
```

Klik "Context" → buka shadcn `Sheet` dari kanan:

```
┌─────────────────────────────────────────────┐
│ Context Preview                    [×]      │
├─────────────────────────────────────────────┤
│ Usage                                       │
│ ████████░░░░░░░░░░░░  1,801 / 200,000      │
│ 0.9% of context window                     │
├─────────────────────────────────────────────┤
│ Segments                                    │
│                                             │
│ ▼ Base Prompt                    342 tokens │
│   You are a social media manager...         │
│                                             │
│ ▼ Mode: chat                      28 tokens │
│   You are having a conversation...          │
│                                             │
│ ▼ User Context                    18 tokens │
│   Current user: Admin (owner)               │
│                                             │
│ ▼ Plugin: jiku.social             45 tokens │
│   Social media tools available...           │
│                                             │
│ ▼ Tool: list_post                  12 tokens│
│   Use this to list all posts                │
│                                             │
│ ── History                       567 tokens │
│   (12 messages)                             │
├─────────────────────────────────────────────┤
│ Active Tools (3)                            │
│ ● list_post      *          no hint        │
│ ● create_post    post:write  has hint      │
│ ● delete_post    post:delete has hint      │
├─────────────────────────────────────────────┤
│ System Prompt                               │
│ ┌─────────────────────────────────────────┐ │
│ │ You are a social media manager...       │ │
│ │ (full prompt, scrollable)               │ │
│ └─────────────────────────────────────────┘ │
└─────────────────────────────────────────────┘
```

### Context Preview Component

```typescript
// components/chat/context-preview-sheet.tsx

interface ContextPreviewSheetProps {
  agentId: string
  conversationId?: string
  open: boolean
  onOpenChange: (open: boolean) => void
}

export function ContextPreviewSheet({
  agentId, conversationId, open, onOpenChange
}: ContextPreviewSheetProps) {
  const { data: preview, isLoading } = useQuery({
    queryKey: ['preview', agentId, conversationId],
    queryFn: () => api.agents.preview(agentId, { conversation_id: conversationId }),
    enabled: open,  // hanya fetch saat sheet dibuka
  })

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="w-96 sm:max-w-96 overflow-y-auto">
        <SheetHeader>
          <SheetTitle>Context Preview</SheetTitle>
          <SheetDescription>
            Tokens and context that will be sent to the model
          </SheetDescription>
        </SheetHeader>

        {isLoading && <ContextPreviewSkeleton />}

        {preview && (
          <div className="space-y-4 mt-4">
            {/* Usage bar */}
            <ContextUsageBar context={preview.context} />

            {/* Warnings */}
            {preview.warnings.map((w, i) => (
              <Alert key={i} variant="warning">
                <AlertTriangle className="h-4 w-4" />
                <AlertDescription>{w}</AlertDescription>
              </Alert>
            ))}

            {/* Segments breakdown */}
            <ContextSegmentsList segments={preview.context.segments} />

            {/* Active tools */}
            <ActiveToolsList tools={preview.active_tools} />

            {/* Full system prompt */}
            <SystemPromptView prompt={preview.system_prompt} />
          </div>
        )}
      </SheetContent>
    </Sheet>
  )
}
```

### Context Usage Bar

```typescript
// components/chat/context-usage-bar.tsx

export function ContextUsageBar({ context }: { context: ConversationContext }) {
  const { total_tokens, history_tokens, grand_total, model_context_window, usage_percent } = context

  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between text-xs">
        <span className="text-muted-foreground">Context usage</span>
        <span className="font-medium">
          {grand_total.toLocaleString()} / {model_context_window.toLocaleString()}
        </span>
      </div>
      <Progress
        value={usage_percent}
        className={cn(
          "h-2",
          usage_percent > 90 && "[&>div]:bg-destructive",
          usage_percent > 70 && usage_percent <= 90 && "[&>div]:bg-amber-500",
        )}
      />
      <div className="flex items-center gap-3 text-xs text-muted-foreground">
        <span>System: {total_tokens.toLocaleString()} tokens</span>
        <span>History: {history_tokens.toLocaleString()} tokens</span>
        <span className="ml-auto">{usage_percent.toFixed(1)}%</span>
      </div>
    </div>
  )
}
```

### Compaction Event di Chat UI

Ketika auto-compact terjadi selama streaming, tampilkan indicator di chat:

```typescript
// components/chat/compaction-indicator.tsx

export function CompactionIndicator({ summary, removedCount }) {
  return (
    <div className="flex items-center gap-2 py-2 px-3 my-2 rounded-lg bg-muted/40 border border-dashed border-border text-xs text-muted-foreground">
      <Minimize2 className="h-3.5 w-3.5 shrink-0" />
      <span>
        Context compacted — {removedCount} messages summarized
      </span>
      <Collapsible>
        <CollapsibleTrigger className="ml-auto text-xs underline underline-offset-2">
          View summary
        </CollapsibleTrigger>
        <CollapsibleContent>
          <p className="mt-2 text-foreground/70">{summary}</p>
        </CollapsibleContent>
      </Collapsible>
    </div>
  )
}
```

---

## 8. Core Changes

### `packages/types/src/index.ts`

```typescript
// Tambah:
ContextSegment
ConversationContext
PreviewRunResult

// Tambah ke JikuStorageAdapter:
replaceMessages(conversation_id: string, messages: Message[]): Promise<void>
```

### `packages/core/src/`

```
runner.ts
  → tambah previewRun() method
  → tambah checkCompactionThreshold()
  → integrate compactConversation() ke run() flow
  → emit 'jiku-compact' data chunk

compaction.ts               ← baru / revisi dari SenkenNeo
  → compactConversation()
  → getTextContent() helper

utils/tokens.ts             ← baru
  → estimateTokens()
  → getModelContextWindow()

resolver/prompt.ts
  → tambah buildModeInstruction()
  → tambah buildUserContext()
  → tambah buildToolHints()
  → export getPromptSegmentsWithMeta() untuk preview

plugins/loader.ts
  → tambah getPromptSegmentsWithMeta(): { plugin_name, label, content }[]
  → tambah getSegmentsForPlugin(pluginId): { label, content }[]
```

### `packages/types/src/index.ts`

```typescript
// Tambah ke JikuDataTypes (stream data types):
'jiku-compact': {
  summary: string
  removed_count: number
  token_saved: number
}
```

---

## 9. Server Changes

### Endpoints Baru

```
POST /api/agents/:aid/preview
  → previewRun tanpa conversation (untuk agent settings page)
  → body: { mode: 'chat' | 'task' }

POST /api/conversations/:id/preview
  → previewRun dengan conversation history
  → body: { mode: 'chat' | 'task' }
```

### Agent Schema Update

```typescript
// PATCH /api/agents/:aid — tambah compaction_threshold ke request body

// DB migration:
ALTER TABLE agents ADD COLUMN compaction_threshold INTEGER DEFAULT 80;
```

### Runtime Manager

```typescript
// Saat wakeUp() — load compaction_threshold dari DB dan pass ke AgentRunner
runtime.addAgent({
  // ... existing fields
  compaction_threshold: agent.compaction_threshold,
})
```

---

## 10. File Changes

### New Files

```
packages/core/src/compaction.ts
packages/core/src/utils/tokens.ts

apps/studio/web/components/chat/
  context-preview-sheet.tsx
  context-usage-bar.tsx
  context-segment-list.tsx
  active-tools-list.tsx
  system-prompt-view.tsx
  compaction-indicator.tsx

apps/studio/server/src/routes/preview.ts
```

### Modified Files

```
packages/types/src/index.ts
  → ContextSegment, ConversationContext, PreviewRunResult
  → JikuStorageAdapter.replaceMessages
  → JikuDataTypes 'jiku-compact'

packages/core/src/runner.ts
  → previewRun(), checkCompactionThreshold()
  → integrate compaction ke run()

packages/core/src/resolver/prompt.ts
  → buildModeInstruction(), buildUserContext(), buildToolHints()

packages/core/src/plugins/loader.ts
  → getPromptSegmentsWithMeta(), getSegmentsForPlugin()

apps/studio/db/src/schema/agents.ts
  → compaction_threshold field

apps/studio/db/src/queries/agent.ts
  → include compaction_threshold

apps/studio/server/src/runtime/manager.ts
  → pass compaction_threshold ke runtime

apps/studio/server/src/runtime/storage.ts
  → implement replaceMessages()

apps/studio/server/src/index.ts
  → mount previewRouter

apps/studio/web/lib/api.ts
  → api.agents.preview()
  → api.conversations.preview()

apps/studio/web/components/chat/ (chats/[conv]/page.tsx)
  → tambah Context button di header
  → ContextPreviewSheet
  → CompactionIndicator saat jiku-compact event

apps/studio/web/app/(app)/.../agents/[agent]/llm/page.tsx
  → compaction_threshold setting (Switch + Slider)

packages/ui/src/index.ts
  → export new chat components
```

---

## 11. Implementation Checklist

> ⚠️ ONGOING — tidak semua harus selesai dalam satu sesi

### Core — Context System

- [ ] `utils/tokens.ts` — `estimateTokens()`, `getModelContextWindow()`
- [ ] `resolver/prompt.ts` — `buildModeInstruction()`, `buildUserContext()`, `buildToolHints()`
- [ ] `plugins/loader.ts` — `getPromptSegmentsWithMeta()`, `getSegmentsForPlugin()`
- [ ] Types: `ContextSegment`, `ConversationContext`, `PreviewRunResult`

### Core — previewRun

- [ ] `runner.ts` — `previewRun()` method
- [ ] Build segments dengan token estimates
- [ ] History token count (kalau ada conversation_id)
- [ ] Warnings generation (>80%, >95%)
- [ ] `JikuRuntime.previewRun()` expose ke luar

### Core — Compaction

- [ ] `compaction.ts` — `compactConversation()`
- [ ] `runner.ts` — `checkCompactionThreshold()`
- [ ] `runner.ts` — integrate compaction ke `run()` flow
- [ ] Emit `jiku-compact` data chunk ke stream
- [ ] `JikuStorageAdapter.replaceMessages()` interface
- [ ] `StudioStorageAdapter.replaceMessages()` implement di server

### DB & Server

- [ ] Migration: `agents.compaction_threshold` field
- [ ] `GET /api/agents/:aid` — include `compaction_threshold`
- [ ] `PATCH /api/agents/:aid` — accept `compaction_threshold`
- [ ] `POST /api/agents/:aid/preview` — previewRun tanpa conversation
- [ ] `POST /api/conversations/:id/preview` — previewRun dengan history
- [ ] Runtime `wakeUp()` — pass `compaction_threshold` ke agent

### Studio Web — Agent Settings

- [ ] LLM tab: compaction toggle (Switch)
- [ ] LLM tab: threshold slider (Slider, 50-95%)
- [ ] Save ke PATCH /api/agents/:aid

### Studio Web — Context Preview UI

- [ ] `ContextPreviewSheet` — shadcn Sheet dari kanan
- [ ] `ContextUsageBar` — progress bar dengan color coding
- [ ] `ContextSegmentList` — collapsible list per segment
- [ ] `ActiveToolsList` — list tools dengan permission info
- [ ] `SystemPromptView` — full prompt scrollable
- [ ] Tombol "Context" di conversation header
- [ ] Fetch via `api.conversations.preview()` atau `api.agents.preview()`

### Studio Web — Tool Calls

- [ ] `ToolCallView` revisi — status icon, duration, success/error state
- [ ] Input args display (collapsible)
- [ ] Output result display (collapsible, max-height scroll)

### Studio Web — Compaction

- [ ] `CompactionIndicator` component
- [ ] Handle `jiku-compact` stream event di chat page
- [ ] Tampilkan CompactionIndicator di message list

---

## Notes untuk AI Builder

### Ongoing Task Management

Plan ini memiliki banyak item yang bisa dikerjakan parallel atau bertahap:
1. Mulai dari **Core — Context System** (foundation untuk semua fitur lain)
2. Lanjut **previewRun** (bisa di-test tanpa UI)
3. Lanjut **Server endpoints**
4. UI bisa dikerjakan terakhir

### Token Estimation Accuracy

`estimateTokens` pakai `chars / 4` — ini rough estimate. Untuk production yang lebih accurate bisa pakai `tiktoken-node` atau `@anthropic-ai/tokenizer`, tapi untuk preview ini cukup. Bisa di-improve nanti tanpa breaking changes.

### Compaction — Keep Recent Count

`keep_recent: 10` adalah default. Pertimbangkan:
- Terlalu kecil → context loss, agent "lupa" terlalu banyak
- Terlalu besar → compaction kurang efektif

Ini bisa dijadikan setting per-agent di masa depan.

### previewRun — Caller Resolution

`previewRun` membutuhkan `CallerContext`. Di server, resolve sama seperti `run()` — load dari DB berdasarkan user JWT.

---

*Generated: 2026-04-05 | Status: Planning — Ongoing Tasks*