import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile, stat } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { DEFAULT_PLATFORM_ORDER, detectOs, formatSize, isMobileOs, macDownloads, orderDownloadCards, platformAsset, recommendedPlatform } from '../src/lib/downloads.ts'
import type { VisitorOs } from '../src/lib/downloads.ts'
import { FAQS, FEATURES, GALLERY_SCREENSHOTS, HERO_SCREENSHOT, MORE_USE_CASE_LINKS, SCREENSHOT_MAX_BYTES, STEPS, USE_CASES, SCREENSHOT_SMALL_WIDTH, screenshotSrcSet } from '../src/lib/home.ts'
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
    ...USE_CASES.flatMap(u => [u.title, u.text, ...u.points]),
    ...MORE_USE_CASE_LINKS.map(l => l.label),
    ...STEPS.flatMap(s => [s.title, s.text]),
    ...FAQS.flatMap(f => [f.question, f.answer]),
    ...[HERO_SCREENSHOT, ...GALLERY_SCREENSHOTS].map(shot => shot.caption),
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
  const linked = [...FEATURES.map(f => f.docSlug), ...USE_CASES.map(u => u.docSlug), ...FAQS.flatMap(f => f.link?.href.startsWith('/docs/') ? [f.link.href.slice('/docs/'.length)] : [])]
  for (const slug of linked) assert.ok(slugs.has(slug), `missing docs page: ${slug}`)
  assert.ok(FEATURES.length >= 9)
  assert.equal(new Set(FEATURES.map(f => f.docSlug)).size, FEATURES.length, 'each feature links to its own page')
  for (const href of FAQS.flatMap(f => f.link && !f.link.href.startsWith('/docs/') ? [f.link.href] : [])) assert.match(href, /^\/(acceptable-use|privacy|terms|security|licenses|disclaimer|changelog|about)$/)
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
  for (const title of [...FEATURES.map(f => f.title), ...USE_CASES.map(u => u.title)]) assert.ok(!/compliance|verified/i.test(title), title)
  for (const point of USE_CASES.flatMap(u => u.points)) assert.ok(!/\bverified\b/i.test(point), point)
  // No positioning the product as an evasion tool.
  assert.ok(!/anti-?detect|fingerprint spoof|multi-?account|unblock|bypass/i.test(copy))
  // Location targeting needs the user's own proxy plan; the hero and the location feature say so.
  const hero = /<p className="hero-description">(.*?)<\/p>/.exec(await homePage())?.[1] ?? ''
  assert.match(hero, /your own proxy plan/)
  assert.match(FEATURES.find(f => f.docSlug === 'locations-and-devices')!.text, /your own proxy plan/)
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
  assert.ok(STEPS.some(s => s.text.includes(`${DEVICE_PRESET_COUNT} emulated device presets`)))
})

test('the home page body links each use-case page once, and only published ones', async () => {
  const linked = [...USE_CASES.flatMap(u => u.useCaseSlug ? [u.useCaseSlug] : []), ...MORE_USE_CASE_LINKS.map(l => l.slug)]
  assert.equal(new Set(linked).size, linked.length, 'one link per use-case page')
  assert.equal(new Set(MORE_USE_CASE_LINKS.map(l => l.label)).size, MORE_USE_CASE_LINKS.length)
  for (const page of USE_CASE_PAGES) assert.ok(linked.includes(page.slug), `the home page does not link /use-cases/${page.slug}`)
  // Cards and the "More use cases" row render a link only when the page exists.
  const page = await homePage()
  assert.ok(page.includes('MORE_USE_CASE_LINKS.filter(link => findUseCase(link.slug))'))
  assert.ok(page.includes('useCase.useCaseSlug ? findUseCase(useCase.useCaseSlug) : null'))
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
