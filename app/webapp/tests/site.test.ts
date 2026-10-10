import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseReleaseNotes } from '../src/lib/changelog.ts'
import { securityTxt } from '../src/lib/security-txt.ts'
import { breadcrumbList, docArticle, pageMetadata, sitemapEntries } from '../src/lib/seo.ts'
import { LEGAL_LINKS, POLICY_DATE, SITE_URL } from '../src/lib/site.ts'

test('sitemap lists home, docs, legal, about and changelog pages', () => {
  const urls = sitemapEntries([{ slug: 'introduction' }, { slug: 'install' }]).map(e => e.url)
  for (const path of ['', '/docs', '/docs/introduction', '/docs/install', '/changelog', '/about', '/terms', '/acceptable-use', '/privacy', '/licenses', '/security', '/disclaimer']) assert.ok(urls.includes(`${SITE_URL}${path}`), path)
  assert.equal(new Set(urls).size, urls.length)
  assert.ok(!urls.some(u => u.includes('/admin')))
  assert.ok(!urls.some(u => u.includes('/docs/search')), 'search result pages are noindex and stay out of the sitemap')
  assert.equal(LEGAL_LINKS.length, 6)
})

test('sitemap dates docs by their last commit, legal pages by the policy date, and lists screenshots', () => {
  const entries = sitemapEntries(
    [{ slug: 'introduction', lastModified: '2026-10-08T10:00:00+05:00', images: ['images/launch.webp'] }, { slug: 'install', lastModified: '2026-10-10T09:00:00+05:00' }, { slug: 'faq' }],
    ['/docs-assets/images/launch.webp'],
  )
  const entry = (path: string) => entries.find(e => e.url === `${SITE_URL}${path}`)!
  assert.equal(entry('/docs/introduction').lastModified, '2026-10-08T10:00:00+05:00')
  assert.deepEqual(entry('/docs/introduction').images, [`${SITE_URL}/docs-assets/images/launch.webp`])
  assert.equal(entry('/docs/faq').lastModified, undefined, 'no date is invented for a page without history')
  assert.equal(entry('').lastModified, '2026-10-10T09:00:00+05:00', 'the home page changes with the newest docs page')
  assert.equal(entry('/docs').lastModified, '2026-10-10T09:00:00+05:00')
  assert.deepEqual(entry('').images, [`${SITE_URL}/docs-assets/images/launch.webp`])
  for (const link of LEGAL_LINKS) assert.equal(entry(link.href).lastModified, POLICY_DATE, link.href)
  assert.equal(entry('/about').lastModified, undefined)
})

test('docs pages get article metadata, a per-page social image and structured data', () => {
  const metadata = pageMetadata({ title: 'Install', description: 'd', path: '/docs/install', image: { url: '/og/install', width: 1200, height: 630, alt: 'a' }, article: { section: 'Getting started', modifiedTime: '2026-10-10T09:00:00+05:00' } })
  assert.equal(metadata.alternates?.canonical, '/docs/install')
  assert.deepEqual(metadata.openGraph, { type: 'article', siteName: 'Proxy QA Browser', title: 'Install | Proxy QA Browser', description: 'd', url: '/docs/install', images: [{ url: '/og/install', width: 1200, height: 630, alt: 'a' }], authors: ['https://ubaidbinwaris.com'], modifiedTime: '2026-10-10T09:00:00+05:00', section: 'Getting started' })
  assert.deepEqual((metadata.twitter as { images: string[] }).images, ['/og/install'])
  const article = docArticle({ slug: 'install', title: 'Install', description: 'd', section: 'Getting started', lastModified: '2026-10-10T09:00:00+05:00' })
  assert.equal(article['@type'], 'TechArticle')
  assert.equal(article.url, `${SITE_URL}/docs/install`)
  assert.deepEqual(article.image, [`${SITE_URL}/og/install`])
  assert.equal(article.dateModified, '2026-10-10T09:00:00+05:00')
  assert.deepEqual(docArticle({ slug: 'launching', title: 'L', description: 'd', section: 'S', images: ['images/launch.webp'] }).image, [`${SITE_URL}/docs-assets/images/launch.webp`])
  const crumbs = breadcrumbList([{ name: 'Home', path: '/' }, { name: 'Documentation', path: '/docs' }]) as { itemListElement: { position: number; item: string }[] }
  assert.deepEqual(crumbs.itemListElement.map(i => [i.position, i.item]), [[1, SITE_URL], [2, `${SITE_URL}/docs`]])
})

test('security.txt has the RFC 9116 fields and expires within a year', () => {
  const now = new Date('2026-10-09T15:30:00Z'), text = securityTxt(now)
  assert.match(text, /^Contact: https:\/\/github\.com\/UbaidBinWaris\/proxy_browser\/security\/advisories\/new$/m)
  assert.match(text, /^Contact: mailto:ubaidwaris34@gmail\.com$/m)
  assert.match(text, /^Preferred-Languages: en$/m)
  assert.match(text, /^Canonical: https:\/\/proxybrowser\.ubaidbinwaris\.com\/\.well-known\/security\.txt$/m)
  assert.match(text, /^Policy: https:\/\/proxybrowser\.ubaidbinwaris\.com\/security$/m)
  assert.equal(text.match(/^Expires: /gm)?.length, 1)
  const value = /^Expires: (.+)$/m.exec(text)?.[1] ?? ''
  assert.match(value, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/)
  const expires = new Date(value)
  assert.ok(expires.getTime() > now.getTime())
  assert.ok(expires.getTime() - now.getTime() <= 365 * 24 * 60 * 60 * 1000)
  assert.ok(text.endsWith('\n'))
})

test('changelog is ordered newest first by numeric version with anchors', () => {
  const entries = parseReleaseNotes(JSON.stringify({ '1.2.0': ['a'], '1.10.0': ['c'], '1.9.1': ['b'], 'draft': ['x'], '2.0.0': 'not a list' }))
  assert.deepEqual(entries.map(e => e.version), ['1.10.0', '1.9.1', '1.2.0'])
  assert.deepEqual(entries[0], { version: '1.10.0', id: 'v1.10.0', notes: ['c'] })
  assert.throws(() => parseReleaseNotes('[]'))
})
