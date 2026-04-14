// Metadata scraping: pulls Open Graph, Twitter Card, JSON-LD, and standard
// <meta> tags out of a parsed Document. Covers the fields Readability does not
// reliably return: lead image, canonical URL, site name, language, etc.

export interface PageMetadata {
  title?: string
  description?: string
  author?: string
  siteName?: string
  lang?: string
  publishedTime?: string
  modifiedTime?: string
  leadImage?: string
  canonicalUrl?: string
  keywords?: string[]
  ogType?: string
  twitterCard?: string
}

type DocLike = {
  querySelector: (sel: string) => { getAttribute(name: string): string | null; textContent?: string | null } | null
  querySelectorAll: (sel: string) => ArrayLike<{ getAttribute(name: string): string | null; textContent?: string | null }>
  documentElement?: { getAttribute(name: string): string | null } | null
}

function meta(doc: DocLike, selector: string, attr = 'content'): string | undefined {
  const el = doc.querySelector(selector)
  const v = el?.getAttribute(attr)
  return v?.trim() || undefined
}

function first<T>(...values: (T | undefined)[]): T | undefined {
  for (const v of values) if (v !== undefined && v !== null && (typeof v !== 'string' || v.length > 0)) return v
  return undefined
}

function readJsonLd(doc: DocLike): Record<string, unknown>[] {
  const nodes = doc.querySelectorAll('script[type="application/ld+json"]')
  const out: Record<string, unknown>[] = []
  for (let i = 0; i < nodes.length; i++) {
    const raw = nodes[i]?.textContent
    if (!raw) continue
    try {
      const parsed = JSON.parse(raw)
      if (Array.isArray(parsed)) out.push(...parsed.filter(x => x && typeof x === 'object'))
      else if (parsed && typeof parsed === 'object') out.push(parsed as Record<string, unknown>)
    } catch {
      // Ignore malformed JSON-LD blocks.
    }
  }
  return out
}

function pickArticleLd(lds: Record<string, unknown>[]): Record<string, unknown> | undefined {
  const preferred = new Set(['Article', 'NewsArticle', 'BlogPosting', 'WebPage'])
  for (const ld of lds) {
    const t = ld['@type']
    const types = Array.isArray(t) ? t : [t]
    if (types.some(x => typeof x === 'string' && preferred.has(x))) return ld
  }
  return lds[0]
}

function extractAuthor(ld: Record<string, unknown> | undefined): string | undefined {
  const a = ld?.['author']
  if (!a) return undefined
  if (typeof a === 'string') return a
  if (Array.isArray(a)) {
    const names = a.map(x => (x && typeof x === 'object' && 'name' in x ? String((x as Record<string, unknown>).name) : typeof x === 'string' ? x : '')).filter(Boolean)
    return names.join(', ') || undefined
  }
  if (typeof a === 'object' && 'name' in (a as Record<string, unknown>)) {
    return String((a as Record<string, unknown>).name)
  }
  return undefined
}

function resolveUrl(baseUrl: string, href: string | undefined): string | undefined {
  if (!href) return undefined
  try { return new URL(href, baseUrl).toString() } catch { return href }
}

export function extractMetadata(doc: DocLike, baseUrl: string): PageMetadata {
  const ld = pickArticleLd(readJsonLd(doc))

  const title = first(
    meta(doc, 'meta[property="og:title"]'),
    meta(doc, 'meta[name="twitter:title"]'),
    ld?.['headline'] as string | undefined,
    ld?.['name'] as string | undefined,
    doc.querySelector('title')?.textContent?.trim() || undefined,
  )

  const description = first(
    meta(doc, 'meta[property="og:description"]'),
    meta(doc, 'meta[name="twitter:description"]'),
    meta(doc, 'meta[name="description"]'),
    ld?.['description'] as string | undefined,
  )

  const author = first(
    meta(doc, 'meta[name="author"]'),
    meta(doc, 'meta[property="article:author"]'),
    extractAuthor(ld),
  )

  const siteName = first(
    meta(doc, 'meta[property="og:site_name"]'),
    meta(doc, 'meta[name="application-name"]'),
  )

  const lang = doc.documentElement?.getAttribute('lang')?.trim() || undefined

  const publishedTime = first(
    meta(doc, 'meta[property="article:published_time"]'),
    meta(doc, 'meta[name="pubdate"]'),
    meta(doc, 'meta[itemprop="datePublished"]'),
    ld?.['datePublished'] as string | undefined,
  )

  const modifiedTime = first(
    meta(doc, 'meta[property="article:modified_time"]'),
    meta(doc, 'meta[itemprop="dateModified"]'),
    ld?.['dateModified'] as string | undefined,
  )

  const leadImageRaw = first(
    meta(doc, 'meta[property="og:image:secure_url"]'),
    meta(doc, 'meta[property="og:image"]'),
    meta(doc, 'meta[name="twitter:image"]'),
    meta(doc, 'meta[name="twitter:image:src"]'),
    (() => {
      const img = ld?.['image']
      if (typeof img === 'string') return img
      if (Array.isArray(img) && img.length > 0) {
        const f = img[0]
        if (typeof f === 'string') return f
        if (f && typeof f === 'object' && 'url' in f) return String((f as Record<string, unknown>).url)
      }
      if (img && typeof img === 'object' && 'url' in (img as Record<string, unknown>)) {
        return String((img as Record<string, unknown>).url)
      }
      return undefined
    })(),
  )

  const canonicalRaw = first(
    meta(doc, 'link[rel="canonical"]', 'href'),
    meta(doc, 'meta[property="og:url"]'),
  )

  const keywordsRaw = meta(doc, 'meta[name="keywords"]')
  const keywords = keywordsRaw ? keywordsRaw.split(',').map(s => s.trim()).filter(Boolean) : undefined

  return {
    title,
    description,
    author,
    siteName,
    lang,
    publishedTime,
    modifiedTime,
    leadImage: resolveUrl(baseUrl, leadImageRaw),
    canonicalUrl: resolveUrl(baseUrl, canonicalRaw),
    keywords,
    ogType: meta(doc, 'meta[property="og:type"]'),
    twitterCard: meta(doc, 'meta[name="twitter:card"]'),
  }
}
