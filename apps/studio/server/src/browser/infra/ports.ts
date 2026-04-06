/**
 * Minimal port availability checker shim for Jiku browser engine.
 */

import net from "node:net";

/**
 * Check if a port is available by attempting to bind to it.
 * Throws if the port is already in use.
 */
export async function ensurePortAvailable(port: number, host = "127.0.0.1"): Promise<void> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "EADDRINUSE") {
        reject(new Error(`Port ${port} is already in use on ${host}`));
      } else {
        reject(err);
      }
    });
    server.once("listening", () => {
      server.close(() => resolve());
    });
    server.listen(port, host);
  });
}
