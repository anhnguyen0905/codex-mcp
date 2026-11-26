export const CAUSES = Object.freeze([
  'spec-ambiguous',
  'plan-wrong',
  'context-missing',
  'skill-gap',
  'executor-error',
  'verifier-gap',
  'infra',
])

export function isCause(value) {
  return typeof value === 'string' && CAUSES.includes(value)
}

export function parseCauses(csv) {
  if (typeof csv !== 'string') throw new Error(`invalid cause: ${csv}`)
  const causes = csv.split(',').map((value) => value.trim()).filter(Boolean)
  const invalid = causes.find((cause) => !isCause(cause))
  if (invalid !== undefined) throw new Error(`invalid cause: ${invalid}`)
  return causes
}
