/**
 * Browser control auth shim for Jiku Studio.
 *
 * Jiku Studio manages its own authentication layer. The browser control server
 * is bound to 127.0.0.1 (loopback only) and is only accessible from within
 * the Studio server process, so no additional auth is needed.
 */

export type BrowserControlAuth = {
  token?: string;
  password?: string;
};

/**
 * Returns empty auth (no token, no password).
 * Jiku Studio's own auth layer protects access to the browser control server.
 */
export function resolveBrowserControlAuth(
  _cfg?: unknown,
  _env?: NodeJS.ProcessEnv,
): BrowserControlAuth {
  return {};
}

/**
 * Returns empty auth — no auto-generation needed in Jiku Studio.
 */
export async function ensureBrowserControlAuth(_params: {
  cfg?: unknown;
  env?: NodeJS.ProcessEnv;
}): Promise<{
  auth: BrowserControlAuth;
  generatedToken?: string;
}> {
  return { auth: {} };
}
