import { describe, test, expect } from "bun:test";
import { parseCommandResult } from "../parser.ts";
import type { BrowserCommand, CommandResult } from "../types.ts";

const openCmd: BrowserCommand = { action: "open", url: "https://example.com" };
const clickCmd: BrowserCommand = { action: "click", ref: "@e1" };
const snapshotCmd: BrowserCommand = { action: "snapshot", interactive: true };
const screenshotCmd: BrowserCommand = { action: "screenshot", full: true };
const waitCmd: BrowserCommand = { action: "wait", ms: 1000 };

function raw(stdout: string, exitCode = 0): CommandResult {
  return { stdout, stderr: "", exitCode };
}

describe("parseCommandResult", () => {
  // --- Success cases ---

  test("parse successful navigate response", () => {
    const result = parseCommandResult(
      raw(JSON.stringify({ success: true, data: { title: "Example", url: "https://example.com/" }, error: null })),
      openCmd,
    );

    expect(result.success).toBe(true);
    expect(result.data).toEqual({ title: "Example", url: "https://example.com/" });
    expect(result.error).toBeNull();
    expect(result.hint).toBeNull();
  });

  test("parse successful snapshot response", () => {
    const result = parseCommandResult(
      raw(
        JSON.stringify({
          success: true,
          data: {
            origin: "https://example.com/",
            refs: { e1: { name: "Example", role: "heading" }, e2: { name: "Learn more", role: "link" } },
            snapshot: '- heading "Example" [ref=e1]\n- link "Learn more" [ref=e2]',
          },
          error: null,
        }),
      ),
      snapshotCmd,
    );

    expect(result.success).toBe(true);
    expect(result.data).toBeDefined();
    const data = result.data as Record<string, unknown>;
    expect(data.refs).toBeDefined();
    expect(data.snapshot).toContain("heading");
    expect(result.hint).toBeNull();
  });

  test("parse successful screenshot response", () => {
    const result = parseCommandResult(
      raw(JSON.stringify({ success: true, data: { path: "/tmp/shot.png" }, error: null })),
      screenshotCmd,
    );

    expect(result.success).toBe(true);
    expect((result.data as Record<string, unknown>).path).toBe("/tmp/shot.png");
  });

  test("parse null data success (e.g. wait)", () => {
    const result = parseCommandResult(
      raw(JSON.stringify({ success: true, data: null, error: null })),
      waitCmd,
    );

    expect(result.success).toBe(true);
    expect(result.data).toBeNull();
    expect(result.error).toBeNull();
  });

  // --- Error cases with hints ---

  test("element not found → hint to re-snapshot", () => {
    const result = parseCommandResult(
      raw(JSON.stringify({ success: false, data: null, error: "Element not found for ref @e5" }), 1),
      clickCmd,
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain("Element not found");
    expect(result.hint).toContain("snapshot");
    expect(result.hint).toContain("fresh element refs");
  });

  test("timeout → hint about page loading", () => {
    const result = parseCommandResult(
      raw(JSON.stringify({ success: false, data: null, error: "Timeout 30000ms exceeded" }), 1),
      openCmd,
    );

    expect(result.success).toBe(false);
    expect(result.hint).toContain("timed out");
  });

  test("not interactable → hint to scroll or close overlay", () => {
    const result = parseCommandResult(
      raw(JSON.stringify({ success: false, data: null, error: "Element is not interactable" }), 1),
      clickCmd,
    );

    expect(result.success).toBe(false);
    expect(result.hint).toContain("scroll");
    expect(result.hint).toContain("overlay");
  });

  test("CDP connect failure → hint about browser container", () => {
    const result = parseCommandResult(
      raw(JSON.stringify({ success: false, data: null, error: "CDP WebSocket connect failed" }), 1),
      openCmd,
    );

    expect(result.success).toBe(false);
    expect(result.hint).toContain("CDP");
    expect(result.hint).toContain("browser container");
  });

  test("file not found → hint about directory", () => {
    const result = parseCommandResult(
      raw(JSON.stringify({ success: false, data: null, error: "no such file or directory" }), 1),
      screenshotCmd,
    );

    expect(result.success).toBe(false);
    expect(result.hint).toContain("directory exists");
  });

  test("multiple elements → hint to re-snapshot", () => {
    const result = parseCommandResult(
      raw(JSON.stringify({ success: false, data: null, error: "strict mode violation: resolved to 3 elements" }), 1),
      clickCmd,
    );

    expect(result.success).toBe(false);
    expect(result.hint).toContain("Multiple elements");
  });

  test("generic click error → fallback interaction hint", () => {
    const result = parseCommandResult(
      raw(JSON.stringify({ success: false, data: null, error: "Something unexpected went wrong" }), 1),
      clickCmd,
    );

    expect(result.success).toBe(false);
    expect(result.hint).toContain("snapshot");
    expect(result.hint).toContain("element ref");
  });

  // --- Edge cases ---

  test("non-JSON stdout with exit 0 → success with raw text", () => {
    const result = parseCommandResult(raw("Done", 0), openCmd);

    expect(result.success).toBe(true);
    expect(result.data).toBe("Done");
    expect(result.error).toBeNull();
  });

  test("non-JSON stdout with exit 1 → error with raw text", () => {
    const result = parseCommandResult(raw("Something failed", 1), openCmd);

    expect(result.success).toBe(false);
    expect(result.error).toBe("Something failed");
    expect(result.hint).toBeTruthy();
  });

  test("empty stdout + stderr → error from stderr", () => {
    const result = parseCommandResult(
      { stdout: "", stderr: "spawn agent-browser ENOENT", exitCode: 1 },
      openCmd,
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain("ENOENT");
    expect(result.hint).toBeTruthy();
  });

  test("empty stdout + empty stderr + nonzero exit → generic error", () => {
    const result = parseCommandResult(
      { stdout: "", stderr: "", exitCode: 127 },
      openCmd,
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain("code 127");
    expect(result.hint).toContain("browser is running");
  });

  test("empty stdout + empty stderr + exit 0 → success with null data", () => {
    const result = parseCommandResult(
      { stdout: "", stderr: "", exitCode: 0 },
      waitCmd,
    );

    expect(result.success).toBe(true);
    expect(result.data).toBeNull();
  });
});
