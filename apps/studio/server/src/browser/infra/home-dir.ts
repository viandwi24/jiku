/**
 * Minimal home-dir shim for Jiku browser engine.
 * Provides home directory resolution utilities used by config/paths.ts and utils.ts.
 */

import os from "node:os";

/**
 * Resolve the home directory from environment or fallback to os.homedir().
 * Supports OPENCLAW_HOME and HOME overrides.
 */
export function resolveRequiredHomeDir(
  env: NodeJS.ProcessEnv = process.env,
  homedir: () => string = os.homedir,
): string {
  const override = env.OPENCLAW_HOME?.trim() || env.HOME?.trim();
  if (override) {
    return override;
  }
  return homedir();
}

/**
 * Resolve the effective home directory (may return undefined if not resolvable).
 */
export function resolveEffectiveHomeDir(
  env: NodeJS.ProcessEnv = process.env,
  homedir: () => string = os.homedir,
): string | undefined {
  try {
    return resolveRequiredHomeDir(env, homedir);
  } catch {
    return undefined;
  }
}

/**
 * Expand a leading ~ or $OPENCLAW_HOME prefix in a path string.
 */
export function expandHomePrefix(
  input: string,
  opts: {
    home: string;
    env?: NodeJS.ProcessEnv;
    homedir?: () => string;
  },
): string {
  const { home } = opts;
  if (input === "~") {
    return home;
  }
  if (input.startsWith("~/") || input.startsWith("~\\")) {
    return `${home}${input.slice(1)}`;
  }
  return input;
}
