import { BrowserAgentServer } from "./server.ts";

const port = Number(process.env.BROWSER_AGENT_PORT ?? 4100);
const host = process.env.BROWSER_AGENT_HOST ?? "0.0.0.0";
const bin = process.env.AGENT_BROWSER_BIN ?? "agent-browser";

const server = new BrowserAgentServer({ port, host, agentBrowserBin: bin });

await server.start();

// biome-ignore lint: server startup log
console.log(`Browser Agent Server listening on http://${host}:${port}`);
