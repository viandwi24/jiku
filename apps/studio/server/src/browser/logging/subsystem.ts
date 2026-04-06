/**
 * Minimal subsystem logger shim for Jiku browser engine.
 * Replaces the heavy tslog/chalk-based original.
 */

export type SubsystemLogger = {
  subsystem: string
  isEnabled: (level: string) => boolean
  trace: (message: string, meta?: Record<string, unknown>) => void
  debug: (message: string, meta?: Record<string, unknown>) => void
  info: (message: string, meta?: Record<string, unknown>) => void
  warn: (message: string, meta?: Record<string, unknown>) => void
  error: (message: string, meta?: Record<string, unknown>) => void
  fatal: (message: string, meta?: Record<string, unknown>) => void
  raw: (message: string) => void
  child: (name: string) => SubsystemLogger
}

export function createSubsystemLogger(subsystem: string): SubsystemLogger {
  const prefix = "[browser:" + subsystem + "]"
  const logger: SubsystemLogger = {
    subsystem,
    isEnabled: () => true,
    trace: () => {},
    debug: () => {},
    info: (msg) => console.log(prefix + " " + msg),
    warn: (msg) => console.warn(prefix + " " + msg),
    error: (msg) => console.error(prefix + " " + msg),
    fatal: (msg) => console.error(prefix + " FATAL " + msg),
    raw: (msg) => console.log(msg),
    child: (name) => createSubsystemLogger(subsystem + ":" + name),
  }
  return logger
}
