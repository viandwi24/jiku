export type SandboxMode = 'code' | 'path' | 'prompt'

export type SandboxErrorCode =
  | 'queue_full'
  | 'queue_timeout'
  | 'exec_timeout'
  | 'eval_error'
  | 'transpile_error'
  | 'read_error'
  | 'llm_error'

export interface SandboxResult {
  mode: SandboxMode
  output: unknown
  logs: string[]
  error?: SandboxErrorCode
  errorDetail?: string
  executedCode?: string
  executionMs: number
  queueWaitMs: number
}

export interface SandboxLimits {
  execTimeoutMs: number
  memoryLimitMb: number
  stackLimitKb: number
}

export interface SandboxConfig {
  max_concurrent: number
  max_queue_depth: number
  queue_timeout_ms: number
  exec_timeout_ms: number
  memory_limit_mb: number
  stack_limit_kb: number
  allowed_path_roots: string[]
  llm_override?: { provider: string; model: string }
  prompt_cache_ttl_ms: number
}
