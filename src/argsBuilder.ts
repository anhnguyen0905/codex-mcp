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

const modelArgs = (model?: string): readonly string[] => (model ? ['--model', model] : [])

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
    input.prompt,
  ]
}

export const buildContinueArgs = (input: ContinueInput): string[] => {
  if (input.sessionId.trim().length === 0) {
    throw new Error('sessionId must be a non-empty string')
  }
  assertPrompt(input.prompt)
  return [
    'exec',
    'resume',
    input.sessionId,
    '--json',
    '--skip-git-repo-check',
    '--config',
    `sandbox_mode="${input.sandbox}"`,
    ...modelArgs(input.model),
    input.prompt,
  ]
}
