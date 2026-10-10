import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile, stat } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { GET as ogImage } from '../src/app/og/use-cases/[slug]/route.tsx'
import { generateMetadata } from '../src/app/use-cases/[slug]/page.tsx'
import { metadata as indexMetadata } from '../src/app/use-cases/page.tsx'
import { SCREENSHOT_MAX_BYTES, SCREENSHOT_SMALL_WIDTH, USE_CASES as HOME_USE_CASES, screenshotSrcSet } from '../src/lib/home.ts'
import { renderMarkdown } from '../src/lib/markdown.ts'
import { faqPage, sitemapEntries, useCaseWebPage } from '../src/lib/seo.ts'
import { DEVICE_PRESET_COUNT, SITE_NAME, SITE_URL, STATIC_PAGES } from '../src/lib/site.ts'
import { USE_CASES, USE_CASES_PATH, contentLinks, findUseCase, inlineParts, inlineTexts, plainText, structuredFaqs, useCaseImagePath, useCasePath } from '../src/lib/use-cases.ts'
import type { UseCase } from '../src/lib/use-cases.ts'
import { config as proxyConfig } from '../src/proxy.ts'

const webapp = resolve(import.meta.dirname, '..')
const repo = resolve(webapp, '../..')
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
/** The root layout's title template appends this to every page title; search results show about 60 characters. */
const TITLE_SUFFIX = ` | ${SITE_NAME}`

async function docSlugs(): Promise<Set<string>> {
  const manifest = JSON.parse(await readFile(join(repo, 'docs', 'site', 'manifest.json'), 'utf8')) as { sections: Array<{ pages: Array<{ slug: string }> }> }
  return new Set(manifest.sections.flatMap(section => section.pages.map(page => page.slug)))
}

/** Heading ids of a docs page, as the website renders them. */
async function docAnchors(slug: string): Promise<Set<string>> {
  const { headings } = renderMarkdown(await readFile(join(repo, 'docs', 'site', `${slug}.md`), 'utf8'), { stripTitle: true })
  return new Set(headings.map(heading => heading.id))
}

/** Everything a reader sees in the page body, without link markup, lower-cased. */
function bodyText(useCase: UseCase): string {
  return [
    useCase.h1,
    plainText(useCase.lead),
    useCase.screenshot.caption,
    ...useCase.sections.flatMap(s => [s.heading, plainText(s.text), ...(s.points ?? []).map(plainText), ...(s.note ? [plainText(s.note)] : [])]),
    ...useCase.steps.flatMap(s => [s.title, plainText(s.text)]),
    ...useCase.faqs.flatMap(f => [f.question, f.answer, ...(f.link ? [f.link.label] : [])]),
  ].join('\n').toLowerCase()
}

/** Every text field of a page, one entry each, for rules that apply sentence by sentence. */
function textFields(useCase: UseCase): string[] {
  return [useCase.navLabel, useCase.title, useCase.description, useCase.eyebrow, useCase.h1, useCase.screenshot.alt, useCase.screenshot.caption, ...inlineTexts(useCase).map(plainText), ...useCase.sections.map(s => s.heading), ...useCase.steps.map(s => s.title), ...useCase.faqs.flatMap(f => [f.question, f.answer])]
}

const occurrences = (text: string, phrase: string) => text.split(phrase.toLowerCase()).length - 1

/**
 * Primary keywords of the home and docs pages in the SEO keyword plan. Each primary keyword belongs to exactly one
 * page, so no use case may target one of these.
 */
const OTHER_PAGE_KEYWORDS = [
  'free open-source website form testing', 'Proxy QA Browser documentation', 'what is Proxy QA Browser', 'install Proxy QA Browser on Windows, Linux and macOS',
  'launch a QA browser through a proxy', 'proxy for QA testing', 'verify proxy exit IP location', 'bundled and installed browsers for testing', 'allowlist QA traffic in your WAF',
  'CSV data-driven browser tests', 'automated accessibility checks', 'self-healing selectors', 'browser testing in GitHub Actions', 'MCP server for browser testing',
  'Proxy QA Browser security and privacy', 'Proxy QA Browser troubleshooting', 'Proxy QA Browser FAQ', 'Proxy QA Browser developer', 'Proxy QA Browser changelog',
  'Proxy QA Browser use cases', 'open source visual regression testing',
]

test('use cases have unique slugs and primary keywords, and the lookup finds each one', () => {
  assert.equal(USE_CASES.length, 6)
  for (const useCase of USE_CASES) {
    assert.match(useCase.slug, SLUG)
    assert.equal(findUseCase(useCase.slug), useCase)
  }
  assert.equal(findUseCase('no-such-page'), null)
  assert.equal(new Set(USE_CASES.map(u => u.slug)).size, USE_CASES.length, 'duplicate slug')
  assert.equal(new Set(USE_CASES.map(u => u.primaryKeyword.toLowerCase())).size, USE_CASES.length, 'duplicate primary keyword')
  assert.equal(useCasePath('location-testing'), '/use-cases/location-testing')
  assert.equal(useCaseImagePath('location-testing'), '/og/use-cases/location-testing')
  // Visual regression testing waits for a comparison screenshot and its worked example.
  assert.equal(findUseCase('visual-regression-testing'), null)
})

test('no use case targets a keyword that another page owns', () => {
  const others = new Set(OTHER_PAGE_KEYWORDS.map(k => k.toLowerCase()))
  const primaries = new Map(USE_CASES.map(u => [u.primaryKeyword.toLowerCase(), u.slug]))
  for (const { slug, primaryKeyword, secondaryKeywords } of USE_CASES) {
    assert.ok(!others.has(primaryKeyword.toLowerCase()), `${slug}: "${primaryKeyword}" is another page's primary keyword`)
    assert.ok(secondaryKeywords.length > 0, slug)
    assert.equal(new Set(secondaryKeywords.map(k => k.toLowerCase())).size, secondaryKeywords.length, `${slug}: duplicate secondary keyword`)
    for (const keyword of secondaryKeywords) {
      const key = keyword.toLowerCase()
      assert.ok(!others.has(key), `${slug}: secondary "${keyword}" is another page's primary keyword`)
      assert.ok(!primaries.has(key) || primaries.get(key) === slug, `${slug}: secondary "${keyword}" is the primary keyword of ${primaries.get(key)}`)
    }
  }
})

test('titles and descriptions fit search results', () => {
  for (const { slug, title, description, primaryKeyword } of USE_CASES) {
    assert.ok(title.length > 0 && title.length + TITLE_SUFFIX.length <= 60, `${slug}: "${title}${TITLE_SUFFIX}" is ${title.length + TITLE_SUFFIX.length} characters`)
    assert.ok(!title.includes(SITE_NAME), `${slug}: the layout appends the site name`)
    assert.ok(description.length >= 120 && description.length <= 158, `${slug}: description is ${description.length} characters`)
    // Every word of the target phrase appears in the title.
    for (const word of primaryKeyword.toLowerCase().split(/\s+/)) assert.ok(title.toLowerCase().includes(word), `${slug}: title lacks "${word}"`)
  }
  const indexTitle = String(indexMetadata.title), indexDescription = String(indexMetadata.description)
  assert.equal(indexTitle, 'Use cases: test your own sites and forms')
  assert.ok(indexTitle.length + TITLE_SUFFIX.length <= 60)
  assert.ok(indexDescription.length >= 120 && indexDescription.length <= 158, `index description is ${indexDescription.length} characters`)
})

test('each exact-match keyword appears at most once in a page body', () => {
  for (const useCase of USE_CASES) {
    const text = bodyText(useCase)
    for (const phrase of [useCase.primaryKeyword, ...useCase.secondaryKeywords]) assert.ok(occurrences(text, phrase) <= 1, `${useCase.slug}: "${phrase}" appears ${occurrences(text, phrase)} times`)
  }
})

test('each page has exactly one h1 and complete content', async () => {
  for (const useCase of USE_CASES) {
    const { slug, h1 } = useCase
    assert.equal(typeof h1, 'string')
    assert.ok(h1.trim().length > 0, `${slug}: empty h1`)
    // Section, step and FAQ headings render as h2/h3; none may repeat the h1.
    const headings = [...useCase.sections.map(s => s.heading), ...useCase.steps.map(s => s.title), ...useCase.faqs.map(f => f.question)]
    assert.ok(!headings.includes(h1), `${slug}: h1 repeated as a lower heading`)
    assert.equal(new Set(headings).size, headings.length, `${slug}: duplicate heading`)
    assert.ok(useCase.lead.length > 0 && useCase.eyebrow.length > 0 && useCase.navLabel.length > 0, slug)
    assert.ok(useCase.sections.length >= 3 && useCase.steps.length >= 3 && useCase.faqs.length >= 3 && useCase.docLinks.length >= 1, slug)
  }
  // The templates render the data's h1 and no other.
  for (const file of ['src/app/use-cases/[slug]/page.tsx', 'src/app/use-cases/page.tsx']) {
    const source = await readFile(join(webapp, file), 'utf8')
    assert.equal(source.match(/<h1[\s>]/g)?.length, 1, `${file} must render exactly one <h1>`)
  }
})

test('inline links are parsed in order and allowed only in the lead, sections and steps', () => {
  assert.deepEqual(inlineParts('See [the docs](/docs/install) now.'), ['See ', { label: 'the docs', href: '/docs/install' }, ' now.'])
  assert.deepEqual(inlineParts('[a](/x) and [b](/y)'), [{ label: 'a', href: '/x' }, ' and ', { label: 'b', href: '/y' }])
  assert.equal(plainText('See [the docs](/docs/install).'), 'See the docs.')
  for (const useCase of USE_CASES) {
    const plain = [useCase.navLabel, useCase.title, useCase.description, useCase.eyebrow, useCase.h1, useCase.screenshot.alt, useCase.screenshot.caption, ...useCase.sections.map(s => s.heading), ...useCase.steps.map(s => s.title), ...useCase.faqs.flatMap(f => [f.question, f.answer])]
    for (const text of plain) assert.ok(!/\]\(/.test(text), `${useCase.slug}: link markup in a plain-text field: ${text}`)
    // No stray brackets: every "[" in a link field belongs to a parsed link.
    for (const text of inlineTexts(useCase)) assert.ok(!plainText(text).includes(']('), `${useCase.slug}: broken link markup: ${text}`)
  }
})

test('every in-content link points to an existing page and heading, once per page', async () => {
  const slugs = await docSlugs()
  const staticPaths = new Set([...STATIC_PAGES.map(page => page.path), ...USE_CASES.map(u => useCasePath(u.slug))])
  for (const useCase of USE_CASES) {
    for (const link of useCase.docLinks) {
      assert.ok(slugs.has(link.slug), `${useCase.slug}: missing docs page ${link.slug}`)
      assert.ok(link.label.length > 0)
    }
    assert.equal(new Set(useCase.docLinks.map(l => l.slug)).size, useCase.docLinks.length, `${useCase.slug}: duplicate docs link`)
    const links = contentLinks(useCase)
    const related = new Set(useCase.docLinks.map(l => `/docs/${l.slug}`))
    for (const { href, label } of links) {
      assert.ok(label.length > 0, `${useCase.slug}: empty anchor for ${href}`)
      assert.ok(!related.has(href), `${useCase.slug}: ${href} is already a related docs card`)
      const docs = /^\/docs\/([a-z0-9-]+)(?:#([a-z0-9-]+))?$/.exec(href)
      if (docs) {
        const [, slug, anchor] = docs
        assert.ok(slugs.has(slug!), `${useCase.slug}: link to missing docs page ${href}`)
        if (anchor) assert.ok((await docAnchors(slug!)).has(anchor), `${useCase.slug}: link to missing heading ${href}`)
      } else {
        assert.ok(staticPaths.has(href), `${useCase.slug}: link to unknown page ${href}`)
        assert.notEqual(href, useCasePath(useCase.slug), `${useCase.slug}: links to its own page`)
      }
    }
    const hrefs = links.map(l => l.href)
    assert.equal(new Set(hrefs).size, hrefs.length, `${useCase.slug}: a target is linked more than once: ${hrefs.join(', ')}`)
  }
})

/** Internal links from use-case pages in the SEO plan, with their settled anchors (a docs URL may add a heading anchor). */
const PLANNED_LINKS: Array<{ from: string; to: string; anchor: string }> = [
  { from: 'location-testing', to: '/use-cases/geo-blocking-testing', anchor: 'test your own geo-blocking and redirect rules' },
  { from: 'location-testing', to: '/use-cases/device-testing', anchor: 'device presets' },
  { from: 'location-testing', to: '/docs/locations-and-devices#exit-ip-verification', anchor: 'how exit-IP verification works' },
  { from: 'location-testing', to: '/docs/locations-and-devices#zip-targeting-caveat', anchor: 'ZIP targeting caveat' },
  { from: 'tcpa-consent-testing', to: '/use-cases/device-testing', anchor: 'small phones and tablets' },
  { from: 'tcpa-consent-testing', to: '/use-cases/test-recorder', anchor: 'record the steps to reach the form' },
  { from: 'tcpa-consent-testing', to: '/docs/checks#lead-certificate-scripts-checkscriptloaded', anchor: 'lead-certificate script check reference' },
  { from: 'device-testing', to: '/use-cases/cross-browser-testing', anchor: 'which browsers can emulate phones' },
  { from: 'device-testing', to: '/use-cases/location-testing', anchor: 'a checked exit location' },
  { from: 'device-testing', to: '/use-cases/tcpa-consent-testing', anchor: 'consent disclosures on small screens' },
  { from: 'device-testing', to: '/docs/locations-and-devices#devices', anchor: 'device preset types and examples' },
  { from: 'cross-browser-testing', to: '/use-cases/device-testing', anchor: 'device presets per engine' },
  { from: 'cross-browser-testing', to: '/docs/browsers#known-limitations', anchor: 'known browser limitations' },
  { from: 'cross-browser-testing', to: '/docs/faq', anchor: 'how profile isolation works' },
  { from: 'test-recorder', to: '/docs/self-healing', anchor: 'self-healing selectors' },
  { from: 'test-recorder', to: '/docs/ci-runner', anchor: 'run recorded tests in CI' },
  { from: 'geo-blocking-testing', to: '/docs/automation#origin-isolation', anchor: 'how redirects are handled' },
  { from: 'geo-blocking-testing', to: '/use-cases/location-testing', anchor: 'see what visitors in a location get' },
]

test('the planned internal links are present with their anchors', () => {
  for (const { from, to, anchor } of PLANNED_LINKS) {
    const useCase = findUseCase(from)
    assert.ok(useCase, from)
    const link = contentLinks(useCase).find(l => l.href === to || (!to.includes('#') && to.startsWith('/docs/') && l.href.startsWith(`${to}#`)))
    assert.ok(link, `${from}: no link to ${to}`)
    assert.equal(link.label.toLowerCase(), anchor.toLowerCase(), `${from} → ${to}`)
  }
})

test('home page use-case cards link to existing landing pages', () => {
  const linked = HOME_USE_CASES.flatMap(card => card.useCaseSlug ? [card.useCaseSlug] : [])
  assert.ok(linked.length >= 2)
  for (const slug of linked) assert.ok(findUseCase(slug), `missing use case: ${slug}`)
})

// Screenshots live in docs/site/images (published with the docs under /docs-assets/images).
const screenshotFile = (src: string) => join(repo, 'docs', 'site', src.slice('/docs-assets/'.length))

test('use-case screenshots exist with their 720 px copies', async () => {
  for (const { slug, screenshot } of USE_CASES) {
    assert.match(screenshot.src, /^\/docs-assets\/images\/[a-z0-9-]+\.webp$/, slug)
    assert.equal(screenshot.width, 1600, slug)
    assert.equal(screenshot.height, 1000, slug)
    assert.ok(screenshot.alt.length >= 40, `${slug}: alt text needs at least 40 characters`)
    assert.ok(screenshot.caption.length > 0, slug)
    const bytes = await readFile(screenshotFile(screenshot.src))
    assert.equal(bytes.subarray(8, 12).toString('latin1'), 'WEBP', screenshot.src)
    assert.ok(bytes.length <= SCREENSHOT_MAX_BYTES, `${screenshot.src}: ${bytes.length} bytes`)
    const small = screenshotSrcSet(screenshot).split(', ')[0]!.split(' ')[0]!
    assert.equal(small, screenshot.src.replace(/\.webp$/, `-${SCREENSHOT_SMALL_WIDTH}.webp`))
    const info = await stat(screenshotFile(small))
    assert.ok(info.size > 0 && info.size < bytes.length, `${small} should exist and be smaller than ${screenshot.src}`)
  }
  assert.equal(new Set(USE_CASES.map(u => u.screenshot.src)).size, USE_CASES.length, 'each page has its own screenshot')
})

test('sitemap lists the use-case index and every use-case page with its screenshot', () => {
  const entries = sitemapEntries([{ slug: 'introduction' }])
  const urls = entries.map(e => e.url)
  assert.ok(urls.includes(`${SITE_URL}${USE_CASES_PATH}`))
  for (const { slug, screenshot } of USE_CASES) {
    const entry = entries.find(e => e.url === `${SITE_URL}/use-cases/${slug}`)
    assert.ok(entry, slug)
    assert.deepEqual(entry.images, [`${SITE_URL}${screenshot.src}`])
  }
  assert.equal(new Set(urls).size, urls.length)
})

test('structured data: a WebPage about the app and an FAQPage of the questions the page owns', () => {
  for (const useCase of USE_CASES) {
    const page = useCaseWebPage(useCase)
    assert.equal(page['@type'], 'WebPage')
    assert.equal(page.url, `${SITE_URL}/use-cases/${useCase.slug}`)
    // The app and the site are the home page's nodes, referenced by @id.
    assert.deepEqual(page.about, { '@id': `${SITE_URL}/#software` })
    assert.deepEqual(page.isPartOf, { '@id': `${SITE_URL}/#website` })
    assert.equal((page.author as Record<string, unknown>)['@id'], `${SITE_URL}/about#person`)
    assert.equal((page.primaryImageOfPage as Record<string, unknown>).url, `${SITE_URL}${useCase.screenshot.src}`)
    const owned = structuredFaqs(useCase)
    assert.ok(owned.length >= 2, `${useCase.slug}: owns too few questions`)
    const faq = faqPage(owned) as { mainEntity: Array<{ name: string; acceptedAnswer: { text: string } }> }
    assert.deepEqual(faq.mainEntity.map(q => q.name), owned.map(f => f.question))
    assert.equal(faq.mainEntity[0]!.acceptedAnswer.text, owned[0]!.answer)
  }
  // A question owned by another page is a short pointer with a link, and stays out of this page's FAQPage.
  const staticPaths = new Set([...STATIC_PAGES.map(page => page.path), ...USE_CASES.map(u => useCasePath(u.slug))])
  for (const useCase of USE_CASES) for (const faq of useCase.faqs.filter(f => f.ownedBy)) {
    assert.ok(faq.link, `${useCase.slug}: "${faq.question}" points elsewhere without a link`)
    assert.ok(staticPaths.has(faq.ownedBy!) || /^\/docs\/[a-z0-9-]+$/.test(faq.ownedBy!), `${useCase.slug}: unknown owner ${faq.ownedBy}`)
    assert.notEqual(faq.ownedBy, useCasePath(useCase.slug))
    assert.ok(!structuredFaqs(useCase).includes(faq))
  }
  assert.ok(findUseCase('location-testing')!.faqs.some(f => f.ownedBy), 'the wrong-city question belongs to the docs')
})

test('page metadata uses the page\'s own social image', async () => {
  for (const useCase of USE_CASES) {
    const metadata = await generateMetadata({ params: Promise.resolve({ slug: useCase.slug }) })
    assert.equal(metadata.title, useCase.title)
    assert.equal(metadata.description, useCase.description)
    assert.deepEqual(metadata.alternates, { canonical: useCasePath(useCase.slug) })
    const [image] = metadata.openGraph!.images as Array<{ url: string; width: number; height: number; alt: string }>
    assert.equal(image!.url, `/og/use-cases/${useCase.slug}`)
    assert.equal(image!.width, 1200)
    assert.equal(image!.height, 630)
    assert.ok(image!.alt.includes(useCase.title))
    assert.deepEqual((metadata.twitter as { images: unknown }).images, [{ url: image!.url, alt: image!.alt }])
  }
})

test('the social image route renders a PNG for each use case and a 404 for unknown slugs', async () => {
  const request = new Request(`${SITE_URL}/og/use-cases/x`)
  const known = await ogImage(request, { params: Promise.resolve({ slug: USE_CASES[0]!.slug }) })
  assert.equal(known.status, 200)
  assert.equal(known.headers.get('content-type'), 'image/png')
  assert.equal(known.headers.get('cache-control'), 'public, max-age=3600')
  const png = Buffer.from(await known.arrayBuffer())
  assert.equal(png.subarray(1, 4).toString('latin1'), 'PNG')
  for (const useCase of USE_CASES.slice(1)) {
    const response = await ogImage(request, { params: Promise.resolve({ slug: useCase.slug }) })
    assert.equal(response.status, 200, useCase.slug)
    await response.body?.cancel()
  }
  for (const slug of ['no-such-page', 'visual-regression-testing', '']) {
    const missing = await ogImage(request, { params: Promise.resolve({ slug }) })
    assert.equal(missing.status, 404, slug)
    assert.equal(await missing.text(), 'Not found')
  }
  // The per-request proxy (CSP nonce, no-store) skips /og/, so these images keep their own cache headers.
  const matcher = new RegExp(`^${proxyConfig.matcher[0]}$`)
  assert.ok(!matcher.test('/og/use-cases/location-testing'))
  assert.ok(matcher.test('/use-cases/location-testing'))
})

test('copy stays within the project scope', () => {
  const banned = [
    'anti-detect', 'antidetect', 'undetectable', 'stealth', 'spoof', 'multi-account', 'multiaccount', 'multi-login', 'evade', 'evasion', 'avoid detection', 'fingerprint',
    'unblock', 'bypass', 'scrap', 'captcha solver', 'fake', 'proxy browser', 'rotating proxy', 're-roll', 'random device', 'random user agent', 'user agent switcher',
    'real device', 'real iphone', 'real phone', 'device cloud', 'free location', 'location testing for free',
    'compliance', 'compliant', 'checker', 'proof of consent', 'consent certificate',
  ]
  for (const useCase of USE_CASES) {
    const text = JSON.stringify(useCase).toLowerCase()
    for (const word of banned) assert.ok(!text.includes(word), `${useCase.slug} mentions "${word}"`)
  }
})

test('browser and device claims match the docs', async () => {
  const source = await readFile(join(webapp, 'src', 'lib', 'use-cases.ts'), 'utf8')
  for (const useCase of USE_CASES) {
    const headline = [useCase.title, useCase.h1, useCase.description, useCase.navLabel, useCase.eyebrow, ...useCase.sections.map(s => s.heading)]
    // Safari is never promised: the name appears only next to WebKit, and never in a title, heading or snippet.
    for (const text of headline) assert.ok(!/safari/i.test(text), `${useCase.slug}: "Safari" in a headline: ${text}`)
    for (const text of textFields(useCase)) {
      if (/safari/i.test(text)) assert.match(text, /webkit/i, `${useCase.slug}: Safari named without WebKit: ${text}`)
      // Vivaldi installs but cannot launch; it is only ever named as a limitation.
      if (/vivaldi/i.test(text)) assert.match(text, /launches fail/i, `${useCase.slug}: Vivaldi named as supported: ${text}`)
    }
    // No third-party trademarks in titles or the h1.
    for (const text of [useCase.title, useCase.h1]) {
      assert.ok(!/\b(chrome|edge|brave|opera|firefox|safari|webkit|playwright|trustedform|jornaya|leadid|axe|github|docker|iphone|ipad|pixel|galaxy|dataimpulse|bright data|oxylabs|decodo|iproyal|browserstack|lambdatest|selenium)\b/i.test(text), `${useCase.slug}: trademark in "${text}"`)
    }
  }
  const device = findUseCase('device-testing')!
  assert.match(device.h1, /emulated/i)
  assert.match(device.description, /emulated/i)
  // The preset count comes from DEVICE_PRESET_COUNT (checked against the docs elsewhere), never a literal.
  assert.ok(textFields(device).some(t => t.includes(`${DEVICE_PRESET_COUNT} presets`)))
  assert.ok(!source.includes(`${DEVICE_PRESET_COUNT}`), 'src/lib/use-cases.ts hard-codes the preset count')
  const browsers = findUseCase('cross-browser-testing')!
  assert.ok(textFields(browsers).some(t => /Chromium-family only/.test(t)), 'installed browsers are Chromium-family only')
  assert.ok(textFields(browsers).some(t => /not Apple Safari/.test(t)), 'WebKit is not Safari')
})

test('location targeting is never presented as free', () => {
  const location = findUseCase('location-testing')!
  for (const text of [location.title, location.h1, location.navLabel, location.eyebrow]) assert.ok(!/\bfree\b/i.test(text), text)
  assert.match(location.description, /your own proxy plan/)
  const free = location.faqs.find(f => f.question === 'Is location testing free?')
  assert.ok(free && /needs your own paid plan/.test(free.answer))
  // Every page that offers location cases says they need the user's own plan.
  for (const slug of ['test-recorder', 'geo-blocking-testing', 'cross-browser-testing', 'device-testing']) {
    assert.ok(textFields(findUseCase(slug)!).some(t => /your own proxy plan/.test(t)), `${slug}: location tests need your own proxy plan`)
  }
})

test('the consent page is QA aid, not legal advice', () => {
  const tcpa = findUseCase('tcpa-consent-testing')!
  const fields = textFields(tcpa)
  assert.ok(fields.some(t => /not legal advice/i.test(t)), 'the consent page says the checks are not legal advice')
  assert.ok(tcpa.sections.some(s => s.note === 'TrustedForm, Jornaya and LeadiD are trademarks of their owners; this project is not affiliated with them.'), 'trademark line')
  for (const useCase of USE_CASES) for (const text of textFields(useCase)) {
    assert.ok(!/tcpa\s+(requires|required|mandates)|required by the tcpa|tcpa (font|checkbox) (size|rule|requirement)/i.test(text), `${useCase.slug}: states what the TCPA requires: ${text}`)
    // Thresholds are product defaults, never legal minimums.
    if (/10 px|4\.5:1/.test(text)) assert.match(text, /default/i, `${useCase.slug}: threshold without "default": ${text}`)
  }
  for (const text of [tcpa.title, tcpa.h1, tcpa.description, ...tcpa.sections.map(s => s.heading)]) assert.ok(!/check(er)?\b.*complian|complian/i.test(text), text)
})
