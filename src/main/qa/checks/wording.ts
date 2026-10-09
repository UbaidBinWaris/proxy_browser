/**
 * Approved-wording comparison for consent disclosures: whitespace normalization and a word-level diff.
 * Only whitespace (including non-breaking and zero-width spaces) and Unicode composition are
 * normalized; punctuation, quotes and case are compared exactly, because they are part of the wording.
 */
import type { QaWordDiffOp } from '@shared/qa-checks'

export function normalizeWording(text: string): string {
  return text
    .normalize('NFC')
    .replace(/\u200b|\u200c|\u200d|\u2060|\ufeff/gu, '')
    .replace(/\s+/gu, ' ')
    .trim()
}

const words = (text: string): string[] => {
  const normalized = normalizeWording(text)
  return normalized ? normalized.split(' ') : []
}

/** Longest-common-subsequence table cap; larger middles are reported as one removed and one added run. */
const MAX_CELLS = 4_000_000

/**
 * Word diff of `actual` (the page) against `expected` (the approved text). `removed` words are in the
 * approved text only, `added` words on the page only. Adjacent words of the same kind are merged.
 */
export function diffWords(expected: string, actual: string): QaWordDiffOp[] {
  const a = words(expected)
  const b = words(actual)
  let start = 0
  while (start < a.length && start < b.length && a[start] === b[start]) start++
  let endA = a.length
  let endB = b.length
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--
    endB--
  }
  const raw: Array<{ op: QaWordDiffOp['op']; word: string }> = a.slice(0, start).map((word) => ({ op: 'same', word }))
  const midA = a.slice(start, endA)
  const midB = b.slice(start, endB)
  if ((midA.length + 1) * (midB.length + 1) > MAX_CELLS) {
    raw.push(...midA.map((word) => ({ op: 'removed' as const, word })), ...midB.map((word) => ({ op: 'added' as const, word })))
  } else {
    const n = midA.length
    const m = midB.length
    const width = m + 1
    const table = new Uint32Array((n + 1) * width)
    for (let i = n - 1; i >= 0; i--)
      for (let j = m - 1; j >= 0; j--)
        table[i * width + j] =
          midA[i] === midB[j]
            ? table[(i + 1) * width + j + 1]! + 1
            : Math.max(table[(i + 1) * width + j]!, table[i * width + j + 1]!)
    let i = 0
    let j = 0
    while (i < n || j < m) {
      if (i < n && j < m && midA[i] === midB[j]) {
        raw.push({ op: 'same', word: midA[i]! })
        i++
        j++
      } else if (i < n && (j === m || table[(i + 1) * width + j]! >= table[i * width + j + 1]!)) {
        raw.push({ op: 'removed', word: midA[i]! })
        i++
      } else {
        raw.push({ op: 'added', word: midB[j]! })
        j++
      }
    }
  }
  raw.push(...a.slice(endA).map((word) => ({ op: 'same' as const, word })))
  const ops: QaWordDiffOp[] = []
  for (const item of raw) {
    const last = ops.at(-1)
    if (last && last.op === item.op) last.text += ` ${item.word}`
    else ops.push({ op: item.op, text: item.word })
  }
  return ops
}

export interface WordingVerdict {
  matches: boolean
  /** Present when the wording does not match. */
  diff?: QaWordDiffOp[]
}

/** `exact`: normalized texts are equal; `contains`: the normalized page text contains the approved text. */
export function compareWording(approved: string, actual: string, mode: 'exact' | 'contains' = 'exact'): WordingVerdict {
  const expected = normalizeWording(approved)
  const page = normalizeWording(actual)
  const matches = mode === 'exact' ? page === expected : page.includes(expected)
  return matches ? { matches } : { matches, diff: diffWords(expected, page) }
}

/**
 * Compact one-line rendering: unchanged runs longer than eight words keep three words of context on
 * each side. `[-word-]` was approved but is missing; `{+word+}` is on the page only.
 */
export function formatWordDiff(ops: readonly QaWordDiffOp[], maxLength = 600): string {
  const parts = ops.map((item, index) => {
    if (item.op === 'removed') return `[-${item.text}-]`
    if (item.op === 'added') return `{+${item.text}+}`
    const list = item.text.split(' ')
    if (list.length <= 8) return item.text
    const head = index === 0 ? [] : list.slice(0, 3)
    const tail = index === ops.length - 1 ? [] : list.slice(-3)
    return [...head, '…', ...tail].join(' ')
  })
  const text = parts.join(' ')
  return text.length > maxLength ? `${text.slice(0, maxLength - 1)}…` : text
}

/** Counts for headlines: "wording: 2 words missing, 1 extra". */
export function describeWordDiff(ops: readonly QaWordDiffOp[]): string {
  const count = (op: QaWordDiffOp['op']): number =>
    ops.filter((item) => item.op === op).reduce((total, item) => total + item.text.split(' ').length, 0)
  const removed = count('removed')
  const added = count('added')
  const parts = [
    ...(removed ? [`${removed} approved word${removed === 1 ? '' : 's'} missing`] : []),
    ...(added ? [`${added} extra word${added === 1 ? '' : 's'}`] : []),
  ]
  return parts.join(', ') || 'whitespace-only difference'
}
