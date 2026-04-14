// Reader-mode extraction pipeline:
//   raw HTML
//     → linkedom parseHTML (Bun-native DOM, no jsdom)
//     → strip noise (script / style / noscript / iframe / form / tracking)
//     → clone document for Readability (it mutates its input)
//     → @mozilla/readability .parse()
//     → resolve relative image / link URLs against final URL
//     → return { article, metadata }

import { parseHTML } from 'linkedom'
import { Readability, isProbablyReaderable } from '@mozilla/readability'
import { extractMetadata, type PageMetadata } from './metadata.ts'

export interface ReaderArticle {
  title: string | null
  byline: string | null
  excerpt: string | null
  contentHtml: string | null
  textContent: string | null
  length: number
  siteName: string | null
  publishedTime: string | null
  lang: string | null
  probablyReaderable: boolean
}

export interface ReaderResult {
  article: ReaderArticle
  metadata: PageMetadata
}

const NOISE_SELECTORS = [
  'script', 'style', 'noscript', 'iframe', 'template',
  '[aria-hidden="true"]',
  '.advertisement', '.ad', '.ads', '.cookie-banner', '.newsletter',
]

function stripNoise(doc: Document): void {
  for (const sel of NOISE_SELECTORS) {
    const nodes = doc.querySelectorAll(sel)
    nodes.forEach(n => n.parentNode?.removeChild(n))
  }
}

function resolveUrls(contentHtml: string, baseUrl: string): string {
  // Rewrite relative src/href so downstream consumers (Markdown/images) get
  // absolute URLs. Cheap string rewrite avoids re-parsing.
  return contentHtml.replace(/\s(src|href)="([^"]+)"/g, (_m, attr, val) => {
    try {
      const abs = new URL(val, baseUrl).toString()
      return ` ${attr}="${abs}"`
    } catch {
      return ` ${attr}="${val}"`
    }
  })
}

export function parseReader(html: string, baseUrl: string): ReaderResult {
  const { document } = parseHTML(html)
  stripNoise(document as unknown as Document)

  const metadata = extractMetadata(document as unknown as Parameters<typeof extractMetadata>[0], baseUrl)

  const probablyReaderable = (() => {
    try { return isProbablyReaderable(document as unknown as Document) } catch { return false }
  })()

  // Readability mutates the document it is given — clone first so our metadata
  // extraction is not contaminated if callers want to re-query.
  const cloneDoc = parseHTML(html).document as unknown as Document
  stripNoise(cloneDoc)

  // Readability's own Document type is a narrower shape than DOM lib's — cast
  // through unknown to satisfy its constructor signature.
  type ReadabilityDoc = ConstructorParameters<typeof Readability>[0]
  let parsed: ReturnType<InstanceType<typeof Readability>['parse']> = null
  try {
    parsed = new Readability(cloneDoc as unknown as ReadabilityDoc, {
      charThreshold: 200,
      keepClasses: false,
    }).parse()
  } catch {
    parsed = null
  }

  const article: ReaderArticle = {
    title: parsed?.title ?? metadata.title ?? null,
    byline: parsed?.byline ?? metadata.author ?? null,
    excerpt: parsed?.excerpt ?? metadata.description ?? null,
    contentHtml: parsed?.content ? resolveUrls(String(parsed.content), baseUrl) : null,
    textContent: typeof parsed?.textContent === 'string' ? parsed.textContent.trim() : null,
    length: parsed?.length ?? 0,
    siteName: parsed?.siteName ?? metadata.siteName ?? null,
    publishedTime: (parsed as { publishedTime?: string } | null)?.publishedTime ?? metadata.publishedTime ?? null,
    lang: parsed?.lang ?? metadata.lang ?? null,
    probablyReaderable,
  }

  return { article, metadata }
}
