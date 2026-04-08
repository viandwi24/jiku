import { BrowserAgentServer } from "../server.ts";

const BASE = "http://127.0.0.1:4100";

// --- helpers ---

async function api<T = unknown>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${BASE}/api${path}`, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const json = (await res.json()) as { success: boolean; data?: T; error?: string };
  if (!json.success) throw new Error(`API error: ${json.error}`);
  return json.data as T;
}

// 1. prepare functions

// 1.1. create or update config cdp
const PROFILE_ID = "example-cdp";
const CDP_ENDPOINT = process.env.CDP_ENDPOINT ?? "ws://localhost:9222";

async function ensureProfile() {
  try {
    return await api("GET", `/profiles/${PROFILE_ID}`);
  } catch {
    // profile doesn't exist yet, create it
    return await api("POST", "/profiles", {
      id: PROFILE_ID,
      type: "cdp",
      config: { endpoint: CDP_ENDPOINT },
    });
  }
}

// 1.2. safe command — auto-creates profile on 404 and retries
async function cmd<T = unknown>(endpoint: string, body?: unknown): Promise<T> {
  try {
    return await api<T>("POST", `/profiles/${PROFILE_ID}${endpoint}`, body);
  } catch {
    // profile might be missing, ensure it exists and retry
    await ensureProfile();
    return await api<T>("POST", `/profiles/${PROFILE_ID}${endpoint}`, body);
  }
}

// --- main ---

async function main() {
  // start server
  const server = new BrowserAgentServer({ port: 4100, host: "127.0.0.1" });
  await server.start();
  console.log("Browser Agent Server started on http://127.0.0.1:4100");

  // 1. ensure profile exists
  const profile = await ensureProfile();
  console.log("Profile ready:", profile);

  // 2. test navigate
  console.log("\n--- Navigate to example.com ---");
  const navResult = await cmd("/open", { url: "https://google.com" });
  console.log("Navigate result:", navResult);

  // wait for page load
  await cmd("/wait", { ms: 2000 });

  // 3. test snapshot
  console.log("\n--- Snapshot (interactive) ---");
  const snapResult = await cmd("/snapshot", { interactive: true });
  console.log("Snapshot result:", snapResult);

  // 4. test screenshot (returns base64)
  console.log("\n--- Screenshot ---");
  const screenshotResult = await cmd<{ success: boolean; data: { base64: string; format: string } | null }>("/screenshot", { full: true });
  if (screenshotResult.success && screenshotResult.data) {
    console.log(`Screenshot: ${screenshotResult.data.format}, ${screenshotResult.data.base64.length} chars base64`);
  } else {
    console.log("Screenshot result:", screenshotResult);
  }

  // 5. type search query into Google search box (ref=e15 from snapshot: combobox "Cari")
  console.log("\n--- Fill search query ---");
  const fillResult = await cmd("/fill", { ref: "@e15", text: "jiku ai agent framework" });
  console.log("Fill result:", fillResult);

  // 6. press Enter to search
  console.log("\n--- Press Enter ---");
  const pressResult = await cmd("/press", { key: "Enter" });
  console.log("Press result:", pressResult);

  // 7. wait for search results
  await cmd("/wait", { ms: 3000 });

  // 8. snapshot search results
  console.log("\n--- Snapshot search results ---");
  const searchSnap = await cmd("/snapshot", { interactive: true, compact: true });
  console.log("Search results snapshot:", searchSnap);

  // 9. screenshot search results
  console.log("\n--- Screenshot search results ---");
  const searchScreenshot = await cmd<{ success: boolean; data: { base64: string; format: string } | null }>("/screenshot", {});
  if (searchScreenshot.success && searchScreenshot.data) {
    console.log(`Search screenshot: ${searchScreenshot.data.format}, ${searchScreenshot.data.base64.length} chars base64`);
  } else {
    console.log("Search screenshot:", searchScreenshot);
  }

  // 10. get page title (should be search results)
  console.log("\n--- Get title ---");
  const titleResult = await cmd("/get", { subcommand: "title" });
  console.log("Title result:", titleResult);

  // 11. get current url
  console.log("\n--- Get URL ---");
  const urlResult = await cmd("/get", { subcommand: "url" });
  console.log("URL result:", urlResult);

  // done
  console.log("\nAll steps completed.");
  process.exit(0);
}

main().catch((err) => {
  console.error("Example failed:", err);
  process.exit(1);
});
