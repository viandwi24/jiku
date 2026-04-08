# CLAUDE.md

## Engineering Standards

- **NEVER ship half-baked features.** Every feature must be fully implemented end-to-end: backend, API, UI config, and properly wired into the running system. No dead code, no "wire it later", no "it works for now".
- **Production-grade always.** This is a production-scale system. Never take shortcuts with "yang penting jalan dulu" (just make it work for now). Every implementation must be configurable, properly integrated, and ready for real users.
- **No orphaned code.** If you create a file (service, utility, module), it MUST be imported and used by the system before you move on. Verify by searching for imports across the codebase.
- **Config over hardcode.** Features that depend on external services (API keys, model selection, providers) must have UI configuration — not hardcoded values or env-var-only fallbacks.
- **Verify integration.** After implementing a feature, verify it's actually running: check that imports exist, services are called, data flows end-to-end. Don't just write code and assume it works.

---

## Tech Stack

- **Runtime:** Bun
- **Language:** TypeScript
- **Package Manager:** Bun (`bun install`, `bun add`, `bun run`)
- **Monorepo:** `package.json` workspaces — packages live under a `packages/` directory (or similar), managed by Bun's workspace resolver

> Always use `bun` instead of `node`, `npm`, `npx`, or `yarn` for any command.

---

## UI Components

- **Always use components from `@jiku/ui` first** — it wraps shadcn/ui. Check there before writing any custom component.
- Only build a custom component if `@jiku/ui` genuinely does not have what you need.
- Import pattern: `import { Button, Input, Tabs, ... } from '@jiku/ui'`

---

## TypeScript Rules

- **No dynamic `import()` type expressions inside function bodies or signatures.** All imports must be at the top of the file as static `import` statements.
  - ❌ `provide: <K extends keyof import('@jiku/types').Foo>(...)` — wrong
  - ✅ Add `import type { Foo } from '@jiku/types'` at the top, then use `Foo` directly
- The only exception is runtime lazy loading (e.g. dynamic plugin discovery from filesystem), where `import()` is intentional and load-time matters.
- **No `any`.** Use proper types, generics, or `unknown` with narrowing.

---

## Bash Scope

- **Never execute bash commands outside this codebase.** All shell commands must be scoped to `/Users/viandwi24/projects/self/jiku/` and its subdirectories.
- Do not create temp files in `/tmp` or anywhere outside the project root.

## Environment Files

- **Never read `.env` files.** Use `.env.example` files only for understanding required environment variables.
- If you need the DB connection string or other secrets, ask the user or refer to `.env.example`.

---

## Project Context — Read These First

Before making any changes, always read the relevant docs:

| File | Purpose |
|------|---------|
| `docs/product_spec.md` | What the product is, goals, target users |
| `docs/architecture.md` | System architecture, packages, tech decisions |
| `docs/builder/current.md` | What is actively being worked on right now |
| `docs/builder/tasks.md` | Backlog and planned work |
| `docs/builder/memory.md` | Persistent context, conventions, gotchas |
| `docs/builder/decisions.md` | Architectural and product decisions log |
| `docs/builder/changelog.md` | History of completed changes |

Feature-specific docs live in `docs/feats/`:
- Each file covers one feature domain: what it does, its public API, known limitations, related files.

---

## Automated Docs Protocol

You must maintain these docs automatically as part of every task. The rules below define when and where to write.

---

### docs/builder/current.md — Active Work & Context Recovery

`current.md` is **persistent working memory**. Its primary function is not just a status tracker — it is a **context recovery point**. After context compaction or a new session, read this file first to immediately know what is being worked on, which files are relevant, and what temporary decisions have been made.

**Update BEFORE starting a task:** Fill in the phase, goal, active tasks, relevant files, and important context.  
**Update AFTER finishing or pausing:** Move temporary decisions to `decisions.md`, check off the checklist, update "Next Up".

When opening a new session or after compaction:
1. Read `current.md` first.
2. Resume from the "Currently Working On" and "Important Context" sections.
3. Do not start from scratch if context is still relevant.

**When to update:**
- Starting any new task (trivial or not)
- Switching focus to another area
- Hitting a blocker
- Making a temporary decision not yet in `decisions.md`
- Finishing something

**Suggested structure:**
```markdown
## Phase
<current phase name or goal>

## Currently Working On
- <active task with brief context>

## Relevant Files
- <file path> — <why it matters>

## Important Context / Temporary Decisions
- <anything that should not be lost between sessions>

## Next Up
- <what comes after the current task>
```

---

### docs/builder/tasks.md — Backlog

**When to update:**
- User requests a new feature or fix that can't be done immediately.
- You discover something that needs to be done later while working.
- A task is completed (mark done or remove it).

**Format:** checklist with short context per item.

```markdown
## Backlog

- [ ] <task> — <short context>
- [ ] <task> — <short context>

## Done

- [x] <task> — completed YYYY-MM-DD
```

---

### docs/builder/changelog.md — Done Log

**Update after every completed change.** One entry per session or per meaningful change. Include: date, what changed, which files were touched.

**Format:**
```markdown
## YYYY-MM-DD — <short title>

- <what changed>
- Files: `<file1>`, `<file2>`
```

---

### docs/builder/decisions.md — Decision Log

**When to update:**
- A non-obvious architectural or product decision is made.
- A library or pattern is chosen over an alternative.
- A tradeoff is accepted consciously.

**Format:**
```markdown
## ADR-NNN — <title>

**Context:** <why this decision was needed>  
**Decision:** <what was decided>  
**Consequences:** <tradeoffs, future implications>
```

---

### docs/builder/memory.md — Persistent Context

**When to update:**
- You learn a convention or pattern specific to this codebase.
- You find a gotcha or non-obvious behavior.
- The user clarifies something that should always be remembered.

**Read at the start of every session** — this is the source of truth for accumulated project knowledge.

**Format:**
```markdown
## <topic>

<short description of the convention, gotcha, or clarification>
```

---

### docs/feats/*.md — Feature Scope

**When to update:**
- A new feature domain is introduced.
- A feature's API, behavior, or scope changes significantly.

**Each file should describe:**
- What the feature does
- Its public API or interface
- Known limitations
- Related files

---

### docs/architecture.md and docs/product_spec.md

Update only when the architecture or product direction meaningfully changes. These are stable reference docs, not frequently updated.
