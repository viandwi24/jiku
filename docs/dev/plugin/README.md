# Plugin development

Everything needed to write, build, and ship a Jiku plugin — from scaffold to production.

## Quick start

```bash
# scaffold a new plugin
bun run jiku plugin create jiku.hello

# build its UI bundle
bun run jiku plugin build jiku.hello

# watch + auto-rebuild while developing
bun run jiku plugin watch

# interactive TUI (arrow nav · b build · w watch · r refresh · q quit)
bun run jiku
```

Server auto-discovers the new plugin on restart. Enable it per project via **Studio → Plugins**.

## Contents

| File | What's inside |
|---|---|
| [`overview.md`](./overview.md) | **Start here.** What a plugin is, directory layout, minimal end-to-end example, gateway + isolation model. |
| [`context-api.md`](./context-api.md) | Full `ctx.*` reference — `api`, `tools`, `storage`, `ui`, `studio.api`, `events`, `permissions`, `log`. |
| [`slots.md`](./slots.md) | Slot contract table — where your component can mount + the props it receives. |
| [`cli.md`](./cli.md) | `jiku` CLI reference — `list` / `info` / `build` / `watch` / `create`, plus the Ink TUI. |
| [`security.md`](./security.md) | Signed URLs, rate limits, secret-handling rules, operator setup. **Read before shipping.** |

## Recommended reading order

1. **`overview.md`** — understand the architecture, get a plugin rendering.
2. **`slots.md`** — pick the slot that matches your UI shape (page, sidebar item, settings section, dashboard widget…).
3. **`context-api.md`** — find the `ctx.*` surface you need (HTTP-backed queries, tool invocation, host API passthrough, toasts, etc.).
4. **`cli.md`** — tighten the dev loop with the `jiku` CLI or its TUI.
5. **`security.md`** — before exposing anything real: what NOT to put in a bundle, what auth guarantees you get, how the operator hardens production.

## Key concepts in one minute

- **Isolation** — your plugin is a self-contained ESM bundle (built with tsup). It carries its own React. A crash or type error inside your plugin cannot break Studio's build or its React tree.
- **Gateway** — server scans `plugins/` at boot and auto-registers every folder. No edits to Studio when you add a plugin.
- **Studio host anchor** — depend on `StudioPlugin` from `@jiku-plugin/studio` to get typed `ctx.http` / `ctx.events` / `ctx.connector` server-side. Use `StudioComponentProps` for typed `ctx.studio.api` in UI components. No module augmentation — the plugin system's native `contributes`/`depends` does it.
- **Signed URLs** — asset bundles are served with short-lived HMAC signatures. The bundle is public-readable by any authed Studio user, so **never embed secrets**.

## Related docs

- Feature-level reference: [`../../feats/plugin-ui.md`](../../feats/plugin-ui.md)
- Plan 17 implementation report: [`../../plans/impl-reports/17-plugin-ui-implementation-report.md`](../../plans/impl-reports/17-plugin-ui-implementation-report.md)
- Other developer topics: [`../README.md`](../README.md)
