import type { BrowserProjectConfig } from '@jiku-studio/db'
import type { ResolvedBrowserConfig } from './browser/config.js'
import { DEFAULT_BROWSER_CONTROL_PORT } from './config/port-defaults.js'

/**
 * Build the base ResolvedBrowserConfig for the shared browser control server.
 *
 * The control server is a singleton — all projects share one Node child process.
 * Each project registers its own profile at runtime.
 *
 * Modes:
 *   - remote: attachOnly=true, CDP connects to an external Chromium (cdp_url from project config)
 *   - managed: attachOnly=false, browser control server can launch a local Chrome executable
 */
export function resolveProjectBrowserConfig(
  cfg: BrowserProjectConfig,
  projectId: string,
): ResolvedBrowserConfig {
  const isRemote = cfg.mode === 'remote' && Boolean(cfg.cdp_url)

  const cdpUrl = isRemote
    ? cfg.cdp_url!.trim().replace(/\/$/, '')
    : `http://127.0.0.1:9222`

  const cdpParsed = new URL(cdpUrl)
  const cdpHost = cdpParsed.hostname
  const cdpPort = parseInt(cdpParsed.port || (cdpParsed.protocol === 'https:' ? '443' : '80'), 10)
  const cdpIsLoopback = cdpHost === '127.0.0.1' || cdpHost === 'localhost' || cdpHost === '::1'

  const profiles: ResolvedBrowserConfig['profiles'] = {
    [projectId]: isRemote
      ? { cdpUrl, color: '#FF4500', driver: 'openclaw' } as never
      : { cdpPort: cdpPort || 9222, color: '#FF4500' } as never,
  }

  return {
    enabled: true,
    evaluateEnabled: cfg.evaluate_enabled ?? true,
    controlPort: DEFAULT_BROWSER_CONTROL_PORT,
    cdpProtocol: cdpParsed.protocol === 'https:' ? 'https' : 'http',
    cdpHost,
    cdpIsLoopback,
    remoteCdpTimeoutMs: cfg.timeout_ms ?? 1500,
    remoteCdpHandshakeTimeoutMs: Math.max(2000, (cfg.timeout_ms ?? 1500) * 2),
    color: '#FF4500',
    executablePath: cfg.executable_path,
    headless: cfg.headless ?? true,
    noSandbox: cfg.no_sandbox ?? false,
    attachOnly: isRemote,
    defaultProfile: projectId,
    profiles,
  }
}

/**
 * Base config for starting the shared browser control server with no profiles.
 * Used only for the initial server spawn — profiles are registered per-project afterward.
 */
export function resolveBaseServerConfig(): ResolvedBrowserConfig {
  return {
    enabled: true,
    evaluateEnabled: true,
    controlPort: DEFAULT_BROWSER_CONTROL_PORT,
    cdpProtocol: 'http',
    cdpHost: '127.0.0.1',
    cdpIsLoopback: true,
    remoteCdpTimeoutMs: 1500,
    remoteCdpHandshakeTimeoutMs: 3000,
    color: '#FF4500',
    executablePath: undefined,
    headless: true,
    noSandbox: false,
    attachOnly: false,
    defaultProfile: 'default',
    profiles: {},
  }
}
