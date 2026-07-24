export const SANDBOX_MODES = ['read-only', 'workspace-write', 'danger-full-access'] as const
export const REASONING_EFFORTS = ['minimal', 'low', 'medium', 'high', 'xhigh'] as const

export type SandboxMode = (typeof SANDBOX_MODES)[number]
export type ReasoningEffort = (typeof REASONING_EFFORTS)[number]

export interface CodexUsage {
  inputTokens: number
  cachedInputTokens: number
  outputTokens: number
  reasoningOutputTokens: number
}

export interface CodexFileChange {
  path: string
  kind: string
}

export interface CodexCommand {
  command: string
  exitCode: number | null
}

export interface CodexResult {
  sessionId: string | null
  agentMessage: string | null
  fileChanges: readonly CodexFileChange[]
  commands: readonly CodexCommand[]
  usage: CodexUsage | null
  errors: readonly string[]
}

export interface ExecuteInput {
  prompt: string
  cwd: string
  sandbox: SandboxMode
  model?: string
  reasoningEffort?: ReasoningEffort
}

export interface ContinueInput {
  sessionId: string
  prompt: string
  sandbox: SandboxMode
  model?: string
  reasoningEffort?: ReasoningEffort
}

export interface RunOutcome {
  stdout: string
  stderr: string
  exitCode: number | null
  timedOut: boolean
  /** True when the run was cancelled via AbortSignal (e.g. user pressed Esc in the MCP client). */
  aborted?: boolean
  /**
   * True when the raw `stdout` field dropped OLD bytes (tail-only retention). The streamed
   * parse (`parsed` on RunOutcomeWithEvents) still saw the full stream, so this is
   * informational for the raw field — it does not mean parser-level event data was lost.
   */
  truncated?: boolean
}
