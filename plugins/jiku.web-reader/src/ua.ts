// Realistic browser User-Agent pool + header builder.
//
// We rotate across recent Chrome / Firefox / Safari desktop UAs and emit a full
// set of client hints + Sec-Fetch headers so the request looks like a real
// browser navigation. This is the single biggest lever against bot-detection
// for plain HTML endpoints (Cloudflare-free sites, news, blogs, etc.).

export interface UaProfile {
  ua: string
  secChUa?: string
  secChUaMobile?: string
  secChUaPlatform?: string
}

const PROFILES: UaProfile[] = [
  {
    ua: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    secChUa: '"Google Chrome";v="131", "Chromium";v="131", "Not_A Brand";v="24"',
    secChUaMobile: '?0',
    secChUaPlatform: '"macOS"',
  },
  {
    ua: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    secChUa: '"Google Chrome";v="131", "Chromium";v="131", "Not_A Brand";v="24"',
    secChUaMobile: '?0',
    secChUaPlatform: '"Windows"',
  },
  {
    ua: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    secChUa: '"Google Chrome";v="131", "Chromium";v="131", "Not_A Brand";v="24"',
    secChUaMobile: '?0',
    secChUaPlatform: '"Linux"',
  },
  {
    ua: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14.6; rv:131.0) Gecko/20100101 Firefox/131.0',
  },
  {
    ua: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.6 Safari/605.1.15',
  },
]

export function pickUaProfile(override?: string): UaProfile {
  if (override && override.trim()) return { ua: override.trim() }
  return PROFILES[Math.floor(Math.random() * PROFILES.length)]!
}

/** Build a header bag that mirrors a real Chrome top-level navigation. */
export function buildRequestHeaders(profile: UaProfile, targetUrl: string): Record<string, string> {
  const headers: Record<string, string> = {
    'User-Agent': profile.ua,
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.9',
    'Accept-Encoding': 'gzip, deflate, br',
    'Cache-Control': 'max-age=0',
    'Upgrade-Insecure-Requests': '1',
    'Sec-Fetch-Dest': 'document',
    'Sec-Fetch-Mode': 'navigate',
    'Sec-Fetch-Site': 'none',
    'Sec-Fetch-User': '?1',
  }
  if (profile.secChUa) headers['Sec-Ch-Ua'] = profile.secChUa
  if (profile.secChUaMobile) headers['Sec-Ch-Ua-Mobile'] = profile.secChUaMobile
  if (profile.secChUaPlatform) headers['Sec-Ch-Ua-Platform'] = profile.secChUaPlatform
  try {
    const u = new URL(targetUrl)
    headers['Referer'] = `${u.protocol}//${u.host}/`
  } catch {
    // ignore
  }
  return headers
}
