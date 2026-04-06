/**
 * Minimal CLI command formatting shim for Jiku browser engine.
 * Replaces the OpenClaw CLI command format utility.
 */

/**
 * Format a CLI command string for display in error messages / help text.
 * In Jiku Studio, we just return the command as-is.
 */
export function formatCliCommand(command: string): string {
  return command;
}
