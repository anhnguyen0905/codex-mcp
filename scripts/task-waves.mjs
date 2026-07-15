// Computes parallel execution "waves" from a codex-flow TASKS.md so large
// backlogs can run several Codex sessions concurrently (one git worktree per
// task, since codex-mcp serializes per cwd but parallelizes across cwds).
//
// A wave is a set of tasks that can run at the same time: every task's
// dependencies are satisfied by earlier waves, and no two tasks in the wave
// touch the same file. Tasks with no declared files run alone (unknown blast
// radius). See skills/parallel-execution/SKILL.md for the playbook.
//
// Usage: node scripts/task-waves.mjs [path/to/TASKS.md] [--max <n>]
//   default file: .codex-flow/TASKS.md   default concurrency cap: 10 subagents/wave

import { promises as fs } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

// Cap on how many subagents/worktrees run at once — a wider ready set is split
// across consecutive waves so we never spawn more than this many in parallel.
export const DEFAULT_MAX_CONCURRENCY = 10

const taskNum = (id) => parseInt(id.slice(1), 10)
const isPlaceholder = (token) => token.includes('<') || token.includes('>')

/** Parse a TASKS.md into [{ id, title, dependsOn, files }]. */
export function parseTasks(markdown) {
  const tasks = []
  let current = null

  for (const raw of (markdown ?? '').split(/\r?\n/)) {
    // Any `##` header ends the previous task's scope. Without this, bullets in a following
    // documentation section (e.g. "## Notes") would silently overwrite the last task's
    // Depends-on/Files (and even inject a self-cycle).
    const anyHeader = raw.match(/^##\s+/)
    const taskHeader = raw.match(/^##\s+(T\d+):\s*(.*)$/i)
    if (taskHeader) {
      current = { id: taskHeader[1].toUpperCase(), title: taskHeader[2].trim(), dependsOn: [], files: [] }
      tasks.push(current)
      continue
    }
    if (anyHeader) {
      current = null
      continue
    }
    if (!current) continue

    const dep = raw.match(/^\s*-\s*Depends on:\s*(.*)$/i)
    if (dep) {
      // Case-insensitive so "t1" is recognized, and anchored to the Depends-on line only —
      // we already scoped this to the deps regex, so free-text "Ticket T42" elsewhere is safe.
      current.dependsOn = (dep[1].match(/\bT\d+\b/gi) ?? [])
        .map((t) => t.toUpperCase())
        .filter((t) => !isPlaceholder(t))
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
export function computeWaves(tasks, { maxConcurrency = DEFAULT_MAX_CONCURRENCY } = {}) {
  // Validate the cap explicitly: non-numeric / <=0 must fall back to the documented default,
  // not disable the cap by silently becoming Infinity (violates the "never >10 subagents" contract).
  const cap = Number.isFinite(maxConcurrency) && maxConcurrency >= 1 ? Math.floor(maxConcurrency) : DEFAULT_MAX_CONCURRENCY
  // Detect duplicate task ids up front — Map/Set keyed on id would otherwise silently drop one.
  const byId = new Map()
  for (const t of tasks) {
    if (byId.has(t.id)) throw new Error(`duplicate task id ${t.id}`)
    byId.set(t.id, t)
  }
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
      if (wave.length >= cap) break // concurrency cap → rest flow to the next wave
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
  const args = process.argv.slice(2)
  const maxIdx = args.findIndex((a) => a === '--max')
  let maxConcurrency = DEFAULT_MAX_CONCURRENCY
  if (maxIdx >= 0) {
    const rawMax = args[maxIdx + 1]
    const parsed = rawMax === undefined ? NaN : Number(rawMax)
    if (!Number.isFinite(parsed) || parsed < 1) {
      // Never silently disable the documented cap on `--max` typos (missing value, "--max abc",
      // "--max 0", "--max -5"). Fail loudly so the operator learns instead of over-spawning.
      console.error(`task-waves: --max requires a positive integer (got: ${rawMax ?? '<missing>'})`)
      process.exit(2)
    }
    maxConcurrency = parsed
  }
  const fileArg = args.find((a, i) => a !== '--max' && args[i - 1] !== '--max')
  const file = path.resolve(fileArg ?? path.join('.codex-flow', 'TASKS.md'))
  fs.readFile(file, 'utf8')
    .then((md) => {
      const tasks = parseTasks(md)
      if (tasks.length === 0) throw new Error(`no tasks found in ${file}`)
      console.log(renderWaves(computeWaves(tasks, { maxConcurrency })))
    })
    .catch((error) => {
      console.error(`task-waves: ${error.message}`)
      process.exit(1)
    })
}
