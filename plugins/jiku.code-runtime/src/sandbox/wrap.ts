// Wrap user code so the sandbox has a single entrypoint and surfaces a result.
//
// Strategy:
//   1. Find the last non-empty, non-comment line of the user's source.
//   2. If that line is a statement-starter (`return`, `const`, `if`, ...),
//      leave it alone — user is driving the flow explicitly.
//   3. Otherwise treat it as a bare expression and rewrite it to
//      `__jiku_result(<expr>)` so the runtime can capture the value.
//
// The whole thing is wrapped in an async IIFE with a try/catch that routes
// thrown errors to `__jiku_error`. Explicit calls to `__jiku_result(...)` in
// user code still work and take priority.

// Lines beginning with these keywords are statements, not expressions.
const STMT_KEYWORDS =
  /^(return|const|let|var|function|class|if|for|while|do|switch|try|throw|import|export|async\s+function|\/\/|\/\*|\}|\{)/

function splitLastExpression(code: string): { head: string; tail: string | null } {
  const lines = code.split('\n')
  // walk backwards past blank lines and single-line comments
  let idx = lines.length - 1
  while (idx >= 0) {
    const trimmed = lines[idx]!.trim()
    if (trimmed.length === 0) { idx--; continue }
    if (trimmed.startsWith('//')) { idx--; continue }
    break
  }
  if (idx < 0) return { head: code, tail: null }

  const lastLine = lines[idx]!
  const trimmed = lastLine.trim()
  if (STMT_KEYWORDS.test(trimmed)) return { head: code, tail: null }

  // Also bail if the line already ends with a semicolon and contains an
  // assignment — treat as statement.
  if (/^(\w+\s*=(?!=))/.test(trimmed)) return { head: code, tail: null }

  // strip trailing semicolon if present
  const expr = trimmed.replace(/;+\s*$/, '')
  const head = lines.slice(0, idx).join('\n')
  return { head, tail: expr }
}

export function wrapCode(code: string): string {
  const { head, tail } = splitLastExpression(code)
  const body = tail
    ? `${head}\nreturn (${tail});`
    : `${head}`
  return `
(async () => {
  try {
    const __result = await (async () => {
${body}
    })();
    if (typeof __result !== 'undefined') __jiku_result(__result);
  } catch (err) {
    __jiku_error(err && err.stack ? err.stack : String(err));
  }
})();
`
}
