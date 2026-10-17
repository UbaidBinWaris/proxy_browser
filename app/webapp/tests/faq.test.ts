import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { metadata as downloadMetadata } from '../src/app/download/page.tsx'
import { metadata as faqMetadata } from '../src/app/faq/page.tsx'
import { FAQ_CHAPTERS, answerText, faqItems } from '../src/lib/faq.ts'
import { renderMarkdown } from '../src/lib/markdown.ts'
import { CONTACT_EMAILS, LEGAL_LINKS, SITE_NAME, STATIC_PAGES } from '../src/lib/site.ts'
import { USE_CASES, inlineParts, useCasePath } from '../src/lib/use-cases.ts'

const webapp = resolve(import.meta.dirname, '..')
const repo = resolve(webapp, '../..')
const TITLE_SUFFIX = ` | ${SITE_NAME}`

/** Heading ids of the questions on the old docs FAQ (docs/site/faq.md), which /docs/faq links still use. */
const DOCS_FAQ_ANCHORS = [
  'is-there-a-paid-edition', 'what-may-i-test-with-it', 'can-it-get-past-bot-detection-captcha-or-fraud-checks', 'does-it-send-any-data-to-the-developer',
  'what-works-without-a-proxy-plan', 'which-proxy-providers-are-supported', 'does-location-search-cover-other-countries', 'what-is-the-bundled-webkit',
  'which-browsers-can-use-phone-and-tablet-presets', 'does-an-installed-browser-use-my-own-profile-bookmarks-or-extensions', 'is-the-reported-exit-ip-location-always-exact',
  'can-i-run-several-browsers-at-once', 'does-it-check-tcpa-consent-disclosures', 'can-an-ai-assistant-run-checks-with-it', 'where-are-my-screenshots-and-run-history',
  'is-my-proxy-password-safe', 'can-i-share-the-exe-or-appimage-with-colleagues', 'why-does-windows-show-a-smartscreen-warning', 'does-it-work-the-same-on-windows-linux-and-macos',
  'is-there-a-mac-version', 'how-do-i-move-to-another-computer', 'how-do-i-uninstall-it', 'can-i-add-a-feature-or-a-proxy-provider',
]

test('every question of the old docs FAQ keeps its anchor, and ids are unique', () => {
  const items = faqItems()
  const ids = items.map(item => item.id)
  assert.equal(new Set(ids).size, ids.length, 'duplicate question id')
  for (const anchor of DOCS_FAQ_ANCHORS) assert.ok(ids.includes(anchor), `missing /faq#${anchor}`)
  const chapters = FAQ_CHAPTERS.map(chapter => chapter.id)
  assert.equal(new Set(chapters).size, chapters.length)
  for (const id of chapters) assert.ok(!ids.includes(id), `a question takes the chapter id ${id}`)
  assert.ok(chapters.includes('contact'), '/faq#contact is linked from the footer')
})

test('chapters are complete: an intro and at least two questions each', () => {
  assert.ok(FAQ_CHAPTERS.length >= 6)
  for (const chapter of FAQ_CHAPTERS) {
    assert.match(chapter.id, /^[a-z]+(?:-[a-z]+)*$/)
    assert.ok(chapter.intro.length > 0 && chapter.entries.length >= 2, chapter.id)
  }
})

test('every FAQ link points to an existing page and heading', async () => {
  const manifest = JSON.parse(await readFile(join(repo, 'docs', 'site', 'manifest.json'), 'utf8')) as { sections: Array<{ pages: Array<{ slug: string }> }> }
  const slugs = new Set(manifest.sections.flatMap(section => section.pages.map(page => page.slug)))
  const paths = new Set([...STATIC_PAGES.map(page => page.path), ...LEGAL_LINKS.map(link => link.href), ...USE_CASES.map(u => useCasePath(u.slug))])
  for (const item of faqItems()) for (const paragraph of item.answer) for (const part of inlineParts(paragraph)) {
    if (typeof part === 'string') continue
    const docs = /^\/docs\/([a-z0-9-]+)(?:#([a-z0-9-]+))?$/.exec(part.href)
    if (docs) {
      const [, slug, anchor] = docs
      assert.ok(slugs.has(slug!), `${item.id}: missing docs page ${part.href}`)
      if (anchor) {
        const { headings } = renderMarkdown(await readFile(join(repo, 'docs', 'site', `${slug}.md`), 'utf8'), { stripTitle: true })
        assert.ok(headings.some(h => h.id === anchor), `${item.id}: missing heading ${part.href}`)
      }
    } else if (part.href.startsWith('/')) assert.ok(paths.has(part.href), `${item.id}: unknown page ${part.href}`)
    else assert.match(part.href, /^https:\/\/github\.com\/UbaidBinWaris\/proxy_browser\b/, `${item.id}: unexpected external link ${part.href}`)
  }
})

test('answers read as plain text in structured data, and stay within the project scope', () => {
  for (const item of faqItems()) {
    const text = answerText(item)
    assert.ok(text.length > 20 && !text.includes(']('), item.id)
    assert.ok(!/anti-?detect|undetectable|multi-?account|unblock|real (devices?|phones?|iphones?)/i.test(text), `${item.id}: ${text}`)
    if (/safari/i.test(text)) assert.match(text, /webkit|download page|mac/i, `${item.id}: Safari named without WebKit`)
  }
  // Evasion is mentioned once, as something the app does not do.
  const evasion = faqItems().find(item => item.id === 'can-it-get-past-bot-detection-captcha-or-fraud-checks')!
  assert.match(answerText(evasion), /^No, and it is not meant to\./)
})

test('the contact answer and card list every public address', async () => {
  const contact = faqItems().find(item => item.id === 'how-do-i-contact-the-developer')!
  for (const { address } of CONTACT_EMAILS) {
    assert.match(address, /^[a-z0-9.]+@[a-z0-9.]+\.[a-z]+$/)
    assert.ok(answerText(contact).includes(address), address)
  }
  assert.equal(contact.chapter, 'contact')
  assert.match(answerText(contact), /Never send proxy passwords/)
  const page = await readFile(join(webapp, 'src', 'app', 'faq', 'page.tsx'), 'utf8')
  assert.ok(page.includes('href={`mailto:${contact.address}`}'))
})

test('the FAQ and download pages fit search results and are in the sitemap', () => {
  for (const metadata of [faqMetadata, downloadMetadata]) {
    const title = String(metadata.title), description = String(metadata.description)
    assert.ok(title.length + TITLE_SUFFIX.length <= 60, `${title}: ${title.length + TITLE_SUFFIX.length} characters`)
    assert.ok(description.length >= 120 && description.length <= 158, `${title}: description is ${description.length} characters`)
  }
  assert.equal(faqMetadata.alternates?.canonical, '/faq')
  assert.equal(downloadMetadata.alternates?.canonical, '/download')
  for (const path of ['/faq', '/download']) assert.ok(STATIC_PAGES.some(page => page.path === path), path)
})

test('/docs/faq redirects permanently to /faq, and no docs page can take the slug again', async () => {
  const config = await readFile(join(webapp, 'next.config.ts'), 'utf8')
  assert.ok(config.includes("{ source: '/docs/faq', destination: '/faq', permanent: true }"))
  const sync = await readFile(join(repo, 'scripts', 'sync-docs.mjs'), 'utf8')
  assert.ok(sync.includes("new Set(['search', 'faq'])"))
  const manifest = await readFile(join(repo, 'docs', 'site', 'manifest.json'), 'utf8')
  assert.ok(!manifest.includes('"slug": "faq"'))
})
