// HTML → Markdown conversion using Turndown with opinionated defaults.
//
// We use ATX headings, fenced code blocks, and inlined links. Script/style/nav
// and common boilerplate are stripped BEFORE conversion in reader.ts — here we
// just shape Markdown output. GFM-ish tables are approximated via a simple
// rule so Readability article tables stay readable.

import TurndownService from 'turndown'

let cached: TurndownService | null = null

function getTurndown(): TurndownService {
  if (cached) return cached
  const td = new TurndownService({
    headingStyle: 'atx',
    codeBlockStyle: 'fenced',
    fence: '```',
    bulletListMarker: '-',
    emDelimiter: '_',
    strongDelimiter: '**',
    linkStyle: 'inlined',
    hr: '---',
  })

  // Strip noise that somehow survived reader.ts pruning.
  td.remove(['script', 'style', 'noscript', 'iframe', 'form', 'nav', 'footer', 'aside'])

  // Simple table → Markdown pipe table.
  td.addRule('table', {
    filter: 'table',
    replacement: (_content, node) => {
      const table = node as unknown as HTMLTableElement
      const rows = Array.from(table.rows)
      if (rows.length === 0) return ''
      const lines: string[] = []
      rows.forEach((row, idx) => {
        const cells = Array.from(row.cells).map(c => (c.textContent ?? '').replace(/\s+/g, ' ').trim())
        lines.push('| ' + cells.join(' | ') + ' |')
        if (idx === 0) lines.push('| ' + cells.map(() => '---').join(' | ') + ' |')
      })
      return '\n\n' + lines.join('\n') + '\n\n'
    },
  })

  cached = td
  return td
}

export function htmlToMarkdown(html: string): string {
  if (!html) return ''
  return getTurndown().turndown(html).trim()
}
