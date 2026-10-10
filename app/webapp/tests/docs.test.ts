import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { allPages, findPage, loadDoc, longDate, neighbours, parseManifest } from '../src/lib/docs.ts'
import type { DocsManifest } from '../src/lib/docs.ts'
import { docArticle } from '../src/lib/seo.ts'

const script = resolve(import.meta.dirname, '../../../scripts/sync-docs.mjs')
const repo = resolve(import.meta.dirname, '../../..')
let work: string
before(async () => { work = await mkdtemp(join(tmpdir(), 'proxy-docs-test-')) })
after(async () => { await rm(work, { recursive: true, force: true }) })

const manifest = { sections: [
  { title: 'Getting started', pages: [{ slug: 'introduction', title: 'Introduction', description: 'Start here.' }, { slug: 'install', title: 'Install' }] },
  { title: 'Reference', pages: [{ slug: 'faq', title: 'FAQ' }] },
] }

async function fixtureRepo(name: string, pages: Record<string, string>, data: unknown = manifest) {
  const root = join(work, name), out = join(root, 'web')
  await mkdir(join(root, 'docs', 'site', 'images'), { recursive: true }); await mkdir(join(root, 'resources'), { recursive: true }); await mkdir(out, { recursive: true })
  await writeFile(join(root, 'docs', 'site', 'manifest.json'), JSON.stringify(data))
  for (const [slug, body] of Object.entries(pages)) await writeFile(join(root, 'docs', 'site', `${slug}.md`), body)
  await writeFile(join(root, 'docs', 'site', 'images', 'shot.png'), 'png')
  await writeFile(join(root, 'resources', 'release-notes.json'), JSON.stringify({ '1.0.0': ['First'] }))
  await writeFile(join(root, 'NOTICE'), 'Proxy QA Browser\nCopyright 2026 Ubaid Bin Waris\n')
  return { root, out }
}
function sync(root: string, out: string, ...flags: string[]) {
  return spawnSync(process.execPath, [script, '--root', root, '--out', out, ...flags], { encoding: 'utf8' })
}

test('sync copies docs, images, release notes and NOTICE when the manifest is valid', async () => {
  const { root, out } = await fixtureRepo('valid', { introduction: '# Introduction\n\nHello.', install: '```md\n# Not a heading\n```\n\n# Install\n', faq: '# FAQ\n' })
  const result = sync(root, out)
  assert.equal(result.status, 0, result.stderr)
  assert.deepEqual(JSON.parse(await readFile(join(out, 'content', 'manifest.json'), 'utf8')), manifest)
  assert.equal(await readFile(join(out, 'content', 'docs', 'faq.md'), 'utf8'), '# FAQ\n')
  assert.equal(await readFile(join(out, 'public', 'docs-assets', 'images', 'shot.png'), 'utf8'), 'png')
  assert.ok((await readFile(join(out, 'content', 'NOTICE.txt'), 'utf8')).includes('Ubaid Bin Waris'))
  assert.deepEqual(JSON.parse(await readFile(join(out, 'content', 'release-notes.json'), 'utf8')), { '1.0.0': ['First'] })
})

test('sync records image sizes and the images each page shows, and rejects references to missing images', async () => {
  // 2×3 PNG: signature, IHDR length and type, then width and height.
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]), Buffer.from('IHDR'), Buffer.from([0, 0, 0, 2, 0, 0, 0, 3])])
  const { root, out } = await fixtureRepo('images', { introduction: '# Introduction\n\n![Shot](images/real.png "Caption")\n\n```md\n![ignored](images/none.png)\n```', install: '# Install\n', faq: '# FAQ\n' })
  await writeFile(join(root, 'docs', 'site', 'images', 'real.png'), png)
  assert.equal(sync(root, out).status, 0)
  assert.deepEqual(JSON.parse(await readFile(join(out, 'content', 'images.json'), 'utf8')), { 'images/real.png': { width: 2, height: 3 } })
  const synced = JSON.parse(await readFile(join(out, 'content', 'manifest.json'), 'utf8')) as DocsManifest
  assert.deepEqual(findPage(synced, 'introduction')?.images, ['images/real.png'])
  assert.equal(findPage(synced, 'install')?.images, undefined)

  await writeFile(join(root, 'docs', 'site', 'install.md'), '# Install\n\n![Gone](images/missing.webp)\n')
  const broken = sync(root, out)
  assert.equal(broken.status, 1)
  assert.match(broken.stderr, /install\.md: image "images\/missing\.webp" does not exist in docs\/site/)
})

test('a missing page fails the sync unless --allow-missing is given', async () => {
  const { root, out } = await fixtureRepo('missing', { introduction: '# Introduction\n', faq: '# FAQ\n' })
  const strict = sync(root, out)
  assert.equal(strict.status, 1)
  assert.match(strict.stderr, /docs\/site\/install\.md is listed in manifest\.json but does not exist/)
  const lenient = sync(root, out, '--allow-missing')
  assert.equal(lenient.status, 0, lenient.stderr)
  assert.match(lenient.stderr, /install/)
  const written = JSON.parse(await readFile(join(out, 'content', 'manifest.json'), 'utf8')) as DocsManifest
  assert.deepEqual(allPages(written).map(p => p.slug), ['introduction', 'faq'])
})

test('duplicate slugs, bad slugs and mismatched titles fail even with --allow-missing', async () => {
  const bad = { sections: [{ title: 'A', pages: [{ slug: 'introduction', title: 'Introduction' }, { slug: 'introduction', title: 'Again' }, { slug: 'Bad Slug', title: 'Bad' }, { slug: 'install', title: 'Install' }] }] }
  const { root, out } = await fixtureRepo('invalid', { introduction: '# Introduction\n', install: '# Installing\n' }, bad)
  const result = sync(root, out, '--allow-missing')
  assert.equal(result.status, 1)
  assert.match(result.stderr, /duplicate slug "introduction"/)
  assert.match(result.stderr, /"slug" must be lowercase/)
  assert.match(result.stderr, /install\.md: first heading "Installing" does not match manifest title "Install"/)
})

test('navigation helpers give reading order across sections and handle unknown slugs', () => {
  const m = parseManifest(JSON.stringify(manifest))
  assert.deepEqual(neighbours(m, 'introduction'), { previous: null, next: { slug: 'install', title: 'Install' } })
  assert.deepEqual(neighbours(m, 'install'), { previous: { slug: 'introduction', title: 'Introduction', description: 'Start here.' }, next: { slug: 'faq', title: 'FAQ' } })
  assert.deepEqual(neighbours(m, 'faq'), { previous: { slug: 'install', title: 'Install' }, next: null })
  assert.deepEqual(neighbours(m, 'nope'), { previous: null, next: null })
  assert.equal(findPage(m, 'nope'), null)
  assert.equal(findPage(m, 'faq')?.section, 'Reference')
})

test('loadDoc renders a synced page and returns null for unknown or malformed slugs', async () => {
  const { root, out } = await fixtureRepo('render', { introduction: '# Introduction\n\nSee [install](install.md).\n\n## Next', install: '# Install\n', faq: '# FAQ\n' })
  assert.equal(sync(root, out).status, 0)
  const previous = process.env.CONTENT_DIR; process.env.CONTENT_DIR = join(out, 'content')
  try {
    const doc = await loadDoc('introduction')
    assert.ok(doc)
    assert.equal(doc.title, 'Introduction')
    assert.ok(doc.html.includes('<a href="/docs/install">install</a>'))
    assert.deepEqual(doc.headings.map(h => h.id), ['next'])
    assert.equal(await loadDoc('unknown'), null)
    assert.equal(await loadDoc('../manifest'), null)
  } finally { if (previous === undefined) delete process.env.CONTENT_DIR; else process.env.CONTENT_DIR = previous }
})

test('an optional seoTitle is validated, kept in the synced manifest and parsed', async () => {
  const withSeo = { sections: [{ title: 'Getting started', pages: [{ slug: 'introduction', title: 'Introduction', seoTitle: 'Free QA browser for location testing' }, { slug: 'install', title: 'Install' }] }, { title: 'Reference', pages: [{ slug: 'faq', title: 'FAQ', seoTitle: 'x'.repeat(42) }] }] }
  const { root, out } = await fixtureRepo('seo-title', { introduction: '# Introduction\n', install: '# Install\n', faq: '# FAQ\n' }, withSeo)
  const tooLong = sync(root, out)
  assert.equal(tooLong.status, 1)
  assert.match(tooLong.stderr, /\(faq\): "seoTitle" must be 1-41 characters/)
  withSeo.sections[1]!.pages[0]!.seoTitle = 'Frequently asked questions'
  await writeFile(join(root, 'docs', 'site', 'manifest.json'), JSON.stringify(withSeo))
  assert.equal(sync(root, out).status, 0)
  const parsed = parseManifest(await readFile(join(out, 'content', 'manifest.json'), 'utf8'))
  assert.equal(findPage(parsed, 'introduction')?.seoTitle, 'Free QA browser for location testing')
  assert.equal(findPage(parsed, 'install')?.seoTitle, undefined)
})

test('a page title too long for search results fails the sync until it gets a short seoTitle', async () => {
  const title = 'Consent, accessibility and performance checks'
  const long: { sections: { title: string; pages: { slug: string; title: string; seoTitle?: string }[] }[] } = { sections: [{ title: 'Automation', pages: [{ slug: 'checks', title }] }] }
  const { root, out } = await fixtureRepo('long-title', { checks: `# ${title}\n` }, long)
  const failed = sync(root, out)
  assert.equal(failed.status, 1)
  assert.match(failed.stderr, /\(checks\): title "Consent, accessibility and performance checks" is 45 characters; add a "seoTitle" of at most 41/)
  long.sections[0]!.pages[0]!.seoTitle = 'Automated accessibility and script checks'
  await writeFile(join(root, 'docs', 'site', 'manifest.json'), JSON.stringify(long))
  const fixed = sync(root, out)
  assert.equal(fixed.status, 0, fixed.stderr)
  assert.doesNotMatch(fixed.stderr, /characters/)
})

test('every page in the real docs manifest has a short search title and a 120-158 character description', async () => {
  const raw = JSON.parse(await readFile(join(repo, 'docs', 'site', 'manifest.json'), 'utf8')) as { sections: { pages: { slug: string; title: string; seoTitle?: string; description?: string }[] }[] }
  for (const page of raw.sections.flatMap(s => s.pages)) {
    const searchTitle = page.seoTitle ?? page.title
    assert.ok(searchTitle.length + ' | Proxy QA Browser'.length <= 60, `${page.slug}: "${searchTitle}" is ${searchTitle.length} characters`)
    assert.ok(page.description && page.description.length >= 120 && page.description.length <= 158, `${page.slug}: description is ${page.description?.length ?? 0} characters`)
  }
})

test('first and last commit dates come from git and pass through the manifest', async () => {
  const { firstCommitDate, lastCommitDate } = (await import(pathToFileURL(script).href)) as Record<'firstCommitDate' | 'lastCommitDate', (root: string, path: string) => string | null>
  const file = join('docs', 'site', 'manifest.json'), first = firstCommitDate(repo, file), last = lastCommitDate(repo, file)
  // Null outside a git checkout (a source archive); otherwise the page was added no later than its last change.
  if (first !== null && last !== null) {
    assert.match(first, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}$/)
    assert.ok(Date.parse(first) <= Date.parse(last), `${first} > ${last}`)
  }
  assert.equal(firstCommitDate(repo, join('docs', 'site', 'no-such-page.md')), null)
  assert.equal(firstCommitDate(work, 'anything.md'), null, 'not a git checkout')
  const parsed = parseManifest(JSON.stringify({ sections: [{ title: 'S', pages: [{ slug: 'install', title: 'Install', datePublished: '2026-10-01T12:00:00+05:00', lastModified: '2026-10-10T00:55:00+05:00' }, { slug: 'faq', title: 'FAQ' }] }] }))
  const install = findPage(parsed, 'install')!
  assert.equal(install.datePublished, '2026-10-01T12:00:00+05:00')
  assert.equal(findPage(parsed, 'faq')!.datePublished, undefined)
  const article = docArticle({ ...install, description: 'd' })
  assert.equal(article.datePublished, install.datePublished)
  assert.equal(article.dateModified, install.lastModified)
})

test('the visible "Last updated" date shows the structured dateModified as written, in any server time zone', async () => {
  const previous = process.env.TZ
  try {
    for (const zone of ['UTC', 'Pacific/Kiritimati', 'Pacific/Pago_Pago']) {
      process.env.TZ = zone
      assert.equal(longDate('2026-10-10T00:55:00+05:00'), '10 October 2026', zone)
      assert.equal(longDate('2026-01-05T23:30:00-08:00'), '5 January 2026', zone)
      assert.equal(longDate('2026-10-09'), '9 October 2026', zone)
    }
  } finally { if (previous === undefined) delete process.env.TZ; else process.env.TZ = previous }
  // The page shows <time dateTime={doc.lastModified}>, the value docArticle publishes as dateModified.
  const source = await readFile(resolve(import.meta.dirname, '../src/app/docs/[slug]/page.tsx'), 'utf8')
  assert.ok(source.includes('Last updated <time dateTime={doc.lastModified}>{longDate(doc.lastModified)}</time>'))
  assert.equal(docArticle({ slug: 'install', title: 'Install', description: 'd', section: 'S', lastModified: '2026-10-10T00:55:00+05:00' }).dateModified, '2026-10-10T00:55:00+05:00')
})

test('a docs page cannot take a slug reserved by a website route', async () => {
  // The script is plain JavaScript without type declarations: import it by URL with an explicit shape.
  const { validateManifest } = (await import(pathToFileURL(script).href)) as {
    validateManifest(raw: unknown, readPage: (slug: string) => Promise<string | null>): Promise<{ errors: string[] }>
  }
  const manifest = { sections: [{ title: 'S', pages: [{ slug: 'search', title: 'Search' }] }] }
  const result = await validateManifest(manifest, async () => '# Search\n')
  assert.ok(result.errors.some((message: string) => /reserved by the website/.test(message)), JSON.stringify(result))
})
