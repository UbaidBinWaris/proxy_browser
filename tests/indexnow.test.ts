import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
// Plain Node ESM script used by the website deploy (deploy-website.yml).
// @ts-expect-error Node scripts intentionally do not ship TypeScript declarations.
import { findKey, indexNowBody, sitemapPages, urlsToSubmit } from '../scripts/indexnow.mjs'

const SITEMAP = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:image="http://www.google.com/schemas/sitemap-image/1.1">
<url><loc>https://proxybrowser.ubaidbinwaris.com</loc><lastmod>2026-11-05</lastmod><image:image><image:loc>https://proxybrowser.ubaidbinwaris.com/docs-assets/images/launch.webp</image:loc></image:image></url>
<url><loc>https://proxybrowser.ubaidbinwaris.com/changelog</loc></url>
<url><loc>https://proxybrowser.ubaidbinwaris.com/docs/sticky-sessions</loc><lastmod>2026-11-04T18:00:00.000Z</lastmod></url>
<url><loc>https://proxybrowser.ubaidbinwaris.com/terms</loc><lastmod>2026-10-09</lastmod></url>
</urlset>`

describe('IndexNow submission', () => {
  it('reads page URLs and dates from the sitemap, not image URLs', () => {
    expect(sitemapPages(SITEMAP)).toEqual([
      { url: 'https://proxybrowser.ubaidbinwaris.com', lastModified: '2026-11-05' },
      { url: 'https://proxybrowser.ubaidbinwaris.com/changelog', lastModified: null },
      { url: 'https://proxybrowser.ubaidbinwaris.com/docs/sticky-sessions', lastModified: '2026-11-04T18:00:00.000Z' },
      { url: 'https://proxybrowser.ubaidbinwaris.com/terms', lastModified: '2026-10-09' },
    ])
  })

  it('submits only recently changed pages, or every page with --all', () => {
    const pages = sitemapPages(SITEMAP)
    const now = new Date('2026-11-05T12:00:00.000Z')
    expect(urlsToSubmit(pages, { now })).toEqual(['https://proxybrowser.ubaidbinwaris.com', 'https://proxybrowser.ubaidbinwaris.com/docs/sticky-sessions'])
    expect(urlsToSubmit(pages, { all: true, now })).toHaveLength(4)
  })

  it('builds the request body with the key file on the same host', () => {
    expect(indexNowBody(['https://proxybrowser.ubaidbinwaris.com/faq'], 'a'.repeat(32))).toEqual({
      host: 'proxybrowser.ubaidbinwaris.com',
      key: 'a'.repeat(32),
      keyLocation: `https://proxybrowser.ubaidbinwaris.com/${'a'.repeat(32)}.txt`,
      urlList: ['https://proxybrowser.ubaidbinwaris.com/faq'],
    })
  })

  it('finds the published key file, whose content is the key', () => {
    const key = findKey(resolve(import.meta.dirname, '../app/webapp/public'))
    expect(key).toMatch(/^[a-f0-9]{32}$/)
    const dir = mkdtempSync(join(tmpdir(), 'pqa-indexnow-'))
    try {
      writeFileSync(join(dir, `${'b'.repeat(32)}.txt`), 'wrong')
      expect(() => findKey(dir)).toThrow(/must contain exactly its key/)
      rmSync(join(dir, `${'b'.repeat(32)}.txt`))
      expect(() => findKey(dir)).toThrow(/found 0/)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
