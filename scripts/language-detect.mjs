import { foldVietnamese, translateVietnamese } from './skill-terms.mjs'
import { ENGLISH_STOP_WORDS, VIETNAMESE_STOP_WORDS } from './skill-match.mjs'

const VIETNAMESE_SHARE_THRESHOLD = 0.7
const ENGLISH_SHARE_THRESHOLD = 0.4
const SHORT_TEXT_TOKEN_LIMIT = 10
const SHORT_GLOSSARY_TOKEN_LIMIT = 6
const MIN_VIETNAMESE_STOP_ANCHORS = 2
// A lone accented anchor amid neutral content is mixed, not decisive Vietnamese.
const BALANCED_MIXED_SCORE = 0.5
const VIETNAMESE_ONSETS = Object.freeze([
  'ngh', 'ch', 'gh', 'gi', 'kh', 'ng', 'nh', 'ph', 'qu', 'th', 'tr',
  'b', 'c', 'd', 'g', 'h', 'k', 'l', 'm', 'n', 'p', 'r', 's', 't', 'v', 'x',
])
const VIETNAMESE_CODAS = new Set(['c', 'ch', 'm', 'n', 'ng', 'nh', 'p', 't', 'i', 'y', 'o', 'u'])
const VIETNAMESE_MEDIALS = new Set(['o', 'u'])
const VIETNAMESE_NUCLEI = new Set([
  'a', 'e', 'i', 'o', 'u', 'y', 'ai', 'ao', 'au', 'ay', 'eo', 'eu', 'ia', 'ie', 'iu',
  'oa', 'oe', 'oi', 'oo', 'ua', 'ue', 'ui', 'uo', 'uu', 'uy', 'ye', 'ieu', 'yeu',
  'oai', 'oao', 'oay', 'oeo', 'uay', 'uoi', 'uou', 'uya', 'uye', 'uyu',
])
const VIETNAMESE_LETTER_PATTERN = new RegExp([
  '[đăâêôơưàáảãạằắẳẵặầấẩẫậèéẻẽẹềếểễệìíỉĩịòôóỏõọồ',
  'ốổỗộ',
  'ờớởỡợùúủũụừứửữựỳýỷỹỵ]',
].join(''), 'iu')

const tokenData = (text) => [...text.matchAll(/[\p{L}\p{N}]+/gu)].map((match) => ({
  original: match[0], folded: foldVietnamese(match[0]),
}))

const isEnglishStopWord = (token) => ENGLISH_STOP_WORDS.has(token.folded)

const isVietnameseStopWord = (token) => VIETNAMESE_STOP_WORDS.has(token.folded)
  && !isEnglishStopWord(token)
  && !(token.original.length >= 2 && token.original === token.original.toUpperCase())

const isVietnameseSyllable = (word) => {
  if (!/^[a-z]+$/u.test(word) || word !== word.toLowerCase()) return false
  if (/[fjwz]/u.test(word) || /(st|rd|ck|nd|rs|ts)$/u.test(word) || /[sflrxz]$/u.test(word)) return false
  const onset = VIETNAMESE_ONSETS.find((candidate) => word.startsWith(candidate)) ?? ''
  const body = word.slice(onset.length)
  if (!body) return false
  const hasMedial = VIETNAMESE_MEDIALS.has(body[0]) && /[aeiouy]/u.test(body[1] ?? '')
  const medial = hasMedial ? body.slice(1) : body
  const nucleus = medial.match(/^[aeiouy]+/u)?.[0] ?? ''
  const coda = medial.slice(nucleus.length)
  return VIETNAMESE_NUCLEI.has(nucleus) && (!coda || VIETNAMESE_CODAS.has(coda))
}

const glossaryCoverage = (tokens, consumed) => {
  let offset = 0
  const offsets = tokens.map(({ folded }) => {
    const range = [offset, offset + folded.length]
    offset += folded.length + 1
    return range
  })
  return offsets.map(([start, end]) => consumed.some(([from, to]) => start >= from && end <= to))
}

const classifyToken = (token, isCoveredByGlossary) => {
  const isAccented = VIETNAMESE_LETTER_PATTERN.test(token.original)
  const isEnglish = !isAccented && isEnglishStopWord(token)
  const isVietnameseStop = isVietnameseStopWord(token)
  const isSyllable = !isEnglish && !isVietnameseStop
    && /^[\x00-\x7F]+$/u.test(token.original)
    && isVietnameseSyllable(token.original)
  return {
    isEnglish,
    isAccented,
    isVietnameseStop,
    isVietnamese: isAccented || (!isEnglish
      && (isVietnameseStop || isCoveredByGlossary || isSyllable)),
  }
}

const evidenceFor = (tokens) => {
  const folded = tokens.map(({ folded: token }) => token).join(' ')
  const { consumed } = translateVietnamese(folded)
  const coveredByGlossary = glossaryCoverage(tokens, consumed)
  const classifications = tokens.map((token, index) => classifyToken(token, coveredByGlossary[index]))
  const vietnameseCount = classifications.filter(({ isVietnamese }) => isVietnamese).length
  const englishCount = classifications.filter(({ isEnglish }) => isEnglish).length
  const accentedCount = classifications.filter(({ isAccented }) => isAccented).length
  const vietnameseStopCount = classifications.filter(({ isVietnameseStop }) => isVietnameseStop).length
  const neutralCount = tokens.length - vietnameseCount - englishCount
  const hasBalancedAccentAndNeutralContent = accentedCount === 1
    && vietnameseCount === accentedCount && englishCount === 0 && neutralCount > 0

  return {
    tokenCount: tokens.length,
    vietnameseCount,
    englishCount,
    neutralCount,
    vietnameseShare: hasBalancedAccentAndNeutralContent
      ? BALANCED_MIXED_SCORE : vietnameseCount / (vietnameseCount + englishCount || 1),
    accentedCount,
    vietnameseStopCount,
    glossarySpanCount: consumed.length,
  }
}

const hasSufficientVietnameseEvidence = (evidence) => {
  const isShort = evidence.tokenCount < SHORT_TEXT_TOKEN_LIMIT
  const hasInsufficientShortGlossaryEvidence = isShort && evidence.glossarySpanCount === 1
    && evidence.accentedCount === 0
    && evidence.vietnameseStopCount === 0
    && (evidence.tokenCount <= SHORT_GLOSSARY_TOKEN_LIMIT || evidence.englishCount >= 2)
  // Short English grammar needs more than coincidental Vietnamese-shaped tokens.
  const hasInsufficientShortEnglishEvidence = isShort && evidence.accentedCount === 0
    && evidence.glossarySpanCount === 0
    && evidence.englishCount > 0 && evidence.vietnameseStopCount <= MIN_VIETNAMESE_STOP_ANCHORS
  const hasSparseVietnameseEvidence = evidence.accentedCount === 0
    && evidence.glossarySpanCount === 0 && evidence.vietnameseCount < 2 && evidence.neutralCount > 0
  const hasDominantEnglishGrammar = evidence.accentedCount === 0
    && evidence.glossarySpanCount === 0
    && evidence.englishCount > 0 && evidence.neutralCount > evidence.vietnameseCount
  return !hasInsufficientShortGlossaryEvidence
    && !hasInsufficientShortEnglishEvidence
    && !hasSparseVietnameseEvidence
    && !hasDominantEnglishGrammar
}

const languageScore = (evidence) => hasSufficientVietnameseEvidence(evidence)
  ? evidence.vietnameseShare
  : 0

/**
 * @param {string} text
 * @returns {'vi'|'en'|'mixed'}
 */
export function detectLanguage(text) {
  const tokens = tokenData(text)
  if (tokens.length === 0) return 'en'
  const score = languageScore(evidenceFor(tokens))
  if (score >= VIETNAMESE_SHARE_THRESHOLD) return 'vi'
  if (score <= ENGLISH_SHARE_THRESHOLD) return 'en'
  return 'mixed'
}
