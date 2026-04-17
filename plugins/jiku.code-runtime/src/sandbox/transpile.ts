// TypeScript → JavaScript transpile via Bun.Transpiler.
//
// QuickJS parses JS only — TS syntax (type annotations, interfaces, enums) must
// be stripped before eval. We use Bun's built-in transpiler (zero-dep) with
// loader='ts' and format='esm'. The transpiler also strips JSX if present and
// handles modern ES features.
//
// For `language: 'js'` we still run the JS through the transpiler with
// loader='js' — this is cheap and normalises the output (strips dead imports,
// etc.), but callers may also pass raw JS through unchanged.

declare const Bun: {
  Transpiler: new (opts: { loader: 'ts' | 'tsx' | 'js' | 'jsx' }) => {
    transformSync(code: string): string
  }
}

let tsTranspiler: ReturnType<typeof createTranspiler> | null = null

function createTranspiler(loader: 'ts' | 'js') {
  if (typeof Bun === 'undefined' || !Bun.Transpiler) {
    throw new Error('Bun.Transpiler not available — jiku.code-runtime requires Bun runtime')
  }
  return new Bun.Transpiler({ loader })
}

export function transpile(source: string, language: 'js' | 'ts'): string {
  if (language === 'js') {
    // fast path — raw JS goes straight through; skip transpiler cost
    return source
  }
  if (!tsTranspiler) tsTranspiler = createTranspiler('ts')
  return tsTranspiler.transformSync(source)
}

// Lightweight heuristic to detect TS syntax in code whose language wasn't
// declared. Used when `language` is omitted in `code` mode — we default to JS
// but upgrade to TS transpile if obvious TS patterns are present.
export function looksLikeTs(source: string): boolean {
  return (
    /:\s*(string|number|boolean|any|unknown|void|never|\w+\[\]|\{\s*\w)/m.test(source) ||
    /\b(interface|enum|type\s+\w+\s*=)\b/m.test(source) ||
    /\bas\s+(const|\w+)\b/.test(source) ||
    /<[A-Z]\w*(,\s*[A-Z]\w*)*>/.test(source)
  )
}
