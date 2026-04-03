# Update Docs

Scan the current conversation context and update all relevant documentation files. Follow these rules precisely:

## Step 1 — Read current state

Read these files before writing anything:
- `docs/builder/current.md`
- `docs/builder/tasks.md`
- `docs/builder/changelog.md`
- `docs/builder/decisions.md`
- `docs/builder/memory.md`
- Any `docs/feats/*.md` files that are relevant to what was worked on

## Step 2 — Determine what was done in this session

Based on the conversation history, identify:
- What features, fixes, or refactors were completed
- Which files were modified
- Any architectural or product decisions made
- Any new conventions, gotchas, or patterns learned

## Step 3 — Update docs/builder/current.md

Check if the work done in this session matches what is currently tracked in `current.md`:
- **If it matches**: update progress — check off completed items, update "Sedang Dikerjakan", move confirmed decisions to `decisions.md`.
- **If it does NOT match**: do NOT overwrite current.md's active task. Only update if the previous task is also done.
- **If current.md is idle/empty**: fill it in with what was just worked on.

## Step 4 — Update docs/builder/changelog.md

Add an entry for every meaningful change. Format:
```
## YYYY-MM-DD — <short title>
**Changed:** <what changed and why>
**Files touched:** `path/to/file`
```

## Step 5 — Update docs/builder/tasks.md
- Move completed tasks to "Done"
- Add new tasks to "Backlog"

## Step 6 — Update docs/builder/decisions.md
Add ADR entries for any non-obvious architectural decisions. Format:
```
## ADR-NNN — <title>
**Context:** ...
**Decision:** ...
**Consequences:** ...
```

## Step 7 — Update docs/feats/*.md
For any feature domain worked on, update the relevant feat file. Create a new one if the domain is new.

## Step 8 — Update docs/builder/memory.md
Add any new conventions, gotchas, or patterns learned.

---
After all updates are done, briefly summarize what was updated and why.