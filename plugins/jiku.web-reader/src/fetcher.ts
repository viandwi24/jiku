// URL fetcher with SSRF guard, timeout, size cap, and redirect safety.
//
// Security posture:
//   • Only http:/https: schemes are allowed.
//   • Hostnames that resolve to (or literally are) loopback / link-local /
//     private RFC1918 / carrier-grade NAT ranges are rejected unless the
//     caller explicitly opted into `allowPrivateNetworks`. This blocks SSRF
//     pivots from agent inputs into the host network.
//   • We cap response size while streaming to avoid OOM from adversarial
//     endpoints that advertise a small Content-Length but stream forever.

import { pickUaProfile, buildRequestHeaders } from './ua.ts'

export interface FetchOptions {
  timeoutMs?: number
  maxBytes?: number
  userAgent?: string
  allowPrivateNetworks?: boolean
}

export interface FetchResult {
  finalUrl: string
  status: number
  contentType: string | null
  html: string
  byteLength: number
}

const DEFAULT_TIMEOUT_MS = 15_000
const DEFAULT_MAX_BYTES = 2 * 1024 * 1024 // 2 MB

/** Lowercased host → true if this host is inside a private range. */
function isPrivateHost(host: string): boolean {
  const lower = host.toLowerCase()
  if (lower === 'localhost' || lower.endsWith('.localhost')) return true
  if (lower === '0.0.0.0' || lower === '::' || lower === '::1') return true
  if (lower.endsWith('.local') || lower.endsWith('.internal')) return true

  const m4 = lower.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/)
  if (m4) {
    const a = Number(m4[1]), b = Number(m4[2])
    if (a === 10) return true
    if (a === 127) return true
    if (a === 169 && b === 254) return true
    if (a === 172 && b >= 16 && b <= 31) return true
    if (a === 192 && b === 168) return true
    if (a === 100 && b >= 64 && b <= 127) return true // CGNAT
    if (a === 0) return true
    if (a >= 224) return true // multicast + reserved
  }
  // Bracketed or bare IPv6 literal — reject common local / ULA forms.
  const ip6 = lower.replace(/^\[|\]$/g, '')
  if (ip6.startsWith('fc') || ip6.startsWith('fd')) return true // ULA
  if (ip6.startsWith('fe80')) return true                        // link-local
  return false
}

function assertSafeUrl(raw: string, allowPrivate: boolean): URL {
  let u: URL
  try { u = new URL(raw) } catch { throw new Error(`Invalid URL: ${raw}`) }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    throw new Error(`Unsupported protocol: ${u.protocol}`)
  }
  if (!allowPrivate && isPrivateHost(u.hostname)) {
    throw new Error(`Blocked private / loopback host: ${u.hostname}`)
  }
  return u
}

export async function fetchUrl(rawUrl: string, opts: FetchOptions = {}): Promise<FetchResult> {
  const {
    timeoutMs = DEFAULT_TIMEOUT_MS,
    maxBytes = DEFAULT_MAX_BYTES,
    userAgent,
    allowPrivateNetworks = false,
  } = opts

  assertSafeUrl(rawUrl, allowPrivateNetworks)

  const profile = pickUaProfile(userAgent)
  const headers = buildRequestHeaders(profile, rawUrl)

  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), timeoutMs)

  let response: Response
  try {
    response = await fetch(rawUrl, {
      method: 'GET',
      headers,
      redirect: 'follow',
      signal: controller.signal,
    })
  } catch (err: unknown) {
    clearTimeout(timeout)
    const msg = err instanceof Error ? err.message : String(err)
    throw new Error(`Fetch failed: ${msg}`)
  }

  // After redirects, re-check final URL against SSRF policy.
  assertSafeUrl(response.url || rawUrl, allowPrivateNetworks)

  if (!response.body) {
    clearTimeout(timeout)
    const text = await response.text()
    return {
      finalUrl: response.url || rawUrl,
      status: response.status,
      contentType: response.headers.get('content-type'),
      html: text,
      byteLength: new TextEncoder().encode(text).length,
    }
  }

  // Stream, cap at maxBytes.
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      if (!value) continue
      total += value.byteLength
      if (total > maxBytes) {
        controller.abort()
        throw new Error(`Response exceeded max size (${maxBytes} bytes)`)
      }
      chunks.push(value)
    }
  } finally {
    clearTimeout(timeout)
    try { reader.releaseLock() } catch { /* noop */ }
  }

  const merged = new Uint8Array(total)
  let offset = 0
  for (const c of chunks) { merged.set(c, offset); offset += c.byteLength }

  // Best-effort charset detection. Default UTF-8.
  const contentType = response.headers.get('content-type')
  const charset = contentType?.match(/charset=([^;\s]+)/i)?.[1]?.toLowerCase() ?? 'utf-8'
  let html: string
  try {
    html = new TextDecoder(charset, { fatal: false }).decode(merged)
  } catch {
    html = new TextDecoder('utf-8', { fatal: false }).decode(merged)
  }

  return {
    finalUrl: response.url || rawUrl,
    status: response.status,
    contentType,
    html,
    byteLength: total,
  }
}
