import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readdir, readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { renderToStaticMarkup } from 'react-dom/server'
import { metadata as aboutMetadata } from '../src/app/about/page.tsx'
import { metadata as changelogMetadata } from '../src/app/changelog/page.tsx'
import { metadata as docsIndexMetadata } from '../src/app/docs/page.tsx'
import { SiteFooter } from '../src/components/SiteChrome.tsx'
import { parseReleaseNotes } from '../src/lib/changelog.ts'
import { GALLERY_SCREENSHOTS, HERO_SCREENSHOT } from '../src/lib/home.ts'
import { securityTxt } from '../src/lib/security-txt.ts'
import { ABOUT_DATE, SCHEMA_IDS, USE_CASES_DATE, breadcrumbList, docArticle, homeGraph, legalBreadcrumbs, pageBreadcrumbs, pageMetadata, profilePage, sitemapEntries } from '../src/lib/seo.ts'
import { LEGAL_LINKS, OWNER, POLICY_DATE, REPO_URL, SITE_URL } from '../src/lib/site.ts'
import { USE_CASES } from '../src/lib/use-cases.ts'

const app = resolve(import.meta.dirname, '../src/app')
type Node = Record<string, unknown>

test('sitemap lists home, docs, use-case, legal, about and changelog pages', () => {
  const urls = sitemapEntries([{ slug: 'introduction' }, { slug: 'install' }]).map(e => e.url)
  for (const path of ['', '/docs', '/docs/introduction', '/docs/install', '/changelog', '/about', '/terms', '/acceptable-use', '/privacy', '/licenses', '/security', '/disclaimer', '/use-cases', ...USE_CASES.map(u => `/use-cases/${u.slug}`)]) assert.ok(urls.includes(`${SITE_URL}${path}`), path)
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
  assert.equal(entry('/about').lastModified, ABOUT_DATE)
  for (const path of ['/use-cases', ...USE_CASES.map(u => `/use-cases/${u.slug}`)]) assert.equal(entry(path).lastModified, USE_CASES_DATE, path)
  assert.equal(entry('/changelog').lastModified, undefined, 'release notes carry no dates, so none is invented')
})

test('sitemap URLs and images are XML-safe absolute HTTPS URLs', () => {
  const entries = sitemapEntries([{ slug: 'introduction', images: ['images/launch.webp'] }], [HERO_SCREENSHOT, ...GALLERY_SCREENSHOTS].map(shot => shot.src))
  for (const url of entries.flatMap(e => [e.url, ...(e.images ?? [])])) assert.match(url, /^https:\/\/[^&<>"']+$/)
})

test('docs pages get article metadata, a per-page social image and structured data', () => {
  const metadata = pageMetadata({ title: 'Install', description: 'd', path: '/docs/install', image: { url: '/og/install', width: 1200, height: 630, alt: 'a' }, article: { section: 'Getting started', modifiedTime: '2026-10-10T09:00:00+05:00' } })
  assert.equal(metadata.alternates?.canonical, '/docs/install')
  assert.deepEqual(metadata.openGraph, { type: 'article', locale: 'en_US', siteName: 'Proxy QA Browser', title: 'Install | Proxy QA Browser', description: 'd', url: '/docs/install', images: [{ url: '/og/install', width: 1200, height: 630, alt: 'a' }], authors: ['https://ubaidbinwaris.com'], modifiedTime: '2026-10-10T09:00:00+05:00', section: 'Getting started' })
  assert.deepEqual((metadata.twitter as { images: unknown }).images, [{ url: '/og/install', alt: 'a' }])
  const article = docArticle({ slug: 'install', title: 'Install', description: 'd', section: 'Getting started', datePublished: '2026-10-01T12:00:00+05:00', lastModified: '2026-10-10T09:00:00+05:00' })
  assert.equal(article['@type'], 'TechArticle')
  assert.equal(article.url, `${SITE_URL}/docs/install`)
  assert.deepEqual(article.image, [`${SITE_URL}/og/install`])
  assert.equal(article.datePublished, '2026-10-01T12:00:00+05:00')
  assert.equal(article.dateModified, '2026-10-10T09:00:00+05:00')
  // The site and the app are referenced by @id, not repeated; the author keeps the name and URL Google reads.
  assert.deepEqual(article.isPartOf, { '@id': `${SITE_URL}/#website` })
  assert.deepEqual(article.about, { '@id': `${SITE_URL}/#software` })
  assert.deepEqual(article.author, { '@type': 'Person', '@id': `${SITE_URL}/about#person`, name: OWNER.name, url: OWNER.website })
  assert.deepEqual(article.publisher, article.author)
  const undated = docArticle({ slug: 'launching', title: 'L', description: 'd', section: 'S', images: ['images/launch.webp'] })
  assert.deepEqual(undated.image, [`${SITE_URL}/docs-assets/images/launch.webp`])
  assert.ok(!('datePublished' in undated) && !('dateModified' in undated), 'no date is invented for a page without history')
})

test('every page variant sets the Open Graph locale', () => {
  const page = pageMetadata({ title: 'Changelog', description: 'd', path: '/changelog' })
  assert.equal((page.openGraph as { locale?: string }).locale, 'en_US')
  assert.equal((page.openGraph as { type?: string }).type, 'website')
  assert.deepEqual((page.twitter as { images: unknown }).images, [{ url: '/opengraph-image', alt: 'Proxy QA Browser: free, open-source QA browser' }])
})

test('home structured data is one linked graph with stable ids', () => {
  const graph = homeGraph({ version: '1.4.2', releasedAt: '2026-10-09T08:00:00.000Z' }) as { '@context': string; '@graph': Node[] }
  assert.equal(graph['@context'], 'https://schema.org')
  const byType = (type: string) => graph['@graph'].filter(node => node['@type'] === type)
  assert.deepEqual(graph['@graph'].map(node => node['@type']), ['WebSite', 'WebPage', 'SoftwareApplication', 'SoftwareSourceCode', 'Person'])
  assert.deepEqual(graph['@graph'].map(node => node['@id']), [SCHEMA_IDS.website, SCHEMA_IDS.webpage, SCHEMA_IDS.software, SCHEMA_IDS.source, SCHEMA_IDS.person])
  assert.deepEqual(SCHEMA_IDS, { website: `${SITE_URL}/#website`, webpage: `${SITE_URL}/#webpage`, software: `${SITE_URL}/#software`, source: `${SITE_URL}/#source`, person: `${SITE_URL}/about#person` })
  const [site] = byType('WebSite'), [page] = byType('WebPage'), [app] = byType('SoftwareApplication'), [source] = byType('SoftwareSourceCode'), [owner] = byType('Person')
  // The same form as the canonical URL of the home page.
  assert.equal(site!.url, SITE_URL)
  assert.deepEqual(page!.isPartOf, { '@id': SCHEMA_IDS.website })
  assert.deepEqual(page!.about, { '@id': SCHEMA_IDS.software })
  assert.equal((page!.primaryImageOfPage as Node).url, `${SITE_URL}${HERO_SCREENSHOT.src}`)
  assert.equal(app!.url, SITE_URL)
  assert.equal(app!.image, `${SITE_URL}${HERO_SCREENSHOT.src}`)
  assert.deepEqual(app!.screenshot, [HERO_SCREENSHOT, ...GALLERY_SCREENSHOTS].map(shot => `${SITE_URL}${shot.src}`))
  assert.equal(app!.applicationCategory, 'DeveloperApplication')
  assert.equal(app!.isAccessibleForFree, true)
  assert.deepEqual(app!.offers, { '@type': 'Offer', price: '0', priceCurrency: 'USD' })
  assert.deepEqual(app!.sameAs, [REPO_URL])
  assert.equal(app!.releaseNotes, `${SITE_URL}/changelog`)
  // The documented system requirements (docs/site/install.md), including the glibc floors on Linux.
  assert.equal(app!.softwareRequirements, 'Windows 10/11 x64; Linux x86-64 with glibc 2.25+ (bundled WebKit needs glibc 2.38+); macOS 12+')
  assert.equal(app!.softwareVersion, '1.4.2')
  assert.equal(app!.dateModified, '2026-10-09T08:00:00.000Z', 'a release updates the app: dateModified, not datePublished')
  assert.ok(!('datePublished' in app!))
  assert.ok(!('codeRepository' in app!), 'the repository belongs to SoftwareSourceCode')
  assert.deepEqual(app!.author, { '@id': SCHEMA_IDS.person })
  assert.equal(source!.codeRepository, REPO_URL)
  assert.equal(source!.license, 'https://www.apache.org/licenses/LICENSE-2.0')
  assert.equal(source!.programmingLanguage, 'TypeScript')
  assert.deepEqual(source!.targetProduct, { '@id': SCHEMA_IDS.software })
  assert.deepEqual(owner, { '@type': 'Person', '@id': SCHEMA_IDS.person, name: OWNER.name, url: OWNER.website, sameAs: [OWNER.github, OWNER.linkedin] })
  const unreleased = (homeGraph(null) as { '@graph': Node[] })['@graph'].find(node => node['@type'] === 'SoftwareApplication')!
  assert.ok(!('softwareVersion' in unreleased) && !('dateModified' in unreleased) && !('downloadUrl' in unreleased))
  assert.equal(unreleased.releaseNotes, `${SITE_URL}/changelog`, 'the changelog exists with or without a published release')
})

test('breadcrumbs run from the site root to the page', async () => {
  const items = (data: Node | null) => (data?.itemListElement as { position: number; name: string; item: string }[]).map(i => [i.position, i.name, i.item])
  assert.deepEqual(items(breadcrumbList([{ name: 'Home', path: '/' }, { name: 'Documentation', path: '/docs' }])), [[1, 'Home', SITE_URL], [2, 'Documentation', `${SITE_URL}/docs`]])
  assert.deepEqual(items(pageBreadcrumbs('Changelog', '/changelog')), [[1, 'Home', SITE_URL], [2, 'Changelog', `${SITE_URL}/changelog`]])
  assert.equal(legalBreadcrumbs('No such policy'), null)
  // Every page rendered with <LegalPage> gets Home > its title, pointing at its own route.
  let legalPages = 0
  for (const dir of await readdir(app)) {
    const source = await readFile(join(app, dir, 'page.tsx'), 'utf8').catch(() => '')
    const title = /<LegalPage\b[^>]*\btitle="([^"]+)"/.exec(source)?.[1]
    if (!title) continue
    legalPages++
    assert.deepEqual(items(legalBreadcrumbs(title)), [[1, 'Home', SITE_URL], [2, title, `${SITE_URL}/${dir}`]], dir)
  }
  assert.ok(legalPages >= 5, `found ${legalPages} legal pages`)
})

test('the about page is a ProfilePage of the same Person node, described with its visible text', async () => {
  const profile = profilePage({ description: 'Lead text.', bio: 'Bio text.' })
  assert.equal(profile['@type'], 'ProfilePage')
  assert.equal(profile.url, `${SITE_URL}/about`)
  assert.equal(profile.description, 'Lead text.')
  assert.equal(profile.dateModified, ABOUT_DATE)
  assert.deepEqual(profile.mainEntity, { '@type': 'Person', '@id': SCHEMA_IDS.person, name: OWNER.name, url: OWNER.website, sameAs: [OWNER.github, OWNER.linkedin], description: 'Bio text.' })
  // The page renders the same strings it passes to the structured data.
  const source = await readFile(join(app, 'about', 'page.tsx'), 'utf8')
  for (const usage of ['profilePage({ description: lead, bio })', '<p className="page-lead">{lead}</p>', '<p>{bio}</p>']) assert.ok(source.includes(usage), usage)
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

test('docs index, about and changelog titles and descriptions fit search results', async () => {
  for (const [name, metadata] of [['docs', docsIndexMetadata], ['about', aboutMetadata], ['changelog', changelogMetadata]] as const) {
    const title = String(metadata.title), description = String(metadata.description)
    // The layout appends " | Proxy QA Browser" to every page title.
    assert.ok(title.length + ' | Proxy QA Browser'.length <= 60, `${name}: "${title}"`)
    assert.ok(description.length >= 120 && description.length <= 158, `${name}: ${description.length} characters`)
    assert.equal(metadata.openGraph?.description, description, name)
  }
  assert.equal(docsIndexMetadata.title, 'Documentation and setup guides')
  assert.equal(changelogMetadata.title, 'Changelog and release notes')
  assert.equal(aboutMetadata.title, `Built by ${OWNER.name}`)
  // The docs index has one H1, and its lead links only use-case pages that exist.
  const docsIndex = await readFile(join(app, 'docs', 'page.tsx'), 'utf8')
  assert.deepEqual([...docsIndex.matchAll(/<h1>(.*?)<\/h1>/g)].map(m => m[1]), ['Proxy QA Browser documentation'])
  assert.ok(docsIndex.includes('TASK_LINKS.filter(link => findUseCase(link.slug))'))
})

test('the footer links the use-case hub and every published use-case page', () => {
  const html = renderToStaticMarkup(SiteFooter())
  for (const path of ['/use-cases', ...USE_CASES.map(u => `/use-cases/${u.slug}`)]) assert.ok(html.includes(`href="${path}"`), path)
})
