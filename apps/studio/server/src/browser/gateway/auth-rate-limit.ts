/**
 * Minimal auth rate-limit shim for Jiku browser engine.
 * Jiku Studio handles rate limiting at the application layer.
 * This shim always allows requests (no rate limiting).
 */

export const AUTH_RATE_LIMIT_SCOPE_SHARED_SECRET = "shared-secret";

export type RateLimitCheckResult =
  | { allowed: true }
  | { allowed: false; retryAfterMs: number };

export type AuthRateLimiter = {
  check(ip: string | undefined, scope: string): RateLimitCheckResult;
  recordFailure(ip: string | undefined, scope: string): void;
  reset(ip: string | undefined, scope: string): void;
};

/**
 * Creates a no-op rate limiter that always allows requests.
 */
export function createAuthRateLimiter(): AuthRateLimiter {
  return {
    check: (_ip, _scope) => ({ allowed: true }),
    recordFailure: (_ip, _scope) => {},
    reset: (_ip, _scope) => {},
  };
}
