/**
 * Minimal Tailscale shim for Jiku browser engine.
 * Jiku Studio does not use Tailscale, so all lookups return null.
 */

export type TailscaleWhoisIdentity = {
  login: string;
  name?: string;
  profilePic?: string;
};

/**
 * Always returns null — Tailscale integration is not used in Jiku Studio.
 */
export async function readTailscaleWhoisIdentity(
  _ip: string,
): Promise<TailscaleWhoisIdentity | null> {
  return null;
}
