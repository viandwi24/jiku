# Automated Docs — AI Builder Infrastructure

> How Jiku maintains living documentation automatically via AI coding assistants. This system ensures context survives across sessions, decisions are logged, and no knowledge is lost to context window limits.

---

## Overview

Jiku uses a structured documentation protocol that AI coding assistants (Claude Code, Cursor, etc.) follow automatically. The system has three layers:

1. **`CLAUDE.md`** — Root instruction file. Defines engineering standards, tech stack rules, and the docs protocol itself. Loaded into every AI session as project context.
2. **`docs/builder/`** — Living working memory. Five files that the AI reads at session start and updates during/after every task.
3. **`.claude/commands/`** — Slash commands for manual triggers (e.g., `/docs-update` to force a full docs sync).

The goal: an AI assistant opening a fresh session on this codebase can read `current.md` + `memory.md` and immediately know what was being worked on, what conventions apply, and what decisions were made — without re-reading the entire codebase.

---

## File Map

```
CLAUDE.md                         # Root instructions (always loaded)
docs/
  product_spec.md                 # What the product is, goals, target users
  architecture.md                 # System architecture, packages, tech decisions
  technical-reference.md          # Deep architecture reference for external devs
  builder/                        # AI builder working memory (5 files)
    current.md                    #   Active work + context recovery
    tasks.md                      #   Backlog + done list
    changelog.md                  #   Completed changes log
    decisions.md                  #   Architecture Decision Records (ADRs)
    memory.md                     #   Persistent conventions, gotchas, patterns
  feats/                          # Per-feature reference docs
    plugin-system.md
    connectors.md
    sandbox.md
    commands.md
    ... (one per feature domain)
  plans/                          # Implementation plans (numbered)
    26-sandbox.md
    25-action-request-center.md
    24-telegram-userbot-mtproto.md
    ...
  scenarios/                      # User journey test scripts
    1-manage-a-channel-with-agent.md
.claude/
  commands/
    docs-update.md                # Slash command: force full docs sync
```

---

## Layer 1: `CLAUDE.md` — Root Instructions

The root `CLAUDE.md` is automatically loaded by Claude Code at the start of every session. It contains:

### Engineering Standards
Rules the AI must follow for every change:
- **Never ship half-baked features** — end-to-end: backend, API, UI, wired into running system
- **No orphaned code** — every created file must be imported and used
- **Config over hardcode** — external dependencies get UI config, not env-var fallbacks
- **Verify integration** — after implementing, verify imports exist and data flows end-to-end

### Tech Stack Rules
- Runtime/package manager constraints (Bun, not Node/npm/yarn)
- UI component library preference (`@jiku/ui` first)
- TypeScript rules (no `any`, no dynamic `import()` in signatures)

### Project Context Map
A table directing the AI to read specific docs before making changes:

```markdown
| File | Purpose |
|------|---------|
| docs/product_spec.md | What the product is, goals, target users |
| docs/architecture.md | System architecture, packages, tech decisions |
| docs/builder/current.md | What is actively being worked on right now |
| docs/builder/tasks.md | Backlog and planned work |
| docs/builder/memory.md | Persistent context, conventions, gotchas |
| docs/builder/decisions.md | Architectural and product decisions log |
| docs/builder/changelog.md | History of completed changes |
```

### Automated Docs Protocol
The core of the system — rules for WHEN and HOW to update each doc file. Embedded directly in `CLAUDE.md` so the AI sees them on every session.

---

## Layer 2: `docs/builder/` — Living Working Memory

Five files, each with a distinct purpose. The AI reads them at session start and updates them as part of every task.

### `current.md` — Active Work & Context Recovery

**Primary function**: Context recovery point. After context compaction (long sessions where older messages are summarized) or a new session, the AI reads this file FIRST to know exactly where to resume.

**When to update**:
- Before starting any task
- When switching focus
- When hitting a blocker
- When making a temporary decision
- After finishing something

**Structure**:
```markdown
## Phase (YYYY-MM-DD) — <title> [status]

<what was done, key files, deploy notes>

## Phase (YYYY-MM-DD) — <title> [status]

<older completed phases stack below>
```

**Key behavior**: Phases stack reverse-chronologically (newest on top). Each phase is self-contained — an AI reading just that block can understand what happened and what files matter. Includes:
- What changed and why
- Files touched (with paths)
- Deploy checklist (migrations, bun install, env vars)
- Known limitations and follow-ups

**Real example** (truncated):
```markdown
## Phase (2026-04-16) — Plan 26 Sandbox: `jiku.code-runtime` plugin + `run_js` tool

Shipped Plan 26 end-to-end. System-scoped plugin registering `run_js` tool...
Three source modes: code / path / prompt...

### Core change (Phase 0, prerequisite)
New `LLMBridge` interface in `packages/types/src/index.ts`...

### Files
- `packages/types/src/index.ts` — `LLMBridge`, `RuntimeContext.llm?`
- `packages/core/src/runner.ts` — `generateText` import, `llmBridge`
- `plugins/jiku.code-runtime/` — new plugin (10 files)
...

### Deploy checklist
1. `bun install` to fetch `quickjs-emscripten`
2. Plugin is system-scoped — no migration needed
...
```

---

### `tasks.md` — Backlog

**Purpose**: Track work that can't be done immediately. Grouped by feature area.

**When to update**:
- User requests something that's deferred
- AI discovers follow-up work during implementation
- Task is completed (mark done)

**Structure**:
```markdown
## Backlog

### <feature area> follow-ups
- [ ] <task> — <short context>
- [ ] <task> — <short context>

### <another area>
- [ ] <task>

## Done
- [x] <task> — completed YYYY-MM-DD
```

**Key behavior**: Tasks are grouped by plan/feature area (e.g., "Plan 26 follow-ups", "Streaming adapter follow-ups"). This prevents a flat list that becomes unmanageable. Each task has inline context so future-AI understands it without reading the full conversation.

---

### `changelog.md` — Done Log

**Purpose**: Chronological record of every completed change. Primary audit trail.

**When to update**: After every completed change (not deferred — done).

**Structure**:
```markdown
## YYYY-MM-DD — <short title>

<detailed description of what changed, why, and how>

Files: `path/to/file1`, `path/to/file2`
```

**Key behavior**: Entries are detailed enough to reconstruct what happened months later. Include:
- Root cause (for bug fixes)
- Design rationale (for features)
- Files touched
- Deploy notes if applicable
- Follow-ups identified during the work

---

### `decisions.md` — Architecture Decision Records

**Purpose**: Log non-obvious architectural and product decisions with context and consequences.

**When to update**:
- A library or pattern is chosen over an alternative
- A tradeoff is accepted consciously
- A design boundary is established

**Structure** (ADR format):
```markdown
## ADR-NNN — <title>

**Context:** <why this decision was needed>
**Decision:** <what was decided>
**Consequences:** <tradeoffs, future implications>
```

**Key behavior**: ADRs are numbered sequentially. They capture the WHY, not just the WHAT. A future developer (or AI) reading an ADR should understand:
1. What problem was being solved
2. What alternatives were considered
3. Why this option was chosen
4. What trade-offs were accepted

**Real example**:
```markdown
## ADR-104 — `RuntimeContext.llm` as the canonical LLM bridge

**Context:** Plan 26 needs tool handlers to call an LLM inside execute().
Two shapes considered: (a) plugin dependency injection, (b) bridge on RuntimeContext.

**Decision:** Bridge on RuntimeContext.llm. Runner constructs it per-run,
bound to agent's model. Plugins call ctx.runtime.llm.generate().

**Consequences:**
- Inheritance by default (agent's model)
- Tools decoupled from provider SDKs
- Optional field — plugins guard with if (!ctx.runtime.llm) throw
- Rejected "depends" approach: duplicates what runner already has
```

---

### `memory.md` — Persistent Conventions & Gotchas

**Purpose**: Accumulated project knowledge that applies across ALL sessions. Not tied to any specific task.

**When to update**:
- A convention or pattern specific to this codebase is discovered
- A non-obvious behavior or gotcha is found
- A user clarifies something that should always be remembered

**Structure**:
```markdown
## <topic>

<short description of the convention, gotcha, or clarification>
```

**Key behavior**: Each entry is self-contained — a future AI reads it and immediately knows the rule. Entries include WHY so edge cases can be judged. Read at the start of EVERY session.

**Real examples**:
```markdown
## Plugin tools get `project_id` via `toolCtx.runtime['project_id']`, NOT via `caller.user_data.project_id`

`CallerContext.user_data` is for user profile. Runner injects `project_id` into
RuntimeContext directly. Plugins reading `caller.user_data.project_id` get undefined.

## Drizzle schema must mirror migration ALTER TABLE

When a migration adds a column, the schema/*.ts file MUST be updated too.
Drizzle silently drops unknown fields → empty SET clause → Postgres syntax error.

## mtcute v0.27 `sendText` `replyTo` must be a plain NUMBER, never a plain object

Passing {messageId, threadId} crashes at send-common.js:27. Use replyTo: Number(msgId).
```

---

## Layer 3: `.claude/commands/` — Manual Triggers

### `/docs-update` Command

A slash command that forces a full documentation sync. When invoked:

1. Reads all 5 builder docs + relevant feat docs
2. Scans conversation context for completed work
3. Updates each file following the protocol
4. Reports what was updated

**When to use**: End of a long session, or when the AI forgot to update docs mid-task. Safety net — the protocol is designed to be automatic, but this command catches gaps.

**File**: `.claude/commands/docs-update.md`

---

## Supporting Docs

### `docs/feats/*.md` — Feature Reference

One file per feature domain. Not part of the automated protocol (rarely auto-updated) but referenced during implementation.

**Structure**:
```markdown
# Feature Name

<what it does>

## Architecture
<key files, data flow>

## API / Interface
<public surface>

## Known Limitations
<gaps, follow-ups>

## Related Files
<file paths>
```

**Current feature docs**: plugin-system, connectors, console, commands, sandbox, chat, memory, persona, browser, filesystem, action-request, permission-policy, cron-tasks, agent-adapters, etc.

### `docs/plans/*.md` — Implementation Plans

Numbered plans for multi-phase features. Created BEFORE implementation starts. Serve as the "blueprint" that the AI follows.

**Naming**: `<number>-<slug>.md` (e.g., `26-sandbox.md`, `24-telegram-userbot-mtproto.md`)

**Typical structure**: Goal, non-goals, data model, phases, open questions, risks, success criteria.

**Key behavior**: Plans are living during implementation (open questions get resolved, phases get checked off) but become historical artifacts once shipped. The changelog captures the final state.

### `docs/product_spec.md` & `docs/architecture.md`

Stable reference docs. Updated only when the product direction or architecture meaningfully changes. The AI reads them at session start for high-level orientation.

---

## How It Works In Practice

### Session Start
```
AI opens session → reads CLAUDE.md (auto-loaded)
  → reads docs/builder/current.md (knows active work)
  → reads docs/builder/memory.md (knows conventions)
  → optionally reads relevant docs/feats/*.md
  → ready to work
```

### During Work
```
AI starts a task → updates current.md (phase, files, context)
AI makes a decision → adds ADR to decisions.md
AI learns a gotcha → adds entry to memory.md
AI discovers follow-up → adds task to tasks.md
```

### Session End
```
AI finishes work → updates current.md (mark done, next up)
  → adds changelog.md entry (what changed, files)
  → moves temp decisions from current.md to decisions.md
  → optionally updates docs/feats/*.md
```

### Context Recovery (new session or after compaction)
```
AI reads current.md → knows exactly where to resume
  "Phase: Plan 26 Sandbox, Currently: Phase 4 tool wiring"
  → reads relevant files listed in current.md
  → continues from where it left off
```

---

## Design Principles

1. **Files over conversation memory**: Conversation context gets compacted/lost. Files persist. Everything important goes to a file.

2. **Self-contained entries**: Each changelog entry, ADR, memory note, and current.md phase can be understood in isolation. No "see above" references.

3. **Automatic, not manual**: The protocol is embedded in `CLAUDE.md` so the AI follows it by default. `/docs-update` is a safety net, not the primary mechanism.

4. **Read-first protocol**: Before writing any code, the AI reads the relevant docs. Before writing any docs, the AI reads the current state. This prevents overwrites and ensures consistency.

5. **Separation of concerns**: `current.md` = working memory (volatile). `memory.md` = long-term knowledge (stable). `changelog.md` = history (append-only). `decisions.md` = rationale (append-only). `tasks.md` = queue (mutable).

6. **Context recovery over summarization**: `current.md` is NOT a summary of the session. It's a recovery point — enough detail that a fresh AI can pick up exactly where the previous session left off, including which files are open, what decisions are pending, and what the next step is.

---

## Adopting This System

To adopt this for your own project:

1. **Create `CLAUDE.md`** at repo root with your engineering standards + the docs protocol section (copy the "Automated Docs Protocol" section from Jiku's CLAUDE.md).

2. **Create `docs/builder/`** with 5 empty files: `current.md`, `tasks.md`, `changelog.md`, `decisions.md`, `memory.md`.

3. **Create `.claude/commands/docs-update.md`** with the sync command (copy from Jiku's).

4. **Seed `memory.md`** with any existing conventions your team knows but hasn't written down.

5. **Start working**. The AI will maintain the docs automatically as long as the protocol is in `CLAUDE.md`.

**Minimum viable version**: Just `CLAUDE.md` + `docs/builder/current.md` + `docs/builder/memory.md`. These two files alone solve 80% of the context recovery problem. Add the others as your project grows.
