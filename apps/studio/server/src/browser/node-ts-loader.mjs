/**
 * Node.js ESM loader: resolves .js imports to .ts files.
 * Used when spawning the browser control server under Node.js
 * so that Playwright's HTTP upgrade handling works correctly.
 */
export async function resolve(specifier, context, nextResolve) {
  if (
    specifier.endsWith('.js') &&
    !specifier.startsWith('node:') &&
    !specifier.includes('://')
  ) {
    try {
      return await nextResolve(specifier.slice(0, -3) + '.ts', context)
    } catch {
      // fall through to .js
    }
  }
  return nextResolve(specifier, context)
}
