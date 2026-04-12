// Plan 17 — signed URLs for plugin UI assets.
//
// Browser dynamic `import()` can't attach Authorization headers, so we embed
// a short-lived HMAC in the URL. The Studio web fetches `ui-registry` while
// authed, gets asset URLs with `?sig=<hmac>&exp=<epoch-seconds>`, and uses
// those URLs directly. The asset router verifies the signature before
// streaming the bundle.
//
// Token scope: (pluginId, file, exp). An attacker who captures one URL
// cannot use it for a different plugin/file, and cannot use it past `exp`.

import { createHmac, timingSafeEqual } from 'node:crypto'
import { env } from '../../env.ts'

const DEFAULT_TTL_SECONDS = 10 * 60  // 10 minutes

function computeHmac(pluginId: string, file: string, exp: number): string {
  return createHmac('sha256', env.JWT_SECRET)
    .update(`${pluginId}\0${file}\0${exp}`)
    .digest('base64url')
}

export interface SignedAsset {
  sig: string
  exp: number
}

/** Mint a `{ sig, exp }` pair that grants access to `<pluginId>/ui/<file>` until `exp`. */
export function signAsset(pluginId: string, file: string, ttlSeconds: number = DEFAULT_TTL_SECONDS): SignedAsset {
  const exp = Math.floor(Date.now() / 1000) + ttlSeconds
  return { sig: computeHmac(pluginId, file, exp), exp }
}

export type VerifyResult =
  | { ok: true }
  | { ok: false; reason: 'missing' | 'expired' | 'invalid' }

/** Check that `(pluginId, file, exp, sig)` is a valid non-expired triple. */
export function verifyAsset(pluginId: string, file: string, exp: number | undefined, sig: string | undefined): VerifyResult {
  if (!sig || !exp) return { ok: false, reason: 'missing' }
  const nowSec = Math.floor(Date.now() / 1000)
  if (exp < nowSec) return { ok: false, reason: 'expired' }
  const expected = computeHmac(pluginId, file, exp)
  // timingSafeEqual requires equal-length buffers — bail early if mismatch.
  if (sig.length !== expected.length) return { ok: false, reason: 'invalid' }
  try {
    const a = Buffer.from(sig)
    const b = Buffer.from(expected)
    return timingSafeEqual(a, b) ? { ok: true } : { ok: false, reason: 'invalid' }
  } catch {
    return { ok: false, reason: 'invalid' }
  }
}
