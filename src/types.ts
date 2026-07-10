export const SANDBOX_MODES = ['read-only', 'workspace-write', 'danger-full-access'] as const

export type SandboxMode = (typeof SANDBOX_MODES)[number]

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
}

export interface ContinueInput {
  sessionId: string
  prompt: string
  sandbox: SandboxMode
  model?: string
}

export interface RunOutcome {
  stdout: string
  stderr: string
  exitCode: number | null
  timedOut: boolean
}
