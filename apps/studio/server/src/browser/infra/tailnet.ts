/**
 * Minimal Tailnet shim for Jiku browser engine.
 * Jiku Studio does not use Tailscale/Tailnet, so these return null.
 */

/**
 * Pick the primary Tailnet IPv4 address from the given list.
 * Always returns null — Tailnet is not used in Jiku Studio.
 */
export function pickPrimaryTailnetIPv4(_addresses: string[]): string | null {
  return null;
}

/**
 * Pick the primary Tailnet IPv6 address from the given list.
 * Always returns null — Tailnet is not used in Jiku Studio.
 */
export function pickPrimaryTailnetIPv6(_addresses: string[]): string | null {
  return null;
}
