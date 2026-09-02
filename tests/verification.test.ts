import { describe, expect, test } from 'vitest'
import { runVerification, VERIFY_OUTPUT_TAIL_CHARS } from '../src/verification.js'

const nodeCmd = (script: string): string => `node -e "${script}"`

describe('runVerification', () => {
  test('reports passed=true with exit code 0 and captured output tail', async () => {
    // Arrange
    const command = nodeCmd("console.log('all green')")

    // Act
    const result = await runVerification(command, { cwd: process.cwd() })

    // Assert
    expect(result.command).toBe(command)
    expect(result.exitCode).toBe(0)
    expect(result.passed).toBe(true)
    expect(result.timedOut).toBe(false)
    expect(result.skipped).toBeUndefined()
    expect(result.outputTail).toContain('all green')
    expect(result.durationMs).toBeGreaterThanOrEqual(0)
  })

  test('reports passed=false with the non-zero exit code and stderr in the tail', async () => {
    const command = nodeCmd("console.error('boom'); process.exit(3)")

    const result = await runVerification(command, { cwd: process.cwd() })

    expect(result.exitCode).toBe(3)
    expect(result.passed).toBe(false)
    expect(result.outputTail).toContain('boom')
  })

  test('times out a hung command and reports timedOut with passed=false', async () => {
    const command = nodeCmd('setTimeout(() => {}, 20000)')

    const result = await runVerification(command, { cwd: process.cwd(), timeoutMs: 300 })

    expect(result.timedOut).toBe(true)
    expect(result.passed).toBe(false)
    expect(result.exitCode).not.toBe(0)
  })

  test('keeps only the newest output when the command is noisy', async () => {
    const command = nodeCmd("process.stdout.write('x'.repeat(5000) + 'TAIL')")

    const result = await runVerification(command, { cwd: process.cwd() })

    expect(result.outputTail.length).toBeLessThanOrEqual(VERIFY_OUTPUT_TAIL_CHARS)
    expect(result.outputTail.endsWith('TAIL')).toBe(true)
  })

  test('returns skipped when the signal is already aborted', async () => {
    const controller = new AbortController()
    controller.abort()

    const result = await runVerification(nodeCmd('1'), { cwd: process.cwd(), signal: controller.signal })

    expect(result.skipped).toBe('aborted')
    expect(result.passed).toBe(false)
  })

  test('settles within the exit grace when a detached grandchild keeps the stdio pipe open', async () => {
    // Parent exits immediately; the grandchild inherits stdout and would block 'close' for 20 s.
    const command = nodeCmd(
      "require('child_process').spawn(process.execPath,['-e','setTimeout(()=>{},20000)'],{detached:true,stdio:'inherit'}).unref()",
    )
    const startedAt = Date.now()

    const result = await runVerification(command, { cwd: process.cwd(), exitSettleGraceMs: 300 })

    expect(Date.now() - startedAt).toBeLessThan(10_000)
    expect(result.exitCode).toBe(0)
    expect(result.passed).toBe(true)
    expect(result.timedOut).toBe(false)
  })

  test('force-settles after the kill grace when a timed-out command never closes its pipes', async () => {
    // A SIGTERM-ignoring parent whose detached grandchild holds the pipe: only the force timer can settle.
    const command = nodeCmd(
      "process.on('SIGTERM',()=>{});require('child_process').spawn(process.execPath,['-e','setTimeout(()=>{},20000)'],{detached:true,stdio:'inherit'}).unref();setTimeout(()=>{},20000)",
    )
    const startedAt = Date.now()

    const result = await runVerification(command, {
      cwd: process.cwd(),
      timeoutMs: 200,
      sigkillGraceMs: 200,
      exitSettleGraceMs: 200,
    })

    expect(Date.now() - startedAt).toBeLessThan(10_000)
    expect(result.timedOut).toBe(true)
    expect(result.passed).toBe(false)
  })

  test('rejects when the command cannot be spawned (missing cwd)', async () => {
    await expect(
      runVerification(nodeCmd('1'), { cwd: '/definitely/not/a/dir/codex-mcp-verify' }),
    ).rejects.toThrow()
  })

  test('aborting mid-run terminates the command and settles with passed=false', async () => {
    const controller = new AbortController()
    const promise = runVerification(nodeCmd('setTimeout(() => {}, 20000)'), {
      cwd: process.cwd(),
      signal: controller.signal,
      sigkillGraceMs: 200,
    })
    setTimeout(() => controller.abort(), 100)

    const result = await promise

    expect(result.passed).toBe(false)
    expect(result.exitCode).not.toBe(0)
  })

  test('rejects an empty command', async () => {
    await expect(runVerification('   ', { cwd: process.cwd() })).rejects.toThrow(/non-empty/)
  })
})
