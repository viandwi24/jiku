/**
 * Minimal spawn-utils shim for Jiku browser engine.
 */

import type { StdioOptions } from "node:child_process";

/**
 * Resolve the stdio configuration for a spawned command.
 * When hasInput is true, stdin must be "pipe" so we can write to it.
 * When preferInherit is true and there is no input, use "inherit" for better TTY support.
 */
export function resolveCommandStdio(params: {
  hasInput: boolean;
  preferInherit?: boolean;
}): StdioOptions {
  const { hasInput, preferInherit } = params;
  if (hasInput) {
    return ["pipe", "pipe", "pipe"];
  }
  if (preferInherit) {
    return ["inherit", "pipe", "pipe"];
  }
  return ["ignore", "pipe", "pipe"];
}
