/**
 * Minimal logger shim for Jiku browser engine.
 *
 * Replaces the tslog-based OpenClaw logger. Nothing in the browser subsystem
 * imports this file directly — they use `logging/subsystem.ts` instead.
 * This file exists only to satisfy any transitive type imports.
 */

import path from "node:path";
import { resolvePreferredOpenClawTmpDir } from "../infra/tmp-openclaw-dir.js";

export const DEFAULT_LOG_DIR = resolvePreferredOpenClawTmpDir();
export const DEFAULT_LOG_FILE = path.join(DEFAULT_LOG_DIR, "openclaw.log");

export type LogLevel = "silent" | "fatal" | "error" | "warn" | "info" | "debug" | "trace";
export type LoggerSettings = {
  level?: LogLevel;
  file?: string;
  consoleLevel?: LogLevel;
};
export type LoggerResolvedSettings = { level: LogLevel; file: string };
export type LogTransportRecord = Record<string, unknown>;
export type LogTransport = (logObj: LogTransportRecord) => void;

export type PinoLikeLogger = {
  level: string;
  child: (bindings?: Record<string, unknown>) => PinoLikeLogger;
  trace: (...args: unknown[]) => void;
  debug: (...args: unknown[]) => void;
  info: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
  fatal: (...args: unknown[]) => void;
};

function noop(..._args: unknown[]): void {}

function makeLogger(prefix: string): PinoLikeLogger {
  return {
    level: "info",
    child: (bindings) => makeLogger(`${prefix}:${JSON.stringify(bindings ?? {})}`),
    trace: noop,
    debug: noop,
    info: (...args) => console.log(`[${prefix}:info]`, ...args),
    warn: (...args) => console.warn(`[${prefix}:warn]`, ...args),
    error: (...args) => console.error(`[${prefix}:error]`, ...args),
    fatal: (...args) => console.error(`[${prefix}:fatal]`, ...args),
  };
}

const _logger = makeLogger("openclaw");

export function getLogger() {
  return _logger;
}

export function getChildLogger(
  bindings?: Record<string, unknown>,
  _opts?: { level?: LogLevel },
) {
  return makeLogger(`openclaw:${JSON.stringify(bindings ?? {})}`);
}

export function toPinoLikeLogger(_logger: unknown, _level: LogLevel): PinoLikeLogger {
  return makeLogger("openclaw");
}

export function isFileLogLevelEnabled(_level: LogLevel): boolean {
  return true;
}

export function getResolvedLoggerSettings(): LoggerResolvedSettings {
  return { level: "info", file: DEFAULT_LOG_FILE };
}

export function setLoggerOverride(_settings: LoggerSettings | null): void {}
export function resetLogger(): void {}
export function registerLogTransport(_transport: LogTransport): () => void {
  return () => {};
}
