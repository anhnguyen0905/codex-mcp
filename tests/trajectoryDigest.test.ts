import { readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { performance } from 'node:perf_hooks'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
// @ts-expect-error — plain .mjs script
import { digestLines, formatDigest, TEST_COMMAND_PATTERNS } from '../scripts/trajectory-digest.mjs'

const fixture = (name: string): string[] => readFileSync(join('tests/fixtures/trajectory', name), 'utf8').trim().split('\n')

describe('trajectory digest', () => {
  it('summarizes commands, churn, tokens, duration, and status', () => {
    // Arrange
    const lines = fixture('normal.jsonl')

    // Act
    const digest = digestLines(lines)

    // Assert
    expect(digest).toEqual({
      commands: ['npm test'],
      failedCommands: [],
      testRuns: 1,
      filesChangedMoreThanOnce: [{ path: 'src/alpha.ts', count: 2 }],
      tokens: { input: 10, cachedInput: 2, output: 5, reasoningOutput: 3 },
      durationSeconds: 5,
      finalStatus: 'completed',
      skippedLines: 0,
    })
  })

  it('counts malformed and missing-stamp lines and failed commands', () => {
    // Arrange
    const lines = fixture('failures.jsonl')

    // Act
    const digest = digestLines(lines)

    // Assert
    expect(digest.failedCommands).toEqual([{ command: 'pytest tests/test_alpha.py --quiet', exitCode: 1 }])
    expect(digest.testRuns).toBe(1)
    expect(digest.skippedLines).toBe(3)
    expect(digest.finalStatus).toBeNull()
  })

  it('uses null duration and status when the run has no final status', () => {
    // Arrange
    const lines = fixture('no-final-status.jsonl')

    // Act
    const digest = digestLines(lines)

    // Assert
    expect(digest.durationSeconds).toBeNull()
    expect(digest.finalStatus).toBeNull()
    expect(digest.tokens).toEqual({ input: 0, cachedInput: 0, output: 0, reasoningOutput: 0 })
  })

  it('matches supported test command patterns but not a non-test command', () => {
    // Arrange
    const matchingCommands = [
      "/bin/zsh -lc 'cd pkg && npm test'",
      'cd svc && go test ./...',
      'python -m pytest -q',
      './node_modules/.bin/vitest run',
      'foo && vitest run',
      "/bin/zsh -lc 'npx vitest run tests/a.test.ts'",
      "/bin/zsh -lc 'npm test'",
      'npm run test:unit',
      'cargo test',
      'jest',
      '/usr/bin/vitest run',
      "/bin/zsh -lc '/opt/homebrew/bin/pytest -q'",
      'C:\\tools\\npm.cmd test',
    ]
    const nonMatchingCommands = [
      'sed -n 1,20p vitest.config.ts',
      'cat jest.config.js',
      'node scripts/build.mjs',
      'npm run build',
    ]

    // Act
    const matchingResults = matchingCommands.map((command) => TEST_COMMAND_PATTERNS.some((pattern: RegExp) => pattern.test(command)))
    const nonMatchingResults = nonMatchingCommands.map((command) => TEST_COMMAND_PATTERNS.some((pattern: RegExp) => pattern.test(command)))

    // Assert
    expect(matchingResults).toEqual(matchingCommands.map(() => true))
    expect(nonMatchingResults).toEqual(nonMatchingCommands.map(() => false))
  })

  it('matches Windows test command forms', () => {
    // Arrange
    const commands = ['npm.cmd test', 'npx.cmd vitest run', 'node_modules\\.bin\\vitest run', 'pytest.exe -q', 'C:\\tools\\go.exe test ./...']

    // Act
    const results = commands.map((command) => TEST_COMMAND_PATTERNS.some((pattern: RegExp) => pattern.test(command)))

    // Assert
    expect(results).toEqual(commands.map(() => true))
  })

  it('classifies a deep non-test path quickly', () => {
    // Arrange
    const command = `cat ${'a\\'.repeat(200)}x.txt`

    // Act
    const startedAt = performance.now()
    const isTestCommand = TEST_COMMAND_PATTERNS.some((pattern: RegExp) => pattern.test(command))
    const elapsedMilliseconds = performance.now() - startedAt

    // Assert
    expect(isTestCommand).toBe(false)
    expect(elapsedMilliseconds).toBeLessThan(100)
  })

  it('classifies a deep mixed-separator non-test path quickly', () => {
    // Arrange
    const command = `cat ${'a\\/'.repeat(500)}x.txt`

    // Act
    const startedAt = performance.now()
    const isTestCommand = TEST_COMMAND_PATTERNS.some((pattern: RegExp) => pattern.test(command))
    const elapsedMilliseconds = performance.now() - startedAt

    // Assert
    expect(isTestCommand).toBe(false)
    expect(elapsedMilliseconds).toBeLessThan(100)
  })

  it('formats the same digest values represented by JSON output', () => {
    // Arrange
    const path = join('tests/fixtures/trajectory', 'normal.jsonl')
    const script = join('scripts', 'trajectory-digest.mjs')
    const jsonResult = spawnSync(process.execPath, [script, '--log', path, '--json'], { encoding: 'utf8' })
    const textResult = spawnSync(process.execPath, [script, '--log', path], { encoding: 'utf8' })

    // Act
    const digest = JSON.parse(jsonResult.stdout)

    // Assert
    expect(jsonResult.status).toBe(0)
    expect(textResult.status).toBe(0)
    expect(textResult.stdout).toContain(`Commands: ${digest.commands.length}`)
    expect(textResult.stdout).toContain('  - src/alpha.ts ×2')
    expect(textResult.stdout).toContain(`Test runs: ${digest.testRuns}`)
    expect(textResult.stdout).toContain(`Tokens: input ${digest.tokens.input}, cached input ${digest.tokens.cachedInput}, output ${digest.tokens.output}, reasoning output ${digest.tokens.reasoningOutput}`)
    expect(textResult.stdout).toContain(`Duration seconds: ${digest.durationSeconds}`)
    expect(textResult.stdout).toContain(`Final status: ${digest.finalStatus}`)
    expect(textResult.stdout).toContain(`Skipped lines: ${digest.skippedLines}`)
    expect(formatDigest(digest)).toBe(textResult.stdout.trim())
  })

  it('prints failed command details in text output', () => {
    // Arrange
    const path = join('tests/fixtures/trajectory', 'failures.jsonl')

    // Act
    const result = spawnSync(process.execPath, ['scripts/trajectory-digest.mjs', '--log', path], { encoding: 'utf8' })

    // Assert
    expect(result.status).toBe(0)
    expect(result.stdout).toContain('  - exit 1: ` pytest tests/test_alpha.py --quiet `')
  })

  it('renders failed commands as safe single-line code spans', () => {
    // Arrange
    const digest = {
      commands: [],
      failedCommands: [{ command: 'node `script`\n--bad', exitCode: 1 }],
      testRuns: 0,
      filesChangedMoreThanOnce: [],
      tokens: { input: 0, cachedInput: 0, output: 0, reasoningOutput: 0 },
      durationSeconds: null,
      finalStatus: null,
      skippedLines: 0,
    }

    // Act
    const output = formatDigest(digest)

    // Assert
    expect(output).toContain('  - exit 1: `` node `script` --bad ``')
    expect(output).not.toContain('\n--bad')
  })

  it('returns exit code two for a missing log file', () => {
    // Arrange
    const result = spawnSync(process.execPath, ['scripts/trajectory-digest.mjs', '--log', 'tests/fixtures/trajectory/missing.jsonl'], { encoding: 'utf8' })

    // Act
    const exitCode = result.status

    // Assert
    expect(exitCode).toBe(2)
    expect(result.stderr).toContain('trajectory-digest:')
  })

  it('returns exit code two when the log value is missing', () => {
    // Arrange
    const result = spawnSync(process.execPath, ['scripts/trajectory-digest.mjs', '--log', '--json'], { encoding: 'utf8' })

    // Act
    const exitCode = result.status

    // Assert
    expect(exitCode).toBe(2)
    expect(result.stderr).toContain('usage: --log <path> [--json]')
  })

  it('returns exit code two for an unexpected positional argument', () => {
    // Arrange
    const result = spawnSync(process.execPath, ['scripts/trajectory-digest.mjs', '--log', 'tests/fixtures/trajectory/normal.jsonl', 'extra'], { encoding: 'utf8' })

    // Act
    const exitCode = result.status

    // Assert
    expect(exitCode).toBe(2)
    expect(result.stderr).toContain('usage: --log <path> [--json]')
  })
})
