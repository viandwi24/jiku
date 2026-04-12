# Plugin UI — Security notes

## Threat model

Plugin UI bundles (`plugins/<id>/dist/ui/*.js`) are loaded by the browser via dynamic `import()`. Because that import can't send an `Authorization` header, the asset endpoint handles auth via **signed URLs** instead of Bearer tokens.

## Controls in place

| Control | Implementation |
|---|---|
| **Signed URL** | `/api/plugins/ui-registry` (authed) mints a short-lived HMAC over `(pluginId, file, exp)` using `JWT_SECRET`. Asset router verifies before serving. TTL: 10 minutes. Token is bound to a specific file, can't be reused elsewhere. |
| **Rate limit** | In-memory per-IP limiter on the asset router: 120 req/min. Returns `429` with `Retry-After`. |
| **Path traversal guard** | Resolved path must start with the plugin's `assetsDir`; otherwise `403`. |
| **Production sourcemap gate** | When `NODE_ENV=production`, `.map` files return `404`. In dev, `.map` is served unsigned so DevTools can fetch it (still rate-limited). |
| **`X-Content-Type-Options: nosniff`** | Browser can't be tricked into executing mis-typed assets. |
| **`Cross-Origin-Resource-Policy: cross-origin`** | Explicit opt-in for ESM cross-origin loading; consistent with the CORS policy. |
| **Conservative cache (`max-age=60`)** | Short enough that expired signatures rotate quickly; long enough to skip repeat fetches. |

## What is NOT protected

- **Bundle contents are readable by any authed Studio user.** The signed URL proves "a registry fetch happened recently" — it does not encode per-user ACL. If plugin A contains content that plugin B's users shouldn't see, you cannot rely on the asset endpoint for that. (Move sensitive logic to `ctx.api`-handled server code instead — those routes ARE authed per-user.)
- **Secrets embedded at build time**. `process.env.SOMETHING` inlined into the bundle is readable by anyone who can fetch the URL. **Never put secrets in plugin UI source.**
- **DDoS at network layer**. Rate limit is per-IP in-memory; deploy behind a reverse proxy / CDN with its own limiter for real-world hardening.

## Do-not-do checklist for plugin authors

- [ ] Do **not** reference `process.env.*` in `src/ui/*.tsx`. If you need a config value, thread it through `ctx.storage` or a `ctx.http?.get` handler that returns it filtered for the current user.
- [ ] Do **not** hardcode API keys, webhook URLs, tenant IDs. Server code in `src/index.ts` can safely use env; UI cannot.
- [ ] Do **not** bundle test utilities, debug logging, or comments that reference internal infra.
- [ ] Do use `ctx.tools.invoke(...)` / `ctx.api.mutate(...)` for any server-mutating action — those go through authed routes.

## For operators

- Set `JWT_SECRET` to a strong, random value in production.
- Set `NODE_ENV=production` so `.map` serving is disabled.
- Deploy Studio server behind a reverse proxy with its own rate limiter if exposed to the public internet.
- Monitor `[plugin-assets]` log lines — unusually high 401 rates may indicate enumeration / token replay attempts.

## Future hardening (Plan 18 — third-party plugins)

Current controls are sufficient for **first-party bundled plugins**. Third-party plugins will additionally need:

- Signed manifest + per-plugin publisher keys.
- Bundle SRI hashes.
- iframe + origin isolation for untrusted authors.
- Per-plugin CSP tightening.
- Per-user permission grants at install time (currently gated only by `plugins:write`).
