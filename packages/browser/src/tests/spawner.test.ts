import { describe, test, expect } from "bun:test";
import { buildArgs } from "../spawner.ts";

const CDP = "ws://localhost:9222";

describe("buildArgs", () => {
  test("open url", () => {
    const args = buildArgs(CDP, { action: "open", url: "https://example.com" });
    expect(args).toEqual(["--cdp", CDP, "--json", "open", "https://example.com"]);
  });

  test("snapshot interactive + compact", () => {
    const args = buildArgs(CDP, { action: "snapshot", interactive: true, compact: true });
    expect(args).toEqual(["--cdp", CDP, "--json", "snapshot", "-i", "-c"]);
  });

  test("snapshot with selector", () => {
    const args = buildArgs(CDP, { action: "snapshot", selector: "#main" });
    expect(args).toEqual(["--cdp", CDP, "--json", "snapshot", "-s", "#main"]);
  });

  test("click ref", () => {
    const args = buildArgs(CDP, { action: "click", ref: "@e1" });
    expect(args).toEqual(["--cdp", CDP, "--json", "click", "@e1"]);
  });

  test("click with new tab", () => {
    const args = buildArgs(CDP, { action: "click", ref: "@e2", newTab: true });
    expect(args).toEqual(["--cdp", CDP, "--json", "click", "@e2", "--new-tab"]);
  });

  test("fill", () => {
    const args = buildArgs(CDP, { action: "fill", ref: "@e3", text: "hello" });
    expect(args).toEqual(["--cdp", CDP, "--json", "fill", "@e3", "hello"]);
  });

  test("screenshot with --full", () => {
    const args = buildArgs(CDP, { action: "screenshot", full: true });
    expect(args).toEqual(["--cdp", CDP, "--json", "screenshot", "--full"]);
  });

  test("screenshot annotate", () => {
    const args = buildArgs(CDP, { action: "screenshot", annotate: true });
    expect(args).toEqual(["--cdp", CDP, "--json", "screenshot", "--annotate"]);
  });

  test("scroll down with pixels", () => {
    const args = buildArgs(CDP, { action: "scroll", direction: "down", pixels: 500 });
    expect(args).toEqual(["--cdp", CDP, "--json", "scroll", "down", "500"]);
  });

  test("get title", () => {
    const args = buildArgs(CDP, { action: "get", subcommand: "title" });
    expect(args).toEqual(["--cdp", CDP, "--json", "get", "title"]);
  });

  test("get text with ref", () => {
    const args = buildArgs(CDP, { action: "get", subcommand: "text", ref: "@e1" });
    expect(args).toEqual(["--cdp", CDP, "--json", "get", "text", "@e1"]);
  });

  test("wait with text", () => {
    const args = buildArgs(CDP, { action: "wait", text: "Loading" });
    expect(args).toEqual(["--cdp", CDP, "--json", "wait", "--text", "Loading"]);
  });

  test("back", () => {
    const args = buildArgs(CDP, { action: "back" });
    expect(args).toEqual(["--cdp", CDP, "--json", "back"]);
  });

  test("batch commands", () => {
    const args = buildArgs(CDP, { action: "batch", commands: ["open https://a.com", "snapshot -i"] });
    expect(args).toEqual(["--cdp", CDP, "--json", "batch", "open https://a.com", "snapshot -i"]);
  });
});
