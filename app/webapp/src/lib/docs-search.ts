import { Marked } from 'marked'
import type { Token, Tokens } from 'marked'
import { allPages, loadManifest, readContent } from './docs.ts'
import type { DocsManifest } from './docs.ts'
import { createSlugger, escapeHtml, firstParagraph, renderMarkdown } from './markdown.ts'

/*
 * Server-side documentation search. The index is built from the synced Markdown (content/docs) on first use and
 * kept in memory; everything below `loadSearchIndex` is pure so it can be unit-tested without the file system.
 */

export const MAX_QUERY_LENGTH = 100
export const MAX_TERMS = 8
export const MAX_RESULTS = 20
export const MIN_QUERY_LENGTH = 2

const WEIGHT = { title: 12, heading: 6, description: 4, section: 1, body: 1 } as const
const PHRASE_BONUS = { title: 20, heading: 12, description: 8, body: 4 } as const
const PREFIX_QUALITY = 0.8
const ALL_TERMS_IN_SECTION_BONUS = 3
const MAX_PREFIX_EXPANSIONS = 64
const SNIPPET_LENGTH = 200
const SNIPPET_LEAD = 50
/** Dropped from multi-word queries so "how to install" does not require "how" and "to" on the page. */
const STOPWORDS = new Set(['a', 'an', 'and', 'are', 'as', 'at', 'be', 'by', 'can', 'do', 'does', 'for', 'from', 'how', 'i', 'in', 'is', 'it', 'my', 'of', 'on', 'or', 'the', 'to', 'what', 'when', 'where', 'why', 'with'])
const POPULAR_SLUGS = ['install', 'first-run', 'proxy-providers', 'launching', 'automation', 'troubleshooting']

// ---------- Tokenizer ----------

/** Case- and diacritic-insensitive form of a string ("Café" → "cafe"). */
export function fold(value: string): string {
  return value.normalize('NFKD').replace(/\p{M}+/gu, '').toLowerCase()
}

/** Words are runs of letters and digits; underscores join them so code identifiers like QA_PROVIDER stay whole. */
const WORD = /[\p{L}\p{M}\p{N}]+(?:_+[\p{L}\p{M}\p{N}]+)*/gu

/** Query terms: folded words in order, identifiers kept whole (`QA_PROVIDER` → `qa_provider`). */
export function tokenize(text: string): string[] {
  return Array.from(fold(text).matchAll(WORD), m => m[0])
}

/**
 * Index forms of one source word: the folded word itself, each underscore prefix (`qa`, `qa_provider`,
 * `qa_provider_host`), each underscore part and each camelCase part (`runCheck` → `run`, `check`).
 */
export function wordForms(word: string): string[] {
  const forms = new Set<string>(), folded = fold(word)
  forms.add(folded)
  const parts = folded.split(/_+/).filter(Boolean)
  if (parts.length > 1) parts.forEach((part, i) => { forms.add(part); forms.add(parts.slice(0, i + 1).join('_')) })
  for (const piece of word.normalize('NFKD').replace(/\p{M}+/gu, '').split(/_+/)) {
    const camel = piece.match(/\p{Lu}?\p{Ll}+|\p{Lu}+(?!\p{Ll})|\p{N}+/gu)
    if (camel && camel.length > 1) camel.forEach(part => forms.add(part.toLowerCase()))
  }
  return [...forms]
}

/** Term frequencies of all index forms in a text. */
export function indexTerms(text: string): Map<string, number> {
  const counts = new Map<string, number>()
  for (const m of text.normalize('NFC').matchAll(WORD)) for (const form of wordForms(m[0])) counts.set(form, (counts.get(form) ?? 0) + 1)
  return counts
}

/** Folded text with punctuation collapsed to single spaces, for exact-phrase matching. */
export function phraseText(text: string): string { return tokenize(text).join(' ') }

// ---------- Index ----------

export type SearchSource = { slug: string; title: string; section: string; description?: string; markdown: string }
export type IndexedSection = {
  /** Heading id as rendered by markdown.ts, or null for the text before the first heading. */
  id: string | null
  title: string
  depth: number
  text: string
  headingTerms: Set<string>
  bodyTerms: Map<string, number>
  headingPhrase: string
  bodyPhrase: string
}
export type IndexedPage = {
  slug: string; title: string; section: string; description: string; order: number
  titleTerms: Set<string>; descriptionTerms: Set<string>; sectionTerms: Set<string>; allTerms: Set<string>
  titlePhrase: string; descriptionPhrase: string
  sections: IndexedSection[]
}
export type SearchIndex = { pages: IndexedPage[]; vocabulary: string[] }

function inlineText(tokens: Token[] | undefined, fallback = ''): string {
  if (!tokens) return fallback
  return tokens.map(token => {
    switch (token.type) {
      case 'br': return ' '
      case 'image': return (token as Tokens.Image).text
      case 'codespan': case 'escape': case 'html': return (token as Tokens.Codespan).text
      default: {
        const t = token as Tokens.Generic
        return Array.isArray(t.tokens) ? inlineText(t.tokens as Token[]) : typeof t.text === 'string' ? t.text : ''
      }
    }
  }).join('')
}

type BlockEvent = { kind: 'heading'; depth: number; text: string } | { kind: 'text'; text: string }

/** Flattens block tokens in document (render) order into headings and plain-text runs; code keeps its identifiers. */
function blockEvents(tokens: Token[], out: BlockEvent[] = []): BlockEvent[] {
  for (const token of tokens) {
    switch (token.type) {
      case 'heading': { const h = token as Tokens.Heading; out.push({ kind: 'heading', depth: h.depth, text: inlineText(h.tokens, h.text) }); break }
      case 'code': out.push({ kind: 'text', text: (token as Tokens.Code).text }); break
      case 'html': out.push({ kind: 'text', text: (token as Tokens.HTML).text }); break
      case 'table': {
        const t = token as Tokens.Table
        out.push({ kind: 'text', text: [t.header, ...t.rows].map(row => row.map(cell => inlineText(cell.tokens, cell.text)).join(' · ')).join('. ') })
        break
      }
      case 'blockquote': blockEvents((token as Tokens.Blockquote).tokens, out); break
      case 'list': for (const item of (token as Tokens.List).items) blockEvents(item.tokens, out); break
      case 'paragraph': case 'text': { const t = token as Tokens.Paragraph; out.push({ kind: 'text', text: inlineText(t.tokens, t.text) }); break }
      default: break // space, hr, def
    }
  }
  return out
}

const squash = (text: string) => text.replace(/\s+/g, ' ').trim()
const termSet = (text: string) => new Set(indexTerms(text).keys())

/** Splits one page into sections whose ids are exactly the ids renderMarkdown gives its headings. */
export function pageSections(markdown: string, title: string): { id: string | null; title: string; depth: number; text: string }[] {
  const source = markdown.replace(/^\uFEFF/, '')
  const { headings } = renderMarkdown(source, { stripTitle: true })
  const fallbackSlug = createSlugger()
  const sections: { id: string | null; title: string; depth: number; text: string[] }[] = [{ id: null, title, depth: 1, text: [] }]
  let titleStripped = false, next = 0
  for (const event of blockEvents(new Marked({ gfm: true }).lexer(source))) {
    if (event.kind === 'text') { sections.at(-1)!.text.push(event.text); continue }
    if (!titleStripped && event.depth === 1) { titleStripped = true; continue }
    const heading = headings[next++]
    const text = heading?.text ?? squash(event.text)
    sections.push({ id: heading?.id ?? fallbackSlug(text), title: text, depth: heading?.depth ?? Math.max(2, event.depth), text: [] })
  }
  return sections.map(s => ({ ...s, text: squash(s.text.join(' ')) })).filter(s => s.id !== null || s.text)
}

/** Builds the in-memory index. Pure: callers pass the Markdown already read. */
export function buildSearchIndex(sources: SearchSource[]): SearchIndex {
  const vocabulary = new Set<string>()
  const pages = sources.map((source, order): IndexedPage => {
    const description = source.description || firstParagraph(source.markdown.replace(/^\uFEFF?#[^\n]*\n/, ''))
    const sections = pageSections(source.markdown, source.title).map((s): IndexedSection => ({
      ...s,
      headingTerms: s.id === null ? new Set() : termSet(s.title),
      bodyTerms: indexTerms(s.text),
      headingPhrase: s.id === null ? '' : phraseText(s.title),
      bodyPhrase: phraseText(s.text),
    }))
    const page = {
      slug: source.slug, title: source.title, section: source.section, description, order,
      titleTerms: termSet(source.title), descriptionTerms: termSet(description), sectionTerms: termSet(source.section),
      titlePhrase: phraseText(source.title), descriptionPhrase: phraseText(description), sections,
      allTerms: new Set<string>(),
    }
    for (const set of [page.titleTerms, page.descriptionTerms, page.sectionTerms, ...sections.flatMap(s => [s.headingTerms, new Set(s.bodyTerms.keys())])]) for (const term of set) page.allTerms.add(term)
    for (const term of page.allTerms) vocabulary.add(term)
    return page
  })
  return { pages, vocabulary: [...vocabulary].sort() }
}

// ---------- Query ----------

export type ParsedQuery = {
  /** The query as searched: trimmed, control characters removed, capped at MAX_QUERY_LENGTH characters. */
  text: string
  terms: string[]
  /** Folded query words joined by spaces, for the exact-phrase bonus ('' for one-word queries). */
  phrase: string
  shortened: boolean
  termsDropped: boolean
  status: 'empty' | 'too-short' | 'ok'
}

export function parseQuery(input: unknown): ParsedQuery {
  const raw = typeof input === 'string' ? input : Array.isArray(input) && typeof input[0] === 'string' ? input[0] : ''
  const cleaned = raw.replace(/[\p{Cc}\p{Cf}]+/gu, ' ').replace(/\s+/g, ' ').trim()
  const chars = Array.from(cleaned), shortened = chars.length > MAX_QUERY_LENGTH
  const text = shortened ? chars.slice(0, MAX_QUERY_LENGTH).join('').trim() : cleaned
  const words = tokenize(text)
  let terms = [...new Set(words)]
  const meaningful = terms.filter(t => t.length > 1 && !STOPWORDS.has(t))
  if (meaningful.length) terms = meaningful
  const termsDropped = terms.length > MAX_TERMS
  terms = terms.slice(0, MAX_TERMS)
  const status = !text ? 'empty' : !terms.length || words.join('').length < MIN_QUERY_LENGTH ? 'too-short' : 'ok'
  return { text, terms: status === 'ok' ? terms : [], phrase: words.length > 1 ? words.join(' ') : '', shortened, termsDropped, status }
}

/** Vocabulary terms starting with `prefix` (binary search over the sorted vocabulary). */
export function expandPrefix(vocabulary: readonly string[], prefix: string, limit = MAX_PREFIX_EXPANSIONS): string[] {
  let lo = 0, hi = vocabulary.length
  while (lo < hi) { const mid = (lo + hi) >>> 1; if (vocabulary[mid]! < prefix) lo = mid + 1; else hi = mid }
  const out: string[] = []
  for (let i = lo; i < vocabulary.length && out.length < limit && vocabulary[i]!.startsWith(prefix); i++) out.push(vocabulary[i]!)
  return out
}

export type Matcher = { term: string; forms: Map<string, number> }
/** One matcher per query term: exact form scores 1; the last term also matches vocabulary words it prefixes. */
export function matchers(index: SearchIndex, terms: string[]): Matcher[] {
  return terms.map((term, i) => {
    const forms = new Map<string, number>([[term, 1]])
    if (i === terms.length - 1) for (const word of expandPrefix(index.vocabulary, term)) if (word !== term) forms.set(word, PREFIX_QUALITY)
    return { term, forms }
  })
}
function quality(m: Matcher, terms: Set<string> | Map<string, number>): number {
  let best = 0
  for (const [form, q] of m.forms) if (q > best && terms.has(form)) { best = q; if (q === 1) break }
  return best
}
function bodyQuality(m: Matcher, terms: Map<string, number>): number {
  let best = 0
  for (const [form, q] of m.forms) { const tf = terms.get(form); if (tf) best = Math.max(best, q * Math.min(3, 1 + Math.log(tf))) }
  return best
}
const hasPhrase = (text: string, phrase: string) => !!phrase && !!text && ` ${text} `.includes(` ${phrase}`)

// ---------- Snippets ----------

type Match = { start: number; end: number; term: number }
function findMatches(text: string, ms: Matcher[]): Match[] {
  const out: Match[] = []
  for (const m of text.matchAll(WORD)) {
    const forms = wordForms(m[0]), term = ms.findIndex(matcher => forms.some(f => matcher.forms.has(f)))
    if (term >= 0) out.push({ start: m.index, end: m.index + m[0].length, term })
  }
  return out
}

/** Escapes the text first, then wraps whole matching words in <mark>. Only <mark> is ever emitted as markup. */
export function highlight(text: string, ms: Matcher[]): string {
  let html = '', at = 0
  for (const match of findMatches(text, ms)) { html += escapeHtml(text.slice(at, match.start)) + `<mark>${escapeHtml(text.slice(match.start, match.end))}</mark>`; at = match.end }
  return html + escapeHtml(text.slice(at))
}

/** A window of about SNIPPET_LENGTH characters around the densest cluster of query terms, escaped and highlighted. */
export function snippet(text: string, ms: Matcher[], length = SNIPPET_LENGTH): string {
  if (!text) return ''
  const matches = findMatches(text, ms)
  let anchor = 0
  if (matches.length) {
    let best = -1
    for (const m of matches) {
      const distinct = new Set(matches.filter(o => o.start >= m.start && o.end <= m.start + length - SNIPPET_LEAD).map(o => o.term)).size
      if (distinct > best) { best = distinct; anchor = m.start }
    }
  }
  let start = Math.max(0, anchor - SNIPPET_LEAD)
  if (start > 0) { const space = text.indexOf(' ', start); start = space >= 0 && space < anchor ? space + 1 : anchor }
  let end = Math.min(text.length, start + length)
  if (end < text.length) { const space = text.lastIndexOf(' ', end); if (space > start) end = space }
  const window = text.slice(start, end)
  return `${start > 0 ? '… ' : ''}${highlight(window, ms)}${end < text.length ? ' …' : ''}`
}

// ---------- Search ----------

export type SearchResult = {
  slug: string
  href: string
  pageTitle: string
  /** Manifest section the page belongs to ("Getting started"). */
  section: string
  /** Heading id of the best-matching section, or null when the page itself is the best match. */
  anchor: string | null
  sectionTitle: string | null
  /** Safe HTML: escaped text with <mark> around matches. */
  snippetHtml: string
  score: number
}
export type SearchResponse = {
  query: ParsedQuery
  results: SearchResult[]
  /** Matching pages before the MAX_RESULTS cap. */
  total: number
  /** Single query terms that would return results on their own (offered when nothing matched). */
  suggestions: string[]
}

function scorePage(page: IndexedPage, ms: Matcher[], phrase: string) {
  if (!ms.every(m => quality(m, page.allTerms) > 0)) return null
  let score = 0
  for (const m of ms) score += Math.max(WEIGHT.title * quality(m, page.titleTerms), WEIGHT.description * quality(m, page.descriptionTerms), WEIGHT.section * quality(m, page.sectionTerms))
  if (hasPhrase(page.titlePhrase, phrase)) score += PHRASE_BONUS.title
  else if (hasPhrase(page.descriptionPhrase, phrase)) score += PHRASE_BONUS.description
  let best: { section: IndexedSection; score: number } | null = null
  for (const section of page.sections) {
    let s = 0, all = true
    for (const m of ms) {
      const h = WEIGHT.heading * quality(m, section.headingTerms), b = WEIGHT.body * bodyQuality(m, section.bodyTerms)
      if (!h && !b) all = false
      s += h + b
    }
    if (all) s += ALL_TERMS_IN_SECTION_BONUS
    if (hasPhrase(section.headingPhrase, phrase)) s += PHRASE_BONUS.heading
    if (hasPhrase(section.bodyPhrase, phrase)) s += PHRASE_BONUS.body
    if (s > 0 && (!best || s > best.score)) best = { section, score: s }
  }
  return { score: score + (best?.score ?? 0), best }
}

export function search(index: SearchIndex, input: unknown): SearchResponse {
  const query = parseQuery(input)
  if (query.status !== 'ok') return { query, results: [], total: 0, suggestions: [] }
  const ms = matchers(index, query.terms)
  const scored = index.pages.flatMap(page => {
    const r = scorePage(page, ms, query.phrase)
    if (!r) return []
    const section = r.best?.section ?? null
    const anchor = section?.id ?? null
    const text = section?.text || page.description || page.sections[0]?.text || ''
    const result: SearchResult = {
      slug: page.slug, href: `/docs/${page.slug}${anchor ? `#${anchor}` : ''}`, pageTitle: page.title, section: page.section,
      anchor, sectionTitle: anchor ? section!.title : null, snippetHtml: snippet(text, ms), score: Math.round(r.score * 100) / 100,
    }
    return [{ result, order: page.order }]
  }).sort((a, b) => b.result.score - a.result.score || a.order - b.order)
  const suggestions = !scored.length && query.terms.length > 1
    ? query.terms.filter(term => index.pages.some(page => page.allTerms.has(term)))
    : []
  return { query, results: scored.slice(0, MAX_RESULTS).map(s => s.result), total: scored.length, suggestions }
}

export type PopularPage = { slug: string; title: string; description?: string }
/** Pages offered on the empty and no-results states: a curated list, falling back to reading order. */
export function popularPages(manifest: DocsManifest, limit = 6): PopularPage[] {
  const pages = allPages(manifest)
  const picked = POPULAR_SLUGS.map(slug => pages.find(p => p.slug === slug)).filter(p => p !== undefined)
  for (const page of pages) if (picked.length < limit && !picked.includes(page)) picked.push(page)
  return picked.slice(0, limit).map(p => ({ slug: p.slug, title: p.title, ...(p.description ? { description: p.description } : {}) }))
}

// ---------- Loading (I/O) ----------

let cached: Promise<SearchIndex> | null = null
/** Reads the synced Markdown once and keeps the index in memory (rebuilt on every call in development). */
export function loadSearchIndex(): Promise<SearchIndex> {
  const build = async () => {
    const pages = allPages(await loadManifest())
    const sources = await Promise.all(pages.map(async page => ({ ...page, markdown: await readContent(`docs/${page.slug}.md`, raw => raw) })))
    return buildSearchIndex(sources)
  }
  if (process.env.NODE_ENV !== 'production') return build()
  cached ??= build().catch(error => { cached = null; throw error })
  return cached
}
