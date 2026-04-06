/**
 * Minimal redact shim for Jiku browser engine.
 * Replaces the full token-redaction pipeline from OpenClaw.
 * In Jiku Studio, sensitive data redaction is handled at the application layer.
 */

const REDACTED_PATTERNS = [
  // Bearer tokens
  /\bBearer\s+[A-Za-z0-9\-._~+/]+=*/gi,
  // Generic secrets in key=value pairs
  /\b(token|password|secret|key|auth)\s*[:=]\s*[^\s,}>"']+/gi,
];

/**
 * Best-effort redaction of sensitive tokens/secrets from a string.
 * Returns the input unchanged if no patterns match.
 */
export function redactSensitiveText(input: string): string {
  if (!input) return input;
  let result = input;
  for (const pattern of REDACTED_PATTERNS) {
    result = result.replace(pattern, (match) => {
      // Keep the key part, redact the value
      const eqIdx = match.search(/[:=]/);
      if (eqIdx !== -1) {
        return `${match.slice(0, eqIdx + 1)}[REDACTED]`;
      }
      return "[REDACTED]";
    });
  }
  return result;
}
