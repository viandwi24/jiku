'use client'

import { useMemo } from 'react'
import type { FileViewAdapterProps } from '@/lib/file-view-adapters'

// ── Inline formatter ──────────────────────────────────────────────────────────
function inlineHtml(text: string): string {
  // Escape HTML first (only in text, not inside already-emitted tags)
  let s = text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')

  s = s.replace(/\*\*\*(.+?)\*\*\*/g, '<strong><em>$1</em></strong>')
  s = s.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
  s = s.replace(/__(.+?)__/g, '<strong>$1</strong>')
  s = s.replace(/\*(.+?)\*/g, '<em>$1</em>')
  s = s.replace(/(?<!\w)_(.+?)_(?!\w)/g, '<em>$1</em>')
  s = s.replace(/~~(.+?)~~/g, '<del>$1</del>')
  s = s.replace(/`([^`]+)`/g, (_m, c) => `<code>${c.replace(/&amp;/g, '&').replace(/</g, '&lt;').replace(/>/g, '&gt;')}</code>`)
  s = s.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, '<img alt="$1" src="$2" />')
  s = s.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noreferrer">$1</a>')
  return s
}

// ── Block parser ──────────────────────────────────────────────────────────────
function markdownToHtml(md: string): string {
  const lines = md.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n')
  const out: string[] = []

  let i = 0

  // Placeholder map for fenced code blocks (so inline formatter won't touch them)
  const codeBlocks: string[] = []

  // Pre-pass: extract fenced code blocks
  const withPlaceholders: string[] = []
  let inFence = false
  let fenceLang = ''
  let fenceContent: string[] = []

  for (const line of lines) {
    if (!inFence) {
      const fenceMatch = line.match(/^```(\w*)$/)
      if (fenceMatch) {
        inFence = true
        fenceLang = fenceMatch[1] ?? ''
        fenceContent = []
      } else {
        withPlaceholders.push(line)
      }
    } else {
      if (line === '```') {
        const code = fenceContent.join('\n')
          .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        const cls = fenceLang ? ` class="language-${fenceLang}"` : ''
        const placeholder = `\x00code${codeBlocks.length}\x00`
        codeBlocks.push(`<pre class="md-pre"><code${cls}>${code}</code></pre>`)
        withPlaceholders.push(placeholder)
        inFence = false
      } else {
        fenceContent.push(line)
      }
    }
  }
  // Unclosed fence: treat as code
  if (inFence && fenceContent.length) {
    const code = fenceContent.join('\n').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    const placeholder = `\x00code${codeBlocks.length}\x00`
    codeBlocks.push(`<pre class="md-pre"><code>${code}</code></pre>`)
    withPlaceholders.push(placeholder)
  }

  const src = withPlaceholders
  i = 0

  function isTableSep(line: string) {
    return /^\|?[\s|:\-]+\|[\s|:\-]*$/.test(line.trim())
  }

  function parseTableAlign(sep: string): string[] {
    return sep.split('|').slice(1, -1).map(cell => {
      const t = cell.trim()
      if (t.startsWith(':') && t.endsWith(':')) return 'center'
      if (t.endsWith(':')) return 'right'
      return 'left'
    })
  }

  function tableRow(line: string): string[] {
    return line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map(c => c.trim())
  }

  while (i < src.length) {
    const line = src[i]!

    // Empty line
    if (line.trim() === '') { i++; continue }

    // Code block placeholder
    if (line.startsWith('\x00code')) {
      const idx = parseInt(line.replace('\x00code', '').replace('\x00', ''))
      out.push(codeBlocks[idx]!)
      i++
      continue
    }

    // Horizontal rule (before heading check — `---` alone is HR)
    if (/^(\*{3,}|-{3,}|_{3,})$/.test(line.trim())) {
      out.push('<hr />')
      i++
      continue
    }

    // ATX Headings
    const headMatch = line.match(/^(#{1,6})\s+(.+)$/)
    if (headMatch) {
      const level = headMatch[1]!.length
      out.push(`<h${level}>${inlineHtml(headMatch[2]!)}</h${level}>`)
      i++
      continue
    }

    // Blockquote
    if (line.startsWith('> ') || line === '>') {
      const bqLines: string[] = []
      while (i < src.length && (src[i]!.startsWith('> ') || src[i] === '>')) {
        bqLines.push(src[i]!.replace(/^> ?/, ''))
        i++
      }
      out.push(`<blockquote>${markdownToHtml(bqLines.join('\n'))}</blockquote>`)
      continue
    }

    // GFM Table — header | separator | rows
    if (line.includes('|') && i + 1 < src.length && isTableSep(src[i + 1]!)) {
      const headers = tableRow(line)
      const aligns = parseTableAlign(src[i + 1]!)
      i += 2
      const rows: string[][] = []
      while (i < src.length && src[i]!.includes('|') && src[i]!.trim() !== '') {
        rows.push(tableRow(src[i]!))
        i++
      }
      const thCells = headers.map((h, ci) => {
        const align = aligns[ci] ?? 'left'
        return `<th style="text-align:${align}">${inlineHtml(h)}</th>`
      }).join('')
      const bodyRows = rows.map(row => {
        const tds = headers.map((_, ci) => {
          const align = aligns[ci] ?? 'left'
          return `<td style="text-align:${align}">${inlineHtml(row[ci] ?? '')}</td>`
        }).join('')
        return `<tr>${tds}</tr>`
      }).join('')
      out.push(`<table><thead><tr>${thCells}</tr></thead><tbody>${bodyRows}</tbody></table>`)
      continue
    }

    // Unordered list
    if (/^[ \t]*[-*+]\s/.test(line)) {
      const items: string[] = []
      while (i < src.length && /^[ \t]*[-*+]\s/.test(src[i]!)) {
        items.push(`<li>${inlineHtml(src[i]!.replace(/^[ \t]*[-*+]\s+/, ''))}</li>`)
        i++
      }
      out.push(`<ul>${items.join('')}</ul>`)
      continue
    }

    // Ordered list
    if (/^[ \t]*\d+\.\s/.test(line)) {
      const items: string[] = []
      while (i < src.length && /^[ \t]*\d+\.\s/.test(src[i]!)) {
        items.push(`<li>${inlineHtml(src[i]!.replace(/^[ \t]*\d+\.\s+/, ''))}</li>`)
        i++
      }
      out.push(`<ol>${items.join('')}</ol>`)
      continue
    }

    // Paragraph: collect consecutive non-empty, non-special lines
    const paraLines: string[] = []
    while (
      i < src.length &&
      src[i]!.trim() !== '' &&
      !src[i]!.startsWith('\x00code') &&
      !/^#{1,6}\s/.test(src[i]!) &&
      !/^[ \t]*[-*+]\s/.test(src[i]!) &&
      !/^[ \t]*\d+\.\s/.test(src[i]!) &&
      !src[i]!.startsWith('> ') &&
      !(src[i]!.includes('|') && i + 1 < src.length && isTableSep(src[i + 1]!)) &&
      !/^(\*{3,}|-{3,}|_{3,})$/.test(src[i]!.trim())
    ) {
      paraLines.push(src[i]!)
      i++
    }
    if (paraLines.length) {
      out.push(`<p>${paraLines.map(inlineHtml).join('<br />')}</p>`)
    }
  }

  // Restore code placeholders (shouldn't be needed since we handle them above,
  // but as a safety net)
  return out.join('\n')
}

// ── Component ─────────────────────────────────────────────────────────────────
export function MarkdownViewAdapter({ content }: FileViewAdapterProps) {
  const html = useMemo(() => markdownToHtml(content), [content])

  return (
    <div
      className="p-6 overflow-auto flex-1
        [&_h1]:text-2xl [&_h1]:font-bold [&_h1]:mb-4 [&_h1]:mt-6 [&_h1]:pb-2 [&_h1]:border-b
        [&_h2]:text-xl [&_h2]:font-semibold [&_h2]:mb-3 [&_h2]:mt-5 [&_h2]:pb-1 [&_h2]:border-b
        [&_h3]:text-lg [&_h3]:font-semibold [&_h3]:mb-2 [&_h3]:mt-4
        [&_h4]:text-base [&_h4]:font-semibold [&_h4]:mb-2 [&_h4]:mt-3
        [&_h5]:text-sm [&_h5]:font-semibold [&_h5]:mb-1 [&_h5]:mt-3
        [&_h6]:text-xs [&_h6]:font-semibold [&_h6]:mb-1 [&_h6]:mt-3 [&_h6]:text-muted-foreground
        [&_p]:mb-3 [&_p]:leading-relaxed
        [&_ul]:mb-3 [&_ul]:pl-5 [&_ul]:list-disc [&_ul_li]:mb-1
        [&_ol]:mb-3 [&_ol]:pl-5 [&_ol]:list-decimal [&_ol_li]:mb-1
        [&_blockquote]:border-l-4 [&_blockquote]:border-border [&_blockquote]:pl-4 [&_blockquote]:py-1 [&_blockquote]:text-muted-foreground [&_blockquote]:mb-3 [&_blockquote]:italic
        [&_.md-pre]:bg-muted [&_.md-pre]:rounded-md [&_.md-pre]:p-4 [&_.md-pre]:mb-3 [&_.md-pre]:overflow-x-auto [&_.md-pre]:text-xs [&_.md-pre]:font-mono
        [&_code]:bg-muted [&_code]:px-1.5 [&_code]:py-0.5 [&_code]:rounded [&_code]:text-xs [&_code]:font-mono
        [&_.md-pre_code]:bg-transparent [&_.md-pre_code]:p-0
        [&_hr]:border-border [&_hr]:my-6
        [&_a]:text-primary [&_a]:underline [&_a]:underline-offset-2 [&_a:hover]:opacity-80
        [&_img]:max-w-full [&_img]:rounded [&_img]:my-3
        [&_strong]:font-semibold [&_em]:italic [&_del]:line-through
        [&_table]:w-full [&_table]:mb-4 [&_table]:border-collapse [&_table]:text-sm
        [&_table_th]:border [&_table_th]:border-border [&_table_th]:px-3 [&_table_th]:py-2 [&_table_th]:bg-muted [&_table_th]:font-semibold [&_table_th]:text-left
        [&_table_td]:border [&_table_td]:border-border [&_table_td]:px-3 [&_table_td]:py-2
        [&_table_tr:hover_td]:bg-muted/30"
      dangerouslySetInnerHTML={{ __html: html }}
    />
  )
}
