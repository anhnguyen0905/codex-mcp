// Computes parallel execution "waves" from a codex-flow TASKS.md so large
// backlogs can run several Codex sessions concurrently (one git worktree per
// task, since codex-mcp serializes per cwd but parallelizes across cwds).
//
// A wave is a set of tasks that can run at the same time: every task's
// dependencies are satisfied by earlier waves, and no two tasks in the wave
// touch the same file. Tasks with no declared files run alone (unknown blast
// radius). See skills/parallel-execution/SKILL.md for the playbook.
//
// Usage: node scripts/task-waves.mjs [path/to/TASKS.md]   (default: .codex-flow/TASKS.md)

import { promises as fs } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const taskNum = (id) => parseInt(id.slice(1), 10)
const isPlaceholder = (token) => token.includes('<') || token.includes('>')

/** Parse a TASKS.md into [{ id, title, dependsOn, files }]. */
export function parseTasks(markdown) {
  const tasks = []
  let current = null

  for (const raw of (markdown ?? '').split(/\r?\n/)) {
    const header = raw.match(/^##\s+(T\d+):\s*(.*)$/)
    if (header) {
      current = { id: header[1], title: header[2].trim(), dependsOn: [], files: [] }
      tasks.push(current)
      continue
    }
    if (!current) continue

    const dep = raw.match(/^\s*-\s*Depends on:\s*(.*)$/i)
    if (dep) {
      current.dependsOn = (dep[1].match(/T\d+/g) ?? []).filter((t) => !isPlaceholder(t))
      continue
    }
    const files = raw.match(/^\s*-\s*Files:\s*(.*)$/i)
    if (files) {
      // An unfilled placeholder like "<files to create>" → treat as no declared files.
      current.files = isPlaceholder(files[1])
        ? []
        : files[1]
            .split(/[,\s]+/)
            .map((f) => f.trim())
            .filter(Boolean)
      continue
    }
  }
  return tasks
}

/**
 * Compute execution waves. Returns { waves: [[id]], maxWidth, parallelizable }.
 * Throws on unknown dependencies or dependency cycles.
 */
export function computeWaves(tasks) {
  const byId = new Map(tasks.map((t) => [t.id, t]))
  for (const t of tasks) {
    for (const dep of t.dependsOn) {
      if (!byId.has(dep)) throw new Error(`${t.id} has unknown dependency ${dep}`)
    }
  }

  const completed = new Set()
  const remaining = new Set(tasks.map((t) => t.id))
  const waves = []

  while (remaining.size) {
    const ready = [...remaining]
      .filter((id) => byId.get(id).dependsOn.every((d) => completed.has(d)))
      .sort((a, b) => taskNum(a) - taskNum(b))

    if (ready.length === 0) {
      throw new Error(`dependency cycle among: ${[...remaining].sort().join(', ')}`)
    }

    const wave = []
    const usedFiles = new Set()
    let exclusiveTaken = false

    for (const id of ready) {
      const files = byId.get(id).files
      if (files.length === 0) {
        // Unknown blast radius → run alone.
        if (wave.length === 0) {
          wave.push(id)
          exclusiveTaken = true
        }
        continue
      }
      if (exclusiveTaken) continue
      if (files.some((f) => usedFiles.has(f))) continue // file conflict → defer to a later wave
      wave.push(id)
      files.forEach((f) => usedFiles.add(f))
    }

    for (const id of wave) {
      completed.add(id)
      remaining.delete(id)
    }
    waves.push(wave)
  }

  const maxWidth = waves.reduce((m, w) => Math.max(m, w.length), 0)
  return { waves, maxWidth, parallelizable: maxWidth > 1 }
}

/** Human-readable wave summary for the CLI / plan review. */
export function renderWaves({ waves, maxWidth, parallelizable }) {
  const lines = [
    `Execution plan: ${waves.length} wave(s), max width ${maxWidth} — ${parallelizable ? 'parallelizable' : 'fully sequential'}`,
    '',
  ]
  waves.forEach((wave, i) => {
    const tag = wave.length > 1 ? `${wave.length} in parallel` : 'sequential'
    lines.push(`Wave ${i + 1} (${tag}): ${wave.join(', ')}`)
  })
  return lines.join('\n')
}

const isDirectRun =
  process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href

if (isDirectRun) {
  const file = path.resolve(process.argv[2] ?? path.join('.codex-flow', 'TASKS.md'))
  fs.readFile(file, 'utf8')
    .then((md) => {
      const tasks = parseTasks(md)
      if (tasks.length === 0) throw new Error(`no tasks found in ${file}`)
      console.log(renderWaves(computeWaves(tasks)))
    })
    .catch((error) => {
      console.error(`task-waves: ${error.message}`)
      process.exit(1)
    })
}
