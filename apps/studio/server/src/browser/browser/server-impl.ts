import type { Server } from "node:http";
import express from "express";
import type { BrowserRouteRegistrar } from "./routes/types.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { type ResolvedBrowserConfig, resolveProfile } from "./config.js";
import { type BrowserControlAuth } from "./control-auth.js";
import { ensureChromeExtensionRelayServer } from "./extension-relay.js";
import { isPwAiLoaded } from "./pw-ai-state.js";
import { registerBrowserRoutes } from "./routes/index.js";
import {
  type BrowserServerState,
  createBrowserRouteContext,
  listKnownProfileNames,
} from "./server-context.js";
import {
  installBrowserAuthMiddleware,
  installBrowserCommonMiddleware,
} from "./server-middleware.js";

let state: BrowserServerState | null = null;
const log = createSubsystemLogger("browser");
const logServer = log.child("server");

/**
 * The actual browser control server implementation — runs under Node.js
 * (not Bun) so that Playwright's HTTP upgrade handling works correctly.
 *
 * Imported by node-server-entry.ts which is spawned as a child process.
 */
export async function startBrowserControlServer(
  resolved: ResolvedBrowserConfig,
  browserAuth: BrowserControlAuth = {},
): Promise<BrowserServerState | null> {
  if (state) {
    return state;
  }

  if (!resolved.enabled) {
    return null;
  }

  const app = express();
  installBrowserCommonMiddleware(app);
  installBrowserAuthMiddleware(app, browserAuth);

  const ctx = createBrowserRouteContext({
    getState: () => state,
    refreshConfigFromDisk: false,
  });
  registerBrowserRoutes(app as unknown as BrowserRouteRegistrar, ctx);

  const port = resolved.controlPort;
  const server = await new Promise<Server>((resolve, reject) => {
    const s = app.listen(port, "127.0.0.1", () => resolve(s));
    s.once("error", reject);
  }).catch((err) => {
    logServer.error(`openclaw browser server failed to bind 127.0.0.1:${port}: ${String(err)}`);
    return null;
  });

  if (!server) {
    return null;
  }

  state = {
    server,
    port,
    resolved,
    profiles: new Map(),
  };

  for (const name of Object.keys(resolved.profiles)) {
    const profile = resolveProfile(resolved, name);
    if (!profile || profile.driver !== "extension") {
      continue;
    }
    await ensureChromeExtensionRelayServer({ cdpUrl: profile.cdpUrl }).catch((err) => {
      logServer.warn(`Chrome extension relay init failed for profile "${name}": ${String(err)}`);
    });
  }

  const authMode = browserAuth.token ? "token" : browserAuth.password ? "password" : "off";
  logServer.info(`Browser control listening on http://127.0.0.1:${port}/ (auth=${authMode})`);
  return state;
}

export async function stopBrowserControlServer(): Promise<void> {
  const current = state;
  if (!current) {
    return;
  }

  const ctx = createBrowserRouteContext({
    getState: () => state,
    refreshConfigFromDisk: false,
  });

  try {
    if (current) {
      for (const name of listKnownProfileNames(current)) {
        try {
          await ctx.forProfile(name).stopRunningBrowser();
        } catch {
          // ignore
        }
      }
    }
  } catch (err) {
    logServer.warn(`openclaw browser stop failed: ${String(err)}`);
  }

  if (current.server) {
    await new Promise<void>((resolve) => {
      current.server?.close(() => resolve());
    });
  }
  state = null;

  if (isPwAiLoaded()) {
    try {
      const mod = await import("./pw-ai.js");
      await mod.closePlaywrightBrowserConnection();
    } catch {
      // ignore
    }
  }
}
