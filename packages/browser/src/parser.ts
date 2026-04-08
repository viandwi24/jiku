import type { BrowserCommand, BrowserResult, CliOutput, CommandResult } from "./types.ts";

/**
 * Parse raw CommandResult (stdout/stderr/exitCode) from agent-browser CLI
 * into a structured BrowserResult with AI-friendly error hints.
 */
export function parseCommandResult<T = unknown>(
  raw: CommandResult,
  command: BrowserCommand,
): BrowserResult<T> {
  // Try parse JSON from stdout
  const trimmed = raw.stdout.trim();
  if (trimmed) {
    try {
      const cli = JSON.parse(trimmed) as CliOutput<T>;
      if (cli.success) {
        return { success: true, data: cli.data, error: null, hint: null };
      }
      // CLI reported failure — add AI hint based on error message
      const hint = generateHint(cli.error ?? "Unknown error", command);
      return { success: false, data: null, error: cli.error, hint };
    } catch {
      // stdout is not valid JSON — treat as plain text output
      return {
        success: raw.exitCode === 0,
        data: (trimmed as unknown) as T,
        error: raw.exitCode !== 0 ? trimmed : null,
        hint: raw.exitCode !== 0 ? generateHint(trimmed, command) : null,
      };
    }
  }

  // No stdout — check stderr
  if (raw.stderr.trim()) {
    const hint = generateHint(raw.stderr.trim(), command);
    return { success: false, data: null, error: raw.stderr.trim(), hint };
  }

  // No output at all
  if (raw.exitCode !== 0) {
    return {
      success: false,
      data: null,
      error: `Command exited with code ${raw.exitCode}`,
      hint: "The browser command failed silently. Verify the browser is running and the CDP connection is active.",
    };
  }

  return { success: true, data: null, error: null, hint: null };
}

// --- Error Hint Generation ---

const HINT_PATTERNS: ReadonlyArray<{ pattern: RegExp; hint: string }> = [
  {
    pattern: /element.*not found|no element|could not find/i,
    hint: "The element ref is no longer valid. Run a snapshot to get fresh element refs before interacting.",
  },
  {
    pattern: /multiple elements|strict mode|resolved to \d+ elements/i,
    hint: "Multiple elements matched the ref. Run a snapshot with interactive mode to get more specific refs.",
  },
  {
    pattern: /not interactable|not clickable|intercepted/i,
    hint: "The element exists but cannot be interacted with. Try scrolling it into view, closing any overlays, or waiting for animations to complete.",
  },
  {
    pattern: /not visible|hidden|display.*none/i,
    hint: "The element is hidden. It may appear after scrolling, hovering, or triggering another action. Run a snapshot to see visible elements.",
  },
  {
    pattern: /timeout|timed out/i,
    hint: "The operation timed out. The page may still be loading. Try waiting longer or check if the page is responsive.",
  },
  {
    pattern: /navigation|net::err|failed to load|ERR_/i,
    hint: "Navigation or network error. The URL may be unreachable, or the page failed to load. Verify the URL and try again.",
  },
  {
    pattern: /CDP.*connect|WebSocket.*failed|connection.*refused/i,
    hint: "Cannot connect to the browser via CDP. Verify the browser container is running and the CDP endpoint is correct.",
  },
  {
    pattern: /no such file|ENOENT|directory/i,
    hint: "File or directory not found. For screenshots, ensure the target directory exists.",
  },
  {
    pattern: /detached|frame.*detached|execution context/i,
    hint: "The page or frame was navigated away during the operation. Run a snapshot to get the current page state.",
  },
  {
    pattern: /dialog|alert|confirm|prompt/i,
    hint: "A browser dialog (alert/confirm/prompt) may be blocking interaction. Try dismissing it first.",
  },
];

function generateHint(error: string, command: BrowserCommand): string {
  for (const { pattern, hint } of HINT_PATTERNS) {
    if (pattern.test(error)) {
      return hint;
    }
  }

  // Generic hints based on command action
  switch (command.action) {
    case "click":
    case "fill":
    case "type":
    case "hover":
    case "select":
      return "The interaction failed. Run a snapshot to verify the element ref is still valid and the element is visible.";
    case "snapshot":
      return "Failed to capture page snapshot. The page may still be loading — try waiting, then snapshot again.";
    case "screenshot":
      return "Screenshot capture failed. Verify the browser is on a loaded page and the output path is writable.";
    case "open":
      return "Navigation failed. Check that the URL is valid and reachable from the browser container.";
    case "wait":
      return "Wait condition was not met. The expected element, text, or URL may not appear — verify your condition.";
    default:
      return "The command failed. Run a snapshot to see the current page state and try again.";
  }
}
