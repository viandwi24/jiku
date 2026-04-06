import { createSubsystemLogger } from "../logging/subsystem.js";
import { type ResolvedBrowserConfig } from "./config.js";
import { type BrowserControlAuth } from "./control-auth.js";
import type { BrowserServerState } from "./server-context.js";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, type ChildProcess } from "node:child_process";

let state: BrowserServerState | null = null;
let nodeChild: ChildProcess | null = null;
const nodeChildren = new Set<ChildProcess>();
const log = createSubsystemLogger("browser");
const logServer = log.child("server");

// Kill all spawned children on any process exit — handles SIGTERM, SIGINT, and crashes.
// `detached: false` (default) means the OS will SIGKILL the child if the parent dies
// ungracefully, but registering these hooks ensures a clean shutdown on normal exit too.
function killAllChildren() {
  for (const child of nodeChildren) {
    try { child.kill("SIGKILL"); } catch { /* ignore */ }
  }
  nodeChildren.clear();
}
process.once("exit", killAllChildren);
process.once("SIGTERM", () => { killAllChildren(); process.exit(0); });
process.once("SIGINT",  () => { killAllChildren(); process.exit(0); });

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Start the browser control server as a Node.js child process.
 *
 * Playwright's connectOverCDP requires Node.js-style HTTP upgrade handling,
 * which Bun v1.x does not implement correctly (fires 'response' instead of
 * 'upgrade' for 101 responses). Running the server under Node.js fixes this.
 */
export async function startBrowserControlServer(
  resolved: ResolvedBrowserConfig,
  _browserAuth: BrowserControlAuth = {},
): Promise<BrowserServerState | null> {
  if (state) {
    return state;
  }

  if (!resolved.enabled) {
    return null;
  }

  const entryFile = path.resolve(__dirname, "../node-server-entry.ts");
  const loaderFile = path.resolve(__dirname, "../node-ts-loader.mjs");

  const child = spawn(
    "node",
    [
      "--experimental-strip-types",
      "--experimental-loader",
      loaderFile,
      entryFile,
    ],
    {
      env: {
        ...process.env,
        BROWSER_SERVER_CONFIG: JSON.stringify(resolved),
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );

  nodeChild = child;
  nodeChildren.add(child);

  const port = await new Promise<number>((resolve, reject) => {
    const timeout = setTimeout(() => {
      child.kill();
      reject(new Error("Browser control server timed out waiting for READY signal"));
    }, 15000);

    let buf = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      buf += chunk.toString();
      const lines = buf.split("\n");
      buf = lines.pop() ?? "";
      for (const line of lines) {
        if (line.startsWith("READY:")) {
          clearTimeout(timeout);
          resolve(Number(line.slice(6)));
        } else if (line.startsWith("ERROR:")) {
          clearTimeout(timeout);
          reject(new Error(line.slice(6)));
        }
      }
    });

    child.stderr?.on("data", (chunk: Buffer) => {
      const text = chunk.toString();
      if (!text.includes("ExperimentalWarning") && !text.includes("--experimental")) {
        logServer.warn(`[node-browser] ${text.trim()}`);
      }
    });

    child.on("error", (err) => {
      clearTimeout(timeout);
      reject(new Error(`Failed to spawn Node.js browser server: ${err.message}`));
    });

    child.on("exit", (code) => {
      clearTimeout(timeout);
      if (code !== 0) {
        reject(new Error(`Browser control server exited with code ${code}`));
      }
    });
  }).catch((err) => {
    logServer.error(`openclaw browser server failed: ${String(err)}`);
    nodeChildren.delete(child);
    return null;
  });

  if (!port) {
    return null;
  }

  state = {
    server: null as never,
    port,
    resolved,
    profiles: new Map(),
  };

  child.on("exit", () => {
    nodeChildren.delete(child);
    if (state?.port === port) {
      state = null;
      nodeChild = null;
    }
  });

  return state;
}

export async function stopBrowserControlServer(): Promise<void> {
  const child = nodeChild;
  if (!child) return;

  await new Promise<void>((resolve) => {
    const t = setTimeout(() => { child.kill("SIGKILL"); resolve(); }, 5000);
    child.once("exit", () => { clearTimeout(t); resolve(); });
    child.kill("SIGTERM");
  });

  state = null;
  nodeChild = null;
}
