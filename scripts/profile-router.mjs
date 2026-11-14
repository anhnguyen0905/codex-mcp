import { appendFileSync, mkdirSync, readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { detectLanguage } from './language-detect.mjs'
import { requestDomains } from './skill-domains.mjs'

const PROFILES = ['code', 'data', 'design', 'plan', 'content', 'mixed']
const PROFILE_MODES = ['off', 'shadow', 'enforce']
const LANGUAGE_MODES = ['off', 'on']
const PACK_MODES = ['off', 'on']
export const PACKS_DEFAULT = 'off'
const PACKS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'packs')
export const NON_CODE_PROFILES = Object.freeze(['data', 'design', 'plan', 'content'])
export const DATA_PROFILE_GATES = Object.freeze([
  'Known-red test baseline',
  'Verify command',
  'Codex review git diff',
  'Checkpoint task commits',
])

const resolveValue = (env, name, values, fallback, warnings) => {
  const raw = env[name]
  if (raw === undefined) return fallback
  const value = raw.trim()
  if (values.includes(value)) return value
  warnings.push(`${name}=${value} is not one of <${values.join('|')}>; using ${fallback}`)
  return fallback
}

/**
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {{profileMode: string, evidenceMode: string, languageMode: string, warnings: string[]}}
 */
export function resolveSwitches(env = process.env) {
  const warnings = []
  return {
    profileMode: resolveValue(env, 'CODEX_FLOW_PROFILE_MODE', PROFILE_MODES, 'shadow', warnings),
    evidenceMode: resolveValue(env, 'CODEX_FLOW_EVIDENCE', PROFILE_MODES, 'off', warnings),
    languageMode: resolveValue(env, 'CODEX_FLOW_RUN_LANGUAGE', LANGUAGE_MODES, 'off', warnings),
    packs: resolveValue(env, 'CODEX_FLOW_PACKS', PACK_MODES, PACKS_DEFAULT, warnings),
    warnings,
  }
}

export const loadPackMetadata = (packsDir = PACKS_DIR) => readdirSync(packsDir, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => {
  const file = path.join(packsDir, entry.name, 'pack.json')
  const pack = JSON.parse(readFileSync(file, 'utf8'))
  if (pack.name !== entry.name || typeof pack.skill !== 'string' || !Array.isArray(pack.domains)) throw new Error(`invalid pack metadata: ${file}`)
  return pack
})
const routedPacks = ({ mode, profile, request }) => mode === 'on' && profile === 'data'
  ? loadPackMetadata().filter((pack) => pack.domains.some((domain) => requestDomains(request ?? '').includes(domain))).map((pack) => pack.name)
  : []

/** @param {{profile: string, profileMode: string}} input @returns {{skip: string[], wouldSkip: string[]}} */
export function routeGates({ profile, profileMode }) {
  if (!NON_CODE_PROFILES.includes(profile)) return { skip: [], wouldSkip: [] }
  if (profileMode === 'enforce') return { skip: [...DATA_PROFILE_GATES], wouldSkip: [] }
  if (profileMode === 'shadow') return { skip: [], wouldSkip: [...DATA_PROFILE_GATES] }
  return { skip: [], wouldSkip: [] }
}

/** @param {{runId: string, profile: string, wouldSkip: string[], evidenceMode: string, languageMode: string}} input */
export function buildShadowRecord(input) {
  return { ts: new Date().toISOString(), ...input }
}

const valueAfter = (argv, index, flag) => {
  const value = argv[index + 1]
  if (!value || value.startsWith('--')) throw new Error(`${flag} requires a value`)
  return value
}

const parseArgs = (argv) => {
  if (argv[0] !== 'resolve') throw new Error('usage: resolve --profile <p>')
  const values = {}
  for (let index = 1; index < argv.length; index += 1) {
    const flag = argv[index]
    if (!['--profile', '--request', '--request-file', '--run-id'].includes(flag)) {
      throw new Error(`unknown flag: ${flag}`)
    }
    const value = valueAfter(argv, index, flag)
    const key = flag.slice(2).replaceAll('-', '')
    if (values[key] !== undefined) throw new Error(`duplicate flag: ${flag}`)
    values[key] = value
    index += 1
  }
  if (!values.profile) throw new Error('--profile requires a value')
  if (!PROFILES.includes(values.profile)) throw new Error(`invalid profile: ${values.profile}`)
  if (values.request !== undefined && values.requestfile !== undefined) {
    throw new Error('use only one of --request or --request-file')
  }
  return values
}

const appendShadowLog = (record) => {
  try {
    const logPath = path.join('.codex-flow', 'notes', 'profile-shadow.log')
    mkdirSync(path.dirname(logPath), { recursive: true })
    appendFileSync(logPath, `${JSON.stringify(record)}\n`)
    return undefined
  } catch (error) {
    return `could not write profile shadow log: ${error instanceof Error ? error.message : String(error)}`
  }
}

/** @param {string[]} [argv] @returns {number} */
export function main(argv = process.argv.slice(2)) {
  try {
    const args = parseArgs(argv)
    const switches = resolveSwitches()
    const request = args.requestfile ? readFileSync(args.requestfile, 'utf8') : args.request
    if (switches.languageMode === 'on' && request === undefined) {
      throw new Error('language mode on requires --request or --request-file')
    }
    const routedProfile = switches.profileMode === 'off' ? '-' : args.profile
    const language = switches.languageMode === 'on' ? detectLanguage(request) : '-'
    const route = routeGates({ profile: args.profile, profileMode: switches.profileMode })
    const result = {
      profile: routedProfile,
      ...switches,
      runLanguage: language,
      languageSource: language === '-' ? '-' : 'detected',
      ...route,
      packs: routedPacks({ mode: switches.packs, profile: args.profile, request }),
      initFlags: [
        `--profile ${routedProfile}`,
        `--profile-mode ${switches.profileMode}`,
        `--evidence-mode ${switches.evidenceMode}`,
        `--language-mode ${switches.languageMode}`,
        `--run-language ${language}`,
      ].join(' '),
    }
    if (switches.profileMode === 'shadow') {
      const warning = appendShadowLog(buildShadowRecord({
        runId: args.runid ?? '-',
        profile: args.profile,
        wouldSkip: route.wouldSkip,
        evidenceMode: switches.evidenceMode,
        languageMode: switches.languageMode,
      }))
      if (warning) result.warnings = [...result.warnings, warning]
    }
    process.stdout.write(`${JSON.stringify(result)}\n`)
    return 0
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    return 2
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) process.exitCode = main()
