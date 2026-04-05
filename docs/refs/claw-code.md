# Claw Code — Reference Analysis

> Source: `./refs-claw-code/src/` (Python porting workspace)  
> Original: TypeScript Claude Code CLI (1,902 TS files, 207 commands, 184 tools)  
> Analysis Date: 2026-04-05

---

## 1. Konteks & Tujuan

`refs-claw-code/src/` adalah **Python porting workspace** yang merefleksikan arsitektur asli TypeScript Claude Code CLI. Bukan full reimplementation — melainkan:

- **Mirror arsitektur** TypeScript melalui placeholder packages
- **Reference layer** dengan snapshot metadata dari codebase asli
- **Orchestration engine** untuk routing, session management, dan execution harness
- **Audit tool** untuk membandingkan coverage Python vs TypeScript archive

Ada dua workspace di repo ini:
- `src/` — Python reference implementation (yang dianalisis ini, lebih lengkap)
- `rust/` — Rust porting (9 crates, partial porting, baru)

---

## 2. Arsitektur Overview

### Layered Architecture

```
CLI (main.py)
  ↓
PortRuntime (routing, session bootstrap)
  ↓
QueryEnginePort (state, persistence, streaming)
  ↓
Snapshots (commands.py, tools.py) + ExecutionRegistry
  ↓
Reference Data (JSON metadata — 207 commands, 184 tools, 35 subsystems)
```

### Bootstrap Pipeline

```
Startup Sequence (BootstrapGraph):
  1. Top-level prefetch side effects     (prefetch.py)
  2. Warning handler + environment guard
  3. CLI parser + trust gate             (main.py)
  4. Setup + commands/agents parallel load (setup.py)
  5. Deferred init after trust           (deferred_init.py)
  6. Mode routing                        (remote_runtime.py, direct_modes.py)
  7. Query engine submit loop            (query_engine.py)
```

### Session Data Flow (Turn Loop)

```
User Prompt
  → PortRuntime.route_prompt()          (token scoring)
  → ExecutionRegistry                   (mirrored shims)
  → _infer_permission_denials()         (destructive check)
  → QueryEnginePort.submit_message()    (state update)
  → persist_session()                   (.port_sessions/{id}.json)
  → TurnResult                          (matched_commands, tools, denials, usage)
```

---

## 3. File-file Inti

### Orchestration Layer

| File | Fungsi |
|------|--------|
| `main.py` | CLI dispatcher — 15+ subcommands (summary, route, bootstrap, turn-loop, dll.) |
| `runtime.py` | `PortRuntime` — routing, session bootstrap, permission inference |
| `query_engine.py` | `QueryEnginePort` — state container, persistence, streaming events |
| `models.py` | Shared dataclasses: `Subsystem`, `PortingModule`, `PermissionDenial`, `UsageSummary` |

### Registry & Snapshot

| File | Fungsi |
|------|--------|
| `commands.py` | Load + search 207 commands dari snapshot JSON, execute shims |
| `tools.py` | Load + search 184 tools dari snapshot JSON, filter by permission |
| `execution_registry.py` | `ExecutionRegistry` — `MirroredCommand` + `MirroredTool` shims |
| `Tool.py` | `ToolDefinition` type + `DEFAULT_TOOLS` set |

### Setup & Bootstrap

| File | Fungsi |
|------|--------|
| `setup.py` | `WorkspaceSetup`, `SetupReport` — full startup sequence |
| `bootstrap_graph.py` | `BootstrapGraph` — define 7 bootstrap stages |
| `prefetch.py` | Parallel background tasks (project scan, keychain, MDM) |
| `deferred_init.py` | Trust-gated init — plugins/skills/MCP hanya aktif jika `trusted=True` |
| `system_init.py` | Generate system init message (command/tool counts, built-in names) |

### Graphs & Manifests

| File | Fungsi |
|------|--------|
| `port_manifest.py` | `PortManifest` — inventory workspace files + subsystem notes |
| `command_graph.py` | `CommandGraph` — kategorisasi command: builtin/plugin_like/skill_like |
| `tool_pool.py` | `ToolPool` — assembly dengan filters: simple_mode, include_mcp, permission_context |
| `parity_audit.py` | `ParityAuditResult` — compare Python workspace vs TypeScript archive |

### Runtime Modes

| File | Fungsi |
|------|--------|
| `remote_runtime.py` | Mode: remote, SSH, teleport — `RuntimeModeReport` |
| `direct_modes.py` | Mode: direct-connect, deep-link — `DirectModeReport` |

### Session & History

| File | Fungsi |
|------|--------|
| `session_store.py` | `StoredSession` — save/load ke `.port_sessions/{id}.json` |
| `transcript.py` | `TranscriptStore` — conversation history, compact, replay |
| `history.py` | `HistoryLog` — event tracking (context, routing, execution, turn) |

### UI & Formatting

| File | Fungsi |
|------|--------|
| `ink.py` | `render_markdown_panel()` — wrapped border output |
| `interactiveHelpers.py` | `bulletize()` — list → markdown bullets |
| `dialogLaunchers.py` | `DialogLauncher` — built-in dialogs: summary, parity_audit |
| `replLauncher.py` | `build_repl_banner()` — REPL banner (placeholder) |
| `QueryEngine.py` | `QueryEngineRuntime` extends `QueryEnginePort`, adds `route()` print |

### Utilities

| File | Fungsi |
|------|--------|
| `query.py` | `QueryRequest`, `QueryResponse` types |
| `cost_tracker.py` | `CostTracker` — record cost events per label |
| `costHook.py` | `apply_cost_hook()` utility |
| `permissions.py` | `ToolPermissionContext` — deny by name atau prefix |
| `context.py` | `PortContext` — workspace paths + file counts |
| `tasks.py` / `task.py` | `PortingTask` — 3 default porting tasks |
| `projectOnboardingState.py` | Onboarding tracking: has_readme, has_tests, python_first |

---

## 4. CLI Commands (main.py)

```bash
python3 -m src.main summary           # Markdown summary of workspace
python3 -m src.main manifest          # File inventory
python3 -m src.main parity-audit      # Compare Python vs TS archive
python3 -m src.main commands          # List mirrored commands
python3 -m src.main tools             # List mirrored tools
python3 -m src.main route "prompt"    # Route prompt → matched commands/tools
python3 -m src.main bootstrap "task"  # Full runtime session with context
python3 -m src.main turn-loop "task" --max-turns 3  # Multi-turn simulation
python3 -m src.main load-session <id> # Resume saved session
python3 -m src.main show-command <name>
python3 -m src.main show-tool <name>
python3 -m src.main exec-command <name> "prompt"
python3 -m src.main exec-tool <name> "payload"
python3 -m src.main remote-mode <target>
python3 -m src.main ssh-mode <target>
python3 -m src.main teleport-mode <target>
python3 -m src.main direct-connect-mode <target>
python3 -m src.main deep-link-mode <target>
```

---

## 5. QueryEngine — Core State Machine

### QueryEngineConfig

```python
max_turns: int = 8
max_budget_tokens: int = 2000
compact_after_turns: int = 12
structured_output: bool = False
structured_retry_limit: int = 2
```

### Methods Utama

| Method | Fungsi |
|--------|--------|
| `submit_message(prompt)` | Process prompt, update state, return `TurnResult` |
| `stream_submit_message(prompt)` | Yield streaming events |
| `persist_session()` | Save ke `.port_sessions/{session_id}.json` |
| `compact_messages_if_needed()` | Trim history jika melebihi `compact_after_turns` |
| `replay_user_messages()` | Resume dari transcript |
| `from_saved_session(stored)` | Reconstruct state dari disk |

### Streaming Events (stream_submit_message)

1. `message_start` — session ID + prompt
2. `command_match` — matched commands
3. `tool_match` — matched tools
4. `permission_denial` — denied tools
5. `message_delta` — output text
6. `message_stop` — usage + stop_reason

---

## 6. Permission System

### ToolPermissionContext

```python
deny_names: frozenset      # Block by exact name
deny_prefixes: tuple       # Block by prefix (e.g., "bash")
blocks(tool_name) → bool
from_iterables(names, prefixes) → ToolPermissionContext
```

### Trust Gating (deferred_init.py)

```
trusted=True  → plugin_init, skill_init, mcp_prefetch, session_hooks — semua aktif
trusted=False → semua disabled
```

### Permission Inference (runtime.py)

`_infer_permission_denials(prompt)` — deteksi operasi destruktif di prompt:
- Kata-kata seperti "bash", "exec", "delete", "rm" → deny tool terkait

---

## 7. Routing Engine (PortRuntime)

### Cara Kerja route_prompt()

```python
tokens = tokenize(prompt)  # lowercase, split, filter stopwords
for each command/tool in PORTED_COMMANDS + PORTED_TOOLS:
    score = count(token in name or responsibility)
return sorted by score, top N
```

Return: `list[RoutedMatch]` — `(kind, name, source_hint, score)`

---

## 8. Subsystem Packages (35 Packages)

Semua package adalah **placeholder** yang load metadata dari `reference_data/subsystems/{name}.json` via `_archive_helper.py`.

Setiap package expose:
- `ARCHIVE_NAME` — nama subsystem TypeScript asli
- `MODULE_COUNT` — jumlah modul TS yang diarsipkan
- `SAMPLE_FILES` — contoh file paths dari archive
- `PORTING_NOTE` — catatan human-readable

### Subsystem Terbesar

| Subsystem | Modules | Deskripsi |
|-----------|---------|-----------|
| `utils/` | 564 | Utility functions (array, shell, auth, api, rendering) |
| `components/` | 389 | React UI components |
| `services/` | 130 | Backend services (analytics, API, session memory) |
| `hooks/` | 104 | React hooks (notifications, permissions, suggestions) |
| `bridge/` | 31 | IDE bridge (REPL, session API) |
| `constants/` | 21 | Application-wide constants |
| `skills/` | 20 | Built-in skills (batch, loop, verify, simplify) |
| `cli/` | 19 | CLI transport & structured I/O |
| `keybindings/` | 14 | Keyboard binding parser |
| `migrations/` | 11 | Settings migrations across versions |
| `types/` | 11 | TypeScript type definitions |
| `memdir/` | 8 | Memory directory management |
| `entrypoints/` | 8 | SDK entry surfaces |
| `state/` | 6 | AppState & store management |
| `vim/` | 5 | Vim motions & operators |
| `remote/` | 4 | Remote session manager |
| `native_ts/` | 4 | Native modules (color-diff, file-index, yoga-layout) |
| `screens/` | 3 | UI screens (Doctor, REPL, Resume) |
| `server/` | 3 | Direct-connect session server |
| `buddy/` | 6 | UI companion sprite |
| `plugins/` | 2 | Plugin loading system |
| `upstreamproxy/` | 2 | Proxy relay |
| `voice/` | 1 | Voice mode detection |
| `assistant/` | 1 | Session history |
| `bootstrap/` | 1 | Bootstrap state |

---

## 9. Reference Data Snapshots

### archive_surface_snapshot.json

```json
{
  "archive_root": "archive/claude_code_ts_snapshot/src",
  "root_files": [18 TypeScript files],
  "root_dirs": [35 subsystem directories],
  "total_ts_like_files": 1902,
  "command_entry_count": 207,
  "tool_entry_count": 184
}
```

### commands_snapshot.json — 207 entries

Setiap entry:
```json
{
  "name": "add-dir",
  "source_hint": "commands/add-dir/add-dir.tsx",
  "responsibility": "..."
}
```

### tools_snapshot.json — 184 entries

Format sama dengan commands.

### subsystems/{name}.json

```json
{
  "archive_name": "original-ts-name",
  "package_name": "python_name",
  "module_count": 389,
  "sample_files": ["components/AlertDialog/index.ts", ...]
}
```

---

## 10. Design Patterns

### Immutable Dataclasses

Heavy use of `@dataclass(frozen=True)` untuk:
- Thread-safe values
- LRU caching aman
- Predictable state

### LRU Cached Snapshots

```python
@lru_cache(maxsize=1)
def load_command_snapshot() → list[dict]: ...

@lru_cache(maxsize=1)
def load_tool_snapshot() → list[dict]: ...
```

Dimuat sekali per process.

### Markdown-First Output

Semua tipe kompleks punya `.as_markdown()` atau equivalen. Memudahkan inspeksi dan reporting.

### Trust Gating Pattern

```python
def run_deferred_init(trusted: bool) -> DeferredInitResult:
    if trusted:
        return DeferredInitResult(
            trusted=True,
            plugin_init=True,
            skill_init=True,
            mcp_prefetch=True,
            session_hooks=True
        )
    return DeferredInitResult(trusted=False, ...)
```

### Parity Audit Pattern

```python
# 18 root TS files → Python equivalents
ARCHIVE_ROOT_FILES = {
    "main.ts": "main.py",
    "query.ts": "query_engine.py",
    ...
}

# 35 subsystem dirs
ARCHIVE_DIR_MAPPINGS = {
    "utils": "utils/",
    "components": "components/",
    ...
}
```

---

## 11. Yang Belum Diimplementasikan (Placeholders)

Fitur-fitur ini intentionally stubbed/simulated:

| Feature | Status |
|---------|--------|
| Actual command/tool execution | Mock message only |
| Interactive REPL | Placeholder banner |
| Deferred init | Just toggles booleans |
| Prefetch side effects | Returns dummy results |
| Remote/SSH/teleport modes | Mock reports |
| Plugin/skill loading | References only |
| MCP server integration | Referenced but not implemented |
| IDE bridge | `bridge/` package is placeholder |

---

## 12. Parity Status

Dari `parity_audit.py`:

```
archive_root_files: 18 TS files
mapped_to_python: partial (majority covered)

archive_dirs: 35 subsystems
python_packages: 35 packages (all covered as placeholders)

total_ts_files: 1,902
python_files: ~100+ (orchestration + placeholders)
```

Coverage yang sesungguhnya ada di metadata layer — semua 35 subsystem terwakili sebagai package, tapi implementasi aktual hanya ada di core orchestration files (~18 root files).

---

## 13. Relevansi untuk Jiku

Insight paling berguna dari `refs-claw-code/src/` untuk jiku:

### Plugin System
- `plugins/__init__.py` merepresentasikan 2 modul TS: plugin loader + registry
- Trust-gating pattern: plugin hanya aktif jika `trusted=True`
- Deferred init untuk lazy-load plugins setelah trust check

### Tool System
- 184 tools dengan metadata: `name`, `source_hint`, `responsibility`
- `ToolPermissionContext` — deny by name/prefix
- `filter_tools_by_permission_context()` — apply permission di tool listing
- `ToolPool` — assembly dengan filters (simple_mode, include_mcp)

### Session/Conversation
- JSONL-like persistence di `.port_sessions/`
- Compaction setelah N turns
- Streaming events dengan typed event names
- Resume dari saved session via `replay_user_messages()`

### Command Architecture
- 207 commands dengan categorization: builtin/plugin_like/skill_like
- `CommandGraph` untuk segmentasi berdasarkan source_hint
- Execute shims yang return structured result

### Bootstrap Sequence
- 7-stage bootstrap graph yang jelas
- Parallel prefetch untuk background tasks
- Mode routing (local/remote/ssh/teleport) sebagai distinct paths
