# PluginContext (`ctx`) — API reference

Each plugin component receives `ctx` (via `usePluginContext()` or as a prop).
Locked at **apiVersion 1**; adds within the major are non-breaking.

## Identity

- `ctx.plugin` — `{ id, version }`
- `ctx.project` — `{ id, slug, name }`
- `ctx.agent?` — only in agent slots
- `ctx.conversation?` — only in chat slots
- `ctx.user` — `{ id, role }`

## `ctx.api` — plugin-defined HTTP

All calls are namespaced to `/api/plugins/<plugin-id>/api/*`. The plugin must
have registered a matching handler via `ctx.http?.get(...)`.

- `ctx.api.query<T>(op, input?)` → `Promise<T>`
- `ctx.api.mutate<T>(op, input?)` → `Promise<T>`
- `ctx.api.stream<T>` — **not yet implemented** (use `ctx.events` for now)

For reactive fetching inside plugin components, use `usePluginQuery` /
`usePluginMutation` from `@jiku/kit/ui` — those are implemented with plain
`useState`+`useEffect` so they work with your plugin's own bundled React.

## `ctx.studio` — Studio host API passthrough

Direct access to Studio's REST API as the current user. Use this when you need
data Studio owns (agents, projects, conversations, memory, filesystem) — not
just the plugin's own namespace.

```ts
ctx.studio.api.get<T>(path)           // GET
ctx.studio.api.post<T>(path, body?)   // POST
ctx.studio.api.put<T>(path, body?)    // PUT
ctx.studio.api.patch<T>(path, body?)  // PATCH
ctx.studio.api.delete<T>(path)        // DELETE
ctx.studio.baseUrl                    // e.g. http://localhost:3001 — for raw URLs (SSE, images)
```

Example:

```ts
const ctx = usePluginContext()
const { data } = usePluginQuery<{ agents: Agent[] }>(ctx, 'none', undefined)
// or directly:
const res = await ctx.studio.api.get<{ agents: Agent[] }>(`/api/projects/${ctx.project.id}/agents`)
```

All requests carry the current user's auth token. Every endpoint you can call
in Studio's own UI is reachable here.

## `ctx.tools`

- `ctx.tools.list({ plugin? })` — tools resolvable for the current project
- `ctx.tools.invoke<T>(toolId, input)` — invoke a tool as the current user.
  `toolId` may be the prefixed form (`<plugin>:<tool>`) or bare. Audit-logged.

## `ctx.storage`

Per-plugin × per-project KV (backed by the existing `plugin_kv` table with scope = plugin id).

- `get<T>(key)`
- `set<T>(key, value)`
- `delete(key)`
- `list(prefix?)`

## `ctx.ui`

- `ctx.ui.toast({ title, description?, variant? })`
- `ctx.ui.confirm({ title, description?, destructive? })` — returns `boolean`
- `ctx.ui.navigate(to)` — host router
- `ctx.ui.openPluginPage(pluginId, subPath?)`
- `ctx.ui.theme` — `{ mode: 'light' | 'dark', tokens }`

## `ctx.permissions`

- `ctx.permissions.has(perm)`
- `ctx.permissions.require(perm)` — throws `PluginPermissionError`

## `ctx.events`

Client-side SSE subscribe happens at the provider layer. `ctx.events.emit` from
a plugin UI does not cross the server — it's for in-page coordination only.
To emit from the server side, call `ctx.events?.emit(topic, payload, { projectId })`
from within an HTTP handler or lifecycle hook.

## `ctx.files` / `ctx.secrets`

Stubs landed; wiring to the filesystem service and credentials vault is **deferred**
to a follow-up — calls currently return empty/throw.

## `ctx.log`

`info | warn | error` — forwards to the browser console with `[plugin:<id>]`
prefix. Server-side structured telemetry lives under `ctx.http` handlers.
