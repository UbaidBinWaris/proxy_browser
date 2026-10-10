import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { buildSearchIndex, expandPrefix, highlight, indexTerms, matchers, MAX_QUERY_LENGTH, MAX_RESULTS, MAX_TERMS, pageSections, parseQuery, popularPages, search, snippet, tokenize } from '../src/lib/docs-search.ts'
import type { SearchSource } from '../src/lib/docs-search.ts'
import { parseManifest } from '../src/lib/docs.ts'
import { renderMarkdown } from '../src/lib/markdown.ts'

const docsSite = resolve(import.meta.dirname, '../../../docs/site')

const sources: SearchSource[] = [
  { slug: 'proxy-providers', title: 'Proxy providers', section: 'Using the app', description: 'Supported gateways and sessions.', markdown: '# Proxy providers\n\nPick a provider.\n\n## Sticky and rotating sessions\n\nSticky sessions keep one exit IP.\n' },
  { slug: 'faq', title: 'FAQ', section: 'Reference', description: 'Frequently asked questions.', markdown: '# FAQ\n\n## Questions\n\nA proxy, a proxy, another proxy and more proxy talk. Rotating is fine.\n' },
  { slug: 'ci-runner', title: 'CI runner', section: 'QA automation', description: 'Command-line runner.', markdown: '# CI runner\n\n## Proxy credentials\n\n| Variable | Meaning |\n| --- | --- |\n| `QA_PROVIDER` | Provider ID |\n| `QA_PROVIDER_HOST` | Gateway |\n\n```bash\nexport runCheck=1\n```\n' },
  { slug: 'install', title: 'Install', section: 'Getting started', description: 'Download and run.', markdown: '# Install\n\n## macOS\n\nClick **Open Anyway** in Privacy & Security. Résumé of the café steps.\n\n## Linux\n\nOpen the AppImage. Anyway, it works.\n' },
  { slug: 'unsafe', title: 'Unsafe', section: 'Reference', description: 'Raw HTML shown as text.', markdown: '# Unsafe\n\n## Script tags\n\nNever run <script>alert(1)</script> from a page & keep "quotes".\n' },
]
const index = buildSearchIndex(sources)

test('tokenizer folds case and diacritics, splits on punctuation and keeps identifiers whole', () => {
  assert.deepEqual(tokenize('Café RÉSUMÉ naïve'), ['cafe', 'resume', 'naive'])
  assert.deepEqual(tokenize('first-run, (proxy)! keys/vault...ok?'), ['first', 'run', 'proxy', 'keys', 'vault', 'ok'])
  assert.deepEqual(tokenize('Set QA_PROVIDER_HOST and `run_check`'), ['set', 'qa_provider_host', 'and', 'run_check'])
  assert.deepEqual(tokenize('<script>alert(1)</script>'), ['script', 'alert', '1', 'script'])
  assert.deepEqual(tokenize('   '), [])
})

test('index terms add identifier prefixes, identifier parts and camelCase parts', () => {
  const terms = indexTerms('QA_PROVIDER_HOST runCheck Café')
  for (const t of ['qa_provider_host', 'qa_provider', 'qa', 'provider', 'host', 'runcheck', 'run', 'check', 'cafe']) assert.ok(terms.has(t), t)
  assert.equal(indexTerms('proxy Proxy PROXY').get('proxy'), 3)
})

test('title matches outrank many body matches', () => {
  const { results } = search(index, 'proxy')
  assert.equal(results[0]?.slug, 'proxy-providers')
  const faq = results.find(r => r.slug === 'faq')
  assert.ok(faq && faq.score < results[0]!.score)
})

test('every query term must match (AND semantics)', () => {
  assert.deepEqual(search(index, 'sticky sessions').results.map(r => r.slug), ['proxy-providers'])
  assert.equal(search(index, 'sticky gateway linux').total, 0)
  // "rotating" appears on two pages, "proxy" on four, but only two have both.
  assert.deepEqual(search(index, 'rotating proxy').results.map(r => r.slug).sort(), ['faq', 'proxy-providers'])
})

test('only the last term is matched as a prefix', () => {
  assert.equal(search(index, 'stic').results[0]?.slug, 'proxy-providers')
  assert.equal(search(index, 'stic sessions').total, 0)
  assert.equal(search(index, 'sessions stic').results[0]?.slug, 'proxy-providers')
  assert.deepEqual(expandPrefix(['ant', 'apple', 'apply', 'banana'], 'app'), ['apple', 'apply'])
})

test('code identifiers are searchable whole and by prefix', () => {
  const exact = search(index, 'QA_PROVIDER')
  assert.equal(exact.results[0]?.slug, 'ci-runner')
  assert.equal(exact.results[0]?.anchor, 'proxy-credentials')
  assert.ok(exact.results[0]?.snippetHtml.includes('<mark>QA_PROVIDER</mark>'))
  assert.equal(search(index, 'qa_provider_ho').results[0]?.slug, 'ci-runner')
  assert.equal(search(index, 'runCheck').results[0]?.slug, 'ci-runner')
  assert.equal(search(index, 'cafe').results[0]?.slug, 'install')
  assert.equal(search(index, 'CAFÉ').results[0]?.slug, 'install')
})

test('exact phrases win and results point at the best section', () => {
  const { results } = search(index, 'open anyway')
  assert.equal(results[0]?.slug, 'install')
  assert.equal(results[0]?.anchor, 'macos')
  assert.equal(results[0]?.sectionTitle, 'macOS')
  assert.equal(results[0]?.href, '/docs/install#macos')
  assert.equal(results[0]?.section, 'Getting started')
  assert.ok(results[0]?.snippetHtml.includes('<mark>Open</mark> <mark>Anyway</mark>'), results[0]?.snippetHtml)
})

test('snippets escape HTML before adding <mark>, for content and for queries', () => {
  const content = search(index, 'script tags').results[0]
  assert.equal(content?.slug, 'unsafe')
  assert.ok(content?.snippetHtml.includes('&lt;<mark>script</mark>&gt;alert(1)&lt;/<mark>script</mark>&gt;'), content?.snippetHtml)
  assert.ok(content?.snippetHtml.includes('&amp; keep &quot;quotes&quot;'))
  assert.ok(!/<(?!\/?mark>)/.test(content?.snippetHtml ?? ''), 'only <mark> tags are emitted')

  const ms = matchers(index, parseQuery('<script>alert(1)</script>').terms)
  const html = highlight('<script>alert(1)</script> & <b>', ms)
  assert.equal(html, '&lt;<mark>script</mark>&gt;<mark>alert</mark>(1)&lt;/<mark>script</mark>&gt; &amp; &lt;b&gt;')
  const response = search(index, '<script>alert(1)</script>')
  for (const r of response.results) assert.ok(!/<(?!\/?mark>)/.test(r.snippetHtml))
})

test('snippets centre on the densest match cluster and mark ellipses', () => {
  const text = `${'filler '.repeat(60)}the sticky session keeps one exit ${'tail '.repeat(60)}`
  const html = snippet(text, matchers(index, ['sticky', 'session']))
  assert.ok(html.startsWith('… ') && html.endsWith(' …'), html)
  assert.ok(html.includes('<mark>sticky</mark> <mark>session</mark>'))
  assert.ok(html.replace(/<\/?mark>/g, '').length <= 205)
})

test('query length and term count are capped', () => {
  const long = parseQuery('a'.repeat(MAX_QUERY_LENGTH + 1))
  assert.equal(long.shortened, true)
  assert.equal(Array.from(long.text).length, MAX_QUERY_LENGTH)
  assert.equal(parseQuery('b'.repeat(MAX_QUERY_LENGTH)).shortened, false)
  const many = parseQuery('one two three four five six seven eight nine ten')
  assert.equal(many.termsDropped, true)
  assert.deepEqual(many.terms, ['one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight'])
  assert.equal(many.terms.length, MAX_TERMS)
  assert.equal(search(index, `${'proxy '.repeat(40)}`).query.shortened, true)
})

test('empty, blank and too-short queries return no results and a status for the empty state', () => {
  for (const q of [undefined, '', '   ', ['']]) assert.equal(search(index, q).query.status, 'empty')
  for (const q of ['a', '!!', '?']) assert.equal(search(index, q).query.status, 'too-short')
  assert.equal(search(index, 'a').results.length, 0)
  assert.equal(parseQuery(['proxy', 'ignored']).text, 'proxy')
  assert.deepEqual(parseQuery('how to install').terms, ['install'], 'stopwords are dropped from multi-word queries')
  assert.deepEqual(parseQuery('to').terms, ['to'], 'a stopword alone is still searched')
})

test('no-result queries suggest single terms that do match', () => {
  const response = search(index, 'sticky zzzzqq')
  assert.equal(response.total, 0)
  assert.deepEqual(response.suggestions, ['sticky'])
})

test('results are capped at MAX_RESULTS', () => {
  const many: SearchSource[] = Array.from({ length: 30 }, (_, i) => ({ slug: `p${i}`, title: `Page ${i}`, section: 'S', markdown: `# Page ${i}\n\nCommon word.\n` }))
  const response = search(buildSearchIndex(many), 'common')
  assert.equal(response.total, 30)
  assert.equal(response.results.length, MAX_RESULTS)
})

test('popular pages prefer the curated list and fall back to reading order', () => {
  const manifest = parseManifest(JSON.stringify({ sections: [{ title: 'A', pages: [{ slug: 'introduction', title: 'Introduction' }, { slug: 'troubleshooting', title: 'Troubleshooting', description: 'Fixes.' }, { slug: 'install', title: 'Install' }] }] }))
  assert.deepEqual(popularPages(manifest).map(p => p.slug), ['install', 'troubleshooting', 'introduction'])
})

test('section anchors match the heading ids markdown.ts renders for real docs pages', async () => {
  for (const slug of ['install', 'ci-runner', 'troubleshooting', 'faq']) {
    const markdown = await readFile(resolve(docsSite, `${slug}.md`), 'utf8')
    const { headings } = renderMarkdown(markdown, { stripTitle: true })
    const sections = pageSections(markdown, slug)
    assert.ok(headings.length > 2, slug)
    assert.deepEqual(sections.filter(s => s.id !== null).map(s => s.id), headings.map(h => h.id), slug)
    assert.deepEqual(sections.filter(s => s.id !== null).map(s => s.title), headings.map(h => h.text), slug)
  }
  const install = await readFile(resolve(docsSite, 'install.md'), 'utf8')
  const real = buildSearchIndex([{ slug: 'install', title: 'Install', section: 'Getting started', markdown: install }])
  const hit = search(real, 'open anyway').results[0]
  assert.equal(hit?.href, '/docs/install#macos')
  assert.ok(renderMarkdown(install, { stripTitle: true }).html.includes('<h2 id="macos">'))
})
