import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile, stat } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { DEFAULT_PLATFORM_ORDER, detectOs, formatSize, isMobileOs, macDownloads, orderDownloadCards, platformAsset, recommendedPlatform } from '../src/lib/downloads.ts'
import type { VisitorOs } from '../src/lib/downloads.ts'
import { HOME_FAQ_QUESTIONS, answerText, faqItems, homeFaqs } from '../src/lib/faq.ts'
import { FEATURES, GALLERY_SCREENSHOTS, HERO_SCREENSHOT, SCREENSHOT_MAX_BYTES, STEPS, SCREENSHOT_SMALL_WIDTH, screenshotSrcSet } from '../src/lib/home.ts'
import type { Release } from '../src/lib/releases.ts'
import { DEVICE_PRESET_COUNT, HOME_TITLE, SITE_DESCRIPTION, SITE_NAME } from '../src/lib/site.ts'
import { USE_CASES as USE_CASE_PAGES } from '../src/lib/use-cases.ts'

const webapp = resolve(import.meta.dirname, '..')
const repo = resolve(webapp, '../..')
const homePage = () => readFile(join(webapp, 'src', 'app', 'page.tsx'), 'utf8')
/** The visible home copy: the page's own JSX text plus the data it renders. */
async function homeCopy(): Promise<string> {
  return [
    await homePage(),
    ...FEATURES.flatMap(f => [f.title, f.text]),
    ...USE_CASE_PAGES.flatMap(u => [u.navLabel, u.summary]),
    ...STEPS.flatMap(s => [s.title, s.text]),
    ...homeFaqs().flatMap(f => [f.question, answerText(f)]),
    HERO_SCREENSHOT.caption,
    ...GALLERY_SCREENSHOTS.flatMap(shot => [shot.title, shot.text, ...shot.points]),
  ].join('\n')
}
const occurrences = (text: string, phrase: string) => text.toLowerCase().split(phrase.toLowerCase()).length - 1

const USER_AGENTS: Array<[string, VisitorOs]> = [
  ['Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36', 'windows'],
  ['Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:143.0) Gecko/20100101 Firefox/143.0', 'windows'],
  ['Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36 Edg/141.0.0.0', 'windows'],
  ['Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Safari/605.1.15', 'macos'],
  ['Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:143.0) Gecko/20100101 Firefox/143.0', 'macos'],
  ['Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36', 'linux'],
  ['Mozilla/5.0 (X11; Ubuntu; Linux x86_64; rv:143.0) Gecko/20100101 Firefox/143.0', 'linux'],
  ['Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Mobile Safari/537.36', 'android'],
  ['Mozilla/5.0 (Linux; Android 14; SM-X710) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36', 'android'],
  ['Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.6 Mobile/15E148 Safari/604.1', 'ios'],
  ['Mozilla/5.0 (iPad; CPU OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1', 'ios'],
  ['Mozilla/5.0 (X11; CrOS x86_64 14541.0.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36', 'unknown'],
  ['curl/8.10.1', 'unknown'],
  ['', 'unknown'],
]

test('visitor OS is detected from the User-Agent header', () => {
  for (const [ua, expected] of USER_AGENTS) assert.equal(detectOs(ua), expected, ua)
  assert.equal(detectOs(null), 'unknown')
  assert.equal(detectOs(undefined), 'unknown')
})

test('only desktop systems get a recommended download', () => {
  assert.equal(recommendedPlatform('windows'), 'win32')
  assert.equal(recommendedPlatform('macos'), 'darwin')
  assert.equal(recommendedPlatform('linux'), 'linux')
  for (const os of ['android', 'ios', 'unknown'] as const) assert.equal(recommendedPlatform(os), null)
  assert.equal(isMobileOs('android'), true)
  assert.equal(isMobileOs('ios'), true)
  assert.equal(isMobileOs('linux'), false)
})

test('download cards put the visitor\'s platform first and keep every other platform visible', () => {
  assert.deepEqual(orderDownloadCards('macos'), [{ platform: 'darwin', recommended: true }, { platform: 'win32', recommended: false }, { platform: 'linux', recommended: false }])
  assert.deepEqual(orderDownloadCards('linux').map(c => c.platform), ['linux', 'win32', 'darwin'])
  assert.deepEqual(orderDownloadCards('windows').map(c => c.platform), ['win32', 'linux', 'darwin'])
  for (const os of ['windows', 'macos', 'linux', 'android', 'ios', 'unknown'] as const) {
    const cards = orderDownloadCards(os)
    assert.deepEqual([...cards.map(c => c.platform)].sort(), [...DEFAULT_PLATFORM_ORDER].sort(), os)
    assert.equal(cards.filter(c => c.recommended).length, recommendedPlatform(os) ? 1 : 0, os)
  }
  assert.deepEqual(orderDownloadCards('ios').map(c => c.platform), [...DEFAULT_PLATFORM_ORDER])
})

test('per-platform files: Windows/Linux assets, one macOS file per architecture with DMG preferred', () => {
  const sha = 'a'.repeat(64)
  const release = {
    format: 1, appId: 'com.ubaidbinwaris.proxy-qa-browser', version: '1.5.0', releasedAt: '2026-10-08T10:00:00.000Z', notes: ['n'],
    assets: [
      { platform: 'win32', arch: 'x64', fileName: 'Proxy-QA-Browser-1.5.0-Windows-x64.exe', size: 106_000_000, sha256: sha },
      { platform: 'linux', arch: 'x64', fileName: 'Proxy-QA-Browser-1.5.0-x86_64.AppImage', size: 571_000_000, sha256: sha },
    ],
    macAssets: [
      { platform: 'darwin', arch: 'x64', fileName: 'Proxy-QA-Browser-1.5.0-macOS-x64.zip', size: 1, sha256: sha },
      { platform: 'darwin', arch: 'x64', fileName: 'Proxy-QA-Browser-1.5.0-macOS-x64.dmg', size: 2, sha256: sha },
      { platform: 'darwin', arch: 'arm64', fileName: 'Proxy-QA-Browser-1.5.0-macOS-arm64.zip', size: 3, sha256: sha },
    ],
  } satisfies Release
  assert.equal(platformAsset(release, 'win32')?.fileName, 'Proxy-QA-Browser-1.5.0-Windows-x64.exe')
  assert.equal(platformAsset(release, 'linux')?.fileName, 'Proxy-QA-Browser-1.5.0-x86_64.AppImage')
  assert.deepEqual(macDownloads(release).map(f => f.fileName), ['Proxy-QA-Browser-1.5.0-macOS-arm64.zip', 'Proxy-QA-Browser-1.5.0-macOS-x64.dmg'])
  assert.deepEqual(macDownloads({ ...release, macAssets: undefined }), [])
  assert.equal(platformAsset(null, 'win32'), null)
  assert.deepEqual(macDownloads(null), [])
  assert.equal(formatSize(106_000_000), '101.1 MB')
})

test('every home page docs link points to an existing docs page', async () => {
  const manifest = JSON.parse(await readFile(join(repo, 'docs', 'site', 'manifest.json'), 'utf8')) as { sections: Array<{ pages: Array<{ slug: string }> }> }
  const slugs = new Set(manifest.sections.flatMap(section => section.pages.map(page => page.slug)))
  for (const slug of GALLERY_SCREENSHOTS.map(s => s.docSlug)) assert.ok(slugs.has(slug), `missing docs page: ${slug}`)
})

test('the features are six short, distinct items, each with its own icon', () => {
  assert.equal(FEATURES.length, 6)
  assert.equal(new Set(FEATURES.map(f => f.icon)).size, FEATURES.length)
  assert.equal(new Set(FEATURES.map(f => f.title)).size, FEATURES.length)
  for (const feature of FEATURES) {
    assert.equal(feature.text.split(/(?<=[.!?])\s+/).length, 1, `${feature.title}: one sentence`)
    assert.ok(feature.text.length <= 130, `${feature.title}: ${feature.text.length} characters`)
  }
})

test('the home title, description and social cards describe the app without overclaiming', async () => {
  assert.ok(HOME_TITLE.startsWith(SITE_NAME), HOME_TITLE)
  assert.ok(HOME_TITLE.length <= 60, `${HOME_TITLE.length} characters`)
  assert.match(HOME_TITLE, /website form testing/)
  assert.ok(SITE_DESCRIPTION.length >= 120 && SITE_DESCRIPTION.length <= 158, `${SITE_DESCRIPTION.length} characters`)
  for (const text of [HOME_TITLE, SITE_DESCRIPTION]) {
    // Devices are emulated, a location is checked (a third-party estimate), and counts go stale in metadata.
    assert.ok(!/\breal (locations?|devices?|phones?)\b/i.test(text), text)
    assert.ok(!/\bverified\b/i.test(text), text)
    assert.ok(!/\d{3}/.test(text), text)
  }
  const layout = await readFile(join(webapp, 'src', 'app', 'layout.tsx'), 'utf8')
  for (const usage of ['title: { default: HOME_TITLE,', "openGraph: { type: 'website', siteName: SITE_NAME, title: HOME_TITLE, description: SITE_DESCRIPTION,", "twitter: { card: 'summary_large_image', title: HOME_TITLE, description: SITE_DESCRIPTION }"]) assert.ok(layout.includes(usage), usage)
})

test('the home page has one H1, which does not claim real devices', async () => {
  const page = await homePage()
  const h1s = [...page.matchAll(/<h1\b[^>]*>(.*?)<\/h1>/g)].map(m => m[1]!)
  assert.equal(h1s.length, 1)
  assert.equal(h1s[0], 'Test your web forms by location, device and browser.')
  assert.ok(!/\breal\b/i.test(h1s[0]!))
})

test('home copy stays within what the docs support', async () => {
  const copy = await homeCopy()
  // Vivaldi installs but cannot be automated (docs/site/browsers.md, Known limitations), so it is never advertised.
  assert.ok(!/vivaldi/i.test(copy), 'Vivaldi is not a supported browser in marketing copy')
  // Phones and tablets are emulated presets inside desktop browsers.
  assert.ok(!/\breal (devices?|phones?|tablets?|iphones?)\b/i.test(copy))
  // QA aids, not legal determinations.
  assert.ok(!/tcpa compliance|compliance (check|software)/i.test(copy))
  for (const title of [...FEATURES.map(f => f.title), ...GALLERY_SCREENSHOTS.map(s => s.title)]) assert.ok(!/compliance|verified/i.test(title), title)
  for (const point of GALLERY_SCREENSHOTS.flatMap(s => s.points)) assert.ok(!/\bverified\b/i.test(point), point)
  // WebKit is the engine Safari is built on, not Safari (docs/site/browsers.md).
  assert.ok(!/\bin safari\b|\bsafari browser\b/i.test(copy))
  // No positioning the product as an evasion tool.
  assert.ok(!/anti-?detect|fingerprint spoof|multi-?account|unblock|bypass/i.test(copy))
  // Location targeting needs the user's own proxy plan; the hero and the location feature say so.
  const hero = /<p className="hero-description">(.*?)<\/p>/.exec(await homePage())?.[1] ?? ''
  assert.match(hero, /your own proxy plan/)
  // The hero names the product: a desktop QA browser for your own site.
  assert.match(hero, /desktop QA browser/)
  assert.match(FEATURES.find(f => f.icon === 'location')!.text, /your own proxy plan/)
  // Each exact-match search phrase appears at most once on the page.
  for (const phrase of ['test your website from different locations', 'free cross-browser testing', 'website form testing', 'website testing tool']) assert.ok(occurrences(copy, phrase) <= 1, phrase)
})

test('the device preset count comes from one constant that matches the docs', async () => {
  const doc = await readFile(join(repo, 'docs', 'site', 'locations-and-devices.md'), 'utf8')
  const stated = [...doc.matchAll(/\b(\d+)\**\s+(?:[a-z,]+\s+){0,4}?presets\b/gi)].map(m => Number(m[1]))
  assert.ok(stated.length > 0, 'docs/site/locations-and-devices.md states the number of presets')
  for (const count of stated) assert.equal(count, DEVICE_PRESET_COUNT, 'DEVICE_PRESET_COUNT (src/lib/site.ts) must match docs/site/locations-and-devices.md')
  // The home copy interpolates the constant instead of repeating the number.
  for (const file of [join(webapp, 'src', 'lib', 'home.ts'), join(webapp, 'src', 'app', 'page.tsx')]) {
    const source = await readFile(file, 'utf8')
    assert.ok(!/\b\d+\s+(?:[a-z,]+\s+){0,4}?presets\b/i.test(source), `${file}: use DEVICE_PRESET_COUNT`)
  }
  assert.ok(FEATURES.some(f => f.text.startsWith(`${DEVICE_PRESET_COUNT} emulated`)))
  for (const file of [join(webapp, 'src', 'lib', 'home.ts'), join(webapp, 'src', 'app', 'page.tsx')]) {
    assert.ok(!(await readFile(file, 'utf8')).includes(String(DEVICE_PRESET_COUNT)), `${file}: no literal ${DEVICE_PRESET_COUNT}, use DEVICE_PRESET_COUNT`)
  }
  assert.ok(STEPS.some(s => s.text.includes(`${DEVICE_PRESET_COUNT} emulated device presets`)))
})

test('the home page links every use-case page once, with a short summary', async () => {
  const page = await homePage()
  // One card per use case, rendered from src/lib/use-cases.ts, so a new page is linked automatically.
  assert.ok(page.includes('{USE_CASES.map(useCase => <li key={useCase.slug}>'))
  assert.equal(page.split('href={useCasePath(useCase.slug)}').length - 1, 1)
  for (const useCase of USE_CASE_PAGES) assert.ok(useCase.summary.length > 0 && useCase.summary.length <= 90, `${useCase.slug}: summary is ${useCase.summary.length} characters`)
  assert.equal(new Set(USE_CASE_PAGES.map(u => u.summary)).size, USE_CASE_PAGES.length)
})

test('downloads go to /download, and the home page keeps the #download anchor the desktop app opens', async () => {
  const page = await homePage()
  assert.ok(page.includes('id="download"'))
  assert.ok(!page.includes('href="#download"') && !page.includes('/#download'))
  assert.ok((page.match(/href=\{DOWNLOAD_PATH\}/g) ?? []).length >= 3)
  for (const file of ['src/components/SiteChrome.tsx', 'src/app/use-cases/[slug]/page.tsx', 'src/app/docs/[slug]/page.tsx', 'src/app/llms.txt/route.ts', 'src/lib/seo.ts']) {
    assert.ok(!(await readFile(join(webapp, file), 'utf8')).includes('#download'), `${file} still links #download`)
  }
})

test('the home questions come from the FAQ page', async () => {
  const questions = new Set(faqItems().map(item => item.question))
  for (const question of HOME_FAQ_QUESTIONS) assert.ok(questions.has(question), question)
  assert.equal(homeFaqs().length, HOME_FAQ_QUESTIONS.length)
  // The FAQPage structured data lives on /faq only, so the same questions are not marked up twice.
  assert.ok(!(await homePage()).includes('faqPage('))
})

test('the gallery shows three screenshot rows, each with its own docs link', async () => {
  assert.equal(GALLERY_SCREENSHOTS.length, 3)
  assert.deepEqual(GALLERY_SCREENSHOTS.map(s => s.src.split('/').pop()), ['run-detail.webp', 'qa-results.webp', 'check-evidence.webp'])
  assert.deepEqual(GALLERY_SCREENSHOTS.map(s => s.docSlug), ['launching', 'automation', 'checks'])
  for (const shot of GALLERY_SCREENSHOTS) {
    assert.ok(shot.alt.length <= 150, `${shot.src}: alt text is ${shot.alt.length} characters; move detail into the visible text`)
    assert.ok(shot.points.length >= 2 && shot.points.length <= 3, shot.title)
    const sentences = shot.text.split(/(?<=[.!?])\s+/).length
    assert.ok(sentences >= 2 && sentences <= 3, `${shot.title}: ${sentences} sentences`)
  }
  // Rows are H3s under the section's H2; images keep their size, srcset, sizes and lazy loading.
  const page = await homePage()
  const gallery = page.slice(page.indexOf('className="section home-gallery"'), page.indexOf('id="use-cases"'))
  assert.ok(page.includes('aria-hidden="true" focusable="false"'), 'feature icons are decorative')
  assert.equal((gallery.match(/<h2\b/g) ?? []).length, 1)
  assert.equal((gallery.match(/<h3>/g) ?? []).length, 1, 'one H3 in the row template')
  assert.ok(!/<h4\b/.test(gallery))
  for (const attr of ['srcSet={screenshotSrcSet(shot)}', 'sizes="', 'width={shot.width}', 'height={shot.height}', 'alt={shot.alt}', 'loading="lazy"']) assert.ok(gallery.includes(attr), attr)
})

// Screenshots live in docs/site/images (published with the docs under /docs-assets/images).
const screenshotFile = (src: string) => join(repo, 'docs', 'site', src.slice('/docs-assets/'.length))

test('referenced screenshots exist, match their declared size and stay under the size limit', async () => {
  for (const shot of [HERO_SCREENSHOT, ...GALLERY_SCREENSHOTS]) {
    assert.match(shot.src, /^\/docs-assets\/images\/[a-z0-9-]+\.webp$/)
    const file = screenshotFile(shot.src)
    const info = await stat(file)
    assert.ok(info.size > 0 && info.size <= SCREENSHOT_MAX_BYTES, `${shot.src}: ${info.size} bytes`)
    const bytes = await readFile(file)
    // WebP: RIFF....WEBP, then a VP8L (lossless) or VP8X/VP8 chunk carrying the canvas size.
    assert.equal(bytes.subarray(0, 4).toString('latin1'), 'RIFF', shot.src)
    assert.equal(bytes.subarray(8, 12).toString('latin1'), 'WEBP', shot.src)
    assert.deepEqual(webpSize(bytes), { width: shot.width, height: shot.height }, shot.src)
    assert.ok(shot.alt.length >= 40, `${shot.src} needs descriptive alt text`)
    // The 720 px copy in the srcset exists, has the declared width and is smaller than the original.
    const small = screenshotSrcSet(shot).split(', ')[0]!.split(' ')[0]!
    const smallBytes = await readFile(screenshotFile(small))
    assert.equal(webpSize(smallBytes).width, SCREENSHOT_SMALL_WIDTH, small)
    assert.ok(smallBytes.length < bytes.length, `${small} should be smaller than ${shot.src}`)
  }
})

function webpSize(bytes: Buffer): { width: number; height: number } {
  const chunk = bytes.subarray(12, 16).toString('latin1')
  if (chunk === 'VP8L') {
    const b = bytes.subarray(21, 25)
    return { width: 1 + (((b[1]! & 0x3f) << 8) | b[0]!), height: 1 + (((b[3]! & 0xf) << 10) | (b[2]! << 2) | ((b[1]! & 0xc0) >> 6)) }
  }
  if (chunk === 'VP8X') return { width: 1 + bytes.readUIntLE(24, 3), height: 1 + bytes.readUIntLE(27, 3) }
  if (chunk === 'VP8 ') return { width: bytes.readUInt16LE(26) & 0x3fff, height: bytes.readUInt16LE(28) & 0x3fff }
  throw new Error(`Unknown WebP chunk ${chunk}`)
}
