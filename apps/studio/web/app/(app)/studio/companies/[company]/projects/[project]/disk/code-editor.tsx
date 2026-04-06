'use client'

import CodeMirror from '@uiw/react-codemirror'
import { javascript } from '@codemirror/lang-javascript'
import { python } from '@codemirror/lang-python'
import { rust } from '@codemirror/lang-rust'
import { go } from '@codemirror/lang-go'
import { json } from '@codemirror/lang-json'
import { css } from '@codemirror/lang-css'
import { html } from '@codemirror/lang-html'
import { markdown } from '@codemirror/lang-markdown'
import { xml } from '@codemirror/lang-xml'
import { sql } from '@codemirror/lang-sql'
import { oneDark } from '@codemirror/theme-one-dark'
import { EditorView } from '@codemirror/view'
import type { Extension } from '@codemirror/state'

function getLangExtension(filePath: string): Extension[] {
  const ext = filePath.split('.').pop()?.toLowerCase() ?? ''
  switch (ext) {
    case 'js': case 'jsx': case 'ts': case 'tsx': case 'mjs': case 'cjs':
      return [javascript({ typescript: ext === 'ts' || ext === 'tsx', jsx: ext === 'jsx' || ext === 'tsx' })]
    case 'py': return [python()]
    case 'rs': return [rust()]
    case 'go': return [go()]
    case 'json': return [json()]
    case 'css': return [css()]
    case 'html': return [html()]
    case 'md': case 'mdx': return [markdown()]
    case 'xml': return [xml()]
    case 'sql': return [sql()]
    default: return []
  }
}

interface CodeEditorProps {
  filePath: string
  value: string
  onChange: (value: string) => void
}

export default function CodeEditor({ filePath, value, onChange }: CodeEditorProps) {
  const extensions: Extension[] = [
    ...getLangExtension(filePath),
    EditorView.lineWrapping,
  ]

  return (
    <CodeMirror
      value={value}
      height="100%"
      theme={oneDark}
      extensions={extensions}
      onChange={onChange}
      className="flex-1 overflow-auto text-sm"
      style={{ height: '100%' }}
    />
  )
}
