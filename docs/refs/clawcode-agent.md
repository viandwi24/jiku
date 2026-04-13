# ClawCode Agent Harness — Technical Reference

> Analisis arsitektur agent/subagent system dari `refs-clawcode/`.  
> Tidak ada sistem bernama "Hermes" di codebase ini — yang terkenal adalah **ConversationRuntime** sebagai orchestrator utama, **TaskRegistry** sebagai IPC, dan **SubagentToolExecutor** sebagai permission boundary.

---

## Ringkasan Arsitektur

ClawCode menggunakan model **thread-per-agent** yang sederhana:

```
Parent ConversationRuntime
  └─ Agent tool invoked
       └─ std::thread::spawn("clawd-agent-{id}")
            └─ Child ConversationRuntime
                 ├─ Fresh Session::new()
                 ├─ Scoped system prompt (role directive)
                 ├─ SubagentToolExecutor (whitelist)
                 └─ run_turn(prompt) → TurnSummary → persist result
```

Koordinasi antar agent tidak lewat channel/pipe, melainkan lewat **TaskRegistry** (in-memory shared state) dan **filesystem** (`/agent_store/`).

---

## 1. Spawning Subagent

**File**: `rust/crates/tools/src/lib.rs` (baris 3490–3590)

### Input Structure

```rust
struct AgentInput {
    description: String,
    prompt: String,
    subagent_type: Option<String>,  // "Explore", "Plan", "Verification", "claw-guide"
    name: Option<String>,
    model: Option<String>,
}
```

### Flow Spawning

1. **Generate Agent ID** — `make_agent_id()` → timestamp + counter
2. **Inject system prompt** — `build_agent_system_prompt()`:
   ```
   "You are a background sub-agent of type `{subagent_type}`. Work only on the 
    delegated task, use only the tools available to you, do not ask the user 
    questions, and finish with a concise result."
   ```
3. **Scope tools** — `allowed_tools_for_subagent()` → whitelist per type
4. **OS thread spawn** dengan panic recovery:
   ```rust
   std::thread::Builder::new()
       .name(format!("clawd-agent-{}", job.manifest.agent_id))
       .spawn(move || {
           let result = std::panic::catch_unwind(|| run_agent_job(&job));
           // terminal state persisted on panic
       })
   ```

### AgentOutput Manifest

```rust
struct AgentOutput {
    agent_id: String,
    name: String,
    subagent_type: String,
    model: String,
    status: "running" | "completed" | "failed",
    output_file: PathBuf,      // /agent_store/{agent_id}.md
    manifest_file: PathBuf,    // /agent_store/{agent_id}.json
    created_at: u64,
    started_at: Option<u64>,
    completed_at: Option<u64>,
    lane_events: Vec<LaneEvent>,  // audit trail
    derived_state: "working" | "blocked",
}
```

---

## 2. Komunikasi Antar Agent — TaskRegistry

**File**: `rust/crates/runtime/src/task_registry.rs`

Tidak ada direct message passing antara parent dan child agent. Semua koordinasi lewat **TaskRegistry** yang thread-safe.

### Task States

```rust
pub enum TaskStatus {
    Created,    // dibuat, belum di-claim
    Running,    // sedang dieksekusi
    Completed,  // terminal — sukses
    Failed,     // terminal — gagal
    Stopped,    // terminal — dibatalkan user
}
```

### Task Structure

```rust
pub struct Task {
    pub task_id: String,              // task_{timestamp}_{counter}
    pub prompt: String,
    pub description: Option<String>,
    pub task_packet: Option<TaskPacket>,  // structured contract (opsional)
    pub status: TaskStatus,
    pub created_at: u64,
    pub updated_at: u64,
    pub messages: Vec<TaskMessage>,   // bidirectional log
    pub output: String,               // accumulated streaming result
    pub team_id: Option<String>,
}
```

### API

| Method | Deskripsi |
|--------|-----------|
| `create(prompt, desc, packet)` | Buat task baru |
| `update(task_id, message)` | Append message ke task |
| `append_output(task_id, output)` | Stream hasil balik ke parent |
| `set_status(task_id, status)` | Transisi state |
| `assign_team(task_id, team_id)` | Grouping |
| `stop(task_id)` | Terminasi task |

**Implementasi**: `Arc<Mutex<HashMap<String, Task>>>` — fine-grained locking, tidak ada lock contention antar task berbeda.

---

## 3. ConversationRuntime — Orchestrator Utama

**File**: `rust/crates/runtime/src/conversation.rs` (baris 125–500+)

Ini adalah inti dari harness — setiap agent (parent maupun child) memiliki satu instance `ConversationRuntime` sendiri.

### Structure

```rust
pub struct ConversationRuntime<C, T> {
    session: Session,
    api_client: C,                    // trait: streaming ke model
    tool_executor: T,                 // trait: dispatch tool calls
    permission_policy: PermissionPolicy,
    system_prompt: Vec<String>,
    max_iterations: usize,
    usage_tracker: UsageTracker,
    hook_runner: HookRunner,          // plugin / hook integration
    auto_compaction_input_tokens_threshold: u32,
    hook_abort_signal: HookAbortSignal,
    session_tracer: Option<SessionTracer>,
}
```

### Main Loop: `run_turn()`

```
run_turn(user_input):
  1. Push user message ke session
  2. Loop (max_iterations):
     a. Build ApiRequest (system_prompt + session messages)
     b. api_client.stream() → events
     c. Build assistant message dari events
     d. session.push_message(assistant)
     e. Jika tidak ada pending tool_use → break
  3. Tool Execution Loop:
     a. HookRunner.run_pre_tool_use_with_context() — bisa deny/modify
     b. permission_policy.authorize_with_context()
     c. tool_executor.execute(tool_name, input)
     d. HookRunner.run_post_tool_use_with_context()
     e. session.push_message(ToolResult)
  4. Auto-compaction jika tokens > threshold
  5. Return TurnSummary
```

### Return Value

```rust
pub struct TurnSummary {
    pub assistant_messages: Vec<ConversationMessage>,
    pub tool_results: Vec<ConversationMessage>,
    pub iterations: usize,
    pub usage: TokenUsage,
    pub auto_compaction: Option<AutoCompactionEvent>,
}
```

---

## 4. SubagentToolExecutor — Permission Boundary

**File**: `rust/crates/tools/src/lib.rs` (baris 4602–4633)

### Structure

```rust
struct SubagentToolExecutor {
    allowed_tools: BTreeSet<String>,     // immutable whitelist saat spawn
    enforcer: Option<PermissionEnforcer>,
}
```

### Enforcement

```rust
fn execute(&mut self, tool_name: &str, input: &str) -> Result<String, ToolError> {
    if !self.allowed_tools.contains(tool_name) {
        return Err(ToolError::new(format!(
            "tool `{tool_name}` is not enabled for this sub-agent"
        )));
    }
    execute_tool_with_enforcer(self.enforcer.as_ref(), tool_name, input)
}
```

### Tool Scoping per Subagent Type

| Type | Allowed Tools |
|------|---------------|
| `Explore` | read_file, glob_search, grep_search, WebFetch, WebSearch, Skill, StructuredOutput |
| `Plan` | Explore tools + TodoWrite, SendUserMessage |
| `Verification` | bash, read_file, glob_search, grep_search, WebFetch, WebSearch, TodoWrite, PowerShell |
| `claw-guide` | read_file, glob_search, grep_search, WebFetch, WebSearch, Skill, SendUserMessage |

### Permission Layers (defense-in-depth)

```
1. Whitelist check (SubagentToolExecutor)
2. PermissionEnforcer (policy_engine.rs)
3. Pre-hook (HookRunner) — dapat deny, modifikasi input, atau cancel
4. Main PermissionPolicy — context-aware evaluation
```

---

## 5. Team & Cron Registry

**File**: `rust/crates/runtime/src/team_cron_registry.rs`

### Team — Multi-Agent Grouping

```rust
pub struct Team {
    pub team_id: String,           // team_{timestamp}_{counter}
    pub name: String,
    pub task_ids: Vec<String>,     // task-task yang tergabung
    pub status: TeamStatus,        // Created, Running, Completed, Deleted (soft-delete)
}
```

- **Soft delete**: status = Deleted, masih bisa diquery
- Agent-agent bisa di-assign ke satu team untuk tracking kolektif

### CronEntry — Recurring Agent Tasks

```rust
pub struct CronEntry {
    pub cron_id: String,
    pub schedule: String,           // standard cron format: "0 * * * *"
    pub prompt: String,             // prompt yang diulang
    pub enabled: bool,              // disable tanpa delete
    pub last_run_at: Option<u64>,
    pub run_count: u64,
}
```

---

## 6. TaskPacket — Structured Task Contract

**File**: `rust/crates/runtime/src/task_packet.rs`

Untuk ad-hoc tasks cukup pakai plain prompt. Tapi untuk task yang lebih terstruktur, TaskPacket memaksa kejelasan scope:

```rust
pub struct TaskPacket {
    pub objective: String,          // apa yang harus dicapai
    pub scope: String,              // batas pekerjaan
    pub repo: String,               // repo yang dikerjakan
    pub branch_policy: String,      // aturan branching
    pub acceptance_tests: Vec<String>,  // kriteria selesai
    pub commit_policy: String,      // aturan commit
    pub reporting_contract: String, // format laporan hasil
    pub escalation_policy: String,  // apa yang dilakukan saat blocked
}
```

- **Validation-by-construction**: `validate_packet()` menolak field kosong
- Bisa `None` di `Task.task_packet` untuk ad-hoc tasks

---

## 7. Worker Bootstrap — Trust & Readiness Handshake

**File**: `rust/crates/runtime/src/worker_boot.rs` (baris 28–158)

Worker adalah konsep untuk agent yang berjalan di cwd berbeda (multi-repo / remote). Ada state machine trust yang harus dilalui:

```rust
pub enum WorkerStatus {
    Spawning,           // proses starting
    TrustRequired,      // perlu approval dari user
    ReadyForPrompt,     // siap terima task
    Running,            // aktif
    Finished,           // selesai
    Failed,
}

pub struct Worker {
    pub worker_id: String,
    pub cwd: String,
    pub trust_auto_resolve: bool,         // auto-approve jika dalam trusted_roots
    pub trust_gate_cleared: bool,         // approval tercatat
    pub auto_recover_prompt_misdelivery: bool,
    pub prompt_in_flight: bool,           // handshake delivery
    pub expected_receipt: Option<WorkerTaskReceipt>,  // verifikasi task benar
    pub replay_prompt: Option<String>,    // recovery jika misdelivery
    pub last_error: Option<WorkerFailure>,
    pub events: Vec<WorkerEvent>,         // audit trail
}
```

Fitur penting:
- **Trust gate**: Tidak bisa spawn agent di cwd sembarangan tanpa approval
- **Prompt misdelivery detection**: Verifikasi task ID yang diterima sesuai yang dikirim
- **Replay recovery**: Jika misdelivery, prompt bisa diulang otomatis

---

## 8. Remote Execution

**File**: `rust/crates/runtime/src/remote.rs`

```rust
pub struct RemoteSessionContext {
    pub enabled: bool,
    pub session_id: Option<String>,
    pub base_url: String,  // WebSocket relay: wss://{base_url}/v1/code/upstreamproxy/ws
}
```

- Token dari disk → injected ke proxy env
- NO_PROXY hardcoded untuk: Anthropic, GitHub, registry.npmjs.org, dll.
- SSL cert bundle management tersendiri

---

## 9. Isolasi & Sharing Context

### Per-Agent Isolation
- Fresh `Session::new()` — tidak ada bleed antar conversation
- System prompt immutable (frozen saat spawn)
- Whitelist tools immutable (frozen saat spawn)
- Independent `UsageTracker`

### Shared Across Agents
- **Filesystem**: `/agent_store/{agent_id}.md` dan `.json`
- **TaskRegistry**: Parent write → child poll-and-claim
- **TeamRegistry**: Grouping lintas agent
- **SessionStore**: Reload via session_id jika perlu resume

---

## 10. Desain Keputusan Penting

| Aspek | Pilihan | Alasan |
|-------|---------|--------|
| Threading model | OS thread per agent | Simpel; 1 ConversationRuntime per thread, tidak ada async complexity |
| IPC | In-memory registry + filesystem | Decoupled; agent bisa restart/reconnect tanpa kehilangan state |
| Tool access | Whitelist per subagent type | Security by constraint; type mendefinisikan kapabilitas |
| Permission flow | Whitelist → Hook → Policy → Enforce | Defense-in-depth |
| State management | `Mutex<HashMap>` | Lock granular per task_id |
| Session isolation | `Session::new()` per agent | Tidak ada cross-agent conversation bleed |
| Failure handling | `catch_unwind` → persist terminal state | Graceful degradation, tidak ada silent hang |
| Message passing | Async task queue (poll-based) | Loose coupling; agent berjalan dengan pace berbeda |

---

## 11. File Reference Utama

| File | Fungsi |
|------|--------|
| `rust/crates/runtime/src/task_registry.rs` | Task lifecycle, status, message append |
| `rust/crates/runtime/src/team_cron_registry.rs` | Team grouping, cron scheduling |
| `rust/crates/runtime/src/task_packet.rs` | Structured task contract + validation |
| `rust/crates/runtime/src/conversation.rs` | Core conversation loop (model ↔ tool ↔ session) |
| `rust/crates/runtime/src/worker_boot.rs` | Trust gates, readiness handshakes, event trail |
| `rust/crates/runtime/src/remote.rs` | Remote execution context, proxy bootstrap |
| `rust/crates/tools/src/lib.rs` (baris 3490+) | Subagent spawning, tool scoping, system prompt injection |
| `rust/crates/tools/src/lib.rs` (baris 4602+) | SubagentToolExecutor permission scoping |

---

## Kesimpulan

ClawCode's agent harness **bukan sistem "Hermes"** — itu bukan nama yang dipakai di codebase. Yang ada adalah:

1. **ConversationRuntime** — orchestrator utama, satu instance per agent
2. **TaskRegistry** — IPC in-memory yang decoupled
3. **SubagentToolExecutor** — permission boundary via whitelist immutable
4. **WorkerBootstrap** — trust gate untuk multi-cwd execution

Yang membuat ini terkenal/istimewa:
- **Simplicity**: Thread-per-agent, tidak ada kompleksitas async/await di layer agent
- **Safety**: Setiap subagent mendapat whitelist tool yang sudah dikunci saat spawn
- **Observability**: Lane events, worker state machine, cron run recording
- **Resilience**: Panic recovery, misdelivery detection, task replay
