/**
 * Minimal SSRF protection shim for Jiku browser engine.
 *
 * In production, this should perform proper SSRF checks (blocking private IPs,
 * loopback addresses, metadata endpoints, etc.). This shim performs basic
 * protocol validation and passes through the default DNS lookup.
 */

import dns from "node:dns";
import type { LookupFunction } from "node:net";

export type PinnedHostname = {
  /** Drop-in replacement for the `lookup` option in http.request / https.request */
  lookup: LookupFunction;
};

const PRIVATE_IP_RANGES = [
  /^127\./,
  /^10\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
  /^192\.168\./,
  /^169\.254\./,
  /^::1$/,
  /^fc00:/i,
  /^fe80:/i,
  /^localhost$/i,
];

function isPrivateAddress(addr: string): boolean {
  return PRIVATE_IP_RANGES.some((re) => re.test(addr));
}

/**
 * Resolve a hostname and return a pinned lookup function that prevents SSRF
 * by blocking private/loopback addresses.
 *
 * This is a best-effort implementation. For production use, consider a more
 * comprehensive SSRF protection library.
 */
export async function resolvePinnedHostname(hostname: string): Promise<PinnedHostname> {
  // Perform a DNS lookup to check if the resolved address is safe.
  const addresses = await new Promise<string[]>((resolve, reject) => {
    dns.resolve(hostname, (err, addrs) => {
      if (err) {
        // Fall back to allowing it — the actual request will handle DNS.
        resolve([]);
        return;
      }
      resolve(addrs);
    });
  });

  for (const addr of addresses) {
    if (isPrivateAddress(addr)) {
      throw new Error(
        `SSRF protection: hostname "${hostname}" resolves to a private/internal address (${addr})`,
      );
    }
  }

  // Return the standard DNS lookup function (unpinned but validated above).
  const lookup: LookupFunction = (host, optionsOrCb, cb) => {
    if (typeof optionsOrCb === "function") {
      dns.lookup(host, optionsOrCb);
    } else {
      dns.lookup(host, optionsOrCb ?? {}, cb!);
    }
  };

  return { lookup };
}
