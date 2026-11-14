import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, test } from 'vitest'

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const PROFILE_PILOT_PATH = path.join(REPO_ROOT, 'skills', 'profile-pilot', 'SKILL.md')
const FAST_PATH_PATH = path.join(REPO_ROOT, 'skills', 'fast-path', 'SKILL.md')
const COMMAND_PATH = path.join(REPO_ROOT, 'commands', 'codex-flow.md')
const CLAUDE_COMMAND_PATH = path.join(REPO_ROOT, '.claude', 'commands', 'codex-flow.md')
const EVIDENCE_CHECK_PATH = path.join(REPO_ROOT, 'scripts', 'evidence-check.mjs')

function readText(filePath: string): string {
  if (!existsSync(filePath)) {
    throw new Error(`Required flow document does not exist: ${filePath}`)
  }

  // Windows checkouts may materialize CRLF via git autocrlf; guards assert LF-relative offsets.
  return readFileSync(filePath, 'utf8').replace(/\r\n/g, '\n')
}

describe('documentation consistency', () => {
  test('every evidence finding named in profile-pilot exists in evidence-check.mjs', () => {
    // Arrange
    const profilePilot = readText(PROFILE_PILOT_PATH)
    const evidenceCheck = readText(EVIDENCE_CHECK_PATH)
    const evidenceSentence = profilePilot.match(
      /Every claim cites at least one figure id\.[^\n]*/,
    )?.[0]
    const findings = evidenceSentence
      ? [...evidenceSentence.matchAll(/`([^`]+)`/g)].map((match) => match[1])
      : []

    // Act
    const missingFindings = findings.filter(
      (finding) => !new RegExp(`(['"])${finding}\\1`).test(evidenceCheck),
    )

    // Assert
    expect(findings).toEqual([
      'anchor-mismatch',
      'anchor-unknown',
      'unanchored-number',
      'table-unknown',
      'table-mismatch',
      'table-command',
      'claim-no-figure',
    ])
    expect(missingFindings).toEqual([])
  })

  test('profile-pilot routes scope-check exit 1 as a finding, not a STOP', () => {
    // Arrange
    const helpersLine = readText(PROFILE_PILOT_PATH)
      .split('\n')
      .find((line) => line.startsWith('**Helpers**:'))

    // Act
    const hasBlockingFindingRule = helpersLine?.includes('scope-check task exit 1 is a blocking finding')
    const hasGenericNonZeroStopRule = helpersLine?.includes('if one exits non-zero')

    // Assert
    expect(hasBlockingFindingRule).toBe(true)
    expect(hasGenericNonZeroStopRule).toBe(false)
  })

  test('fast-path log format carries the evidence result', () => {
    // Arrange
    const fastPath = readText(FAST_PATH_PATH)

    // Act
    const hasEvidenceResult = fastPath.includes('evidence=<pass|fail|off>')

    // Assert
    expect(hasEvidenceResult).toBe(true)
  })

  test('Phase 4 uses a snapshot base when checkpoint commits are off', () => {
    // Arrange
    const command = readText(COMMAND_PATH)
    const phaseFour = command.match(/## Phase 4[\s\S]*?(?=\n## |$)/)?.[0] ?? ''
    const stepOne = phaseFour.match(/\n1\. Before[\s\S]*?(?=\n\s*- `prompt`)/)?.[0] ?? ''

    // Act
    const mentionsCheckpointCommits = stepOne.includes('checkpointCommits')
    const mentionsSnapshotBase = stepOne.includes('scope-check.mjs snapshot')

    // Assert
    expect(mentionsCheckpointCommits).toBe(true)
    expect(mentionsSnapshotBase).toBe(true)
  })

  test('profile-pilot router records the snapshot base', () => {
    // Arrange
    const routerRow = readText(PROFILE_PILOT_PATH)
      .split('\n')
      .find((line) => line.startsWith('| Checkpoint task commits |'))

    // Act
    const mentionsSnapshotBase = routerRow?.includes('scope-check.mjs" snapshot')

    // Assert
    expect(mentionsSnapshotBase).toBe(true)
  })

  test('the mirror command stays byte-identical', () => {
    // Arrange
    const command = readFileSync(COMMAND_PATH)
    const mirror = readFileSync(CLAUDE_COMMAND_PATH)

    // Act
    const isIdentical = command.equals(mirror)

    // Assert
    expect(isIdentical).toBe(true)
  })
})
