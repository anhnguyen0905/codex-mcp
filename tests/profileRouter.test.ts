import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
// @ts-expect-error — plain .mjs script, not part of the tsc build
import { DATA_PROFILE_GATES, NON_CODE_PROFILES, resolveSwitches, routeGates } from '../scripts/profile-router.mjs'

const script = fileURLToPath(new URL('../scripts/profile-router.mjs', import.meta.url))
const cleanEnv = (): NodeJS.ProcessEnv => {
  const env = { ...process.env }
  delete env.CODEX_FLOW_PROFILE_MODE
  delete env.CODEX_FLOW_EVIDENCE
  delete env.CODEX_FLOW_RUN_LANGUAGE
  return env
}
const run = (cwd: string, args: string[], values: NodeJS.ProcessEnv = {}) => spawnSync(
  process.execPath, [script, ...args], { cwd, env: { ...cleanEnv(), ...values }, encoding: 'utf8' },
)
const tempCwd = (): string => mkdtempSync(path.join(os.tmpdir(), 'profile-router-'))

describe('profile router', () => {
  it('resolves defaults with an empty environment', () => {
    // Arrange
    const env: NodeJS.ProcessEnv = {}
    // Act
    const actual = resolveSwitches(env)
    // Assert
    expect(actual).toEqual({ profileMode: 'shadow', evidenceMode: 'off', languageMode: 'off', warnings: [] })
  })

  it('resolves explicit switches and warns for unknown values', () => {
    // Arrange
    const env = { CODEX_FLOW_PROFILE_MODE: ' enforce ', CODEX_FLOW_EVIDENCE: 'shadow', CODEX_FLOW_RUN_LANGUAGE: 'on' }
    // Act
    const actual = resolveSwitches(env)
    const unknown = resolveSwitches({
      CODEX_FLOW_PROFILE_MODE: 'bad', CODEX_FLOW_EVIDENCE: 'nope', CODEX_FLOW_RUN_LANGUAGE: 'x',
    })
    // Assert
    expect(actual).toMatchObject({ profileMode: 'enforce', evidenceMode: 'shadow', languageMode: 'on' })
    expect(unknown.warnings).toEqual([
      'CODEX_FLOW_PROFILE_MODE=bad is not one of <off|shadow|enforce>; using shadow',
      'CODEX_FLOW_EVIDENCE=nope is not one of <off|shadow|enforce>; using off',
      'CODEX_FLOW_RUN_LANGUAGE=x is not one of <off|on>; using off',
    ])
  })

  it('routes data gates for off, shadow, and enforce', () => {
    // Arrange
    const modes = ['off', 'shadow', 'enforce']
    // Act
    const actual = modes.map((profileMode) => routeGates({ profile: 'data', profileMode }))
    // Assert
    expect(actual).toEqual([
      { skip: [], wouldSkip: [] }, { skip: [], wouldSkip: DATA_PROFILE_GATES },
      { skip: DATA_PROFILE_GATES, wouldSkip: [] },
    ])
  })

  it('leaves non-data gates unchanged', () => {
    // Arrange / Act
    const actual = routeGates({ profile: 'code', profileMode: 'enforce' })
    // Assert
    expect(actual).toEqual({ skip: [], wouldSkip: [] })
  })

  it.each(['design', 'plan', 'content'])('%s routes all non-code gates by mode', (profile) => {
    // Arrange
    const expected = {
      enforce: { skip: DATA_PROFILE_GATES, wouldSkip: [] },
      shadow: { skip: [], wouldSkip: DATA_PROFILE_GATES },
      off: { skip: [], wouldSkip: [] },
    }
    // Act
    const actual = Object.fromEntries(Object.keys(expected).map((profileMode) => [
      profileMode, routeGates({ profile, profileMode }),
    ]))
    // Assert
    expect(actual).toEqual(expected)
  })

  it.each(['code', 'mixed'])('%s remains unrouted in every mode', (profile) => {
    // Arrange
    const modes = ['off', 'shadow', 'enforce']
    // Act
    const actual = modes.map((profileMode) => routeGates({ profile, profileMode }))
    // Assert
    expect(actual).toEqual(modes.map(() => ({ skip: [], wouldSkip: [] })))
  })

  it('freezes and lists exactly the non-code profiles', () => {
    // Arrange / Act / Assert
    expect(Object.isFrozen(NON_CODE_PROFILES)).toBe(true)
    expect(NON_CODE_PROFILES).toEqual(['data', 'design', 'plan', 'content'])
  })

  it('writes a complete shadow record and detects Vietnamese request language', () => {
    // Arrange
    const cwd = tempCwd()
    const args = ['resolve', '--profile', 'data', '--request', 'Phân tích dữ liệu', '--run-id', 'run-7']
    const env = { CODEX_FLOW_PROFILE_MODE: 'shadow', CODEX_FLOW_EVIDENCE: 'enforce', CODEX_FLOW_RUN_LANGUAGE: 'on' }
    // Act
    const result = run(cwd, args, env)
    const output = JSON.parse(result.stdout)
    const record = JSON.parse(readFileSync(path.join(cwd, '.codex-flow/notes/profile-shadow.log'), 'utf8'))
    // Assert
    expect(result.status).toBe(0)
    expect(output.initFlags).toBe(
      '--profile data --profile-mode shadow --evidence-mode enforce --language-mode on --run-language vi',
    )
    expect(record).toMatchObject({
      runId: 'run-7', profile: 'data', wouldSkip: DATA_PROFILE_GATES,
      evidenceMode: 'enforce', languageMode: 'on',
    })
    expect(record.ts).toEqual(expect.any(String))
  })

  it('reads a request file for language detection', () => {
    // Arrange
    const cwd = tempCwd()
    const requestFile = path.join(cwd, 'request.txt')
    writeFileSync(requestFile, 'Xin chào tiếng Việt')
    // Act
    const result = run(
      cwd, ['resolve', '--profile', 'data', '--request-file', requestFile], { CODEX_FLOW_RUN_LANGUAGE: 'on' },
    )
    // Assert
    expect(result.status).toBe(0)
    expect(JSON.parse(result.stdout)).toMatchObject({ runLanguage: 'vi', languageSource: 'detected' })
  })

  it('uses a routed dash profile and writes no log when off', () => {
    // Arrange
    const cwd = tempCwd()
    // Act
    const result = run(cwd, ['resolve', '--profile', 'data', '--request', 'hello'], { CODEX_FLOW_PROFILE_MODE: 'off' })
    const output = JSON.parse(result.stdout)
    // Assert
    expect(output).toMatchObject({
      profile: '-',
      initFlags: '--profile - --profile-mode off --evidence-mode off --language-mode off --run-language -',
    })
    expect(() => readFileSync(path.join(cwd, '.codex-flow/notes/profile-shadow.log'))).toThrow()
  })

  it('returns a warning and succeeds when the shadow log cannot be written', () => {
    // Arrange
    const cwd = tempCwd()
    mkdirSync(path.join(cwd, '.codex-flow'))
    writeFileSync(path.join(cwd, '.codex-flow/notes'), 'not a directory')
    // Act
    const result = run(cwd, ['resolve', '--profile', 'data', '--request', 'hello'])
    // Assert
    expect(result.status).toBe(0)
    expect(JSON.parse(result.stdout).warnings[0]).toContain('could not write profile shadow log:')
  })

  it.each([
    ['unknown flag', ['resolve', '--profile', 'data', '--unknown'], 'unknown flag: --unknown'],
    ['missing value', ['resolve', '--profile', 'data', '--request'], '--request requires a value'],
    [
      'duplicate flag', ['resolve', '--profile', 'data', '--request', 'a', '--request', 'b'],
      'duplicate flag: --request',
    ],
    [
      'both request forms', ['resolve', '--profile', 'data', '--request', 'a', '--request-file', 'b'],
      'use only one of --request or --request-file',
    ],
    ['invalid profile', ['resolve', '--profile', 'bad'], 'invalid profile: bad'],
    [
      'language without request', ['resolve', '--profile', 'data'],
      'language mode on requires --request or --request-file',
    ],
  ])('rejects %s without writing a log', (_name, args, message) => {
    // Arrange
    const cwd = tempCwd()
    const env = _name === 'language without request' ? { CODEX_FLOW_RUN_LANGUAGE: 'on' } : {}
    // Act
    const result = run(cwd, args, env)
    // Assert
    expect(result.status).toBe(2)
    expect(result.stderr).toContain(message)
    expect(() => readFileSync(path.join(cwd, '.codex-flow/notes/profile-shadow.log'))).toThrow()
  })

  it('matches every data gate to the inventory Gate column', () => {
    // Arrange
    const document = readFileSync(new URL('../docs/gate-inventory.md', import.meta.url), 'utf8')
    const gates = document.split('\n').filter((line) => line.startsWith('|') && !line.includes('| ---')).slice(1)
      .map((line) => line.split('|')[1].trim())
    // Act / Assert
    DATA_PROFILE_GATES.forEach((gate) => expect(gates).toContain(gate))
  })
})
