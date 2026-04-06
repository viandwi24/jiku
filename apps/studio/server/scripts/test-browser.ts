/**
 * Browser tool smoke test
 * Usage: bun run scripts/test-browser.ts [baseUrl] [cdpUrl]
 *
 * Examples:
 *   bun run scripts/test-browser.ts                          # auto-detect from running server
 *   bun run scripts/test-browser.ts http://127.0.0.1:18791  # direct control server URL
 *
 * This script directly exercises the same code path that agents use,
 * without going through the AI layer.
 */

import { executeBrowserAction } from '../src/browser/execute.js'

const baseUrl = process.argv[2] ?? 'http://127.0.0.1:18791'
const cdpUrl = process.argv[3]  // optional, for direct CDP check

const RESET = '\x1b[0m'
const GREEN = '\x1b[32m'
const RED = '\x1b[31m'
const YELLOW = '\x1b[33m'
const CYAN = '\x1b[36m'
const BOLD = '\x1b[1m'

function ok(label: string, data?: unknown) {
  console.log(`${GREEN}✓${RESET} ${label}`)
  if (data !== undefined) {
    const str = typeof data === 'string' ? data : JSON.stringify(data, null, 2)
    console.log(`  ${CYAN}${str.slice(0, 300)}${str.length > 300 ? '...' : ''}${RESET}`)
  }
}

function fail(label: string, err: unknown) {
  const msg = err instanceof Error ? err.message : String(err)
  console.log(`${RED}✗${RESET} ${label}`)
  console.log(`  ${RED}${msg}${RESET}`)
}

function info(msg: string) {
  console.log(`${YELLOW}→${RESET} ${msg}`)
}

async function run(label: string, fn: () => Promise<unknown>) {
  try {
    const result = await fn()
    ok(label, result)
    return result
  } catch (err) {
    fail(label, err)
    return null
  }
}

console.log(`\n${BOLD}Browser Tool Smoke Test${RESET}`)
console.log(`Control server: ${CYAN}${baseUrl}${RESET}`)
if (cdpUrl) console.log(`CDP URL: ${CYAN}${cdpUrl}${RESET}`)
console.log()

// 1. Check control server reachability
info('Step 1: Check control server reachability')
const reachable = await run('GET / (control server status)', async () => {
  const res = await fetch(`${baseUrl}/`, { signal: AbortSignal.timeout(5000) })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return res.json()
})

if (!reachable) {
  console.log(`\n${RED}Control server not reachable at ${baseUrl}${RESET}`)
  console.log('Make sure the Jiku server is running and browser is enabled for the project.')
  process.exit(1)
}

// 2. Check CDP directly if provided
if (cdpUrl) {
  info('Step 2: Check CDP endpoint directly')
  await run(`GET ${cdpUrl}/json/version`, async () => {
    const res = await fetch(`${cdpUrl}/json/version`, { signal: AbortSignal.timeout(5000) })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    return res.json()
  })
}

// 3. Status check via browser tool
info('Step 3: browser status')
await run('action=status', () =>
  executeBrowserAction({ action: 'status' }, baseUrl).then(r => JSON.parse(r.content[0].text!))
)

// 4. Start browser
info('Step 4: start browser')
const startResult = await run('action=start', () =>
  executeBrowserAction({ action: 'start' }, baseUrl).then(r => JSON.parse(r.content[0].text!))
)

if (!startResult) {
  console.log(`\n${RED}Browser failed to start. Check server logs.${RESET}`)
  process.exit(1)
}

// 4b. Check WebSocket debugger URL reachability
info('Step 4b: Check CDP WebSocket URL from /json/version')
const cdpStatus = await run('GET http://localhost:9222/json/version (WebSocket URL check)', async () => {
  const res = await fetch('http://localhost:9222/json/version', { signal: AbortSignal.timeout(5000) })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  const json = await res.json() as { webSocketDebuggerUrl?: string }
  const wsUrl = json.webSocketDebuggerUrl ?? ''
  // Check if ws URL uses localhost — Playwright will try to connect to this
  if (wsUrl.includes('localhost') || wsUrl.includes('127.0.0.1')) {
    return { wsUrl, warning: 'WebSocket URL uses localhost — Playwright should be able to connect' }
  }
  return { wsUrl, warning: 'WebSocket URL uses unexpected host: ' + wsUrl }
}).catch(() => null)

// 4c. Check tabs directly
info('Step 4c: list CDP tabs directly')
await run('GET http://localhost:9222/json', async () => {
  const res = await fetch('http://localhost:9222/json', { signal: AbortSignal.timeout(5000) })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return res.json()
})

// 4d. Check tabs via control server
info('Step 4d: list tabs via control server')
await run('action=tabs', () =>
  executeBrowserAction({ action: 'tabs' }, baseUrl).then(r => JSON.parse(r.content[0].text!))
)

// 4e. Test Playwright connectOverCDP directly
info('Step 4e: Test Playwright connectOverCDP directly')
await run('playwright.connectOverCDP(http://localhost:9222)', async () => {
  const { chromium } = await import('playwright')
  const browser = await chromium.connectOverCDP('http://localhost:9222', { timeout: 5000 })
  const contexts = browser.contexts()
  const pages = contexts.flatMap(c => c.pages())
  await browser.close()
  return { contexts: contexts.length, pages: pages.length }
})

// 4f. Test raw WebSocket connect with Origin header
info('Step 4f: Test raw WebSocket with Origin header')
await run('WebSocket ws://localhost:9222 with Origin: http://localhost', async () => {
  const wsUrlRes = await fetch('http://localhost:9222/json/version', { signal: AbortSignal.timeout(3000) })
  const wsJson = await wsUrlRes.json() as { webSocketDebuggerUrl: string }
  const wsUrl = wsJson.webSocketDebuggerUrl

  return await new Promise<unknown>((resolve, reject) => {
    const WebSocket = require('ws')
    const ws = new WebSocket(wsUrl, {
      headers: { 'Origin': 'http://localhost' },
      handshakeTimeout: 4000,
    })
    const t = setTimeout(() => { ws.terminate(); reject(new Error('timeout')) }, 4500)
    ws.once('open', () => { clearTimeout(t); ws.close(); resolve({ connected: true, wsUrl }) })
    ws.once('error', (err: Error) => { clearTimeout(t); reject(err) })
  })
})

// 5. Navigate
info('Step 5: navigate to https://example.com')
const navResult = await run('action=navigate url=https://example.com', () =>
  executeBrowserAction({ action: 'navigate', targetUrl: 'https://example.com' }, baseUrl)
    .then(r => JSON.parse(r.content[0].text!))
)

if (!navResult) {
  console.log(`\n${RED}Navigate failed — CDP connection likely broken.${RESET}`)
  process.exit(1)
}

// 6. Snapshot
info('Step 6: snapshot')
await run('action=snapshot', async () => {
  const r = await executeBrowserAction({ action: 'snapshot', snapshotFormat: 'aria' }, baseUrl)
  const text = r.content[0].text ?? ''
  return text.slice(0, 200) + (text.length > 200 ? '...' : '')
})

// 7. Screenshot
info('Step 7: screenshot')
await run('action=screenshot', async () => {
  const r = await executeBrowserAction({ action: 'screenshot', type: 'png' }, baseUrl)
  const img = r.content.find(c => c.type === 'image')
  return img ? `image captured (${Math.round((img.data?.length ?? 0) * 0.75 / 1024)}kb)` : r.content[0].text
})

console.log(`\n${BOLD}Done.${RESET}\n`)
