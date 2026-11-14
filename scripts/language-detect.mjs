import { foldVietnamese, translateVietnamese } from './skill-terms.mjs'
import { ENGLISH_STOP_WORDS, VIETNAMESE_STOP_WORDS } from './skill-match.mjs'

const SHORT_TEXT_TOKEN_LIMIT = 10
const MIN_STOP_SIGNALS = 2
const MIN_STOP_SIGNAL_SHARE = 0.25
const ENGLISH_EVIDENCE_SHARE_LIMIT = 0.5
const SHORT_GLOSSARY_ENGLISH_TOKEN_LIMIT = 6
const VIETNAMESE_LETTER_PATTERN = new RegExp([
  '[đăâêôơưàáảãạằắẳẵặầấẩẫậèéẻẽẹềếểễệìíỉĩịòôóỏõọồ',
  'ốổỗộ',
  'ờớởỡợùúủũụừứửữựỳýỷỹỵ]',
].join(''), 'i')

const tokenData = (text) => [...text.matchAll(/\p{L}+/gu)].map((match) => ({
  original: match[0], folded: foldVietnamese(match[0]),
}))

const isVietnameseStopWord = (token) => VIETNAMESE_STOP_WORDS.has(token.folded)
  && !ENGLISH_STOP_WORDS.has(token.folded)
  && !(token.original.length >= 2 && token.original === token.original.toUpperCase())

/** Detect Vietnamese, English, or mixed language from alphabetic words. */
export function detectLanguage(text) {
  const tokens = tokenData(text)
  if (tokens.length === 0) return 'en'
  const folded = tokens.map(({ folded: token }) => token).join(' ')
  const { consumed } = translateVietnamese(folded)
  const offsets = []
  let offset = 0
  for (const token of tokens) {
    offsets.push([offset, offset + token.folded.length])
    offset += token.folded.length + 1
  }
  const coveredByGlossary = (index) => consumed.some(([start, end]) => (
    offsets[index][0] >= start && offsets[index][1] <= end
  ))
  const stopSignals = tokens.filter(isVietnameseStopWord).length
  const englishStopSignals = tokens.filter(({ folded }) => ENGLISH_STOP_WORDS.has(folded)).length
  const glossarySignals = consumed.length
  const accentedIndexes = tokens.map((token, index) => (
    VIETNAMESE_LETTER_PATTERN.test(token.original) ? index : -1
  )).filter((index) => index >= 0)
  const stopIndexes = tokens.map((token, index) => (
    isVietnameseStopWord(token) ? index : -1
  )).filter((index) => index >= 0)
  const glossaryIndexes = tokens.map((_, index) => coveredByGlossary(index) ? index : -1)
    .filter((index) => index >= 0)
  const signalIndexes = new Set([...accentedIndexes, ...stopIndexes, ...glossaryIndexes])
  const signalCount = accentedIndexes.length > 0
    ? signalIndexes.size : stopSignals + glossarySignals
  if (accentedIndexes.length === 0 && glossarySignals === 0
    && stopSignals < MIN_STOP_SIGNALS && englishStopSignals > 0) return 'en'
  if (accentedIndexes.length === 0 && tokens.length >= SHORT_TEXT_TOKEN_LIMIT
    && (glossarySignals > 0 || stopSignals >= MIN_STOP_SIGNALS)) return 'vi'
  if (accentedIndexes.length === 0 && glossarySignals > 0
    && (stopSignals > 0 || glossarySignals >= MIN_STOP_SIGNALS)) return 'vi'
  if (tokens.length < SHORT_TEXT_TOKEN_LIMIT && accentedIndexes.length === 0) {
    const signalUnits = stopSignals + glossarySignals
    const stopShare = stopSignals / tokens.length
    if (signalUnits < MIN_STOP_SIGNALS || (glossarySignals === 0 && stopShare < MIN_STOP_SIGNAL_SHARE)
      || (glossarySignals === 0
        && englishStopSignals >= 1
        && (tokens.length - signalIndexes.size) / tokens.length > ENGLISH_EVIDENCE_SHARE_LIMIT)) {
      return glossarySignals > 0 && tokens.length > SHORT_GLOSSARY_ENGLISH_TOKEN_LIMIT ? 'mixed' : 'en'
    }
  }
  const share = signalCount / tokens.length
  return share === 0 ? 'en' : share >= 0.3 ? 'vi' : 'mixed'
}
