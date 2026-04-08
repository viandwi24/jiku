import { describe, test, expect, mock, beforeEach } from "bun:test";
import { buildArgs } from "../spawner.ts";

// Mock execBrowserCommand — returns parsed BrowserResult
const mockExecBrowserCommand = mock(() =>
  Promise.resolve({
    success: true,
    data: { ok: true },
    error: null,
    hint: null,
  }),
);

// Mock resolveCdpEndpoint to return the endpoint as-is
const mockResolveCdpEndpoint = mock((endpoint: string) => endpoint);

// Replace the module-level import — must come before importing server
mock.module("../spawner.ts", () => ({
  execBrowserCommand: mockExecBrowserCommand,
  execCommand: mock(() => Promise.resolve({ stdout: "", stderr: "", exitCode: 0 })),
  resolveCdpEndpoint: mockResolveCdpEndpoint,
  buildArgs,
}));

// Import server AFTER mock.module so it picks up the mock
const { BrowserAgentServer } = await import("../server.ts");

type Server = InstanceType<typeof BrowserAgentServer>;
type MockCall = [cdp: string, cmd: Record<string, unknown>, opts?: Record<string, unknown>];

function lastMockCall(): MockCall {
  const calls = mockExecBrowserCommand.mock.calls as unknown as MockCall[];
  return calls[calls.length - 1]!;
}

function createTestServer(): Server {
  return new BrowserAgentServer({
    port: 0,
    host: "127.0.0.1",
    agentBrowserBin: "agent-browser",
  });
}

async function request(
  app: ReturnType<Server["getApp"]>,
  method: string,
  urlPath: string,
  body?: unknown,
): Promise<{ status: number; body: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const http = require("node:http");
    const srv = http.createServer(app);

    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      const port = addr.port;
      const url = `http://127.0.0.1:${port}${urlPath}`;
      const payload = body !== undefined ? JSON.stringify(body) : undefined;

      fetch(url, {
        method,
        headers: { "Content-Type": "application/json" },
        body: payload,
      })
        .then(async (res) => {
          const json = await res.json();
          srv.close();
          resolve({ status: res.status, body: json as Record<string, unknown> });
        })
        .catch((err) => {
          srv.close();
          reject(err);
        });
    });
  });
}

describe("BrowserAgentServer API", () => {
  let server: Server;

  beforeEach(() => {
    server = createTestServer();
    mockExecBrowserCommand.mockClear();
  });

  // --- Profile CRUD ---

  test("POST /api/profiles — create profile", async () => {
    const app = server.getApp();
    const res = await request(app, "POST", "/api/profiles", {
      id: "browser-1",
      type: "cdp",
      config: { endpoint: "ws://localhost:9222" },
    });

    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);
    const data = res.body.data as Record<string, unknown>;
    expect(data.id).toBe("browser-1");
    expect(data.type).toBe("cdp");
    expect((data.config as Record<string, unknown>).endpoint).toBe("ws://localhost:9222");
  });

  test("POST /api/profiles — reject invalid config", async () => {
    const app = server.getApp();
    const res = await request(app, "POST", "/api/profiles", {
      id: "bad",
      type: "cdp",
      config: { endpoint: "not-a-url" },
    });

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
  });

  test("POST /api/profiles — reject duplicate", async () => {
    const app = server.getApp();
    await request(app, "POST", "/api/profiles", {
      id: "dup",
      type: "cdp",
      config: { endpoint: "ws://localhost:9222" },
    });
    const res = await request(app, "POST", "/api/profiles", {
      id: "dup",
      type: "cdp",
      config: { endpoint: "ws://localhost:9222" },
    });

    expect(res.status).toBe(409);
    expect(res.body.success).toBe(false);
  });

  test("GET /api/profiles — list profiles", async () => {
    const app = server.getApp();
    await request(app, "POST", "/api/profiles", {
      id: "p1",
      type: "cdp",
      config: { endpoint: "ws://localhost:9222" },
    });

    const res = await request(app, "GET", "/api/profiles");
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(Array.isArray(res.body.data)).toBe(true);
    expect((res.body.data as unknown[]).length).toBe(1);
  });

  test("GET /api/profiles/:id — get profile", async () => {
    const app = server.getApp();
    await request(app, "POST", "/api/profiles", {
      id: "get-me",
      type: "cdp",
      config: { endpoint: "ws://localhost:9222" },
    });

    const res = await request(app, "GET", "/api/profiles/get-me");
    expect(res.status).toBe(200);
    const data = res.body.data as Record<string, unknown>;
    expect(data.id).toBe("get-me");
  });

  test("GET /api/profiles/:id — 404 for missing", async () => {
    const app = server.getApp();
    const res = await request(app, "GET", "/api/profiles/nope");
    expect(res.status).toBe(404);
  });

  test("DELETE /api/profiles/:id — delete profile", async () => {
    const app = server.getApp();
    await request(app, "POST", "/api/profiles", {
      id: "to-delete",
      type: "cdp",
      config: { endpoint: "ws://localhost:9222" },
    });

    const res = await request(app, "DELETE", "/api/profiles/to-delete");
    expect(res.status).toBe(200);

    const check = await request(app, "GET", "/api/profiles/to-delete");
    expect(check.status).toBe(404);
  });

  // --- Browser Commands (mocked) ---

  test("POST /api/profiles/:id/open — navigate", async () => {
    const app = server.getApp();
    server.getProfileManager().create({
      id: "nav",
      type: "cdp",
      config: { endpoint: "ws://localhost:9222" },
    });

    const res = await request(app, "POST", "/api/profiles/nav/open", {
      url: "https://example.com",
    });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(mockExecBrowserCommand).toHaveBeenCalledTimes(1);

    const [cdp, cmd] = lastMockCall();
    expect(cdp).toBe("ws://localhost:9222");
    expect(cmd).toEqual({ action: "open", url: "https://example.com" });
  });

  test("POST /api/profiles/:id/snapshot — interactive snapshot", async () => {
    const app = server.getApp();
    server.getProfileManager().create({
      id: "snap",
      type: "cdp",
      config: { endpoint: "ws://localhost:9222" },
    });

    const res = await request(app, "POST", "/api/profiles/snap/snapshot", {
      interactive: true,
    });

    expect(res.status).toBe(200);
    const [, cmd] = lastMockCall();
    expect(cmd).toEqual({ action: "snapshot", interactive: true });
  });

  test("POST /api/profiles/:id/screenshot — returns base64", async () => {
    const app = server.getApp();
    server.getProfileManager().create({
      id: "ss",
      type: "cdp",
      config: { endpoint: "ws://localhost:9222" },
    });

    const res = await request(app, "POST", "/api/profiles/ss/screenshot", {
      full: true,
    });

    expect(res.status).toBe(200);
    expect(mockExecBrowserCommand).toHaveBeenCalledTimes(1);

    const [cdp, cmd] = lastMockCall();
    expect(cdp).toBe("ws://localhost:9222");
    expect(cmd).toEqual({
      action: "screenshot",
      full: true,
    });
  });

  test("POST /api/profiles/:id/click — click element", async () => {
    const app = server.getApp();
    server.getProfileManager().create({
      id: "clk",
      type: "cdp",
      config: { endpoint: "ws://localhost:9222" },
    });

    const res = await request(app, "POST", "/api/profiles/clk/click", {
      ref: "@e5",
    });

    expect(res.status).toBe(200);
    const [, cmd] = lastMockCall();
    expect(cmd).toEqual({ action: "click", ref: "@e5" });
  });

  test("browser command on missing profile returns 404", async () => {
    const app = server.getApp();
    const res = await request(app, "POST", "/api/profiles/ghost/open", {
      url: "https://example.com",
    });

    expect(res.status).toBe(404);
    expect(mockExecBrowserCommand).not.toHaveBeenCalled();
  });

  // --- Health ---

  test("GET /api/health", async () => {
    const app = server.getApp();
    const res = await request(app, "GET", "/api/health");
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });
});
