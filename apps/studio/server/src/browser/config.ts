import type { BrowserProjectConfig } from '@jiku-studio/db'
import type { ResolvedBrowserConfig } from './browser/config.js'

const DEFAULT_CONTROL_PORT = 18791

/**
 * Map Jiku's BrowserProjectConfig to OpenClaw's ResolvedBrowserConfig.
 * Supports two modes:
 *   - managed: local Playwright browser (default)
 *   - remote:  external Chromium via CDP URL (e.g. Docker container)
 */
export function resolveProjectBrowserConfig(
  cfg: BrowserProjectConfig,
  projectId: string,
  portOffset = 0,
): ResolvedBrowserConfig {
  const controlPort = (cfg.control_port ?? DEFAULT_CONTROL_PORT) + portOffset
  const isRemote = cfg.mode === 'remote' && Boolean(cfg.cdp_url)
  const cdpUrl = isRemote
    ? cfg.cdp_url!.trim().replace(/\/$/, '')
    : `http://127.0.0.1:${controlPort + 1}`

  const cdpParsed = new URL(cdpUrl)
  const cdpHost = cdpParsed.hostname
  const cdpPort = parseInt(cdpParsed.port || (cdpParsed.protocol === 'https:' ? '443' : '80'), 10)
  const cdpIsLoopback = cdpHost === '127.0.0.1' || cdpHost === 'localhost' || cdpHost === '::1'

  // Use projectId as the profile key so each project gets an isolated
  // browser context even when sharing the same control server.
  const profiles: ResolvedBrowserConfig['profiles'] = {
    [projectId]: isRemote
      ? { cdpUrl, color: '#FF4500', driver: 'openclaw' } as never
      : { cdpPort: cdpPort || controlPort + 1, color: '#FF4500' } as never,
  }

  return {
    enabled: true,
    evaluateEnabled: cfg.evaluate_enabled ?? true,
    controlPort,
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
