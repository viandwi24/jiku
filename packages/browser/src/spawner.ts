import { spawn } from "node:child_process";
import { readFile, unlink } from "node:fs/promises";
import path from "node:path";
import { parseCommandResult } from "./parser.ts";
import type { BrowserCommand, BrowserResult, CommandResult } from "./types.ts";

const DEFAULT_BIN = path.resolve(import.meta.dirname, "../node_modules/.bin/agent-browser");
const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * Normalize a CDP endpoint to the format agent-browser expects.
 *
 * Accepts:
 *  - "ws://host:port"           → "http://host:port"
 *  - "wss://host:port/path"     → kept as-is (remote service with full URL)
 *  - "http://host:port"         → kept as-is
 *  - "9222"                     → kept as-is (port number)
 */
export function resolveCdpEndpoint(endpoint: string): string {
  if (/^\d+$/.test(endpoint)) {
    return endpoint;
  }

  try {
    const url = new URL(endpoint);

    if (url.protocol === "wss:" && url.pathname !== "/" && url.pathname !== "") {
      return endpoint;
    }

    if (url.protocol === "ws:" || url.protocol === "wss:") {
      url.protocol = url.protocol === "wss:" ? "https:" : "http:";
      return url.toString().replace(/\/$/, "");
    }

    return endpoint;
  } catch {
    return endpoint;
  }
}

/**
 * Build CLI arguments from a BrowserCommand + CDP endpoint.
 */
export function buildArgs(cdpEndpoint: string, command: BrowserCommand): string[] {
  const base = ["--cdp", cdpEndpoint, "--json"];

  switch (command.action) {
    // --- Navigation ---
    case "open":
      return [...base, "open", command.url];
    case "back":
      return [...base, "back"];
    case "forward":
      return [...base, "forward"];
    case "reload":
      return [...base, "reload"];
    case "close":
      return [...base, "close"];

    // --- Observation ---
    case "snapshot": {
      const args = [...base, "snapshot"];
      if (command.interactive) args.push("-i");
      if (command.compact) args.push("-c");
      if (command.depth !== undefined) args.push("-d", String(command.depth));
      if (command.selector) args.push("-s", command.selector);
      return args;
    }
    case "screenshot": {
      const args = [...base, "screenshot"];
      if (command.full) args.push("--full");
      if (command.annotate) args.push("--annotate");
      return args;
    }
    case "pdf":
      return [...base, "pdf", command.path];
    case "get": {
      const args = [...base, "get", command.subcommand];
      if (command.ref) args.push(command.ref);
      if (command.attr) args.push(command.attr);
      return args;
    }

    // --- Interaction ---
    case "click": {
      const args = [...base, "click", command.ref];
      if (command.newTab) args.push("--new-tab");
      return args;
    }
    case "dblclick":
      return [...base, "dblclick", command.ref];
    case "fill":
      return [...base, "fill", command.ref, command.text];
    case "type":
      return [...base, "type", command.ref, command.text];
    case "press":
      return [...base, "press", command.key];
    case "hover":
      return [...base, "hover", command.ref];
    case "focus":
      return [...base, "focus", command.ref];
    case "check":
      return [...base, "check", command.ref];
    case "uncheck":
      return [...base, "uncheck", command.ref];
    case "select":
      return [...base, "select", command.ref, ...command.values];
    case "drag":
      return [...base, "drag", command.src, command.dst];
    case "upload":
      return [...base, "upload", command.ref, ...command.files];
    case "scroll": {
      const args = [...base, "scroll", command.direction];
      if (command.pixels !== undefined) args.push(String(command.pixels));
      return args;
    }
    case "scrollintoview":
      return [...base, "scrollintoview", command.ref];

    // --- Wait ---
    case "wait": {
      const args = [...base, "wait"];
      if (command.ref) args.push(command.ref);
      if (command.text) args.push("--text", command.text);
      if (command.url) args.push("--url", command.url);
      if (command.ms !== undefined) args.push(String(command.ms));
      return args;
    }

    // --- Tabs ---
    case "tab": {
      switch (command.operation) {
        case "list":
          return [...base, "tab", "list"];
        case "new":
          return command.url ? [...base, "tab", "new", command.url] : [...base, "tab", "new"];
        case "close":
          return command.index !== undefined ? [...base, "tab", "close", String(command.index)] : [...base, "tab", "close"];
        case "switch":
          return [...base, "tab", String(command.index)];
      }
    }

    // --- JavaScript ---
    case "eval":
      return [...base, "eval", command.js];

    // --- Cookies & Storage ---
    case "cookies": {
      if (command.operation === "set") {
        return [...base, "cookies", "set", JSON.stringify(command.cookie)];
      }
      return [...base, "cookies", command.operation];
    }
    case "storage":
      return [...base, "storage", command.storageType];

    // --- Batch ---
    case "batch":
      return [...base, "batch", ...command.commands];
  }
}

// Track endpoints that have been connected via `agent-browser connect`
const connectedEndpoints = new Set<string>();

/**
 * Run `agent-browser connect <endpoint>` once per endpoint to establish
 * a session. Subsequent calls with the same endpoint are no-ops.
 */
async function ensureConnected(endpoint: string, bin: string, timeoutMs: number): Promise<void> {
  const resolved = resolveCdpEndpoint(endpoint);
  if (connectedEndpoints.has(resolved)) return;

  await new Promise<void>((resolve, reject) => {
    const child = spawn(bin, ["connect", resolved], {
      stdio: ["pipe", "pipe", "pipe"],
      timeout: timeoutMs,
    });

    child.on("error", (err) => {
      reject(new Error(`Failed to connect to CDP: ${err.message}`));
    });

    child.on("close", (code) => {
      if (code === 0) {
        connectedEndpoints.add(resolved);
        resolve();
      } else {
        reject(new Error(`agent-browser connect exited with code ${code}`));
      }
    });
  });
}

/**
 * Spawn the agent-browser CLI process and collect output.
 */
export async function execCommand(
  cdpEndpoint: string,
  command: BrowserCommand,
  options?: {
    bin?: string;
    timeoutMs?: number;
  },
): Promise<CommandResult> {
  const bin = options?.bin ?? DEFAULT_BIN;
  const timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  await ensureConnected(cdpEndpoint, bin, timeoutMs);

  const resolvedEndpoint = resolveCdpEndpoint(cdpEndpoint);
  const args = buildArgs(resolvedEndpoint, command);

  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, {
      stdio: ["pipe", "pipe", "pipe"],
      timeout: timeoutMs,
    });

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];

    child.stdout.on("data", (chunk: Buffer) => stdoutChunks.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderrChunks.push(chunk));

    child.on("error", (err) => {
      reject(new Error(`Failed to spawn ${bin}: ${err.message}`));
    });

    child.on("close", (code) => {
      resolve({
        stdout: Buffer.concat(stdoutChunks).toString("utf-8"),
        stderr: Buffer.concat(stderrChunks).toString("utf-8"),
        exitCode: code ?? 1,
      });
    });
  });
}

/**
 * Execute a browser command and return a parsed, AI-friendly result
 * with structured data and error hints.
 */
export async function execBrowserCommand<T = unknown>(
  cdpEndpoint: string,
  command: BrowserCommand,
  options?: {
    bin?: string;
    timeoutMs?: number;
  },
): Promise<BrowserResult<T>> {
  try {
    const raw = await execCommand(cdpEndpoint, command, options);
    const result = parseCommandResult<T>(raw, command);

    // Screenshot post-processing: read temp file → base64 → delete
    if (command.action === "screenshot" && result.success && result.data) {
      const data = result.data as Record<string, unknown>;
      if (typeof data.path === "string") {
        const filePath = data.path;
        const buffer = await readFile(filePath);
        const base64 = buffer.toString("base64");
        // Clean up temp file
        await unlink(filePath).catch(() => {});
        return {
          success: true,
          data: { base64, format: "png" } as unknown as T,
          error: null,
          hint: null,
        };
      }
    }

    return result;
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown spawn error";
    return {
      success: false,
      data: null,
      error: message,
      hint: "Failed to execute the browser command. Verify the agent-browser binary is installed and the CDP connection is active.",
    };
  }
}
