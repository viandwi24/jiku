/**
 * Node.js entry point for the browser control server.
 *
 * Spawned by the Bun main server to run Playwright under Node.js,
 * which correctly handles HTTP upgrade/WebSocket events (unlike Bun v1.x).
 *
 * Protocol:
 *   - Config passed via BROWSER_SERVER_CONFIG env var (JSON)
 *   - Writes "READY:<port>\n" to stdout when listening
 *   - Writes "ERROR:<message>\n" to stdout on failure
 *   - Exits on SIGTERM/SIGINT
 */

import { startBrowserControlServer, stopBrowserControlServer } from './browser/server-impl.js'
import type { ResolvedBrowserConfig } from './browser/config.js'

const configJson = process.env['BROWSER_SERVER_CONFIG']
if (!configJson) {
  process.stdout.write('ERROR:BROWSER_SERVER_CONFIG env var not set\n')
  process.exit(1)
}

let resolved: ResolvedBrowserConfig
try {
  resolved = JSON.parse(configJson) as ResolvedBrowserConfig
} catch (err) {
  process.stdout.write(`ERROR:Invalid config JSON: ${String(err)}\n`)
  process.exit(1)
}

try {
  const state = await startBrowserControlServer(resolved)
  if (!state) {
    process.stdout.write('ERROR:Browser control server failed to start\n')
    process.exit(1)
  }
  process.stdout.write(`READY:${state.port}\n`)
} catch (err) {
  process.stdout.write(`ERROR:${String(err)}\n`)
  process.exit(1)
}

async function shutdown() {
  try {
    await stopBrowserControlServer()
  } catch {
    // ignore
  }
  process.exit(0)
}

process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)
