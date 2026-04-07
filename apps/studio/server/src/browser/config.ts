import type { ResolvedBrowserConfig } from './browser/config.js'
import { DEFAULT_BROWSER_CONTROL_PORT } from './config/port-defaults.js'

/**
 * Build the base ResolvedBrowserConfig for the shared browser control server.
 *
 * No profiles are included here — each project registers its own profile
 * at runtime via POST /profiles/create on the control server.
 *
 * Only remote mode is supported in this setup.
 */
export function resolveRemoteBrowserConfig(): ResolvedBrowserConfig {
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
    attachOnly: true,
    defaultProfile: 'default',
    profiles: {},
  }
}
