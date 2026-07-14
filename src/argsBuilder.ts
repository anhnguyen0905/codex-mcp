import { isAbsolute } from 'node:path'
import type { ContinueInput, ExecuteInput } from './types.js'

const assertPrompt = (prompt: string): void => {
  if (prompt.trim().length === 0) {
    throw new Error('prompt must be a non-empty string')
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

export const buildExecuteArgs = (input: ExecuteInput): string[] => {
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
    // End-of-options marker: a prompt beginning with `-`/`--` must be treated as the
    // positional prompt, never parsed as a Codex flag.
    '--',
    input.prompt,
  ]
}

export const buildContinueArgs = (input: ContinueInput): string[] => {
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
    '--',
    input.prompt,
  ]
}
