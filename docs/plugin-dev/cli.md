# Jiku CLI

`jiku` is the developer CLI for this workspace — a single binary for plugin ops, with placeholders reserved for future `agent`, `db`, and `dev` namespaces.

- Source: `apps/cli/`
- Binary name: `jiku`
- Stack: **commander** (command parsing) + **Ink** (interactive TUI) + **tsup** (plugin builds).

## Running

```bash
# from anywhere in the workspace
bun run jiku                 # interactive TUI (default)
bun run jiku plugin list
bun run jiku plugin build jiku.analytics
```

Or link the binary for a shorter path:

```bash
bun link apps/cli            # optional
jiku plugin list
```

## Plugin commands (fase 1)

| Command | What it does |
|---|---|
| `jiku plugin list [--json]` | List every plugin in `plugins/` with UI entry count + build status. |
| `jiku plugin info <id>` | Show the manifest (meta, UI entries, module paths, assetsDir). |
| `jiku plugin build [id]` | Build a plugin UI bundle via tsup. Resolution when `id` is omitted: if cwd is inside a plugin folder → build that one; otherwise build all plugins. |
| `jiku plugin watch [id]` | Spawn tsup in watch mode. Same cwd-aware resolution as `build`. |
| `jiku plugin create <id> [-n name]` | Scaffold a new plugin folder under `plugins/<id>/` with package.json, tsup config, tsconfig, `src/index.ts`, `src/ui/Dashboard.tsx`. |

### Interactive TUI

`jiku` (no args) launches an Ink-based TUI:

- `↑ / ↓` — navigate plugin list
- `b` — build the selected plugin
- `w` — toggle watch mode on/off for the selected plugin
- `r` — refresh the list (re-runs discovery)
- `q` / `Esc` — quit (also stops any watchers started here)

Status column: `ui:N` (entry count), `built` / `unbuilt`, `watching` / `building`.

## Reserved namespaces

Present in `--help` as coming-soon stubs so the command tree is stable:

- `jiku agent list|run` — agent ops
- `jiku db push|studio|seed` — wrap drizzle scripts
- `jiku dev doctor` — workspace diagnostics

Each stub currently exits with code 2 and a TODO note.

## Isolation

`apps/cli/` is a standalone workspace package. It depends on `@jiku/core` (for `discoverPluginsFromFolder`) and `@jiku/types` only. **No runtime code in `apps/studio/server` or `apps/studio/web` depends on `apps/cli/`**, and Next.js never bundles it. This keeps the CLI free to pull in Node-only / dev-only deps (tsup, Ink, commander) without any risk of leaking them into the client bundle.
