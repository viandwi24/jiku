/**
 * Minimal logger shim for Jiku browser engine.
 * Replaces the tslog-based OpenClaw logger with simple console delegates.
 */

export function logDebug(message: string): void {
  if (
    process.env.OPENCLAW_VERBOSE === "1" ||
    process.env.DEBUG === "1" ||
    process.env.DEBUG === "openclaw" ||
    process.env.DEBUG === "*"
  ) {
    console.debug(`[openclaw:debug] ${message}`);
  }
}

export function logInfo(message: string): void {
  console.log(`[openclaw:info] ${message}`);
}

export function logWarn(message: string): void {
  console.warn(`[openclaw:warn] ${message}`);
}

export function logError(message: string): void {
  console.error(`[openclaw:error] ${message}`);
}

export function logFatal(message: string): void {
  console.error(`[openclaw:fatal] ${message}`);
}
