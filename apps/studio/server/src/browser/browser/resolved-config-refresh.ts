/**
 * Config refresh shim for Jiku browser engine.
 *
 * In Jiku Studio, the browser config is passed at startup and does not need
 * hot-reload from disk. All disk-read paths are no-ops here.
 */

import type { BrowserServerState } from "./server-context.types.js";
import { resolveProfile, type ResolvedBrowserProfile } from "./config.js";

/**
 * No-op: In Jiku Studio, config is passed at startup and does not change.
 * The original implementation re-read the config file from disk; we skip that.
 */
export function refreshResolvedBrowserConfigFromDisk(_params: {
  current: BrowserServerState;
  refreshConfigFromDisk: boolean;
  mode: "cached" | "fresh";
}): void {
  // No-op — config is injected at startup, not reloaded from disk.
}

export function resolveBrowserProfileWithHotReload(params: {
  current: BrowserServerState;
  refreshConfigFromDisk: boolean;
  name: string;
}): ResolvedBrowserProfile | null {
  // No hot-reload: just resolve from the current in-memory resolved config.
  return resolveProfile(params.current.resolved, params.name);
}
