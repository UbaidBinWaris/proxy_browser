import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createSlugger, firstParagraph, renderMarkdown, resolveHref } from '../src/lib/markdown.ts'

test('raw HTML in Markdown is escaped, never rendered', () => {
  const { html } = renderMarkdown('<script>alert(1)</script>\n\nText with <img src=x onerror=alert(1)> inline.\n\n<div onclick="x()">block</div>')
  assert.ok(!/<script/i.test(html), html)
  assert.ok(!/<img/i.test(html), html)
  assert.ok(!/<div onclick/i.test(html), html)
  assert.ok(html.includes('&lt;script&gt;alert(1)&lt;/script&gt;'))
  assert.ok(html.includes('&lt;img src=x onerror=alert(1)&gt;'))
})

test('unsafe link schemes are dropped and attributes are escaped', () => {
  const { html } = renderMarkdown('[a](javascript:alert(1)) [b](data:text/html,x) [c](https://example.com/"onmouseover="x) [d](//evil.example)')
  assert.ok(!html.includes('javascript:'))
  assert.ok(!html.includes('data:text'))
  assert.ok(!html.includes('href="//evil'))
  assert.ok(html.includes('href="https://example.com/&quot;onmouseover=&quot;x"'))
})

test('headings get GitHub-style ids, anchor links and a table of contents', () => {
  const { html, headings } = renderMarkdown('# Title\n\nIntro\n\n## Getting started\n\n### Step 1: Install `npm`!\n\n## Getting started\n\n## Café & résumé', { stripTitle: true })
  assert.ok(!html.includes('<h1'), 'the page title is rendered by the page, not the Markdown')
  assert.deepEqual(headings.map(h => [h.depth, h.id]), [[2, 'getting-started'], [3, 'step-1-install-npm'], [2, 'getting-started-1'], [2, 'café--résumé']])
  assert.ok(html.includes('<h2 id="getting-started">Getting started<a class="heading-anchor" href="#getting-started"'))
  assert.ok(html.includes('<code>npm</code>'))
})

test('a second level-1 heading is demoted so a page keeps one h1', () => {
  const { html } = renderMarkdown('# One\n\n# Two', { stripTitle: true })
  assert.ok(!html.includes('<h1'))
  assert.ok(html.includes('<h2 id="two">'))
})

test('slugger matches github-slugger for duplicates', () => {
  const slug = createSlugger()
  assert.deepEqual(['FAQ', 'FAQ', 'FAQ', 'FAQ-1'].map(slug), ['faq', 'faq-1', 'faq-2', 'faq-1-1'])
})

test('external links get rel="noopener noreferrer"; internal links do not', () => {
  const { html } = renderMarkdown('[GitHub](https://github.com/x) [Docs](/docs/install) [Top](#top) [Mail](mailto:a@example.com)')
  assert.ok(html.includes('<a href="https://github.com/x" rel="noopener noreferrer" class="external">GitHub</a>'))
  assert.ok(html.includes('<a href="/docs/install">Docs</a>'))
  assert.ok(html.includes('<a href="#top">Top</a>'))
  assert.ok(html.includes('<a href="mailto:a@example.com">Mail</a>'))
})

test('relative links resolve to docs pages or to files on GitHub', () => {
  const docSlugs = new Set(['install'])
  assert.deepEqual(resolveHref('install.md#linux', { docSlugs }), { href: '/docs/install#linux', external: false })
  assert.deepEqual(resolveHref('./missing.md', { docSlugs }), { href: 'https://github.com/UbaidBinWaris/proxy_browser/blob/main/docs/site/missing.md', external: true })
  assert.deepEqual(resolveHref('../../SECURITY.md', { docSlugs }), { href: 'https://github.com/UbaidBinWaris/proxy_browser/blob/main/SECURITY.md', external: true })
  assert.equal(resolveHref('../../../etc/passwd', { docSlugs }), null)
})

test('code blocks and tables are styled without client JavaScript', () => {
  const { html } = renderMarkdown('```bash\necho "<b>hi</b>"\n```\n\n| A | B |\n| --- | --- |\n| 1 | 2 |')
  assert.ok(html.includes('<div class="code-block"><span class="code-lang">bash</span><pre tabindex="0"><code class="language-bash">echo &quot;&lt;b&gt;hi&lt;/b&gt;&quot;</code></pre></div>'))
  assert.ok(html.includes('<div class="table-wrap" tabindex="0"><table>'))
  assert.ok(html.includes('<th>A</th>'))
})

test('a screenshot alone in its paragraph becomes a sized figure with its title as the caption', () => {
  const images = { 'images/shot.webp': { width: 1600, height: 1000 }, 'images/shot-720.webp': { width: 720, height: 450 }, 'images/plain.png': { width: 800, height: 600 } }
  const { html } = renderMarkdown('![The Launch page](images/shot.webp "Launch: pick a location")\n\n![No caption](images/plain.png)\n\nInline ![icon](images/plain.png) here.', { images })
  assert.ok(html.includes('<figure class="doc-figure"><a href="/docs-assets/images/shot.webp" aria-label="Open full-size image: The Launch page"><img src="/docs-assets/images/shot.webp" alt="The Launch page" width="1600" height="1000" srcset="/docs-assets/images/shot-720.webp 720w, /docs-assets/images/shot.webp 1600w" sizes="(max-width: 760px) 100vw, 640px" loading="lazy" decoding="async"></a><figcaption>Launch: pick a location</figcaption></figure>'), html)
  assert.ok(html.includes('<img src="/docs-assets/images/plain.png" alt="No caption" width="800" height="600" loading="lazy" decoding="async"></a></figure>'), 'no srcset without a smaller copy, no empty caption')
  assert.ok(html.includes('<p>Inline <img src="/docs-assets/images/plain.png" alt="icon" width="800" height="600" loading="lazy" decoding="async"> here.</p>'), 'inline images stay inline')
  assert.ok(!/<p>\s*<figure/.test(html), 'a figure is never wrapped in a paragraph')
})

test('images are limited to bundled docs assets', () => {
  const { html } = renderMarkdown('![Shot](images/a.png) ![Remote](https://example.com/a.png)')
  assert.ok(html.includes('<img src="/docs-assets/images/a.png" alt="Shot" loading="lazy" decoding="async">'))
  assert.ok(!html.includes('<img src="https://'))
})

test('firstParagraph extracts plain text', () => {
  assert.equal(firstParagraph('Proxy **QA** [Browser](/x) &amp; more.\n\nSecond.'), 'Proxy QA Browser & more.')
})
