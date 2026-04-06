/**
 * Minimal globals shim for Jiku browser engine.
 * Replaces the OpenClaw global state module.
 */

/**
 * Returns whether verbose logging is enabled.
 * Checks OPENCLAW_VERBOSE or DEBUG environment variables.
 */
export function shouldLogVerbose(): boolean {
  return (
    process.env.OPENCLAW_VERBOSE === "1" ||
    process.env.DEBUG === "1" ||
    process.env.DEBUG === "openclaw" ||
    process.env.DEBUG === "*"
  );
}

/**
 * Log a verbose message to stdout if verbose logging is enabled.
 */
export function logVerbose(message: string): void {
  if (shouldLogVerbose()) {
    console.log(`[openclaw:verbose] ${message}`);
  }
}

/**
 * Wrap a string to mark it as "dangerous" context for logging.
 * In the shim, returns the string unchanged.
 */
export function danger(message: string): string {
  return message;
}
