import { mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, test } from 'vitest'
import { createLiveView } from '../src/liveView.js'

const tempDirs: string[] = []
afterAll(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true })
})

describe('createLiveView symlink guard', () => {
  test('refuses when the nested .codex-flow/live dir is a planted symlink (no write through it)', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'codex-mcp-lv-'))
    const target = mkdtempSync(join(tmpdir(), 'codex-mcp-lv-target-'))
    tempDirs.push(cwd, target)

    // Simulate a cloned repo with a real .codex-flow/ but `live` committed as a symlink elsewhere.
    mkdirSync(join(cwd, '.codex-flow'))
    symlinkSync(target, join(cwd, '.codex-flow', 'live'))

    const view = createLiveView(cwd)

    // Guard tripped → degraded no-op view, and nothing written through the symlink to the target.
    expect(view.logPath).toBeNull()
    expect(view.onStdout).toBeUndefined()
    expect(readdirSync(target)).toHaveLength(0)
  })
})
