// Plan 17 — plugin UI asset serving, hardened.
//
// Route:  GET /api/plugins/:id/ui/<file>?sig=<hmac>&exp=<epoch>
//
// Auth model: browser dynamic `import()` can't send Authorization headers, so
// the URL itself carries a short-lived HMAC signature minted by the authed
// ui-registry endpoint (see plugins/ui/signer.ts). A lifted signature bound
// to (pluginId, file, exp) cannot be reused for another asset nor used past
// `exp`.
//
// Additionally:
//   • Simple in-memory IP rate limiting (casual DoS guard).
//   • Production mode refuses to serve .map files.
//   • Path-traversal safe (resolve + prefix check).

import { Router } from 'express'
import { createReadStream, statSync } from 'node:fs'
import { join, normalize, resolve as pathResolve, sep } from 'node:path'
import { runtimeManager } from '../runtime/manager.ts'
import { verifyAsset } from '../plugins/ui/signer.ts'

const router = Router()

const ASSET_RX = /^\/plugins\/([^/]+)\/ui\/(.+)$/
const IS_PROD = process.env['NODE_ENV'] === 'production'

// ─── Simple fixed-window IP rate limiter ─────────────────────────────────────

const RATE_WINDOW_MS = 60_000    // 1 minute
const RATE_MAX_REQUESTS = 120    // per IP per window

interface Bucket { count: number; resetAt: number }
const buckets = new Map<string, Bucket>()

function rateLimitOk(ip: string): boolean {
  const now = Date.now()
  const b = buckets.get(ip)
  if (!b || now >= b.resetAt) {
    buckets.set(ip, { count: 1, resetAt: now + RATE_WINDOW_MS })
    return true
  }
  if (b.count >= RATE_MAX_REQUESTS) return false
  b.count += 1
  return true
}

// Periodic sweep — removes stale buckets so the map doesn't grow unbounded.
setInterval(() => {
  const now = Date.now()
  for (const [ip, b] of buckets) {
    if (b.resetAt <= now) buckets.delete(ip)
  }
}, 5 * 60_000).unref?.()

// ─── Middleware ──────────────────────────────────────────────────────────────

router.use((req, res, next) => {
  if (req.method !== 'GET' && req.method !== 'HEAD' && req.method !== 'OPTIONS') return next()
  const m = req.path.match(ASSET_RX)
  if (!m) return next()

  // CORS preflight — dynamic import() cross-origin in dev (:3000 → :3001).
  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Origin', '*')
    res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS')
    res.setHeader('Access-Control-Allow-Headers', '*')
    res.status(204).end()
    return
  }

  // Rate limit (per client IP).
  const ip = (req.ip ?? req.socket.remoteAddress ?? 'unknown')
  if (!rateLimitOk(ip)) {
    res.setHeader('Retry-After', '60')
    res.status(429).json({ error: 'Too many requests' })
    return
  }

  const pluginId = m[1]!
  const rawFile = m[2]!

  // Production: no source maps. Cheap win — avoids exposing original TS comments.
  if (IS_PROD && rawFile.endsWith('.map')) {
    res.status(404).json({ error: 'Not found' })
    return
  }

  // Verify signed URL. Exception: `.map` files in dev mode are fetched by
  // DevTools implicitly (from the bundle's Source-Map-URL comment) and
  // cannot be pre-signed. Still path-traversal + rate-limited below.
  const isDevSourceMap = !IS_PROD && rawFile.endsWith('.map')
  if (!isDevSourceMap) {
    const sig = typeof req.query['sig'] === 'string' ? req.query['sig'] : undefined
    const expRaw = typeof req.query['exp'] === 'string' ? req.query['exp'] : undefined
    const exp = expRaw ? Number(expRaw) : undefined
    const verdict = verifyAsset(pluginId, rawFile, exp, sig)
    if (!verdict.ok) {
      res.status(401).json({ error: `Asset signature ${verdict.reason}` })
      return
    }
  }

  // Resolve plugin registry.
  const loader = runtimeManager.getPluginLoader()
  const def = loader?.getAllPlugins().find(p => p.meta.id === pluginId)
  if (!def) { res.status(404).json({ error: `Plugin "${pluginId}" not registered` }); return }
  const assetsDir = def.ui?.assetsDir
  if (!assetsDir) { res.status(404).json({ error: `Plugin "${pluginId}" has no UI assetsDir` }); return }

  // Path safety.
  const absRoot = pathResolve(assetsDir)
  const requested = pathResolve(join(absRoot, normalize(rawFile)))
  if (!(requested === absRoot || requested.startsWith(absRoot + sep))) {
    res.status(403).json({ error: 'Forbidden' })
    return
  }

  let info
  try { info = statSync(requested) } catch {
    res.status(404).json({ error: 'Not found' })
    return
  }
  if (!info.isFile()) { res.status(404).json({ error: 'Not a file' }); return }

  const ct = requested.endsWith('.map') ? 'application/json; charset=utf-8'
    : requested.endsWith('.css') ? 'text/css; charset=utf-8'
    : 'application/javascript; charset=utf-8'
  res.setHeader('Content-Type', ct)
  // Short cache: the URL includes `exp`, so after expiry the registry issues
  // a fresh URL with a new exp. Conservative max-age here.
  res.setHeader('Cache-Control', 'public, max-age=60, must-revalidate')
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin')
  res.setHeader('X-Content-Type-Options', 'nosniff')

  if (req.method === 'HEAD') {
    res.setHeader('Content-Length', String(info.size))
    res.status(200).end()
    return
  }

  createReadStream(requested)
    .on('error', (err) => {
      console.error(`[plugin-assets] stream error for ${requested}:`, err)
      if (!res.headersSent) res.status(500).end()
    })
    .pipe(res)
})

export { router as pluginAssetsRouter }
