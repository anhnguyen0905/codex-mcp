import { isAbsolute } from 'node:path'
import type { ContinueInput, ExecuteInput } from './types.js'

/** Upper bound for a prompt delivered over stdin — protects the child from unbounded input. */
export const MAX_PROMPT_BYTES = 5 * 1024 * 1024
/** `codex exec` (and `exec resume`) read the prompt from stdin when the positional is `-`. */
const STDIN_PROMPT_MARKER = '-'

/** Argv plus the prompt to deliver over the child's stdin (argv carries `-` instead of the prompt). */
export interface CodexInvocation {
  args: string[]
  stdinInput: string
}

const assertPrompt = (prompt: string): void => {
  if (prompt.trim().length === 0) {
    throw new Error('prompt must be a non-empty string')
  }
}

const assertPromptWithinLimit = (prompt: string): void => {
  const bytes = Buffer.byteLength(prompt, 'utf8')
  if (bytes > MAX_PROMPT_BYTES) {
    throw new Error(
      `prompt is ${bytes} bytes, which exceeds the ${MAX_PROMPT_BYTES}-byte (5MB) limit; ` +
        'move large content into files in the workspace and reference them from the prompt',
    )
  }
}

export const assertAbsoluteCwd = (cwd: string): void => {
  if (!isAbsolute(cwd)) {
    throw new Error(`cwd must be an absolute path, got: ${cwd}`)
  }
}

const modelArgs = (model?: string): readonly string[] => {
  if (!model) return []
  // A model value beginning with `-` would be parsed by the codex CLI as a flag, not the
  // --model argument — reject it rather than emit a broken/injectable arg list.
  if (model.startsWith('-')) {
    throw new Error(`model must not start with '-', got: ${model}`)
  }
  return ['--model', model]
}

/** Shared leading args for `codex exec` — everything except the trailing `--` + prompt positional. */
const executeBaseArgs = (input: ExecuteInput): readonly string[] => {
  assertPrompt(input.prompt)
  assertAbsoluteCwd(input.cwd)
  return [
    'exec',
    '--json',
    '--skip-git-repo-check',
    '--cd',
    input.cwd,
    '--sandbox',
    input.sandbox,
    ...modelArgs(input.model),
  ]
}

/** Shared leading args for `codex exec resume` — everything except the trailing `--` + prompt positional. */
const continueBaseArgs = (input: ContinueInput): readonly string[] => {
  const sessionId = input.sessionId.trim()
  if (sessionId.length === 0) {
    throw new Error('sessionId must be a non-empty string')
  }
  // sessionId is a bare positional right after `resume`, ahead of the `--` guard, so a value
  // starting with `-` is parsed as a flag by the codex CLI (breaking resume, or smuggling an
  // arbitrary flag). Reject it — real session ids / thread names never start with a dash.
  if (sessionId.startsWith('-')) {
    throw new Error(`sessionId must not start with '-', got: ${input.sessionId}`)
  }
  assertPrompt(input.prompt)
  return [
    'exec',
    'resume',
    sessionId,
    '--json',
    '--skip-git-repo-check',
    '--config',
    `sandbox_mode="${input.sandbox}"`,
    ...modelArgs(input.model),
  ]
}

// End-of-options marker on both prompt positional variants: a prompt beginning with `-`/`--` must
// be treated as the positional prompt, never parsed as a Codex flag.

/** Legacy variant: the prompt travels as an argv positional. Prefer `buildExecuteInvocation`. */
export const buildExecuteArgs = (input: ExecuteInput): string[] => [
  ...executeBaseArgs(input),
  '--',
  input.prompt,
]

/** Legacy variant: the prompt travels as an argv positional. Prefer `buildContinueInvocation`. */
export const buildContinueArgs = (input: ContinueInput): string[] => [
  ...continueBaseArgs(input),
  '--',
  input.prompt,
]

/**
 * Stdin variant of `buildExecuteArgs`: argv carries `-` so the prompt (which can embed PLAN.md and
 * skill blocks) never hits E2BIG limits or shows up in process listings; the caller writes
 * `stdinInput` to the child's stdin.
 */
export const buildExecuteInvocation = (input: ExecuteInput): CodexInvocation => {
  const args = [...executeBaseArgs(input), '--', STDIN_PROMPT_MARKER]
  assertPromptWithinLimit(input.prompt)
  return { args, stdinInput: input.prompt }
}

/** Stdin variant of `buildContinueArgs` — see `buildExecuteInvocation`. */
export const buildContinueInvocation = (input: ContinueInput): CodexInvocation => {
  const args = [...continueBaseArgs(input), '--', STDIN_PROMPT_MARKER]
  assertPromptWithinLimit(input.prompt)
  return { args, stdinInput: input.prompt }
}
