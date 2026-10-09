import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseReleaseNotes } from '../src/lib/changelog.ts'
import { securityTxt } from '../src/lib/security-txt.ts'
import { sitemapEntries } from '../src/lib/seo.ts'
import { LEGAL_LINKS, SITE_URL } from '../src/lib/site.ts'

test('sitemap lists home, docs, legal, about and changelog pages', () => {
  const urls = sitemapEntries(['introduction', 'install']).map(e => e.url)
  for (const path of ['', '/docs', '/docs/introduction', '/docs/install', '/changelog', '/about', '/terms', '/acceptable-use', '/privacy', '/licenses', '/security', '/disclaimer']) assert.ok(urls.includes(`${SITE_URL}${path}`), path)
  assert.equal(new Set(urls).size, urls.length)
  assert.ok(!urls.some(u => u.includes('/admin')))
  assert.equal(LEGAL_LINKS.length, 6)
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
