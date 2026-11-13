/** Ordered flow phases accepted by the CLI and state kernel. */
export const PHASES = Object.freeze(['interview', 'plan', 'backlog', 'execution', 'review', 'complete'])
/** Approval gate names accepted by the CLI and state kernel. */
export const APPROVAL_GATES = Object.freeze(['requirements', 'plan', 'backlog'])
/** Non-linear transition command names accepted by the CLI and state kernel. */
export const NON_LINEAR_COMMANDS = Object.freeze(['requirement-delta', 'plan-drift', 'improvement-gate'])

const PHASE_SET = new Set(PHASES)
const APPROVAL_GATE_SET = new Set(APPROVAL_GATES)
const NON_LINEAR_COMMAND_SET = new Set(NON_LINEAR_COMMANDS)

export function parseOptions(args, positionalCount, allowedOptions, flagOptions = new Set()) {
  const positionals = []
  const options = {}
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]
    if (!argument.startsWith('--')) {
      positionals.push(argument)
      continue
    }
    if (!allowedOptions.has(argument)) throw new Error(`unknown option ${argument}`)
    if (Object.hasOwn(options, argument)) throw new Error(`duplicate option ${argument}`)
    if (flagOptions.has(argument)) {
      options[argument] = true
      continue
    }
    const value = args[index + 1]
    if (!value || value.startsWith('--')) throw new Error(`${argument} requires a value`)
    options[argument] = value
    index += 1
  }
  if (positionals.length !== positionalCount) throw new Error('invalid arguments')
  return { positionals, options }
}

function requiredOption(options, name) {
  const value = options[name]
  if (!value) throw new Error(`${name} requires a value`)
  return value
}

export function parseCliArgs(argv) {
  if (!Array.isArray(argv) || argv.some((argument) => typeof argument !== 'string')) {
    throw new TypeError('CLI args must be an array of strings')
  }
  const [command, ...args] = argv
  const state = (options) => options['--state'] ?? '.codex-flow/STATE.md'
  if (command === 'init') {
    const parsed = parseOptions(args, 0, new Set([
      '--state', '--baseline', '--known-red', '--dirty-baseline', '--executor',
      '--events', '--profile', '--profile-mode', '--evidence-mode', '--language-mode', '--run-language',
    ]))
    return {
      command,
      state: state(parsed.options),
      baseline: requiredOption(parsed.options, '--baseline'),
      knownRed: requiredOption(parsed.options, '--known-red'),
      dirtyBaseline: parsed.options['--dirty-baseline'],
      executor: parsed.options['--executor'],
      profile: parsed.options['--profile'],
      profileMode: parsed.options['--profile-mode'],
      evidenceMode: parsed.options['--evidence-mode'],
      languageMode: parsed.options['--language-mode'],
      runLanguage: parsed.options['--run-language'],
      events: parsed.options['--events'],
    }
  }
  if (command === 'approve') {
    const parsed = parseOptions(
      args,
      1,
      new Set(['--state', '--at', '--delta', '--checkpoint-commits', '--execution-mode', '--dir', '--events']),
      new Set(['--delta']),
    )
    const gate = parsed.positionals[0]
    if (!APPROVAL_GATE_SET.has(gate)) throw new Error(`unknown approval ${gate}`)
    return {
      command,
      gate,
      state: state(parsed.options),
      at: parsed.options['--at'],
      delta: parsed.options['--delta'] === true,
      checkpointCommits: parsed.options['--checkpoint-commits'],
      executionMode: parsed.options['--execution-mode'],
      dir: parsed.options['--dir'] ?? '.codex-flow',
      events: parsed.options['--events'],
    }
  }
  if (command === 'advance') {
    const parsed = parseOptions(args, 0, new Set(['--state', '--tasks', '--events']))
    return {
      command, state: state(parsed.options), tasks: parsed.options['--tasks'] ?? '.codex-flow/TASKS.md',
      events: parsed.options['--events'],
    }
  }
  if (NON_LINEAR_COMMAND_SET.has(command)) {
    const parsed = parseOptions(args, 0, new Set(['--state', '--at', '--events']))
    return {
      command, state: state(parsed.options), at: parsed.options['--at'], events: parsed.options['--events'],
    }
  }
  if (command === 'resume') {
    const parsed = parseOptions(args, 0, new Set(['--state', '--head', '--phase', '--events']))
    const phase = parsed.options['--phase']
    if (phase !== undefined && !PHASE_SET.has(phase)) throw new Error(`invalid phase ${JSON.stringify(phase)}`)
    return {
      command, state: state(parsed.options), head: requiredOption(parsed.options, '--head'), phase,
      events: parsed.options['--events'],
    }
  }
  if (command === 'set') {
    const parsed = parseOptions(args, 2, new Set(['--state']))
    return { command, key: parsed.positionals[0], value: parsed.positionals[1], state: state(parsed.options) }
  }
  if (command === 'check') {
    const parsed = parseOptions(args, 0, new Set(['--state', '--tasks', '--events']))
    return {
      command, state: state(parsed.options), tasks: parsed.options['--tasks'] ?? null,
      events: parsed.options['--events'],
    }
  }
  if (command === 'archive-paths') {
    const parsed = parseOptions(args, 0, new Set(['--state']))
    return { command, state: state(parsed.options) }
  }
  if (command === 'task') {
    const parsed = parseOptions(args, 2, new Set(['--tasks', '--at']))
    return {
      command,
      id: parsed.positionals[0],
      status: parsed.positionals[1],
      tasks: parsed.options['--tasks'] ?? '.codex-flow/TASKS.md',
      at: parsed.options['--at'],
    }
  }
  throw new Error(
    'usage: flow-state <init|approve|advance|requirement-delta|plan-drift|improvement-gate|resume|set|check'
      + '|archive-paths|task> ...',
  )
}
